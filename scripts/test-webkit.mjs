#!/usr/bin/env node
// Closer-to-iOS-WKWebView integration test: spins up a Playwright WebKit
// browser and runs the actual `transport.ts` from inside a real WebKit
// engine, exercising fetch + WebSocket against the deployed cue-worker.
//
// Why this exists: iOS WKWebView is WebKit-family. Chromium-based tests
// (jsdom, simulator, headless Chrome) miss WebKit-specific quirks like
// stricter CORS handling, different binary-body fetch behavior, and
// WebSocket open-handshake differences. Playwright/WebKit is the closest
// desktop engine to iOS WKWebView available — bugs that depend on JS
// engine + WebKit network stack will surface here, even if production
// iOS WKWebView still has an additional layer of platform-specific
// quirks we can't fully replicate.
//
// What it tests:
//   1. fetch GET /healthz works from WebKit (sanity)
//   2. fetch POST /suggest with Bearer auth + JSON body works
//   3. fetch POST /transcribe with Bearer auth + Blob (binary) body works
//   4. WebSocket('wss://.../ws?token=...') open succeeds (so we know if
//      WS is structurally blocked at WebKit level, vs only on iOS)
//
// Run:
//   node scripts/test-webkit.mjs
// Requires:
//   - npx playwright install webkit (one-time)
//   - cue.ehpk's app.json whitelist must contain the worker host
//   - SHARED_SECRET env var OR /tmp/cue-shared-secret.txt with the bearer
//   - The worker must be deployed (we hit the live URL, not local)

import { webkit } from 'playwright'
import { existsSync, readFileSync } from 'node:fs'

const WORKER_URL = process.env.CUE_WORKER_URL || 'https://cue-worker.jiazuo.workers.dev'
const SHARED_SECRET =
  process.env.SHARED_SECRET ||
  (existsSync('/tmp/cue-shared-secret.txt') ? readFileSync('/tmp/cue-shared-secret.txt', 'utf-8').trim() : '')

if (!SHARED_SECRET) {
  console.error('✗ no SHARED_SECRET. Set env or write to /tmp/cue-shared-secret.txt')
  process.exit(2)
}

const PASS = []
const FAIL = []
function ok(name, detail = '') { console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ''}`); PASS.push(name) }
function fail(name, detail) { console.log(`  ✗ ${name} — ${detail}`); FAIL.push({ name, detail }) }

console.log('Launching Playwright/WebKit (engine family used by iOS WKWebView)…')
const browser = await webkit.launch({ headless: true })
const context = await browser.newContext()
const page = await context.newPage()

// Forward console + page errors to our terminal so we see what the
// in-page test reports (otherwise they'd be swallowed by the headless run).
page.on('console', msg => {
  const t = msg.type()
  if (t === 'error' || t === 'warning') console.log(`  page.${t}: ${msg.text()}`)
})
page.on('pageerror', err => console.log(`  page.error: ${err.message}`))

// Mount a minimal HTML page that we'll evaluate JavaScript inside.
await page.goto('about:blank')

// Test 1: GET /healthz.
{
  const result = await page.evaluate(async (url) => {
    const r = await fetch(`${url}/healthz`)
    return { status: r.status, body: await r.json() }
  }, WORKER_URL)
  if (result.status === 200 && result.body?.ok) ok('GET /healthz from WebKit')
  else fail('GET /healthz from WebKit', JSON.stringify(result))
}

// Test 2: POST /suggest with Bearer + JSON.
{
  try {
    const result = await page.evaluate(async (args) => {
      const r = await fetch(`${args.url}/suggest`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${args.bearer}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ mode: 'date', transcript: 'How was your day?' }),
      })
      return { status: r.status, body: await r.json() }
    }, { url: WORKER_URL, bearer: SHARED_SECRET })
    if (result.status === 200 && result.body?.ok && Array.isArray(result.body?.suggestions)) {
      ok('POST /suggest from WebKit', `${result.body.suggestions.length} suggestions`)
    } else {
      fail('POST /suggest from WebKit', `status=${result.status} body=${JSON.stringify(result.body).slice(0, 80)}`)
    }
  } catch (err) {
    fail('POST /suggest from WebKit', err instanceof Error ? err.message : String(err))
  }
}

// Test 3: POST /transcribe with Bearer + Blob (binary body).
// THIS IS THE HOT PATH for the current Cue chunked-HTTP transport.
// If this succeeds in WebKit but fails in iOS, the bug is iOS-only.
// If this fails here too, we have a reproducible test for it.
{
  try {
    const result = await page.evaluate(async (args) => {
      // 1 second of silence at 16kHz 16-bit mono = 32000 bytes
      const pcm = new Uint8Array(32000)
      const blob = new Blob([pcm], { type: 'application/octet-stream' })
      const r = await fetch(`${args.url}/transcribe`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${args.bearer}` },
        body: blob,
      })
      let body
      try { body = await r.json() } catch { body = '<non-json>' }
      return { status: r.status, body }
    }, { url: WORKER_URL, bearer: SHARED_SECRET })
    if (result.status === 200 && result.body?.ok !== undefined) {
      ok('POST /transcribe (Blob) from WebKit', `text="${(result.body.text ?? '').slice(0, 30)}"`)
    } else {
      fail('POST /transcribe (Blob) from WebKit', `status=${result.status} body=${JSON.stringify(result.body).slice(0, 80)}`)
    }
  } catch (err) {
    fail('POST /transcribe (Blob) from WebKit', err instanceof Error ? err.message : String(err))
  }
}

// Test 4: WebSocket open (the bug we hit on iOS).
// We expect this to SUCCEED on macOS WebKit. If it fails here, that's
// a test reproduction of the iOS bug — much easier to debug than only
// on real glasses.
{
  try {
    const result = await page.evaluate(async (args) => {
      const wsUrl = `${args.url.replace(/^https?:/, 'wss:')}/ws?token=${encodeURIComponent(args.bearer)}`
      return await new Promise((resolve) => {
        const t = setTimeout(() => resolve({ ok: false, reason: 'open timeout (8s)' }), 8000)
        const ws = new WebSocket(wsUrl)
        ws.binaryType = 'arraybuffer'
        ws.addEventListener('open', () => { clearTimeout(t); ws.close(); resolve({ ok: true }) }, { once: true })
        ws.addEventListener('error', () => { clearTimeout(t); resolve({ ok: false, reason: 'WS error event' }) }, { once: true })
      })
    }, { url: WORKER_URL, bearer: SHARED_SECRET })
    if (result.ok) {
      ok('WebSocket open in WebKit', 'success — iOS-only WS gap confirmed')
    } else {
      fail('WebSocket open in WebKit', result.reason)
    }
  } catch (err) {
    fail('WebSocket open in WebKit', err instanceof Error ? err.message : String(err))
  }
}

await browser.close()

console.log()
console.log(`Result: ${PASS.length} passed, ${FAIL.length} failed`)
if (FAIL.length > 0) {
  console.log('Failures:')
  for (const f of FAIL) console.log(`  - ${f.name}: ${f.detail}`)
  process.exit(1)
}
