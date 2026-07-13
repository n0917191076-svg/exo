import { parseNumberedList } from './utterance'

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
//   2. POST /suggest — same as before; sends transcript context, gets
//      back numbered suggestions list.
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
}

export interface CueTransport {
  ready: boolean
  startMicSession: (onTranscript: (e: TranscriptEvent) => void, onError: (msg: string) => void) => Promise<void>
  sendAudioFrame: (frame: Uint8Array) => void
  endMicSession: () => Promise<void>
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
  /** Diagnostic stats — used by the UI to show whether audio is flowing. */
  stats: () => { framesReceived: number; bytesReceived: number; chunksFlushed: number; chunksOk: number; lastError: string }
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

// Audio chunking — keep low enough that the user feels live, high enough
// that Deepgram batch latency + chunk-boundary inaccuracy stays tolerable.
// 2.5s is the empirical sweet spot for a coaching app where the LLM
// /suggest step debounces at 6s anyway.
const SAMPLE_RATE = 16000
const BYTES_PER_SECOND = SAMPLE_RATE * 2 // 16-bit mono
const CHUNK_MS = 2500
const CHUNK_BYTES = Math.round((BYTES_PER_SECOND * CHUNK_MS) / 1000)
const MIN_CHUNK_BYTES = Math.round(BYTES_PER_SECOND * 0.5) // 500ms — below this, skip the call

export function createTransport(
  workerUrl: string,
  bearerToken: string,
  opts: { lang?: 'zh' | 'en' } = {},
): CueTransport {
  const baseHttp = workerUrl.replace(/\/$/, '')
  const ready = !!workerUrl && !!bearerToken
  // Phase 1：lang 決定 Worker 端的 Deepgram language 參數（zh→zh-TW）。
  // /transcribe 的 body 是 raw PCM，塞不了 JSON 欄位，所以走 query。
  const lang = opts.lang ?? 'zh'

  let onTranscriptCb: ((e: TranscriptEvent) => void) | null = null
  let onErrorCb: ((msg: string) => void) | null = null
  let pending = new Uint8Array(0)
  let inFlight = false
  let active = false
  // Diagnostic counters — surface via stats() so the UI can show whether
  // audio is flowing (most common silent failure mode: SDK starts mic but
  // never emits audio events to our handler).
  let framesReceived = 0
  let bytesReceived = 0
  let chunksFlushed = 0
  let chunksOk = 0
  let lastError = ''

  // POST one accumulated chunk to the worker. We never block the audio
  // pipeline on a slow request — `inFlight` gates concurrency and any
  // bytes that arrive while a request is in flight just keep accumulating
  // in `pending` for the next flush.
  async function flush(force = false): Promise<void> {
    // `force` lets endMicSession drain the trailing partial chunk
    // even after `active` has been cleared. Without it, the
    // post-session flush is a silent no-op (caught while writing
    // v0.4.0 utterance tests; previously the trailing 5-30s of a
    // session was being dropped on the floor).
    if ((!active && !force) || inFlight || pending.byteLength < MIN_CHUNK_BYTES) return
    inFlight = true
    chunksFlushed += 1
    const chunk = pending
    pending = new Uint8Array(0)
    const url = `${baseHttp}/transcribe?lang=${lang}`
    const startedAt = Date.now()
    try {
      // Body as Blob, not raw ArrayBuffer — WKWebView's fetch handles
      // Blobs more consistently across iOS versions, especially with
      // CORS preflight where some implementations refuse raw binary.
      const body = new Blob([chunk], { type: 'application/octet-stream' })
      const resp = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${bearerToken}`,
        },
        body,
      })
      if (!resp.ok) {
        const txt = await resp.text().catch(() => '')
        const friendly = explainHttp(resp.status, txt)
        lastError = `HTTP ${resp.status} ${txt.slice(0, 60)}`
        logSink?.({
          ts: startedAt, url, method: 'POST',
          status: resp.status, ms: Date.now() - startedAt, ok: false,
          error: friendly, bytes: chunk.byteLength,
        })
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
          error: json.error ?? 'transcribe failed', bytes: chunk.byteLength,
        })
        onErrorCb?.(json.error ?? 'transcribe failed')
        return
      }
      chunksOk += 1
      lastError = '' // success — clear stale error
      logSink?.({
        ts: startedAt, url, method: 'POST',
        status: resp.status, ms: Date.now() - startedAt, ok: true, bytes: chunk.byteLength,
      })
      const text = (json.text ?? '').trim()
      const utterances: TranscriptUtterance[] = (json.utterances ?? [])
        .map(u => ({
          speaker: typeof u.speaker === 'number' ? u.speaker : 0,
          text: (u.text ?? '').trim(),
          confidence: typeof u.confidence === 'number' ? u.confidence : 0,
        }))
        .filter(u => u.text.length > 0)
      if (text && onTranscriptCb) {
        onTranscriptCb({ type: 'transcript', text, isFinal: true, utterances })
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      lastError = `network: ${msg.slice(0, 70)}`
      logSink?.({
        ts: startedAt, url, method: 'POST',
        status: null, ms: Date.now() - startedAt, ok: false,
        error: `Network failure: ${msg.slice(0, 120)}`, bytes: chunk.byteLength,
      })
      onErrorCb?.(`transcribe network error: ${msg.slice(0, 80)}`)
    } finally {
      inFlight = false
    }
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
      active = true
    },
    sendAudioFrame(frame) {
      if (!active) return
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
    async endMicSession() {
      // Final flush for the trailing partial chunk so a quick utterance
      // ending mid-buffer isn't dropped. `force` is required because the
      // active-flag check would otherwise skip the trailing send (set
      // active=false BEFORE awaiting so no new sendAudioFrame races in).
      active = false
      await flush(true)
      onTranscriptCb = null
      onErrorCb = null
    },
    stats() {
      return { framesReceived, bytesReceived, chunksFlushed, chunksOk, lastError }
    },
    async requestSuggestions({ mode, transcript, customPrompt, recentSuggestions, sceneNote, model, length, lang: suggestLang, kbPersonal, kbExtra }) {
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
          body: JSON.stringify({ mode, transcript, customPrompt, recentSuggestions, sceneNote, model, length, lang: suggestLang, kbPersonal, kbExtra }),
          signal: ctrl.signal,
        })
        if (!resp.ok) {
          return { ok: false as const, error: `Worker HTTP ${resp.status}` }
        }
        const json = (await resp.json()) as
          | { ok: true; suggestions: string[] }
          | { ok: false; error: string }
        return json
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
          return { ok: false as const, error: `Worker HTTP ${resp.status}` }
        }
        // 舊 Worker（或 OpenAI fallback）回 JSON — 自動走舊格式
        const contentType = resp.headers.get('Content-Type') ?? ''
        if (contentType.includes('json')) {
          const json = (await resp.json()) as
            | { ok: true; suggestions: string[] }
            | { ok: false; error: string }
          return json.ok ? { ...json, streamed: false as const } : json
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
        return { ok: true as const, suggestions: parseNumberedList(accumulated), streamed: true as const }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return { ok: false as const, error: msg }
      } finally {
        clearTimeout(timer)
      }
    },
  }
}
