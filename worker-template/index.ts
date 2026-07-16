import { buildSuggestPrompt, singleAnswerFromText } from './suggestion-policy'

// Cue personal Cloudflare Worker — proxies the glasses-to-Deepgram audio
// stream + caches the rolling transcript so the LLM call can use it as
// context. Each Cue user deploys their own Worker with their own
// Deepgram + Anthropic / OpenAI keys; the plugin never sees the keys.
//
// Endpoints:
//   GET /ws?token=<bearer>      — WebSocket. Plugin sends raw 16kHz mono
//                                 16-bit PCM frames; we proxy to Deepgram
//                                 and stream interim+final transcripts back
//                                 as JSON text frames {"type":"transcript",
//                                 "text": "...", "isFinal": bool}.
//
//   POST /suggest               — body { mode, transcript, customPrompt? }
//                                 Auth: Authorization: Bearer <SHARED_SECRET>
//                                 Returns { ok, suggestions: string[] }.
//
//   GET /healthz                — sanity check
//
// All cookies/keys live in Worker secrets, set via:
//   wrangler secret put SHARED_SECRET
//   wrangler secret put DEEPGRAM_API_KEY
//   wrangler secret put ANTHROPIC_API_KEY      (or OPENAI_API_KEY)

interface Env {
  SHARED_SECRET: string
  DEEPGRAM_API_KEY: string
  ANTHROPIC_API_KEY?: string
  OPENAI_API_KEY?: string
}

// IMPORTANT: must be https:// not wss:// — Cloudflare Workers' fetch() only
// accepts http(s) schemes for outbound WebSocket negotiation. The Upgrade
// header on the request handles the protocol switch. Using wss:// here
// produces a runtime TypeError ("Fetch API cannot load: wss://...") that
// returns HTTP 500 to the client.
const DEEPGRAM_WS = 'https://api.deepgram.com/v1/listen?model=nova-2&interim_results=true&encoding=linear16&sample_rate=16000&channels=1'
// Batch (HTTP) Deepgram endpoint used by /transcribe — no interim results
// since each call gets one chunk.
//   diarize=true        → adds speaker:N per word (so plugin can tell
//                          who is talking — wearer vs other person)
//   utterances=true     → groups words into speaker turns with start/end
//   smart_format=true   → cleaner punctuation, numbers, dates
// Phase 1（Exo）：nova-3 自 2026-03 起支援繁中（zh-TW）；diarization 為
// 語言無關。lang 由 /transcribe 的 ?lang= query 帶入（body 是 raw PCM，
// 塞不了 JSON 欄位）。若實測 nova-3 中文品質不佳，退 nova-2（同樣支援 zh-TW）。
// Phase 4：閘門模式（gated=1，預設）拿掉 diarize/utterances — 閘門收音
// 保證整段都是「對方」，語者分離是純浪費（加價項＋延遲）。gated=0 退回
// Cue 原 diarize 流程（自動收音模式用）。export 供 test-worker 驗證組裝。
const DEEPGRAM_HTTP_BASE =
  'https://api.deepgram.com/v1/listen?model=nova-3&punctuate=true&smart_format=true'

export function deepgramHttpUrl(lang: 'zh' | 'en', gated: boolean): string {
  const diarize = gated ? '' : '&diarize=true&utterances=true'
  return `${DEEPGRAM_HTTP_BASE}${diarize}&language=${lang === 'en' ? 'en' : 'zh-TW'}`
}

const SAMPLE_RATE = 16000

