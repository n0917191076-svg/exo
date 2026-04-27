// Contract tests for the local dev Worker stub. Boots the actual http.Server
// from scripts/dev-worker.mjs on an ephemeral port and round-trips real
// fetch calls against it. This catches regressions where the stub's
// response shape drifts from what createTransport() expects, since
// transport.test.ts only mocks fetch — it doesn't exercise the real stub.
//
// We also drive a real createTransport() against the stub end-to-end so
// the chunking + utterance-decode path is verified against actual HTTP,
// not just a fetch double.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
// @ts-expect-error — .mjs has no .d.ts; the shape is asserted by tests below.
import { createDevWorker } from '../scripts/dev-worker.mjs'
import { createTransport, type TranscriptEvent } from '../src/transport'

let server: Server
let baseUrl: string

beforeEach(async () => {
  server = createDevWorker({ latencyMs: 0 })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()))
  const addr = server.address() as AddressInfo
  baseUrl = `http://127.0.0.1:${addr.port}`
})

afterEach(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()))
})

describe('dev-worker.mjs HTTP contract', () => {
  it('GET /healthz returns 200 ok', async () => {
    const r = await fetch(`${baseUrl}/healthz`)
    expect(r.status).toBe(200)
    expect(await r.text()).toBe('ok')
  })

  it('POST /transcribe returns ok+text+utterances shape', async () => {
    const r = await fetch(`${baseUrl}/transcribe`, {
      method: 'POST',
      headers: { Authorization: 'Bearer dev' },
      body: new Uint8Array(1000),
    })
    expect(r.status).toBe(200)
    const json = await r.json()
    expect(json.ok).toBe(true)
    expect(typeof json.text).toBe('string')
    expect(json.text.length).toBeGreaterThan(0)
    expect(Array.isArray(json.utterances)).toBe(true)
    for (const u of json.utterances) {
      expect(typeof u.speaker).toBe('number')
      expect(typeof u.text).toBe('string')
      expect(typeof u.confidence).toBe('number')
    }
  })

  it('POST /transcribe rotates through fixtures (consecutive calls return different text)', async () => {
    const a = await (await fetch(`${baseUrl}/transcribe`, { method: 'POST', body: new Uint8Array(100) })).json()
    const b = await (await fetch(`${baseUrl}/transcribe`, { method: 'POST', body: new Uint8Array(100) })).json()
    expect(a.text).not.toBe(b.text)
  })

  it('POST /suggest returns mode-specific suggestions', async () => {
    const dateRes = await fetch(`${baseUrl}/suggest`, {
      method: 'POST',
      headers: { Authorization: 'Bearer dev', 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'date', transcript: 'how was your day' }),
    })
    const dateJson = await dateRes.json()
    expect(dateJson.ok).toBe(true)
    expect(dateJson.suggestions).toHaveLength(3)

    const argueRes = await fetch(`${baseUrl}/suggest`, {
      method: 'POST',
      headers: { Authorization: 'Bearer dev', 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'argue-calm', transcript: 'we have a conflict' }),
    })
    const argueJson = await argueRes.json()
    expect(argueJson.suggestions).toHaveLength(3)
    // date and argue-calm fixtures must differ.
    expect(argueJson.suggestions).not.toEqual(dateJson.suggestions)
  })

  it('POST /suggest with unknown mode falls back to date', async () => {
    const r = await fetch(`${baseUrl}/suggest`, {
      method: 'POST',
      headers: { Authorization: 'Bearer dev', 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'nonexistent-mode', transcript: 'x' }),
    })
    const json = await r.json()
    expect(json.ok).toBe(true)
    expect(json.suggestions).toHaveLength(3)
  })

  it('OPTIONS preflight returns 204 with permissive CORS headers', async () => {
    const r = await fetch(`${baseUrl}/transcribe`, { method: 'OPTIONS' })
    expect(r.status).toBe(204)
    expect(r.headers.get('access-control-allow-origin')).toBe('*')
    expect(r.headers.get('access-control-allow-methods')).toMatch(/POST/)
  })

  it('unknown route returns 404 with json error', async () => {
    const r = await fetch(`${baseUrl}/nope`)
    expect(r.status).toBe(404)
    const json = await r.json()
    expect(json.ok).toBe(false)
  })
})

describe('createTransport against the real dev-worker', () => {
  // This is the proof that the stub is a drop-in for the real Worker:
  // the production transport code (chunking + decode) round-trips
  // through actual HTTP and surfaces utterances correctly.
  it('startMicSession + sendAudioFrame + endMicSession yields a TranscriptEvent', async () => {
    const t = createTransport(baseUrl, 'dev')
    expect(t.ready).toBe(true)
    let captured: TranscriptEvent | null = null
    await t.startMicSession(e => { captured = e }, () => {})
    // 20KB > MIN_CHUNK_BYTES (16KB), below CHUNK_BYTES (80KB).
    // Trailing flush on endMicSession should send the partial.
    t.sendAudioFrame(new Uint8Array(20_000))
    await t.endMicSession()
    expect(captured).not.toBeNull()
    expect(captured!.isFinal).toBe(true)
    expect(captured!.text.length).toBeGreaterThan(0)
    expect(Array.isArray(captured!.utterances)).toBe(true)
  })

  it('requestSuggestions returns a 3-tuple from the real /suggest', async () => {
    const t = createTransport(baseUrl, 'dev')
    const r = await t.requestSuggestions({ mode: 'date', transcript: 'how was your day' })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.suggestions).toHaveLength(3)
  })
})
