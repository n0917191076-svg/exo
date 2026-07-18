// Unit tests for the transport layer's HTTP path. We mock fetch globally so
// these tests don't make real network calls — the goal is to verify the
// request shape and response handling, not to exercise a real Worker.
//
// The WebSocket path can't be tested cleanly here without a full WS mock
// (and in practice the audio pipeline only has value when run end-to-end
// against real glasses + a real deployed Worker — covered manually).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTransport } from '../src/transport'

const ORIGINAL_FETCH = globalThis.fetch

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH
  vi.restoreAllMocks()
})

describe('createTransport', () => {
  it('reports not-ready when URL or token missing', () => {
    expect(createTransport('', '').ready).toBe(false)
    expect(createTransport('https://x.workers.dev', '').ready).toBe(false)
    expect(createTransport('', 'bearer').ready).toBe(false)
  })

  it('reports ready when both are set', () => {
    expect(createTransport('https://x.workers.dev', 'bearer').ready).toBe(true)
  })

  it('requestSuggestions returns error when not ready', async () => {
    const t = createTransport('', '')
    const r = await t.requestSuggestions({ mode: 'date', transcript: 'hi' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/not configured/)
  })

  it('requestSuggestions sends POST with bearer + JSON body', async () => {
    const fetchSpy = vi.fn(async (_url: string, init?: RequestInit) => {
      // Capture for assertions and return a canned ok response.
      return new Response(
        JSON.stringify({ ok: true, suggestions: ['First', 'Second', 'Third'] }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )
    })
    globalThis.fetch = fetchSpy as unknown as typeof fetch
    const t = createTransport('https://cue.example.workers.dev', 'secret')
    const r = await t.requestSuggestions({
      mode: 'date',
      transcript: 'How was your day?',
    })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.suggestions).toEqual(['First\nSecond\nThird'])
    expect(fetchSpy).toHaveBeenCalledOnce()
    const [url, init] = fetchSpy.mock.calls[0]!
    expect(url).toBe('https://cue.example.workers.dev/suggest?stream=0')
    expect(init?.method).toBe('POST')
    const headers = init?.headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer secret')
    expect(headers['Content-Type']).toBe('application/json')
    const body = JSON.parse(init?.body as string)
    expect(body).toEqual({ mode: 'date', transcript: 'How was your day?', customPrompt: undefined })
  })

  it('requestSuggestions surfaces non-ok HTTP as error result', async () => {
    globalThis.fetch = vi.fn(async () => new Response('rate limited', { status: 429 })) as unknown as typeof fetch
    const t = createTransport('https://cue.example.workers.dev', 'secret')
    const r = await t.requestSuggestions({ mode: 'date', transcript: 'hi' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/429/)
  })

  // 不可靜默失敗：Worker 對上游 4xx/5xx 回 JSON {ok:false,error:"openai 429: ...
  // insufficient_quota..."}；plugin 必須保留上游訊息，不能只回 "Worker HTTP 400"。
  it('requestSuggestions 保留 Worker body 的上游錯誤訊息（含 insufficient_quota）', async () => {
    globalThis.fetch = vi.fn(async () => new Response(
      JSON.stringify({ ok: false, error: 'openai 429: insufficient_quota — You exceeded your current quota' }),
      { status: 429, headers: { 'Content-Type': 'application/json' } },
    )) as unknown as typeof fetch
    const t = createTransport('https://cue.example.workers.dev', 'secret')
    const r = await t.requestSuggestions({ mode: 'work', transcript: 'hi' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/insufficient_quota/)
  })

  it('requestSuggestionsStream 保留 Worker body 的上游錯誤訊息', async () => {
    globalThis.fetch = vi.fn(async () => new Response(
      JSON.stringify({ ok: false, error: 'openai 400: insufficient_quota' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } },
    )) as unknown as typeof fetch
    const t = createTransport('https://cue.example.workers.dev', 'secret')
    const r = await t.requestSuggestionsStream({ mode: 'work', transcript: 'hi' }, { onDelta: () => {} })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/insufficient_quota/)
  })

  it('requestSuggestions surfaces network failure as error result', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new TypeError('Failed to fetch')
    }) as unknown as typeof fetch
    const t = createTransport('https://cue.example.workers.dev', 'secret')
    const r = await t.requestSuggestions({ mode: 'date', transcript: 'hi' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/Failed to fetch/)
  })

  // ─── v0.4.0: utterances field on /transcribe response ─────────────
  it('parses utterances field into TranscriptEvent.utterances', async () => {
    const fetchSpy = vi.fn(async (url: string) => {
      // Probe response (healthz) gets a generic ok
      if (typeof url === 'string' && url.includes('/healthz')) {
        return new Response('ok', { status: 200 })
      }
      // /transcribe response shape from the v0.4.0 worker
      return new Response(
        JSON.stringify({
          ok: true,
          text: 'hello there how are you',
          utterances: [
            { speaker: 0, text: 'hello there', confidence: 0.95 },
            { speaker: 1, text: 'how are you', confidence: 0.91 },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )
    })
    globalThis.fetch = fetchSpy as unknown as typeof fetch

    const t = createTransport('https://cue.example.workers.dev', 'secret')
    let captured: { text: string; isFinal: boolean; utterances: Array<{ speaker: number; text: string; confidence: number }> } | null = null
    await t.startMicSession(
      e => { captured = { text: e.text, isFinal: e.isFinal, utterances: e.utterances } },
      () => {},
    )
    // Send enough audio bytes to trip MIN_CHUNK_BYTES (~16KB) so endMicSession's
    // tail-flush fires.
    t.sendAudioFrame(new Uint8Array(20_000))
    await t.endMicSession()
    expect(captured).not.toBeNull()
    expect(captured!.utterances).toHaveLength(2)
    expect(captured!.utterances[0]).toMatchObject({ speaker: 0, text: 'hello there', confidence: 0.95 })
    expect(captured!.utterances[1]).toMatchObject({ speaker: 1, text: 'how are you', confidence: 0.91 })
    expect(captured!.text).toBe('hello there how are you')
  })

  it('handles missing utterances field (back-compat with older worker)', async () => {
    const fetchSpy = vi.fn(async (url: string) => {
      if (typeof url === 'string' && url.includes('/healthz')) {
        return new Response('ok', { status: 200 })
      }
      // Old worker: no utterances field
      return new Response(
        JSON.stringify({ ok: true, text: 'just text, no speakers' }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )
    })
    globalThis.fetch = fetchSpy as unknown as typeof fetch

    const t = createTransport('https://cue.example.workers.dev', 'secret')
    let captured: { text: string; utterances: unknown[] } | null = null
    await t.startMicSession(e => { captured = { text: e.text, utterances: e.utterances } }, () => {})
    t.sendAudioFrame(new Uint8Array(20_000))
    await t.endMicSession()
    expect(captured).not.toBeNull()
    expect(captured!.text).toBe('just text, no speakers')
    expect(captured!.utterances).toEqual([]) // empty array, not undefined
  })

  it('drops empty-text utterances from the array', async () => {
    const fetchSpy = vi.fn(async (url: string) => {
      if (typeof url === 'string' && url.includes('/healthz')) {
        return new Response('ok', { status: 200 })
      }
      return new Response(
        JSON.stringify({
          ok: true,
          text: 'hi',
          utterances: [
            { speaker: 0, text: 'hi', confidence: 0.9 },
            { speaker: 0, text: '', confidence: 0.0 },        // dropped
            { speaker: 1, text: '   ', confidence: 0.1 },     // dropped (whitespace)
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )
    })
    globalThis.fetch = fetchSpy as unknown as typeof fetch
    const t = createTransport('https://cue.example.workers.dev', 'secret')
    let captured: { utterances: unknown[] } | null = null
    await t.startMicSession(e => { captured = { utterances: e.utterances } }, () => {})
    t.sendAudioFrame(new Uint8Array(20_000))
    await t.endMicSession()
    expect(captured!.utterances).toHaveLength(1)
  })

  it('passes customPrompt when provided', async () => {
    const fetchSpy = vi.fn(async () => new Response(
      JSON.stringify({ ok: true, suggestions: ['x'] }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ))
    globalThis.fetch = fetchSpy as unknown as typeof fetch
    const t = createTransport('https://cue.example.workers.dev', 'secret')
    await t.requestSuggestions({
      mode: 'custom',
      transcript: 'foo',
      customPrompt: 'You are a butler...',
    })
    const body = JSON.parse(fetchSpy.mock.calls[0]![1]!.body as string)
    expect(body.customPrompt).toBe('You are a butler...')
  })

  // ─── Phase 1: lang 進 /transcribe query、新設定進 /suggest body ────
  it('flush 的 /transcribe URL 帶 ?lang=', async () => {
    const urls: string[] = []
    globalThis.fetch = vi.fn(async (url: string) => {
      urls.push(String(url))
      if (String(url).includes('/healthz')) return new Response('ok', { status: 200 })
      return new Response(JSON.stringify({ ok: true, text: '' }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      })
    }) as unknown as typeof fetch
    const t = createTransport('https://cue.example.workers.dev', 'secret', { lang: 'en' })
    await t.startMicSession(() => {}, () => {})
    t.sendAudioFrame(new Uint8Array(20_000))
    await t.endMicSession()
    const transcribeUrl = urls.find(u => u.includes('/transcribe'))
    expect(transcribeUrl).toBe('https://cue.example.workers.dev/transcribe?lang=en&gated=1')
  })

  it('未指定 lang 時 /transcribe 預設 zh', async () => {
    const urls: string[] = []
    globalThis.fetch = vi.fn(async (url: string) => {
      urls.push(String(url))
      if (String(url).includes('/healthz')) return new Response('ok', { status: 200 })
      return new Response(JSON.stringify({ ok: true, text: '' }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      })
    }) as unknown as typeof fetch
    const t = createTransport('https://cue.example.workers.dev', 'secret')
    await t.startMicSession(() => {}, () => {})
    t.sendAudioFrame(new Uint8Array(20_000))
    await t.endMicSession()
    expect(urls.find(u => u.includes('/transcribe'))).toContain('?lang=zh')
  })

  it('requestSuggestions 帶 sceneNote/model/length/lang 進 body', async () => {
    const fetchSpy = vi.fn(async () => new Response(
      JSON.stringify({ ok: true, suggestions: ['一', '二'] }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ))
    globalThis.fetch = fetchSpy as unknown as typeof fetch
    const t = createTransport('https://cue.example.workers.dev', 'secret')
    await t.requestSuggestions({
      mode: 'work',
      transcript: '請自我介紹',
      sceneNote: '面試：主管面',
      model: 'claude-haiku-4-5',
      length: 'short',
      lang: 'zh',
    })
    const body = JSON.parse(fetchSpy.mock.calls[0]![1]!.body as string)
    expect(body.sceneNote).toBe('面試：主管面')
    expect(body.model).toBe('claude-haiku-4-5')
    expect(body.length).toBe('short')
    expect(body.lang).toBe('zh')
  })

  // ─── Phase 2: KB 欄位進 /suggest body ────────────────────────────
  it('requestSuggestions 帶 kbPersonal/kbExtra 進 body；未帶時欄位不存在', async () => {
    const fetchSpy = vi.fn(async () => new Response(
      JSON.stringify({ ok: true, suggestions: ['一'] }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ))
    globalThis.fetch = fetchSpy as unknown as typeof fetch
    const t = createTransport('https://cue.example.workers.dev', 'secret')
    await t.requestSuggestions({
      mode: 'work',
      transcript: '你有什麼優勢？',
      kbPersonal: '八年產線督導；AI 投資競賽第一名',
      kbExtra: '目標職缺：風控分析',
    })
    const body1 = JSON.parse(fetchSpy.mock.calls[0]![1]!.body as string)
    expect(body1.kbPersonal).toBe('八年產線督導；AI 投資競賽第一名')
    expect(body1.kbExtra).toBe('目標職缺：風控分析')

    await t.requestSuggestions({ mode: 'custom', transcript: 'hi' })
    const body2 = JSON.parse(fetchSpy.mock.calls[1]![1]!.body as string)
    expect('kbPersonal' in body2).toBe(false)
    expect('kbExtra' in body2).toBe(false)
  })

  // ─── Phase 3: requestSuggestionsStream ────────────────────────────
  function streamResponse(chunks: string[], contentType = 'text/plain; charset=utf-8'): Response {
    const encoder = new TextEncoder()
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const c of chunks) controller.enqueue(encoder.encode(c))
        controller.close()
      },
    })
    return new Response(body, { status: 200, headers: { 'Content-Type': contentType } })
  }

  it('串流回應：onDelta 遞增累積、結束保留單一完整答案、streamed=true', async () => {
    const fetchSpy = vi.fn(async () => streamResponse([
      '我認為這個轉變是從 READ ONLY ',
      '走向 TAKE ACTION，核心是模型與工具整合。',
    ]))
    globalThis.fetch = fetchSpy as unknown as typeof fetch
    const t = createTransport('https://cue.example.workers.dev', 'secret')
    const deltas: string[] = []
    const r = await t.requestSuggestionsStream(
      { mode: 'work', transcript: '你怎麼看 AI Agent？' },
      { onDelta: acc => deltas.push(acc) },
    )
    expect(deltas.at(-1)).toBe('我認為這個轉變是從 READ ONLY 走向 TAKE ACTION，核心是模型與工具整合。')
    expect(r).toEqual({
      ok: true,
      streamed: true,
      suggestions: ['我認為這個轉變是從 READ ONLY 走向 TAKE ACTION，核心是模型與工具整合。'],
    })
  })

  it('回應是 application/json（舊 Worker）→ 不呼叫 onDelta，走舊格式', async () => {
    globalThis.fetch = vi.fn(async () => new Response(
      JSON.stringify({ ok: true, suggestions: ['甲', '乙'] }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )) as unknown as typeof fetch
    const t = createTransport('https://cue.example.workers.dev', 'secret')
    const deltas: string[] = []
    const r = await t.requestSuggestionsStream(
      { mode: 'work', transcript: 'hi' },
      { onDelta: acc => deltas.push(acc) },
    )
    expect(deltas).toEqual([])
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.streamed).toBe(false)
      expect(r.suggestions).toEqual(['甲\n乙'])
    }
  })

  it('空白串流回應 → ok:false', async () => {
    globalThis.fetch = vi.fn(async () => streamResponse([' ', '\n'])) as unknown as typeof fetch
    const t = createTransport('https://cue.example.workers.dev', 'secret')
    const r = await t.requestSuggestionsStream(
      { mode: 'work', transcript: 'hi' },
      { onDelta: () => {} },
    )
    expect(r).toEqual({ ok: false, error: 'empty suggestion response' })
  })

  it('串流網路錯誤 → ok:false', async () => {
    globalThis.fetch = vi.fn(async () => { throw new TypeError('Failed to fetch') }) as unknown as typeof fetch
    const t = createTransport('https://cue.example.workers.dev', 'secret')
    const r = await t.requestSuggestionsStream({ mode: 'work', transcript: 'hi' }, { onDelta: () => {} })
    expect(r.ok).toBe(false)
  })

  it('未設定 Worker → ok:false', async () => {
    const t = createTransport('', '')
    const r = await t.requestSuggestionsStream({ mode: 'work', transcript: 'hi' }, { onDelta: () => {} })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/not configured/)
  })

  // ─── Phase 4: gated 參數與 extendContext ──────────────────────────
  it('/transcribe URL 帶 gated 參數（預設 1）', async () => {
    const urls: string[] = []
    globalThis.fetch = vi.fn(async (url: string) => {
      urls.push(String(url))
      if (String(url).includes('/healthz')) return new Response('ok', { status: 200 })
      return new Response(JSON.stringify({ ok: true, text: '' }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      })
    }) as unknown as typeof fetch
    const t = createTransport('https://cue.example.workers.dev', 'secret', { lang: 'zh' })
    await t.startMicSession(() => {}, () => {})
    t.sendAudioFrame(new Uint8Array(20_000))
    await t.endMicSession()
    expect(urls.find(u => u.includes('/transcribe'))).toBe(
      'https://cue.example.workers.dev/transcribe?lang=zh&gated=1',
    )
  })

  it('gated: false 時 /transcribe 帶 gated=0（Cue 原 diarize 流程）', async () => {
    const urls: string[] = []
    globalThis.fetch = vi.fn(async (url: string) => {
      urls.push(String(url))
      if (String(url).includes('/healthz')) return new Response('ok', { status: 200 })
      return new Response(JSON.stringify({ ok: true, text: '' }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      })
    }) as unknown as typeof fetch
    const t = createTransport('https://cue.example.workers.dev', 'secret', { lang: 'zh', gated: false })
    await t.startMicSession(() => {}, () => {})
    t.sendAudioFrame(new Uint8Array(20_000))
    await t.endMicSession()
    expect(urls.find(u => u.includes('/transcribe'))).toContain('gated=0')
  })

  // ─── 極短語音修正：force-flush 送出、尾端補靜音、繞過 MIN_CHUNK ───
  // BYTES_PER_SECOND = 16000×2 = 32000；MIN_CHUNK = 0.5s = 16000；
  // PADDING_TARGET = 1.5s = 48000。
  const BYTES_PER_SECOND = 32_000
  const PADDING_TARGET_BYTES = BYTES_PER_SECOND * 1.5 // 48000

  async function captureTranscribeBody(
    frameBytes: number,
    fill: number,
  ): Promise<{ transcribeCalls: number; body: Uint8Array | null }> {
    let transcribeCalls = 0
    let body: Uint8Array | null = null
    globalThis.fetch = vi.fn(async (url: string, init?: RequestInit) => {
      const u = String(url)
      if (u.includes('/healthz')) return new Response('ok', { status: 200 })
      if (u.includes('/transcribe')) {
        transcribeCalls += 1
        const b = init?.body as Blob
        body = new Uint8Array(await b.arrayBuffer())
        return new Response(JSON.stringify({ ok: true, text: '你好嗎' }), {
          status: 200, headers: { 'Content-Type': 'application/json' },
        })
      }
      return new Response('not found', { status: 404 })
    }) as unknown as typeof fetch
    const t = createTransport('https://cue.example.workers.dev', 'secret')
    await t.startMicSession(() => {}, () => {})
    const frame = new Uint8Array(frameBytes)
    frame.fill(fill)
    t.sendAudioFrame(frame)
    await t.endMicSession()
    return { transcribeCalls, body }
  }

  it('尾端 250ms buffer + endMicSession() 必送出一次 /transcribe（force 繞過 MIN_CHUNK）', async () => {
    // 250ms = 8000 bytes，遠低於 MIN_CHUNK(16000) — 舊行為會整段丟棄
    const { transcribeCalls, body } = await captureTranscribeBody(8_000, 0xab)
    expect(transcribeCalls).toBe(1)
    expect(body).not.toBeNull()
  })

  it('480ms 輸入 → body 被補靜音到 ≥1.5s 門檻，且原音在前段完整', async () => {
    const frameBytes = 15_360 // 480ms
    const { transcribeCalls, body } = await captureTranscribeBody(frameBytes, 0xab)
    expect(transcribeCalls).toBe(1)
    expect(body!.byteLength).toBeGreaterThanOrEqual(PADDING_TARGET_BYTES)
    // 原音（0xAB）完整保留在前段
    for (let i = 0; i < frameBytes; i++) expect(body![i]).toBe(0xab)
    // 尾端補的是靜音 0x00
    expect(body![frameBytes]).toBe(0x00)
    expect(body![body!.byteLength - 1]).toBe(0x00)
  })

  it('單塊 800ms 不被 MIN_CHUNK 擋掉，且同樣補到 target', async () => {
    const { transcribeCalls, body } = await captureTranscribeBody(25_600, 0xcd) // 800ms
    expect(transcribeCalls).toBe(1)
    expect(body!.byteLength).toBeGreaterThanOrEqual(PADDING_TARGET_BYTES)
  })

  // ─── gate-stop 排空：前一塊仍在飛時，endMicSession 必等它完成 ───────
  // 重現「第一次講 3 秒 → 沒聽清楚，第二次才 3秒+1秒合併」的根因：
  // 2.5s 塊 flush 還 inFlight 時 gate-stop，舊碼 flush(true) 被 inFlight 擋掉、
  // producedText 讀到 false、在飛塊晚回時 onTranscriptCb 已 null → 文字丟失。
  it('前一塊在飛時 gate-stop：endMicSession 等它完成，producedText=true、文字不漏、尾端也送', async () => {
    let releaseFirst: (() => void) | null = null
    const firstGate = new Promise<void>(r => { releaseFirst = r })
    let transcribeCalls = 0
    globalThis.fetch = vi.fn(async (url: string) => {
      const u = String(url)
      if (u.includes('/healthz')) return new Response('ok', { status: 200 })
      if (u.includes('/transcribe')) {
        transcribeCalls += 1
        if (transcribeCalls === 1) {
          await firstGate // 第一塊卡住（模擬 Deepgram 尚未回）
          return new Response(JSON.stringify({ ok: true, text: '第一塊三秒內容' }), {
            status: 200, headers: { 'Content-Type': 'application/json' },
          })
        }
        return new Response(JSON.stringify({ ok: true, text: '尾端零點五秒' }), {
          status: 200, headers: { 'Content-Type': 'application/json' },
        })
      }
      return new Response('nf', { status: 404 })
    }) as unknown as typeof fetch

    const t = createTransport('https://cue.example.workers.dev', 'secret')
    const texts: string[] = []
    await t.startMicSession(e => texts.push(e.text), () => {})
    t.sendAudioFrame(new Uint8Array(80_000)) // 達 CHUNK_BYTES → 觸發第一塊 flush（inFlight）
    t.sendAudioFrame(new Uint8Array(16_000)) // 尾端 pending（未達門檻，不自動送）
    await new Promise(r => setTimeout(r, 10)) // 讓第一塊 flush 進入 inFlight（卡 firstGate）

    const endP = t.endMicSession()            // gate-stop：必須等第一塊 + 送尾端
    releaseFirst!()                            // 放行第一塊
    const r = await endP

    expect(r.producedText).toBe(true)          // 等到轉寫結果，非 false
    expect(texts).toContain('第一塊三秒內容')   // 在飛塊文字沒被 onTranscriptCb=null 丟棄
    expect(texts).toContain('尾端零點五秒')      // 尾端也送出（不卡 buffer）
    expect(transcribeCalls).toBe(2)
  })

  it('requestSuggestionsStream 帶 extendContext 進 body', async () => {
    const fetchSpy = vi.fn(async () => new Response(
      JSON.stringify({ ok: true, suggestions: ['更深一層'] }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ))
    globalThis.fetch = fetchSpy as unknown as typeof fetch
    const t = createTransport('https://cue.example.workers.dev', 'secret')
    await t.requestSuggestionsStream(
      { mode: 'work', transcript: '請自我介紹', extendContext: '1. 我有八年產線經驗。' },
      { onDelta: () => {} },
    )
    const body = JSON.parse(fetchSpy.mock.calls[0]![1]!.body as string)
    expect(body.extendContext).toBe('1. 我有八年產線經驗。')
  })
})
