import { normalizeSuggestionArray, singleAnswerFromText } from './utterance'

// Transport layer to the user's personal Cue Worker.
//
// All communication goes through fetch() — never WebSocket — because the
// Even Hub WebView (at least on iOS) blocks outbound `new WebSocket()`
// during handshake even when the network whitelist permits the host.
// `WS open failed` was the symptom; chunked HTTP POST is the workaround.
//
// Two flows:
//   1. POST /transcribe — plugin buffers ~CHUNK_MS of PCM16 audio, then
//      POSTs the raw buffer. Worker wraps as WAV, calls Deepgram batch,
//      returns { text }. Trade-off vs streaming WS: ~CHUNK_MS latency
//      added, no interim transcripts.
//   2. POST /suggest — sends transcript context and gets one complete
//      answer while preserving the public suggestions:string[] shape.
//
// Both gated on a SHARED_SECRET bearer the user pasted into phone settings.
// If the user hasn't configured a Worker, transport.ready returns false
// and main.ts falls back to mock-mode suggestions.

export interface TranscriptUtterance {
  speaker: number  // Deepgram-assigned speaker id (0, 1, 2, ...)
  text: string
  confidence: number
}

export interface TranscriptEvent {
  type: 'transcript'
  text: string  // joined transcript for the chunk (back-compat)
  isFinal: boolean
  // v0.4.0: per-speaker turns within the chunk. Empty array if Deepgram
  // returned no utterances field (older worker, single-speaker chunk, etc).
  utterances: TranscriptUtterance[]
}

/** /suggest 的請求參數 — 串流與非串流共用。 */
export interface SuggestParams {
  mode: string
  transcript: string
  customPrompt?: string
  /** v0.4.2: rolling list of recent suggestions; worker adds a "don't repeat these" instruction to the LLM prompt. */
  recentSuggestions?: string[]
  /** Phase 1（Exo）：場景說明，Worker 原樣附進 prompt（【目前場景】…）。 */
  sceneNote?: string
  /** Phase 1：Anthropic 模型 id；Worker 端有允許清單把關。 */
  model?: string
  /** Phase 1：回答長度 short/medium/long → Worker 轉成字數上限規則。 */
  length?: string
  /** Phase 1：zh/en，決定 prompt 語言分支。 */
  lang?: string
  /** Phase 2：個人資訊 KB — 只在當前模式勾選掛載時帶。 */
  kbPersonal?: string
  /** Phase 2：補充資料 KB — 同上。 */
  kbExtra?: string
  /** Phase 4：延伸（extend）— 螢幕上的完整回答；Worker 據此要求「接續深入、不重複」。 */
  extendContext?: string
  /** 對話記憶（全模式）：最近幾輪 {them,me}，讓追問接得上。Worker 組成【最近對話】脈絡。 */
  history?: DialogTurn[]
}

/** 一輪對話：them＝對方說的話（solve＝提問）、me＝當時的回答。 */
export interface DialogTurn {
  them: string
  me: string
}

/** /vision 的請求參數 — 只送縮圖 base64，模型自己辨識圖中問題。 */
export interface VisionParams {
  imageBase64: string
  mediaType: string
  /** 可選：附帶的文字提問；不給時模型自行辨識圖中題目。 */
  question?: string
  mode?: string
  lang?: string
  length?: string
  kbPersonal?: string
  kbExtra?: string
  history?: DialogTurn[]
}

