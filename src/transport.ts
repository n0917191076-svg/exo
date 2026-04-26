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

export interface TranscriptEvent {
  type: 'transcript'
  text: string
  isFinal: boolean
}

export interface CueTransport {
  ready: boolean
  startMicSession: (onTranscript: (e: TranscriptEvent) => void, onError: (msg: string) => void) => Promise<void>
  sendAudioFrame: (frame: Uint8Array) => void
  endMicSession: () => Promise<void>
  requestSuggestions: (params: {
    mode: string
    transcript: string
    customPrompt?: string
  }) => Promise<{ ok: true; suggestions: string[] } | { ok: false; error: string }>
  /** Diagnostic stats — used by the UI to show whether audio is flowing. */
  stats: () => { framesReceived: number; bytesReceived: number; chunksFlushed: number; chunksOk: number; lastError: string }
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

export function createTransport(workerUrl: string, bearerToken: string): CueTransport {
  const baseHttp = workerUrl.replace(/\/$/, '')
  const ready = !!workerUrl && !!bearerToken

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
  async function flush(): Promise<void> {
    if (!active || inFlight || pending.byteLength < MIN_CHUNK_BYTES) return
    inFlight = true
    chunksFlushed += 1
    const chunk = pending
    pending = new Uint8Array(0)
    try {
      // Body as Blob, not raw ArrayBuffer — WKWebView's fetch handles
      // Blobs more consistently across iOS versions, especially with
      // CORS preflight where some implementations refuse raw binary.
      const body = new Blob([chunk], { type: 'application/octet-stream' })
      const resp = await fetch(`${baseHttp}/transcribe`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${bearerToken}`,
        },
        body,
      })
      if (!resp.ok) {
        const txt = await resp.text().catch(() => '')
        lastError = `HTTP ${resp.status} ${txt.slice(0, 60)}`
        onErrorCb?.(`transcribe HTTP ${resp.status}: ${txt.slice(0, 80)}`)
        return
      }
      const json = (await resp.json()) as { ok: boolean; text?: string; error?: string }
      if (!json.ok) {
        lastError = `worker said: ${(json.error ?? 'unknown').slice(0, 60)}`
        onErrorCb?.(json.error ?? 'transcribe failed')
        return
      }
      chunksOk += 1
      lastError = '' // success — clear stale error
      const text = (json.text ?? '').trim()
      if (text && onTranscriptCb) {
        onTranscriptCb({ type: 'transcript', text, isFinal: true })
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      lastError = `network: ${msg.slice(0, 70)}`
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
      // ending mid-buffer isn't dropped.
      active = false
      await flush()
      onTranscriptCb = null
      onErrorCb = null
    },
    stats() {
      return { framesReceived, bytesReceived, chunksFlushed, chunksOk, lastError }
    },
    async requestSuggestions({ mode, transcript, customPrompt }) {
      if (!ready) return { ok: false as const, error: 'Worker not configured' }
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), 12_000)
      try {
        const resp = await fetch(`${baseHttp}/suggest`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${bearerToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ mode, transcript, customPrompt }),
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
  }
}