// WAV-wrap raw PCM16 mono so Deepgram's HTTP endpoint (which sniffs the
// container) accepts it. Same shape used by typical clients.
function wavWrap(pcm: Uint8Array): Uint8Array {
  const numChannels = 1
  const bitsPerSample = 16
  const byteRate = SAMPLE_RATE * numChannels * (bitsPerSample / 8)
  const blockAlign = numChannels * (bitsPerSample / 8)
  const dataSize = pcm.byteLength
  const buffer = new ArrayBuffer(44 + dataSize)
  const view = new DataView(buffer)
  view.setUint8(0, 0x52); view.setUint8(1, 0x49); view.setUint8(2, 0x46); view.setUint8(3, 0x46) // "RIFF"
  view.setUint32(4, 36 + dataSize, true)
  view.setUint8(8, 0x57); view.setUint8(9, 0x41); view.setUint8(10, 0x56); view.setUint8(11, 0x45) // "WAVE"
  view.setUint8(12, 0x66); view.setUint8(13, 0x6d); view.setUint8(14, 0x74); view.setUint8(15, 0x20) // "fmt "
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, numChannels, true)
  view.setUint32(24, SAMPLE_RATE, true)
  view.setUint32(28, byteRate, true)
  view.setUint16(32, blockAlign, true)
  view.setUint16(34, bitsPerSample, true)
  view.setUint8(36, 0x64); view.setUint8(37, 0x61); view.setUint8(38, 0x74); view.setUint8(39, 0x61) // "data"
  view.setUint32(40, dataSize, true)
  new Uint8Array(buffer, 44).set(pcm)
  return new Uint8Array(buffer)
}

async function handleTranscribe(request: Request, env: Env): Promise<Response> {
  // POST /transcribe — body is raw PCM16 mono 16kHz audio. Bearer-gated.
  // Wraps as WAV and sends to Deepgram's HTTP /v1/listen endpoint, which
  // returns a single transcript for the chunk. This bypasses WebSockets
  // entirely so the plugin's WebView (which can't open outbound WS) can
  // still get real STT via fetch() — same network permission as /suggest.
  if (request.method !== 'POST') {
    // Echo what we ACTUALLY received in the body so the plugin's debug
    // log shows whether something is downgrading POST→GET in transit
    // (Cloudflare WAF, redirect, WebView quirk, etc.). Plain text body
    // so it's readable when curl-tested.
    const cf = (request as unknown as { cf?: Record<string, unknown> }).cf
    const headerKeys: string[] = []
    request.headers.forEach((_v, k) => headerKeys.push(k))
    return new Response(
      `POST only. Received: method=${request.method}, url=${request.url}, ` +
      `headers=[${headerKeys.join(',')}], cf-ray=${request.headers.get('cf-ray') ?? 'none'}, ` +
      `cf-country=${(cf as { country?: string } | undefined)?.country ?? 'none'}`,
      { status: 405, headers: { 'Content-Type': 'text/plain', ...corsHeaders() } },
    )
  }
  const auth = request.headers.get('Authorization') ?? ''
  if (!env.SHARED_SECRET || auth !== `Bearer ${env.SHARED_SECRET}`) {
    return jsonResponse(401, { ok: false, error: 'unauthorized' })
  }
  if (!env.DEEPGRAM_API_KEY) {
    return jsonResponse(500, { ok: false, error: 'DEEPGRAM_API_KEY not configured' })
  }
  const pcm = new Uint8Array(await request.arrayBuffer())
  if (pcm.byteLength < 1600) {
    // < ~50ms of audio at 16k. Don't burn quota on near-empty chunks.
    return jsonResponse(200, { ok: true, text: '' })
  }
  const params = new URL(request.url).searchParams
  const lang = params.get('lang') === 'en' ? ('en' as const) : ('zh' as const)
  const gated = params.get('gated') !== '0' // 預設閘門開
  const wav = wavWrap(pcm)
  const dgRes = await fetch(deepgramHttpUrl(lang, gated), {
    method: 'POST',
    headers: {
      Authorization: `Token ${env.DEEPGRAM_API_KEY}`,
      'Content-Type': 'audio/wav',
    },
    body: wav,
  })
  if (!dgRes.ok) {
    const errText = await dgRes.text()
    return jsonResponse(dgRes.status, { ok: false, error: `deepgram ${dgRes.status}: ${errText.slice(0, 200)}` })
  }
  const json = (await dgRes.json()) as {
    results?: {
      channels?: Array<{ alternatives?: Array<{ transcript?: string; words?: Array<{ word?: string; speaker?: number; confidence?: number }> }> }>
      utterances?: Array<{ start?: number; end?: number; speaker?: number; transcript?: string; confidence?: number }>
    }
  }
  const text = (json.results?.channels?.[0]?.alternatives?.[0]?.transcript ?? '').trim()
  // Per-speaker utterances. Each is a turn — same speaker until they
  // stop. Plugin uses these to show speaker labels and to exclude the
  // wearer's own speech from the suggestion-prompt context.
  const utterances = (json.results?.utterances ?? [])
    .map(u => ({
      speaker: typeof u.speaker === 'number' ? u.speaker : 0,
      text: (u.transcript ?? '').trim(),
      confidence: typeof u.confidence === 'number' ? u.confidence : 0,
    }))
    .filter(u => u.text.length > 0)
  return jsonResponse(200, { ok: true, text, utterances })
}