export interface CueTransport {
  ready: boolean
  startMicSession: (onTranscript: (e: TranscriptEvent) => void, onError: (msg: string) => void) => Promise<void>
  sendAudioFrame: (frame: Uint8Array) => void
  /**
   * Phase 4：discard=true 丟棄尾端 pending 音訊（取消本段），不打 /transcribe。
   * 回傳 producedText：本次 session 是否至少產出過一句非空逐字稿，讓呼叫端
   * 能在「開了麥卻沒聽到任何話」時給提示。
   */
  endMicSession: (opts?: { discard?: boolean }) => Promise<{ producedText: boolean }>
  /** VAD（自動收音模式）：說完即刻送出 pending 音訊，不等切塊滿。低於 MIN_CHUNK 或已有請求在飛則無作用。 */
  flushNow: () => void
  requestSuggestions: (params: SuggestParams) => Promise<{ ok: true; suggestions: string[] } | { ok: false; error: string }>
  /**
   * Phase 3：串流版 /suggest。onDelta 以「累積全文」回呼（呼叫端只管
   * 顯示最新狀態）；結束後回解析好的建議陣列。舊 Worker 回 JSON 時
   * 自動走舊格式（streamed=false，不會呼叫 onDelta）。
   */
  requestSuggestionsStream: (
    params: SuggestParams,
    cb: { onDelta: (accumulated: string) => void },
  ) => Promise<{ ok: true; suggestions: string[]; streamed: boolean } | { ok: false; error: string }>
  /**
   * Phase 7：圖片問答 /vision（串流純文字）。只送縮圖 base64，模型自己辨識
   * 圖中問題並依 solve 直答格式回答。onDelta 同 requestSuggestionsStream。
   */
  requestVisionStream: (
    params: VisionParams,
    cb: { onDelta: (accumulated: string) => void },
  ) => Promise<{ ok: true; answer: string } | { ok: false; error: string }>
  /** Diagnostic stats — used by the UI to show whether audio is flowing. */
  stats: () => {
    framesReceived: number
    bytesReceived: number
    chunksFlushed: number
    chunksOk: number
    lastError: string
    lastTranscriptChars: number
    lastTranscribeStatus: string
    firstFrameLatencyMs: number
  }
}

// Per-fetch debug log entry — captured for every /transcribe and /suggest
// call so the phone-side debug panel can show exactly what URL was hit,
// what the worker said, and how long it took. Decoupled via a callback
// so transport.ts stays UI-free.
export interface CueFetchLog {
  ts: number
  url: string
  method: string
  status: number | null    // null = network failure / aborted
  ms: number
  ok: boolean
  error?: string           // user-friendly summary
  bytes?: number           // request body size
  kind?: 'transcribe' | 'suggest' | 'vision'  // Debug Console 分層用
  transcript?: string      // transcribe 回應逐字稿全文（''＝Deepgram 回空，可辨 empty）
}

let logSink: ((entry: CueFetchLog) => void) | null = null
export function setTransportLogger(sink: ((entry: CueFetchLog) => void) | null): void {
  logSink = sink
}

function explainHttp(status: number, body: string): string {
  if (status === 401) return 'Worker rejected bearer token. Check SHARED_SECRET in phone settings matches the value you set on the Worker.'
  if (status === 405) return `Worker route exists but rejected the method. Most likely your Worker URL is OLD or wrong — verify it points at your latest deploy. (Body: ${body.slice(0, 80)})`
  if (status === 404) return 'Worker URL responded but /transcribe route is missing. Re-deploy worker-template/ to pick up the latest endpoint.'
  if (status === 500) {
    if (body.includes('DEEPGRAM_API_KEY not configured')) {
      return 'Worker is missing DEEPGRAM_API_KEY. Run `npx wrangler secret put DEEPGRAM_API_KEY` in worker-template/.'
    }
    return `Worker internal error: ${body.slice(0, 120)}`
  }
  if (status === 429) return 'Deepgram rate-limited the worker. Slow down or check your Deepgram quota.'
  if (status >= 500) return `Worker upstream error (${status}): ${body.slice(0, 120)}`
  if (status === 0) return 'Network failure (CORS, DNS, or no connectivity).'
  return `HTTP ${status}: ${body.slice(0, 120)}`
}

// 上游（Anthropic/OpenAI/Deepgram）4xx/5xx 時，Worker 一律回 JSON
// {ok:false, error} 並把上游狀態碼/訊息（如 insufficient_quota）包在 error 裡。
// 保留它——只回「Worker HTTP 400」會丟失可行動原因（不可靜默失敗）。兩家共用。
async function errorFromResponse(resp: Response): Promise<string> {
  try {
    const j = (await resp.json()) as { error?: string }
    if (j && typeof j.error === 'string' && j.error) {
      return `Worker HTTP ${resp.status}: ${j.error}`
    }
  } catch {
    /* 非 JSON body — 落回純狀態碼 */
  }
  return `Worker HTTP ${resp.status}`
}

