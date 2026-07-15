// Pure helpers for end-of-utterance detection, transcript trimming, and
// glasses line wrapping. No side effects, no SDK imports — kept here so
// the wiring in main.ts stays small and the heuristics are unit-testable
// in isolation.

// --- end-of-utterance detection ---

// Sentence-final punctuation, including common Unicode punctuation that
// Deepgram emits (it normalizes some, but not all, depending on language).
const SENTENCE_FINAL_RE = /[.!?…。！？]\s*$/

export function endsOnSentenceFinalPunct(text: string): boolean {
  return SENTENCE_FINAL_RE.test(text.trim())
}

export interface UtteranceSignal {
  // Last non-empty transcript chunk's text — used to detect sentence-final.
  lastChunkText: string
  // Wall-clock time (ms) of the last non-empty chunk arriving.
  lastChunkAt: number
  // Wall-clock time (ms) of the most recent suggestion request fire.
  lastSuggestionAt: number
  // Whether a /suggest call is currently in flight — never fire while one is.
  inFlight: boolean
  // Total chars in the live transcript window — too short = skip.
  transcriptLen: number
}

export interface UtteranceTriggerConfig {
  /** Don't fire a /suggest call closer than this to the previous one (ms). */
  minDebounceMs: number
  /** Maximum we'll wait for "natural" pause; fire anyway after this (ms). */
  maxWaitMs: number
  /** Silence between final chunks long enough to count as end-of-utterance (ms). */
  silenceGapMs: number
  /** Skip if the rolling transcript is shorter than this (chars). */
  minTranscriptChars: number
}

export const DEFAULT_TRIGGER: UtteranceTriggerConfig = {
  minDebounceMs: 3_000,
  maxWaitMs: 12_000,
  silenceGapMs: 1_500,
  minTranscriptChars: 16,
}

/**
 * Decide whether to fire a /suggest call right now. Replaces the old
 * fixed-6s debounce. Returns true on:
 *   - sentence-final punctuation in the latest chunk (after minDebounce), or
 *   - silence gap exceeded (no new chunk for `silenceGapMs`), or
 *   - max-wait exceeded since last suggestion.
 *
 * Always blocked by: `inFlight`, transcript too short, or below minDebounce.
 */
export function shouldRequestSuggestion(
  state: UtteranceSignal,
  now: number,
  cfg: UtteranceTriggerConfig = DEFAULT_TRIGGER,
): boolean {
  if (state.inFlight) return false
  if (state.transcriptLen < cfg.minTranscriptChars) return false
  const sinceLastSuggestion = now - state.lastSuggestionAt
  if (sinceLastSuggestion < cfg.minDebounceMs) return false
  if (sinceLastSuggestion >= cfg.maxWaitMs) return true
  if (endsOnSentenceFinalPunct(state.lastChunkText)) return true
  const sinceLastChunk = now - state.lastChunkAt
  if (sinceLastChunk >= cfg.silenceGapMs) return true
  return false
}

// --- transcript trimming (sentence-aware) ---

// Split on sentence boundaries while preserving the punctuation. We split
// AFTER terminal punctuation followed by whitespace, so "A. B!" → ["A.", "B!"].
const SENTENCE_SPLIT_RE = /(?<=[.!?…。！？])\s+/

/**
 * Trim a rolling transcript to fit within a soft char budget while
 * respecting sentence boundaries. Drops whole leading sentences until
 * the result fits; if a single sentence is longer than the budget, the
 * tail of that sentence is returned (graceful degrade — better to
 * truncate mid-sentence than emit nothing).
 */
export function trimToSentences(text: string, maxChars: number): string {
  const trimmed = text.trim()
  if (trimmed.length <= maxChars) return trimmed
  const sentences = trimmed.split(SENTENCE_SPLIT_RE)
  // Drop from the front until we fit.
  let candidate = sentences.join(' ')
  while (sentences.length > 1 && candidate.length > maxChars) {
    sentences.shift()
    candidate = sentences.join(' ')
  }
  if (candidate.length <= maxChars) return candidate
  // Single sentence still too long — fall back to char-tail.
  return candidate.slice(-maxChars)
}

// --- glasses line wrapping (word-boundary, multi-line) ---

/**
 * Wrap a single suggestion line to multiple lines on word boundaries.
 * `width` is the max characters per line; `maxLines` caps the total
 * lines emitted (extra is collapsed with an ellipsis on the last line).
 * Returns each output line as a separate string in the array.
 */