function corsHeaders(): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
  }
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders() },
  })
}

async function handleSuggest(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'POST') return jsonResponse(405, { ok: false, error: 'POST only' })
  const auth = request.headers.get('Authorization') ?? ''
  if (!env.SHARED_SECRET || auth !== `Bearer ${env.SHARED_SECRET}`) {
    return jsonResponse(401, { ok: false, error: 'unauthorized' })
  }
  let body: {
    mode?: string
    transcript?: string
    customPrompt?: string
    recentSuggestions?: string[]
    sceneNote?: string
    model?: string
    length?: string
    lang?: string
    kbPersonal?: string
    kbExtra?: string
    extendContext?: string
  }
  try {
    body = (await request.json()) as typeof body
  } catch {
    return jsonResponse(400, { ok: false, error: 'invalid JSON body' })
  }
  if (!body.transcript || typeof body.transcript !== 'string') {
    return jsonResponse(400, { ok: false, error: 'transcript required' })
  }
  const { systemPrompt, lang } = buildSuggestPrompt({
    mode: body.mode,
    customPrompt: body.customPrompt,
    recentSuggestions: body.recentSuggestions,
    sceneNote: body.sceneNote,
    length: body.length,
    lang: body.lang,
    kbPersonal: body.kbPersonal,
    kbExtra: body.kbExtra,
    extendContext: body.extendContext,
  })

  // 只轉發允許清單內的模型 — plugin 傳什麼不可信（bearer 洩漏時的保險）。
  const model = ALLOWED_MODELS.includes(body.model ?? '') ? body.model! : DEFAULT_MODEL

  // Phase 3：預設串流（純文字 chunked），?stream=0 走舊 JSON 路徑。
  // OpenAI 路徑只有非串流 — plugin 以回應 Content-Type 自動判別。
  const wantStream = new URL(request.url).searchParams.get('stream') !== '0'

  // 使用者選了 ChatGPT 模型 → 走 OpenAI（需 OPENAI_API_KEY）。
  if (isOpenAIModel(model)) {
    if (!env.OPENAI_API_KEY) {
      return jsonResponse(500, { ok: false, error: 'OPENAI_API_KEY 未設定：wrangler secret put OPENAI_API_KEY' })
    }
    return await callOpenAI(env.OPENAI_API_KEY, systemPrompt, body.transcript, model)
  }
  // Claude 模型 → Anthropic-first；只設了 OpenAI key 時退回 OpenAI 預設模型。
  if (env.ANTHROPIC_API_KEY) {
    if (wantStream) {
      return await callAnthropicStream(env.ANTHROPIC_API_KEY, systemPrompt, body.transcript, model, lang)
    }
    return await callAnthropic(env.ANTHROPIC_API_KEY, systemPrompt, body.transcript, model, lang)
  }
  if (env.OPENAI_API_KEY) {
    return await callOpenAI(env.OPENAI_API_KEY, systemPrompt, body.transcript, 'gpt-4o-mini')
  }
  return jsonResponse(500, { ok: false, error: 'no LLM API key configured (set ANTHROPIC_API_KEY or OPENAI_API_KEY)' })
}

const ALLOWED_MODELS = ['claude-haiku-4-5', 'claude-sonnet-4-6', 'gpt-4o', 'gpt-4o-mini']
const DEFAULT_MODEL = 'claude-sonnet-4-6'

