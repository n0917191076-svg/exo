// End-to-end audio pipeline tests. Drives synthetic PCM through a fake
// bridge into transport.sendAudioFrame, mocks the Worker /healthz +
// /transcribe + /suggest responses, and asserts that the conversation
// renders correctly on the glasses.
//
// What this covers that transport.test.ts can't:
//   - The full main.ts state machine (toggleMic → startRealSession →
//     even.startMic frame handler → transport.sendAudioFrame).
//   - Diarization rendering: utterances flow into onTranscriptFrame,
//     appendTurn into the conversation buffer, [A]/[B] labels appear.
//   - Wearer-id filter: wearer's lines stay rendered with "(you)" but
//     are excluded from the /suggest transcript field.
//   - Trailing flush on mic-off catching the partial chunk.
//   - Calibrate-me anchoring wearer to the first detected speaker.
//
// The "PCM" is plain Uint8Array — transport.ts only counts bytes for
// chunking, never decodes. Diarization comes from the mocked worker
// response shape, not from real audio.

/// <reference types="vitest/globals" />
// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { synthFrame } from '../src/vad'

interface FakeRuntime {
  render: (text: string) => Promise<void>
  onTap: (h: (src: string) => void) => void
  onSwipe: (h: (dir: string, src: string) => void) => void
  onDoubleTap: (h: (src: string) => void) => void
  onForeground: (h: () => void) => void
  startMic: (h: (frame: Uint8Array) => void) => Promise<boolean>
  stopMic: () => Promise<void>
  exitApp: () => Promise<void>
  getStorage: (k: string) => Promise<string>
  setStorage: (k: string, v: string) => Promise<boolean>
  getBatteryLevel: () => Promise<number | undefined>
}

interface FakeBridge {
  runtime: FakeRuntime
  invokeTap: (src?: string) => void
  invokeDoubleTap: (src?: string) => void
  invokeForeground: () => void
  lastRender: () => string
  micActive: () => boolean
  /** Pump one PCM frame to whatever handler main.ts registered via even.startMic. */
  pumpFrame: (frame: Uint8Array) => void
  /** Pump a sequence of N frames each `bytes` long. */
  pumpFrames: (count: number, bytes: number) => void
}

function createFakeBridge(initialBattery: number | undefined = 80): FakeBridge {
  let tapHandler: ((src: string) => void) | null = null
  let doubleTapHandler: ((src: string) => void) | null = null
  let foregroundHandler: (() => void) | null = null
  let frameHandler: ((frame: Uint8Array) => void) | null = null
  let lastRendered = ''
  let mic = false
  const battery = initialBattery
  const storage: Record<string, string> = {}

  const runtime: FakeRuntime = {
    render: async (text: string) => { lastRendered = text },
    onTap: h => { tapHandler = h },
    onSwipe: () => {},
    onDoubleTap: h => { doubleTapHandler = h },
    onForeground: h => { foregroundHandler = h },
    startMic: async (h: (frame: Uint8Array) => void) => {
      mic = true
      frameHandler = h
      return true
    },
    stopMic: async () => { mic = false; frameHandler = null },
    exitApp: async () => {},
    getStorage: async k => storage[k] ?? '',
    setStorage: async (k, v) => { storage[k] = v; return true },
    getBatteryLevel: async () => battery,
  }
  return {
    runtime,
    invokeTap: (src = 'glasses') => tapHandler?.(src),
    invokeDoubleTap: (src = 'glasses') => doubleTapHandler?.(src),
    invokeForeground: () => foregroundHandler?.(),
    lastRender: () => lastRendered,
    micActive: () => mic,
    pumpFrame: (frame: Uint8Array) => frameHandler?.(frame),
    pumpFrames: (count: number, bytes: number) => {
      for (let i = 0; i < count; i++) {
        // Deterministic non-zero bytes so any byte-count assertion is meaningful.
        const f = new Uint8Array(bytes)
        for (let j = 0; j < bytes; j++) f[j] = (i + j) & 0xff
        frameHandler?.(f)
      }
    },
  }
}

interface FakeFetchOpts {
  /** Per-call utterances to return in order. After exhausted, returns text-only. */
  utterancesQueue?: Array<Array<{ speaker: number; text: string; confidence?: number }>>
  /** Suggestions to return on /suggest. Defaults to a static triple. */
  suggestions?: string[]
  /** Captures every transcribe + suggest call so tests can assert. */
  calls?: Array<{ url: string; method: string; body?: unknown; bytes?: number }>
}