export function wrapWords(text: string, width: number, maxLines: number): string[] {
  if (width <= 0 || maxLines <= 0) return []
  const out: string[] = []
  const words = text.trim().split(/\s+/)
  let line = ''
  for (const word of words) {
    if (line.length === 0) {
      // First word on line — break a too-long word at width.
      if (word.length > width) {
        line = word.slice(0, width)
        if (out.length === maxLines - 1) {
          out.push(`${line.slice(0, Math.max(0, width - 1))}…`)
          return out
        }
        out.push(line)
        line = word.slice(width)
        continue
      }
      line = word
      continue
    }
    if (line.length + 1 + word.length <= width) {
      line = `${line} ${word}`
    } else {
      if (out.length === maxLines - 1) {
        // Last allowed line — squeeze what's left in with an ellipsis.
        const remaining = words.slice(words.indexOf(word)).join(' ')
        const room = Math.max(0, width - line.length - 2) // ' …' or ' ...'
        if (remaining.length <= room) {
          line = `${line} ${remaining}`
        } else {
          line = `${line} …`
        }
        out.push(line)
        return out
      }
      out.push(line)
      line = word
    }
  }
  if (line.length > 0) out.push(line)
  return out
}

// --- conversation accumulation (v0.4.0) ---
//
// Per-speaker rolling buffer for transcript display. Same-speaker turns
// merge so words stream in until the speaker actually changes (fixes
// the v0.3 bug where each 2.5s chunk overwrote the previous one).
// Old turns age out of the window so the buffer doesn't grow unbounded.

export interface ConversationTurn {
  speaker: number
  text: string
  ts: number
}

export interface ConversationConfig {
  /** How long a turn stays in the buffer (ms). */
  scrollbackMs: number
  /** Hard cap on buffer length so a non-stop speaker can't grow it. */
  hardCap: number
}

export const DEFAULT_CONVERSATION: ConversationConfig = {
  scrollbackMs: 30_000,
  hardCap: 8,
}

/**
 * Append a new utterance to the buffer, merging into the last turn if
 * it's the same speaker. Returns the (mutated) buffer for chaining.
 */
export function appendTurn(
  buffer: ConversationTurn[],
  speaker: number,
  text: string,
  now: number,
  cfg: ConversationConfig = DEFAULT_CONVERSATION,
): ConversationTurn[] {
  if (text.trim().length === 0) return buffer
  const last = buffer[buffer.length - 1]
  if (last && last.speaker === speaker) {
    last.text = `${last.text} ${text}`.trim()
    last.ts = now
  } else {
    buffer.push({ speaker, text: text.trim(), ts: now })
  }
  return pruneTurns(buffer, now, cfg)
}

export function pruneTurns(
  buffer: ConversationTurn[],
  now: number,
  cfg: ConversationConfig = DEFAULT_CONVERSATION,
): ConversationTurn[] {
  const cutoff = now - cfg.scrollbackMs
  while (buffer.length > 0 && buffer[0]!.ts < cutoff) buffer.shift()
  while (buffer.length > cfg.hardCap) buffer.shift()
  return buffer
}

/** 0 → "A", 1 → "B", ..., 25 → "Z". Clamps out-of-range. */
export function speakerLabel(id: number): string {
  return String.fromCharCode(65 + Math.max(0, Math.min(25, id)))
}

// --- battery glyph for header ---

/**
 * Render a battery glyph + percent suffix for the glasses header.
 * Uses Unicode characters confirmed safe on the LVGL renderer.
 */
export function batteryHeaderSuffix(level: number | undefined): string {
  if (typeof level !== 'number' || !Number.isFinite(level)) return ''
  const pct = Math.max(0, Math.min(100, Math.round(level)))
  // Solid block when above 20%, hollow ring under 20% as a visual warning.
  // ■/○ 皆在官方認證字元集（◼ 不在，可能被 LVGL 字型丟棄）
  const glyph = pct < 20 ? '○' : '■'
  return `${glyph}${pct}%`
}

// ── Phase 3：串流顯示的純函式 ──────────────────────────────────────

/**
 * 把「1. 甲\n2) 乙」解析成 ['甲','乙']。只留編號行、容忍 LLM
 * 前言雜訊；完全沒有編號行時整段當一條。保留給舊測試與工具使用，
 * production /suggest 路徑已改用 singleAnswerFromText。
 */
export function parseNumberedList(text: string): string[] {
  if (text.trim().length === 0) return []
  const lines = text.split(/\r?\n/)
  const out: string[] = []
  for (const line of lines) {
    const m = line.match(/^\s*\d+[.)]\s+(.+)$/)
    if (m && m[1]) out.push(m[1].trim())
  }
  return out.length > 0 ? out : [text.trim()]
}

export function singleAnswerFromText(text: string): string[] {
  const answer = text.trim()
  return answer ? [answer] : []
}

export function normalizeSuggestionArray(items: string[]): string[] {
  return singleAnswerFromText(
    items
      .filter(item => typeof item === 'string')
      .map(item => item.trim())
      .filter(Boolean)
      .join('\n'),
  )
}