// Audio chunking — keep low enough that the user feels live, high enough
// that Deepgram batch latency + chunk-boundary inaccuracy stays tolerable.
// 2.5s is the empirical sweet spot for a coaching app where the LLM
// /suggest step debounces at 6s anyway.
const SAMPLE_RATE = 16000
const BYTES_PER_SECOND = SAMPLE_RATE * 2 // 16-bit mono
const CHUNK_MS = 2500
const CHUNK_BYTES = Math.round((BYTES_PER_SECOND * CHUNK_MS) / 1000)
const MIN_CHUNK_BYTES = Math.round(BYTES_PER_SECOND * 0.5) // 500ms — below this, skip the call（僅擋非 force 流程）
// 極短語音修正：Deepgram nova-3 對 <1.5s 的中文常回空 transcript。gate-stop
// 的尾端 force-flush 若不足此長度，就在尾端補靜音 PCM(0x00) 到 1.5s，原始音訊
// 保持在前段完整——換來的空 transcript 大幅減少，代價是每段多幾 KB 靜音。
const PADDING_TARGET_MS = 1500
const PADDING_TARGET_BYTES = Math.round((BYTES_PER_SECOND * PADDING_TARGET_MS) / 1000)
// /transcribe 的 fetch 逾時上限。原本無 AbortController，卡住的請求永不返回、
// endMicSession 永不 resolve → UI 永遠停在 processing。任何等待都必須有 timeout。
const TRANSCRIBE_FETCH_TIMEOUT_MS = 12_000