function installFakeFetch(opts: FakeFetchOpts): void {
  const transcribeQueue = opts.utterancesQueue ? [...opts.utterancesQueue] : []
  const suggestions = opts.suggestions ?? ['Ask follow-up.', 'Mirror back.', 'Pivot to next topic.']
  globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString()
    const method = init?.method ?? 'GET'
    if (url.endsWith('/healthz')) {
      opts.calls?.push({ url, method })
      return new Response('ok', { status: 200 })
    }
    if (url.includes('/transcribe')) {
      const body = init?.body as Blob | undefined
      const bytes = body ? body.size : 0
      opts.calls?.push({ url, method, bytes })
      const utts = transcribeQueue.shift() ?? []
      const joined = utts.map(u => u.text).join(' ').trim()
      return new Response(
        JSON.stringify({
          ok: true,
          text: joined || 'sample transcript',
          utterances: utts.map(u => ({ ...u, confidence: u.confidence ?? 0.9 })),
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )
    }
    if (url.includes('/suggest')) {
      const body = init?.body ? JSON.parse(init.body as string) : null
      opts.calls?.push({ url, method, body })
      return new Response(
        JSON.stringify({ ok: true, suggestions }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )
    }
    return new Response('not found', { status: 404 })
  }) as unknown as typeof fetch
}

let fake: FakeBridge

async function bootMocked(initialStorage: Record<string, string> = {}): Promise<void> {
  vi.resetModules()
  fake = createFakeBridge()

  // Pre-populate both bridge storage and localStorage fallback so
  // bootstrap reads are robust to ordering.
  for (const [k, v] of Object.entries(initialStorage)) {
    await fake.runtime.setStorage(k, v)
  }
  const lsStore = { ...initialStorage }
  globalThis.localStorage = {
    getItem: (k: string) => lsStore[k] ?? null,
    setItem: (k: string, v: string) => { lsStore[k] = v },
    removeItem: (k: string) => { delete lsStore[k] },
    clear: () => { for (const k of Object.keys(lsStore)) delete lsStore[k] },
    key: (i: number) => Object.keys(lsStore)[i] ?? null,
    get length() { return Object.keys(lsStore).length },
  } as Storage

  vi.doMock('../src/even', () => ({
    connectEvenRuntime: vi.fn(() => Promise.resolve(fake.runtime)),
  }))

  document.body.innerHTML = '<div id="app"></div>'
  // @ts-expect-error — define is normally injected by Vite at build time
  globalThis.__APP_VERSION__ = '0.0.0-test'

  await import('../src/main')
  await new Promise(r => setTimeout(r, 60))
}

const ORIGINAL_FETCH = globalThis.fetch

// 殭屍計時器防護：vitest 的 jsdom 計時器回傳 Node Timeout「物件」，
// 用數字 id 清不掉；vi.resetModules 也不會停掉舊模組的 interval——
// micTick 會活過測試邊界，靜默 6s 後把 /suggest 打進「下一個測試」的
// fetch mock。改用包裝追蹤：攔截註冊、afterEach 逐 handle 清除。
const liveTimers: Array<ReturnType<typeof setTimeout>> = []
const REAL_SET_INTERVAL = globalThis.setInterval.bind(globalThis)
const REAL_SET_TIMEOUT = globalThis.setTimeout.bind(globalThis)

beforeEach(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  globalThis.setInterval = ((fn: any, ms?: any, ...args: any[]) => {
    const h = REAL_SET_INTERVAL(fn, ms, ...args)
    liveTimers.push(h)
    return h
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  globalThis.setTimeout = ((fn: any, ms?: any, ...args: any[]) => {
    const h = REAL_SET_TIMEOUT(fn, ms, ...args)
    liveTimers.push(h)
    return h
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any
})

function drainLiveTimers(): void {
  for (const h of liveTimers.splice(0)) {
    clearInterval(h)
    clearTimeout(h)
  }
}

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH
  document.body.innerHTML = ''
  vi.doUnmock('../src/even')
  vi.useRealTimers()
  vi.restoreAllMocks()
  drainLiveTimers()
})

// CHUNK_BYTES from transport.ts: 16000 sample-rate × 2 bytes × 2.5s = 80_000.
const CHUNK_BYTES = 80_000

describe('Cue audio pipeline (fake bridge + mocked worker)', () => {
  it('probes /healthz on mic-on when worker is configured', async () => {
    const calls: FakeFetchOpts['calls'] = []
    installFakeFetch({ calls })
    await bootMocked({
      'cue:privacy-agreed:v1': '1',
      'cue:worker-url:v1': 'https://cue-test.workers.dev',
      'cue:worker-token:v1': 'test-bearer',
    })
    fake.invokeTap('glasses')
    await new Promise(r => setTimeout(r, 50))
    const probed = calls!.some(c => c.url.endsWith('/healthz'))
    expect(probed).toBe(true)
  })

  it('chunks PCM into a /transcribe POST after CHUNK_BYTES bytes accumulate', async () => {
    const calls: FakeFetchOpts['calls'] = []
    installFakeFetch({
      calls,
      utterancesQueue: [
        [{ speaker: 0, text: 'how was your day' }],
      ],
    })
    await bootMocked({
      'cue:privacy-agreed:v1': '1',
      'cue:worker-url:v1': 'https://cue-test.workers.dev',
      'cue:worker-token:v1': 'test-bearer',
    })
    fake.invokeTap('glasses')
    await new Promise(r => setTimeout(r, 50))
    // 100KB > CHUNK_BYTES (80KB), so the threshold-flush fires once.
    fake.pumpFrames(10, 10_000)
    await new Promise(r => setTimeout(r, 50))
    const transcribeCalls = calls!.filter(c => c.url.includes('/transcribe'))
    expect(transcribeCalls).toHaveLength(1)
    expect(transcribeCalls[0]!.bytes).toBeGreaterThanOrEqual(CHUNK_BYTES)
  })

  it('renders [A]/[B] labels for two-speaker utterances', async () => {
    installFakeFetch({
      utterancesQueue: [
        [
          { speaker: 0, text: 'how was your day' },
          { speaker: 1, text: 'pretty good thanks' },
        ],
      ],
    })
    await bootMocked({
      'cue:privacy-agreed:v1': '1',
      'cue:worker-url:v1': 'https://cue-test.workers.dev',
      'cue:worker-token:v1': 'test-bearer',
      'cue:gated-mode:v1': '0', // 語者標籤是閘門關（diarize）流程
    })
    fake.invokeTap('glasses')
    await new Promise(r => setTimeout(r, 50))
    fake.pumpFrames(10, 10_000)
    // Wait long enough for fetch + onTranscript + paint to settle.
    await new Promise(r => setTimeout(r, 80))
    const out = fake.lastRender()
    expect(out).toMatch(/\[A\] how was your day/)
    expect(out).toMatch(/\[B\] pretty good/)
  })

  it('marks the wearer with "(you)" and excludes wearer text from /suggest transcript', async () => {
    const calls: FakeFetchOpts['calls'] = []
    installFakeFetch({
      calls,
      utterancesQueue: [
        [
          { speaker: 0, text: 'I had a long day' },              // wearer
          { speaker: 1, text: 'tell me about the meeting' },     // other
        ],
      ],
    })
    await bootMocked({
      'cue:privacy-agreed:v1': '1',
      'cue:worker-url:v1': 'https://cue-test.workers.dev',
      'cue:worker-token:v1': 'test-bearer',
      'cue:wearer-speaker-id:v1': '0',  // I am speaker A
      'cue:gated-mode:v1': '0', // wearer 過濾是閘門關流程
    })
    fake.invokeTap('glasses')
    await new Promise(r => setTimeout(r, 50))
    fake.pumpFrames(10, 10_000)
    // Wait for transcribe + the silence-driven /suggest fire (sentence-final).
    await new Promise(r => setTimeout(r, 200))

    const out = fake.lastRender()
    expect(out).toMatch(/\[A \(you\)\] I had a long day/)
    expect(out).toMatch(/\[B\] tell me about the meeting/)

    // /suggest payload's transcript field must NOT contain wearer's text.
    const suggestCalls = calls!.filter(c => c.url.includes('/suggest'))
    expect(suggestCalls.length).toBeGreaterThanOrEqual(1)
    const lastSuggest = suggestCalls[suggestCalls.length - 1]!
    const transcript = (lastSuggest.body as { transcript: string }).transcript
    expect(transcript).not.toMatch(/I had a long day/)
    expect(transcript).toMatch(/tell me about the meeting/)
  })

  it('flushes a trailing partial chunk when mic is toggled off', async () => {
    const calls: FakeFetchOpts['calls'] = []
    installFakeFetch({
      calls,
      utterancesQueue: [
        [{ speaker: 0, text: 'short utterance before stop' }],
      ],
    })
    await bootMocked({
      'cue:privacy-agreed:v1': '1',
      'cue:worker-url:v1': 'https://cue-test.workers.dev',
      'cue:worker-token:v1': 'test-bearer',
    })
    fake.invokeTap('glasses')
    await new Promise(r => setTimeout(r, 50))
    // Pump less than CHUNK_BYTES but more than MIN_CHUNK_BYTES (16000).
    // 2 frames × 10000 = 20000 bytes — below threshold so no auto-flush
    // happens, but trailing flush on mic-off should send it.
    fake.pumpFrames(2, 10_000)
    await new Promise(r => setTimeout(r, 30))
    const before = calls!.filter(c => c.url.includes('/transcribe')).length
    expect(before).toBe(0) // no auto-flush yet
    // Tap again — mic off → trailing flush.
    fake.invokeTap('glasses')
    await new Promise(r => setTimeout(r, 80))
    const after = calls!.filter(c => c.url.includes('/transcribe')).length
    expect(after).toBe(1)
  })

  it('calibrate-me anchors wearer to first detected speaker', async () => {
    installFakeFetch({
      utterancesQueue: [
        [
          { speaker: 1, text: 'this is me speaking' },  // first speech → wearer
        ],
      ],
    })
    await bootMocked({
      'cue:privacy-agreed:v1': '1',
      'cue:worker-url:v1': 'https://cue-test.workers.dev',
      'cue:worker-token:v1': 'test-bearer',
      'cue:calibrating:v1': '1',  // user just tapped Calibrate me
      'cue:wearer-speaker-id:v1': '-1', // none yet
      'cue:gated-mode:v1': '0', // 語者錨定是閘門關流程
    })
    fake.invokeTap('glasses')
    await new Promise(r => setTimeout(r, 50))
    fake.pumpFrames(10, 10_000)
    await new Promise(r => setTimeout(r, 100))

    // Speaker B's line should now be marked "(you)".
    expect(fake.lastRender()).toMatch(/\[B \(you\)\] this is me speaking/)
    // And the wearer-speaker-id should have been persisted.
    expect(await fake.runtime.getStorage('cue:wearer-speaker-id:v1')).toBe('1')
  })

  // ─── Phase 3: 串流建議 — 手機側逐字、結束後保留單一完整回答 ────────
  it('串流 /suggest：手機側逐字顯示，結束後顯示未編號完整回答並渲染眼鏡', async () => {
    let suggestHit = false
    let releaseChunk2: () => void = () => {}
    const gate = new Promise<void>(r => { releaseChunk2 = r })
    const encoder = new TextEncoder()

    globalThis.fetch = vi.fn(async (url: string, init?: RequestInit) => {
      const u = String(url)
      if (u.includes('/healthz')) return new Response('ok', { status: 200 })
      if (u.includes('/transcribe')) {
        return new Response(
          JSON.stringify({
            ok: true,
            text: 'tell me about the meeting',
            utterances: [{ speaker: 1, text: 'tell me about the meeting', confidence: 0.9 }],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        )
      }
      if (u.includes('/suggest')) {
        expect(u).toContain('stream=1')
        expect(init?.method).toBe('POST')
        suggestHit = true
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode('我認為 Agent 的演進，是從 READ ONLY '))
            void gate.then(() => {
              controller.enqueue(encoder.encode('走向 TAKE ACTION，讓模型可以透過 MCP 與 API 執行任務。'))
              controller.close()
            })
          },
        })
        return new Response(body, { status: 200, headers: { 'Content-Type': 'text/plain; charset=utf-8' } })
      }
      return new Response('not found', { status: 404 })
    }) as unknown as typeof fetch

    await bootMocked({
      'cue:privacy-agreed:v1': '1',
      'cue:worker-url:v1': 'https://cue-test.workers.dev',
      'cue:worker-token:v1': 'test-bearer',
    })
    fake.invokeTap('glasses')
    await new Promise(r => setTimeout(r, 50))
    fake.pumpFrames(10, 10_000)

    // 等 /suggest 開流 + 第一個 chunk 的 onDelta 落到手機 DOM
    const deadline = Date.now() + 2_000
    while (!suggestHit && Date.now() < deadline) await new Promise(r => setTimeout(r, 20))
    expect(suggestHit).toBe(true)
    await new Promise(r => setTimeout(r, 40))
    const liveEl = document.querySelector<HTMLDivElement>('#live-suggestions')!
    expect(liveEl.textContent).toContain('READ ONLY') // 串流中：手機已有部分文字

    // 放行第二個 chunk → 串流結束 → 未編號完整回答 + 眼鏡渲染
    releaseChunk2()
    await new Promise(r => setTimeout(r, 380)) // > 300ms 節流窗，讓 trailing/flush 落定
    expect(liveEl.textContent).toBe(
      '我認為 Agent 的演進，是從 READ ONLY 走向 TAKE ACTION，讓模型可以透過 MCP 與 API 執行任務。',
    )
    expect(fake.lastRender()).not.toMatch(/1\.[■●★]/)
    expect(fake.lastRender()).toContain('TAKE ACTION')
  })

  // ─── Phase 4: 閘門收音（gated）＋ cancel ＋ extend ────────────────
  it('gated：/transcribe 帶 gated=1，無 utterances 的整段文字標「對方」', async () => {
    const calls: FakeFetchOpts['calls'] = []
    globalThis.fetch = vi.fn(async (url: string, init?: RequestInit) => {
      const u = String(url)
      if (u.includes('/healthz')) return new Response('ok', { status: 200 })
      if (u.includes('/transcribe')) {
        calls!.push({ url: u, method: init?.method ?? 'POST', body: null })
        // gated 回應：只有 text，無 utterances
        return new Response(JSON.stringify({ ok: true, text: '請自我介紹一下。' }), {
          status: 200, headers: { 'Content-Type': 'application/json' },
        })
      }
      if (u.includes('/suggest')) {
        calls!.push({ url: u, method: init?.method ?? 'POST', body: JSON.parse(init!.body as string) })
        return new Response(JSON.stringify({ ok: true, suggestions: ['結論：八年產線經驗。'] }), {
          status: 200, headers: { 'Content-Type': 'application/json' },
        })
      }
      return new Response('not found', { status: 404 })
    }) as unknown as typeof fetch

    await bootMocked({
      'cue:privacy-agreed:v1': '1',
      'cue:worker-url:v1': 'https://cue-test.workers.dev',
      'cue:worker-token:v1': 'test-bearer',
      'cue:wearer-speaker-id:v1': '0', // gated 模式必須無視 wearer 過濾
    })
    fake.invokeTap('glasses')
    await new Promise(r => setTimeout(r, 50))
    fake.pumpFrames(10, 10_000)
    await new Promise(r => setTimeout(r, 100))

    const tUrl = calls!.find(c => c.url.includes('/transcribe'))!.url
    expect(tUrl).toContain('gated=1')
    expect(fake.lastRender()).toMatch(/\[對方\] 請自我介紹一下/)
    expect(fake.lastRender()).not.toMatch(/\(you\)/)
  })

  it('gated：gate-stop（單擊）後強制觸發 /suggest，回答保留在屏', async () => {
    const calls: FakeFetchOpts['calls'] = []
    globalThis.fetch = vi.fn(async (url: string, init?: RequestInit) => {
      const u = String(url)
      if (u.includes('/healthz')) return new Response('ok', { status: 200 })
      if (u.includes('/transcribe')) {
        return new Response(JSON.stringify({ ok: true, text: '你的優勢是什麼' }), {
          status: 200, headers: { 'Content-Type': 'application/json' },
        })
      }
      if (u.includes('/suggest')) {
        calls!.push({ url: u, method: 'POST', body: JSON.parse(init!.body as string) })
        return new Response(JSON.stringify({ ok: true, suggestions: ['結論：數據分析與風控。'] }), {
          status: 200, headers: { 'Content-Type': 'application/json' },
        })
      }
      return new Response('not found', { status: 404 })
    }) as unknown as typeof fetch

    await bootMocked({
      'cue:privacy-agreed:v1': '1',
      'cue:worker-url:v1': 'https://cue-test.workers.dev',
      'cue:worker-token:v1': 'test-bearer',
    })
    fake.invokeTap('glasses')          // gate-start
    await new Promise(r => setTimeout(r, 50))
    fake.pumpFrames(2, 10_000)         // 20KB < CHUNK_BYTES — 靠尾端 flush
    await new Promise(r => setTimeout(r, 30))
    fake.invokeTap('glasses')          // gate-stop → 尾端 flush + 強制 suggest
    await new Promise(r => setTimeout(r, 150))

    expect(calls!.length).toBeGreaterThanOrEqual(1) // 強制觸發，不等 debounce
    expect(fake.lastRender()).toMatch(/mic off/)
    expect(fake.lastRender()).toMatch(/數據分析與風控/) // 回答顯示中
  })

  it('gated：收音中雙擊＝取消（不發 /suggest、丟棄 transcript）', async () => {
    const suggestCalls: string[] = []
    globalThis.fetch = vi.fn(async (url: string) => {
      const u = String(url)
      if (u.includes('/healthz')) return new Response('ok', { status: 200 })
      if (u.includes('/transcribe')) {
        return new Response(JSON.stringify({ ok: true, text: '這句要被丟掉' }), {
          status: 200, headers: { 'Content-Type': 'application/json' },
        })
      }
      if (u.includes('/suggest')) {
        suggestCalls.push(u)
        return new Response(JSON.stringify({ ok: true, suggestions: ['x'] }), {
          status: 200, headers: { 'Content-Type': 'application/json' },
        })
      }
      return new Response('not found', { status: 404 })
    }) as unknown as typeof fetch

    await bootMocked({
      'cue:privacy-agreed:v1': '1',
      'cue:worker-url:v1': 'https://cue-test.workers.dev',
      'cue:worker-token:v1': 'test-bearer',
    })
    fake.invokeTap('glasses')
    await new Promise(r => setTimeout(r, 50))
    fake.pumpFrames(2, 10_000)
    await new Promise(r => setTimeout(r, 30))
    fake.invokeDoubleTap('glasses')    // cancel
    await new Promise(r => setTimeout(r, 120))

    expect(suggestCalls).toHaveLength(0)
    expect(fake.lastRender()).toMatch(/mic off/)
    expect(fake.lastRender()).not.toMatch(/這句要被丟掉/)
  })

  it('回答視圖開頭定錨窗：超長答案留開頭、尾端補 ▼，總量 ≤512 bytes', async () => {
    // 提詞機語意：全文遠超 512 bytes 時，眼鏡端裁尾留頭（由朗讀節奏推進，非跟生成捲尾）
    const longAnswer = `唯一開頭標記${'這是一段有內容的專業分析。'.repeat(30)}真正的尾端`
    globalThis.fetch = vi.fn(async (url: string) => {
      const u = String(url)
      if (u.includes('/healthz')) return new Response('ok', { status: 200 })
      if (u.includes('/transcribe')) {
        return new Response(JSON.stringify({ ok: true, text: '請詳細說明' }), {
          status: 200, headers: { 'Content-Type': 'application/json' },
        })
      }
      if (u.includes('/suggest')) {
        return new Response(JSON.stringify({ ok: true, suggestions: [longAnswer] }), {
          status: 200, headers: { 'Content-Type': 'application/json' },
        })
      }
      return new Response('not found', { status: 404 })
    }) as unknown as typeof fetch

    await bootMocked({
      'cue:privacy-agreed:v1': '1',
      'cue:worker-url:v1': 'https://cue-test.workers.dev',
      'cue:worker-token:v1': 'test-bearer',
    })
    fake.invokeTap('glasses')
    await new Promise(r => setTimeout(r, 50))
    fake.pumpFrames(2, 10_000)
    await new Promise(r => setTimeout(r, 30))
    fake.invokeTap('glasses')
    await new Promise(r => setTimeout(r, 150))

    const rendered = fake.lastRender()
    expect(new TextEncoder().encode(rendered).length).toBeLessThanOrEqual(512)
    expect(rendered).toContain('唯一開頭標記') // 定錨開頭可見
    expect(rendered).not.toContain('真正的尾端') // 尾端被裁掉
    expect(rendered).toContain('▼') // 提示下方還有內容
    expect(rendered).not.toMatch(/1\.[■●★]/)
  })

  it('自動收音：final transcript 命中問句 → 立即觸發 /suggest（繞過 debounce）', async () => {
    const suggestBodies: Array<Record<string, unknown>> = []
    const urls: string[] = []
    globalThis.fetch = vi.fn(async (url: string, init?: RequestInit) => {
      const u = String(url)
      urls.push(u)
      if (u.includes('/healthz')) return new Response('ok', { status: 200 })
      if (u.includes('/transcribe')) {
        return new Response(JSON.stringify({
          ok: true,
          text: '你的優勢是什麼',
          utterances: [{ speaker: 1, text: '你的優勢是什麼', confidence: 0.9 }],
        }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      if (u.includes('/suggest')) {
        suggestBodies.push(JSON.parse(init!.body as string))
        return new Response(JSON.stringify({ ok: true, suggestions: ['結論：數據分析。'] }), {
          status: 200, headers: { 'Content-Type': 'application/json' },
        })
      }
      return new Response('not found', { status: 404 })
    }) as unknown as typeof fetch

    await bootMocked({
      'cue:privacy-agreed:v1': '1',
      'cue:worker-url:v1': 'https://cue-test.workers.dev',
      'cue:worker-token:v1': 'test-bearer',
      'cue:auto-listen:v1': '1',
    })
    fake.invokeTap('glasses')
    await new Promise(r => setTimeout(r, 50))
    fake.pumpFrames(10, 10_000)
    await new Promise(r => setTimeout(r, 120))

    // 問句命中 → 立即 /suggest（「你的優勢是什麼」無句尾標點，靠問句偵測）
    expect(suggestBodies.length).toBeGreaterThanOrEqual(1)
    expect(String(suggestBodies[0]!.transcript)).toContain('你的優勢是什麼')
    // 自動收音依賴語者錨定 → /transcribe 必須走 diarize（gated=0）
    expect(urls.find(u => u.includes('/transcribe'))).toContain('gated=0')
  })

  it('自動收音：非問句不立即觸發 /suggest', async () => {
    const suggestCalls: string[] = []
    globalThis.fetch = vi.fn(async (url: string) => {
      const u = String(url)
      if (u.includes('/healthz')) return new Response('ok', { status: 200 })
      if (u.includes('/transcribe')) {
        return new Response(JSON.stringify({
          ok: true,
          text: '今天天氣不錯',
          utterances: [{ speaker: 1, text: '今天天氣不錯', confidence: 0.9 }],
        }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      if (u.includes('/suggest')) {
        suggestCalls.push(u)
        return new Response(JSON.stringify({ ok: true, suggestions: ['x'] }), {
          status: 200, headers: { 'Content-Type': 'application/json' },
        })
      }
      return new Response('not found', { status: 404 })
    }) as unknown as typeof fetch

    await bootMocked({
      'cue:privacy-agreed:v1': '1',
      'cue:worker-url:v1': 'https://cue-test.workers.dev',
      'cue:worker-token:v1': 'test-bearer',
      'cue:auto-listen:v1': '1',
    })
    fake.invokeTap('glasses')
    await new Promise(r => setTimeout(r, 50))
    fake.pumpFrames(10, 10_000)
    await new Promise(r => setTimeout(r, 150))
    expect(suggestCalls).toHaveLength(0)
  })

  it('VAD 邊界：自動收音模式下 voice-end 提早 flush（不等 2.5s 切塊滿）', async () => {
    const transcribeCalls: number[] = []
    globalThis.fetch = vi.fn(async (url: string) => {
      const u = String(url)
      if (u.includes('/healthz')) return new Response('ok', { status: 200 })
      if (u.includes('/transcribe')) {
        transcribeCalls.push(Date.now())
        return new Response(JSON.stringify({ ok: true, text: '' }), {
          status: 200, headers: { 'Content-Type': 'application/json' },
        })
      }
      return new Response(JSON.stringify({ ok: true, suggestions: [] }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      })
    }) as unknown as typeof fetch

    await bootMocked({
      'cue:privacy-agreed:v1': '1',
      'cue:worker-url:v1': 'https://cue-test.workers.dev',
      'cue:worker-token:v1': 'test-bearer',
      'cue:auto-listen:v1': '1',
    })
    fake.invokeTap('glasses')
    await new Promise(r => setTimeout(r, 50))
    // 30KB 有聲（> MIN_CHUNK 16KB、遠小於 80KB 切塊閾值）→ 停止說話
    for (let i = 0; i < 3; i += 1) fake.pumpFrame(synthFrame(5_000, 0.2))
    fake.pumpFrame(synthFrame(500, 0.001)) // 進 POST_VOICE
    await new Promise(r => setTimeout(r, 750)) // 撐過 700ms silence-hold
    fake.pumpFrame(synthFrame(500, 0.001))    // voice-end → flushNow
    await new Promise(r => setTimeout(r, 80))
    expect(transcribeCalls.length).toBeGreaterThanOrEqual(1)
  })

  it('VAD 邊界：閘門模式完全不經 VAD（同樣音訊不提早 flush）', async () => {
    const transcribeCalls: number[] = []
    globalThis.fetch = vi.fn(async (url: string) => {
      const u = String(url)
      if (u.includes('/healthz')) return new Response('ok', { status: 200 })
      if (u.includes('/transcribe')) {
        transcribeCalls.push(Date.now())
        return new Response(JSON.stringify({ ok: true, text: '' }), {
          status: 200, headers: { 'Content-Type': 'application/json' },
        })
      }
      return new Response(JSON.stringify({ ok: true, suggestions: [] }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      })
    }) as unknown as typeof fetch

    await bootMocked({
      'cue:privacy-agreed:v1': '1',
      'cue:worker-url:v1': 'https://cue-test.workers.dev',
      'cue:worker-token:v1': 'test-bearer',
      // 閘門模式（預設開）——不設 auto-listen
    })
    fake.invokeTap('glasses')
    await new Promise(r => setTimeout(r, 50))
    for (let i = 0; i < 3; i += 1) fake.pumpFrame(synthFrame(5_000, 0.2))
    fake.pumpFrame(synthFrame(500, 0.001))
    await new Promise(r => setTimeout(r, 750))
    fake.pumpFrame(synthFrame(500, 0.001))
    await new Promise(r => setTimeout(r, 80))
    // 30KB < 80KB 切塊閾值且無 VAD — 不得有任何 /transcribe
    expect(transcribeCalls).toHaveLength(0)
  })

  it('extend：回答顯示中雙擊 → 再發 /suggest 帶 extendContext，接「── 延伸 ──」', async () => {
    const suggestBodies: Array<Record<string, unknown>> = []
    let round = 0
    globalThis.fetch = vi.fn(async (url: string, init?: RequestInit) => {
      const u = String(url)
      if (u.includes('/healthz')) return new Response('ok', { status: 200 })
      if (u.includes('/transcribe')) {
        return new Response(JSON.stringify({ ok: true, text: '你的優勢是什麼' }), {
          status: 200, headers: { 'Content-Type': 'application/json' },
        })
      }
      if (u.includes('/suggest')) {
        suggestBodies.push(JSON.parse(init!.body as string))
        round += 1
        const payload = round === 1
          ? { ok: true, suggestions: ['結論：數據分析與風控。'] }
          : { ok: true, suggestions: ['具體案例：Stacking 模型 Sharpe 1.57。'] }
        return new Response(JSON.stringify(payload), {
          status: 200, headers: { 'Content-Type': 'application/json' },
        })
      }
      return new Response('not found', { status: 404 })
    }) as unknown as typeof fetch

    await bootMocked({
      'cue:privacy-agreed:v1': '1',
      'cue:worker-url:v1': 'https://cue-test.workers.dev',
      'cue:worker-token:v1': 'test-bearer',
    })
    fake.invokeTap('glasses')
    await new Promise(r => setTimeout(r, 50))
    fake.pumpFrames(2, 10_000)
    await new Promise(r => setTimeout(r, 30))
    fake.invokeTap('glasses')          // gate-stop → 第一輪回答
    await new Promise(r => setTimeout(r, 150))
    expect(fake.lastRender()).toMatch(/數據分析與風控/)

    fake.invokeDoubleTap('glasses')    // extend
    await new Promise(r => setTimeout(r, 400)) // 含 300ms 節流窗

    expect(suggestBodies.length).toBe(2)
    expect(String(suggestBodies[1]!.extendContext)).toContain('數據分析與風控')
    expect(fake.lastRender()).toMatch(/── 延伸 ──/)
    expect(fake.lastRender()).toMatch(/Stacking 模型/)
    expect(fake.exitCalls?.() ?? 0).toBe(0)
  })
})
