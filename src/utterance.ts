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

// --- battery glyph for header ---

/**
 * Render a battery glyph + percent suffix for the glasses header.
 * Uses Unicode characters confirmed safe on the LVGL renderer.
 */
export function batteryHeaderSuffix(level: number | undefined): string {
  if (typeof level !== 'number' || !Number.isFinite(level)) return ''
  const pct = Math.max(0, Math.min(100, Math.round(level)))
  // Solid block when above 20%, hollow ring under 20% as a visual warning.
  const glyph = pct < 20 ? '○' : '◼'
  return `${glyph}${pct}%`
}