export function createTransport(
  workerUrl: string,
  bearerToken: string,
  opts: { lang?: 'zh' | 'en'; gated?: boolean } = {},
): CueTransport {
  const baseHttp = workerUrl.replace(/\/$/, '')
  const ready = !!workerUrl && !!bearerToken
  // Phase 1：lang 決定 Worker 端的 Deepgram language 參數（zh→zh-TW）。
  // /transcribe 的 body 是 raw PCM，塞不了 JSON 欄位，所以走 query。
  // Phase 4：gated（預設開）— Worker 據此拿掉 diarize/utterances。
  const lang = opts.lang ?? 'zh'
  const gated = opts.gated ?? true

  let onTranscriptCb: ((e: TranscriptEvent) => void) | null = null
  let onErrorCb: ((msg: string) => void) | null = null
  let pending = new Uint8Array(0)
  let inFlight = false
  // 目前在飛的 flush promise（供 endMicSession 排空——等轉寫結果回來再判 producedText）。
  let inFlightPromise: Promise<void> | null = null
  let active = false
  // Diagnostic counters — surface via stats() so the UI can show whether
  // audio is flowing (most common silent failure mode: SDK starts mic but
  // never emits audio events to our handler).
  let framesReceived = 0
  let bytesReceived = 0
  let chunksFlushed = 0
  let chunksOk = 0
  let lastError = ''
  // 診斷：最後一段逐字稿字數與狀態（overlay 顯示 stt: 行）。
  let lastTranscriptChars = 0
  let lastTranscribeStatus = '—'
  // 本次 session 是否至少收到一句非空逐字稿；endMicSession 回傳給呼叫端。
  let sessionProducedText = false
  // 診斷：首幀延遲 — startMicSession（active=true，緊接 audioControl）到第一個
  // PCM frame 的毫秒數。驗證「audioControl 暖機延遲吃掉短句起始」假說的關鍵數字。
  // -1 = 本次 session 尚未收到任何 frame。
  let micStartAt = 0
  let firstFrameLatencyMs = -1

  // POST one accumulated chunk to the worker. We never block the audio
  // pipeline on a slow request — `inFlight` gates concurrency and any
  // bytes that arrive while a request is in flight just keep accumulating
  // in `pending` for the next flush.
  // 同步排程器：判斷是否要送、取出 chunk、啟動 async 送出並記錄 inFlightPromise。
  // 回傳可 await 的 promise（在飛時回傳「正在飛的那個」，供 endMicSession 排空）。
  function flush(force = false): Promise<void> {
    // 在飛時：回傳目前那個 promise，讓呼叫端能 await 它完成（而非 no-op return）。
    // 這是 gate-stop 時序 bug 的修正核心——endMicSession 靠它等轉寫結果回來。
    if (inFlight) return inFlightPromise ?? Promise.resolve()
    if (!force) {
      // 一般（active）flush：未達切塊門檻先不送，避免碎片請求。
      if (!active || pending.byteLength < MIN_CHUNK_BYTES) return Promise.resolve()
    } else {
      // force（endMicSession 尾端）：只要 >0 bytes 就送，繞過 MIN_CHUNK，
      // 否則不足 0.5s 的尾端 buffer 會被整段丟棄（極短語音完全沒反應的主因）。
      if (pending.byteLength === 0) return Promise.resolve()
    }
    inFlight = true
    chunksFlushed += 1
    let chunk = pending
    pending = new Uint8Array(0)
    // 不足 1.5s 時尾端補靜音，原音在前段完整（見 PADDING_TARGET_BYTES 註解）。
    // 一般 flush 送的是 ≥CHUNK_BYTES(2.5s) 的整塊，永遠 >target，不受影響。
    if (chunk.byteLength < PADDING_TARGET_BYTES) {
      const padded = new Uint8Array(PADDING_TARGET_BYTES)
      padded.set(chunk, 0)
      chunk = padded
    }
    const p = sendChunk(chunk).finally(() => {
      inFlight = false
      if (inFlightPromise === p) inFlightPromise = null
    })
    inFlightPromise = p
    return p
  }

  // 實際送出一塊到 /transcribe。inFlight 生命週期由 flush 的 p.finally 管理。
  async function sendChunk(chunk: Uint8Array<ArrayBuffer>): Promise<void> {
    const url = `${baseHttp}/transcribe?lang=${lang}&gated=${gated ? 1 : 0}`
    const startedAt = Date.now()
    try {
      // Body as Blob, not raw ArrayBuffer — WKWebView's fetch handles
      // Blobs more consistently across iOS versions, especially with
      // CORS preflight where some implementations refuse raw binary.
      const body = new Blob([chunk], { type: 'application/octet-stream' })
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), TRANSCRIBE_FETCH_TIMEOUT_MS)
      const resp = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${bearerToken}`,
        },
        body,
        signal: ctrl.signal,
      }).finally(() => clearTimeout(timer))
      if (!resp.ok) {
        const txt = await resp.text().catch(() => '')
        const friendly = explainHttp(resp.status, txt)
        lastError = `HTTP ${resp.status} ${txt.slice(0, 60)}`
        logSink?.({
          ts: startedAt, url, method: 'POST',
          status: resp.status, ms: Date.now() - startedAt, ok: false,
          error: friendly, bytes: chunk.byteLength, kind: 'transcribe',
        })
        lastTranscribeStatus = `http${resp.status}`
        onErrorCb?.(`transcribe HTTP ${resp.status}: ${txt.slice(0, 80)}`)
        return
      }
      const json = (await resp.json()) as {
        ok: boolean
        text?: string
        error?: string
        utterances?: Array<{ speaker?: number; text?: string; confidence?: number }>
      }
      if (!json.ok) {
        lastError = `worker said: ${(json.error ?? 'unknown').slice(0, 60)}`
        logSink?.({
          ts: startedAt, url, method: 'POST',
          status: resp.status, ms: Date.now() - startedAt, ok: false,
          error: json.error ?? 'transcribe failed', bytes: chunk.byteLength, kind: 'transcribe',
        })
        lastTranscribeStatus = 'worker-err'
        onErrorCb?.(json.error ?? 'transcribe failed')
        return
      }
      chunksOk += 1
      lastError = '' // success — clear stale error
      const text = (json.text ?? '').trim()
      // Debug Console：帶上逐字稿全文（含 ''＝Deepgram 回空），讓面板能分辨
      // 「送出成功但回空」與「有內容」——這是短句 no-speech 定位的關鍵一層。
      logSink?.({
        ts: startedAt, url, method: 'POST',
        status: resp.status, ms: Date.now() - startedAt, ok: true, bytes: chunk.byteLength,
        kind: 'transcribe', transcript: text,
      })
      const utterances: TranscriptUtterance[] = (json.utterances ?? [])
        .map(u => ({
          speaker: typeof u.speaker === 'number' ? u.speaker : 0,
          text: (u.text ?? '').trim(),
          confidence: typeof u.confidence === 'number' ? u.confidence : 0,
        }))
        .filter(u => u.text.length > 0)
      if (text) {
        lastTranscriptChars = text.length
        lastTranscribeStatus = 'ok'
        sessionProducedText = true
        onTranscriptCb?.({ type: 'transcript', text, isFinal: true, utterances })
      } else {
        lastTranscribeStatus = 'empty'
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      lastError = `network: ${msg.slice(0, 70)}`
      lastTranscribeStatus = 'neterr'
      logSink?.({
        ts: startedAt, url, method: 'POST',
        status: null, ms: Date.now() - startedAt, ok: false,
        error: `Network failure: ${msg.slice(0, 120)}`, bytes: chunk.byteLength, kind: 'transcribe',
      })
      onErrorCb?.(`transcribe network error: ${msg.slice(0, 80)}`)
    }
    // inFlight=false 由 flush 的 p.finally 統一管理（勿在此重複清）。
  }

  return {
    ready,
    async startMicSession(onTranscript, onError) {
      if (!ready) {
        throw new Error('Worker not configured')
      }
      // Probe the worker's /healthz with the bearer auth via a 1s fetch.
      // /healthz is unauth so we use it to confirm reachability; bearer
      // validation will happen on the first /transcribe POST. If we used
      // an authed endpoint here as the probe, a 401 would cleanly tell us
      // the bearer is wrong; the trade-off is the extra round-trip. We
      // accept that for clearer error messages on first-tap failures.
      try {
        const probeCtrl = new AbortController()
        const probeTimer = setTimeout(() => probeCtrl.abort(), 5_000)
        const probe = await fetch(`${baseHttp}/healthz`, { signal: probeCtrl.signal }).finally(() =>
          clearTimeout(probeTimer),
        )
        if (!probe.ok) {
          throw new Error(`worker /healthz returned ${probe.status}`)
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        throw new Error(`worker unreachable: ${msg.slice(0, 80)}`)
      }
      onTranscriptCb = onTranscript
      onErrorCb = onError
      pending = new Uint8Array(0)
      inFlight = false
      inFlightPromise = null
      active = true
      sessionProducedText = false
      micStartAt = Date.now()
      firstFrameLatencyMs = -1
    },
    sendAudioFrame(frame) {
      if (!active) return
      if (framesReceived === 0 && micStartAt > 0) {
        firstFrameLatencyMs = Date.now() - micStartAt
      }
      framesReceived += 1
      bytesReceived += frame.byteLength
      // Accumulate. Each incoming frame is small (~10-40ms typically); we
      // append until we hit CHUNK_BYTES, then trigger an async flush.
      const merged = new Uint8Array(pending.byteLength + frame.byteLength)
      merged.set(pending, 0)
      merged.set(frame, pending.byteLength)
      pending = merged
      if (pending.byteLength >= CHUNK_BYTES) {
        void flush()
      }
    },
    flushNow() {
      void flush()
    },
    async endMicSession(opts = {}) {
      // active=false BEFORE awaiting so no new sendAudioFrame races in.
      active = false
      // 排空：先等任何在飛的塊完成——否則它晚回時 onTranscriptCb 已被清/被下一
      // session 覆寫（文字丟失或錯置），且 producedText 會在轉寫結果回來前就被讀成
      // false（gate-stop「沒聽清楚」假象的根因）。等它回來，sessionProducedText 與
      // onTranscriptCb 才反映真實結果。
      if (inFlightPromise) {
        try { await inFlightPromise } catch { /* 已於 sendChunk 內記錄 */ }
      }
      // Phase 4：discard（取消本段）— 丟棄 pending，不打 /transcribe。
      if (opts.discard) {
        pending = new Uint8Array(0)
      } else {
        // 送尾端 partial chunk 並 await 到轉寫結果（此時 inFlight 已 false，不被擋）。
        await flush(true)
      }
      onTranscriptCb = null
      onErrorCb = null
      return { producedText: sessionProducedText }
    },
    stats() {
      return {
        framesReceived, bytesReceived, chunksFlushed, chunksOk, lastError,
        lastTranscriptChars, lastTranscribeStatus, firstFrameLatencyMs,
      }
    },
    async requestSuggestions({ mode, transcript, customPrompt, recentSuggestions, sceneNote, model, length, lang: suggestLang, kbPersonal, kbExtra, history }) {
      if (!ready) return { ok: false as const, error: 'Worker not configured' }
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), 12_000)
      try {
        // Phase 3 起 Worker 預設回串流；此非串流路徑明確要求 JSON
        const resp = await fetch(`${baseHttp}/suggest?stream=0`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${bearerToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ mode, transcript, customPrompt, recentSuggestions, sceneNote, model, length, lang: suggestLang, kbPersonal, kbExtra, history }),
          signal: ctrl.signal,
        })
        if (!resp.ok) {
          return { ok: false as const, error: await errorFromResponse(resp) }
        }
        const json = (await resp.json()) as
          | { ok: true; suggestions: string[] }
          | { ok: false; error: string }
        if (!json.ok) return json
        const suggestions = normalizeSuggestionArray(json.suggestions)
        return suggestions.length > 0
          ? { ok: true as const, suggestions }
          : { ok: false as const, error: 'empty suggestion response' }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return { ok: false as const, error: msg }
      } finally {
        clearTimeout(timer)
      }
    },
    async requestSuggestionsStream(params, { onDelta }) {
      if (!ready) return { ok: false as const, error: 'Worker not configured' }
      const ctrl = new AbortController()
      // 串流上限放寬到 30s — 長答案生成中途斷線比等待更糟
      const timer = setTimeout(() => ctrl.abort(), 30_000)
      try {
        const resp = await fetch(`${baseHttp}/suggest?stream=1`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${bearerToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(params),
          signal: ctrl.signal,
        })
        if (!resp.ok) {
          return { ok: false as const, error: await errorFromResponse(resp) }
        }
        // 舊 Worker（或 OpenAI fallback）回 JSON — 自動走舊格式
        const contentType = resp.headers.get('Content-Type') ?? ''
        if (contentType.includes('json')) {
          const json = (await resp.json()) as
            | { ok: true; suggestions: string[] }
            | { ok: false; error: string }
          if (!json.ok) return json
          const suggestions = normalizeSuggestionArray(json.suggestions)
          return suggestions.length > 0
            ? { ok: true as const, suggestions, streamed: false as const }
            : { ok: false as const, error: 'empty suggestion response' }
        }
        if (!resp.body) {
          return { ok: false as const, error: 'no response body' }
        }
        const reader = resp.body.getReader()
        const decoder = new TextDecoder()
        let accumulated = ''
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          accumulated += decoder.decode(value, { stream: true })
          if (accumulated.length > 0) onDelta(accumulated)
        }
        accumulated += decoder.decode() // flush 殘餘 multi-byte
        const suggestions = singleAnswerFromText(accumulated)
        return suggestions.length > 0
          ? { ok: true as const, suggestions, streamed: true as const }
          : { ok: false as const, error: 'empty suggestion response' }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return { ok: false as const, error: msg }
      } finally {
        clearTimeout(timer)
      }
    },
    async requestVisionStream(params, { onDelta }) {
      if (!ready) return { ok: false as const, error: 'Worker not configured' }
      const ctrl = new AbortController()
      // 圖片處理較慢 — 放寬到 45s
      const timer = setTimeout(() => ctrl.abort(), 45_000)
      try {
        const resp = await fetch(`${baseHttp}/vision`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${bearerToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            image_base64: params.imageBase64,
            media_type: params.mediaType,
            question: params.question,
            mode: params.mode,
            lang: params.lang,
            length: params.length,
            kbPersonal: params.kbPersonal,
            kbExtra: params.kbExtra,
            history: params.history,
          }),
          signal: ctrl.signal,
        })
        if (!resp.ok) {
          return { ok: false as const, error: await errorFromResponse(resp) }
        }
        if (!resp.body) return { ok: false as const, error: 'no response body' }
        const reader = resp.body.getReader()
        const decoder = new TextDecoder()
        let accumulated = ''
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          accumulated += decoder.decode(value, { stream: true })
          if (accumulated.length > 0) onDelta(accumulated)
        }
        accumulated += decoder.decode()
        const answer = accumulated.trim()
        return answer
          ? { ok: true as const, answer }
          : { ok: false as const, error: 'empty vision response' }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return { ok: false as const, error: msg }
      } finally {
        clearTimeout(timer)
      }
    },
  }
}