// 依 model 名稱前綴決定服務商路由。export 供測試。
export function isOpenAIModel(model: string): boolean {
  return model.startsWith('gpt-') || model.startsWith('o1') || model.startsWith('o3')
}

async function callAnthropic(
  apiKey: string,
  systemPrompt: string,
  transcript: string,
  model: string,
  lang: 'zh' | 'en',
): Promise<Response> {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      max_tokens: 1024,
      system: systemPrompt,
      messages: [
        {
          role: 'user',
          content: lang === 'en'
            ? `Recent conversation transcript (the other person's voice):\n\n"${transcript}"\n\nSuggestions:`
            : `最近的對話逐字稿（對方說的話）：\n\n「${transcript}」\n\n建議：`,
        },
      ],
    }),
  })
  if (!res.ok) {
    const text = await res.text()
    return jsonResponse(res.status, { ok: false, error: `anthropic ${res.status}: ${text.slice(0, 200)}` })
  }
  const json = (await res.json()) as { content?: Array<{ text?: string }> }
  const text = json.content?.[0]?.text ?? ''
  const suggestions = singleAnswerFromText(text)
  return suggestions.length > 0
    ? jsonResponse(200, { ok: true, suggestions })
    : jsonResponse(502, { ok: false, error: 'anthropic returned empty text' })
}

async function callOpenAI(
  apiKey: string,
  systemPrompt: string,
  transcript: string,
  model: string,
): Promise<Response> {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      max_tokens: 1024,
      messages: [
        { role: 'system', content: systemPrompt },
        {
          role: 'user',
          content: `Recent conversation transcript:\n\n"${transcript}"\n\nSuggestions:`,
        },
      ],
    }),
  })
  if (!res.ok) {
    const text = await res.text()
    return jsonResponse(res.status, { ok: false, error: `openai ${res.status}: ${text.slice(0, 200)}` })
  }
  const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> }
  const text = json.choices?.[0]?.message?.content ?? ''
  const suggestions = singleAnswerFromText(text)
  return suggestions.length > 0
    ? jsonResponse(200, { ok: true, suggestions })
    : jsonResponse(502, { ok: false, error: 'openai returned empty text' })
}

// Phase 3：串流版 — 向 Anthropic 開 stream:true，把 SSE 的 text_delta
// 增量以純文字 chunked response 直接轉發。plugin 端累積後保留為
// 單一完整答案。Anthropic 非 200 時尚未開流，安全回 JSON 錯誤。
async function callAnthropicStream(
  apiKey: string,
  systemPrompt: string,
  transcript: string,
  model: string,
  lang: 'zh' | 'en',
): Promise<Response> {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      max_tokens: 1024,
      stream: true,
      system: systemPrompt,
      messages: [
        {
          role: 'user',
          content: lang === 'en'
            ? `Recent conversation transcript (the other person's voice):\n\n"${transcript}"\n\nSuggestions:`
            : `最近的對話逐字稿（對方說的話）：\n\n「${transcript}」\n\n建議：`,
        },
      ],
    }),
  })
  if (!res.ok || !res.body) {
    const text = await res.text()
    return jsonResponse(res.status || 502, { ok: false, error: `anthropic ${res.status}: ${text.slice(0, 200)}` })
  }

  const { readable, writable } = new TransformStream()
  const writer = writable.getWriter()
  const encoder = new TextEncoder()
  const decoder = new TextDecoder()

  // 背景消化 SSE：`data: {...}` 行 → content_block_delta.text_delta 寫進流。
  // 不 await — 先把 readable 交回給 client，首字才能最快上屏。
  void (async () => {
    const reader = res.body!.getReader()
    let buf = ''
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        const lines = buf.split('\n')
        buf = lines.pop() ?? '' // 最後一行可能不完整，留到下一輪
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue
          try {
            const evt = JSON.parse(line.slice(6)) as {
              type?: string
              delta?: { type?: string; text?: string }
            }
            if (evt.type === 'content_block_delta' && evt.delta?.type === 'text_delta' && evt.delta.text) {
              await writer.write(encoder.encode(evt.delta.text))
            }
          } catch {
            /* 非 JSON 的 data 行（如 [DONE]）— 忽略 */
          }
        }
      }
    } catch {
      /* 上游中斷 — 關流讓 client 拿到目前為止的內容 */
    } finally {
      try { await writer.close() } catch { /* already closed */ }
    }
  })()

  return new Response(readable, {
    headers: { 'Content-Type': 'text/plain; charset=utf-8', ...corsHeaders() },
  })
}