// ── 眼鏡渲染的位元組預算 ────────────────────────────────────────────

/**
 * 官方 Device APIs：textContainerUpgrade 的 content 上限 512 bytes/次，
 * 超過會被「無聲截斷」（不報錯）。中文 UTF-8 每字 3 bytes，約 170 字就爆。
 */
export const GLASSES_CONTENT_MAX_BYTES = 512

const UTF8 = new TextEncoder()

/**
 * 尾端滾動窗：從最新（尾端）行往回裝，總 UTF-8 位元組（含換行）不超過
 * maxBytes；有裁切時第一行補「…」提示還有更早內容。單行就超預算時
 * 截該行頭部保留尾端（延伸功能的最新內容永遠優先可見）。
 */
export function fitTailByBytes(lines: string[], maxBytes: number): string[] {
  if (lines.length === 0 || maxBytes <= 0) return []
  const size = (t: string) => UTF8.encode(t).length
  const total = size(lines.join('\n'))
  if (total <= maxBytes) return lines.slice()

  const ELLIPSIS = '▲' // 認證字元（… 不在集內）；語意：上方還有內容。3 bytes
  const out: string[] = []
  let used = size(ELLIPSIS) // 預留裁切提示行
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const cost = size(lines[i]!) + 1 // +1 換行
    if (used + cost > maxBytes) break
    out.unshift(lines[i]!)
    used += cost
  }
  if (out.length === 0) {
    // 最新一行自己就超預算 — 從行尾往前裝字元
    const last = lines[lines.length - 1]!
    let acc = ''
    for (let i = last.length - 1; i >= 0; i -= 1) {
      const candidate = last[i]! + acc
      if (size(ELLIPSIS + candidate) > maxBytes) break
      acc = candidate
    }
    return acc.length > 0 ? [ELLIPSIS + acc] : []
  }
  out.unshift(ELLIPSIS)
  return out
}

// ── Phase 4：中文問句偵測（自動收音模式的觸發條件） ─────────────────

// 疑問詞（多字詞，誤判率低）。單字「幾/哪」另外處理。
const QUESTION_WORDS = /什麼|如何|為什麼|怎麼|多少|能不能|可不可以|是不是/

/**
 * v1 純規則問句偵測：句尾「？/?/嗎/呢」或含疑問詞。
 * 已知限制（測試有記錄）：轉述句（「他問我什麼時候到」）會誤判命中 —
 * 自動收音模式多發一次 /suggest 的代價可接受，v1 不做語意判斷。
 */
export function isQuestionZh(text: string): boolean {
  const t = text.trim()
  if (t.length === 0) return false
  // 去掉尾端句號/驚嘆號/引號後看最後一個字
  const stripped = t.replace(/[。．.!！~～\s」』"']+$/, '')
  if (/[？?]$/.test(t) || /[？?]$/.test(stripped)) return true
  if (/[嗎呢]$/.test(stripped)) return true
  if (QUESTION_WORDS.test(t)) return true
  // 「幾」單字誤判率高（幾乎/幾天前）— 排除「幾乎」後才算
  if (t.includes('幾') && !t.includes('幾乎')) return true
  if (t.includes('哪')) return true
  return false
}

export interface RenderThrottle {
  /** 立即執行（距上次 ≥interval），否則排一次 trailing-edge 執行「最後一筆」。 */
  push(fn: () => void): void
  /** 立即執行未決的最後一筆（串流結束時用），之後原排程不重複執行。 */
  flush(): void
}

/**
 * 眼鏡渲染節流器。串流增量進來時最多每 intervalMs 觸發一次渲染 —
 * 併發／高頻 textContainerUpgrade 會弄壞 BLE（KNOWN_QUIRKS）。
 * now/schedule 可注入，讓測試不依賴真實計時器。
 */
export function createRenderThrottle(
  intervalMs: number,
  now: () => number = Date.now,
  schedule: (fn: () => void, ms: number) => void = (fn, ms) => { setTimeout(fn, ms) },
): RenderThrottle {
  let lastRunAt = -Infinity
  let pending: (() => void) | null = null
  let timerArmed = false

  function runPending(): void {
    timerArmed = false
    if (!pending) return
    const fn = pending
    pending = null
    lastRunAt = now()
    fn()
  }

  return {
    push(fn) {
      const t = now()
      if (t - lastRunAt >= intervalMs) {
        lastRunAt = t
        fn()
        return
      }
      pending = fn // 覆蓋前一筆 — 渲染只需要最新狀態
      if (!timerArmed) {
        timerArmed = true
        schedule(runPending, intervalMs - (t - lastRunAt))
      }
    },
    flush() {
      runPending()
    },
  }
}
