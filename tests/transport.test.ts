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
    if (r.ok) expect(r.suggestions).toEqual(['First', 'Second', 'Third'])
    expect(fetchSpy).toHaveBeenCalledOnce()
    const [url, init] = fetchSpy.mock.calls[0]!
    expect(url).toBe('https://cue.example.workers.dev/suggest')
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
    expect(transcribeUrl).toBe('https://cue.example.workers.dev/transcribe?lang=en')
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
})