async function handleWebSocket(request: Request, env: Env): Promise<Response> {
  // Auth via query token (WebSocket doesn't support custom headers from
  // browser clients reliably, so we accept the bearer in ?token=).
  const url = new URL(request.url)
  const token = url.searchParams.get('token')
  if (!env.SHARED_SECRET || token !== env.SHARED_SECRET) {
    return jsonResponse(401, { ok: false, error: 'unauthorized' })
  }

  const upgrade = request.headers.get('Upgrade') ?? ''
  if (upgrade.toLowerCase() !== 'websocket') {
    return jsonResponse(400, { ok: false, error: 'expected WebSocket upgrade' })
  }

  // Open a WebSocket to Deepgram and pipe frames in both directions.
  // Workers' fetch() supports outbound WS; WebSocketPair gives us the
  // pair to hand back to the client.
  const dgRes = await fetch(DEEPGRAM_WS, {
    headers: {
      Authorization: `Token ${env.DEEPGRAM_API_KEY}`,
      Upgrade: 'websocket',
    },
  })
  const dgWs = (dgRes as unknown as { webSocket: WebSocket }).webSocket
  if (!dgWs) return jsonResponse(502, { ok: false, error: 'failed to open Deepgram WS' })
  dgWs.accept()

  const pair = new WebSocketPair()
  const [client, server] = Object.values(pair) as [WebSocket, WebSocket]
  server.accept()

  // Pipe: glasses audio → Deepgram
  server.addEventListener('message', evt => {
    if (typeof evt.data === 'string') return // ignore text frames from client
    try {
      dgWs.send(evt.data)
    } catch {
      /* ignore */
    }
  })
  server.addEventListener('close', () => {
    try { dgWs.close() } catch { /* ignore */ }
  })

  // Pipe: Deepgram transcripts → glasses (as JSON text frames)
  dgWs.addEventListener('message', evt => {
    try {
      const data = typeof evt.data === 'string' ? evt.data : new TextDecoder().decode(evt.data as ArrayBuffer)
      const parsed = JSON.parse(data) as {
        channel?: { alternatives?: Array<{ transcript?: string }> }
        is_final?: boolean
      }
      const text = parsed.channel?.alternatives?.[0]?.transcript ?? ''
      if (text) {
        server.send(
          JSON.stringify({ type: 'transcript', text, isFinal: !!parsed.is_final }),
        )
      }
    } catch {
      /* ignore parse errors */
    }
  })
  dgWs.addEventListener('close', () => {
    try { server.close() } catch { /* ignore */ }
  })

  return new Response(null, { status: 101, webSocket: client })
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // Log every incoming request so `wrangler tail` shows what's actually
    // arriving at the worker (vs what the plugin claims it's sending).
    // Catches the class of bug where Cloudflare WAF / WebView / a redirect
    // mangles the method en route. Cheap — Workers logging is async.
    // eslint-disable-next-line no-console
    console.log(`[req] ${request.method} ${new URL(request.url).pathname} ua=${(request.headers.get('user-agent') ?? '').slice(0, 60)}`)
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders() })
    }
    const url = new URL(request.url)
    if (url.pathname === '/healthz') return jsonResponse(200, { ok: true })
    if (url.pathname === '/suggest') return handleSuggest(request, env)
    if (url.pathname === '/transcribe') return handleTranscribe(request, env)
    if (url.pathname === '/ws') return handleWebSocket(request, env)
    return jsonResponse(404, { ok: false, error: 'not found' })
  },
}
