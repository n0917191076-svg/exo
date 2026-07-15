#!/usr/bin/env node
// WebKit integration smoke test for Exo's deployed Worker.
//
// Playwright/WebKit is the closest desktop approximation of the iOS
// WKWebView used by the Even App. It catches WebKit-specific CORS, binary
// request-body, and ReadableStream issues that Chromium-only tests can miss.
// Real iOS, BLE, microphone, and glasses behavior still require G2 hardware.
//
// What it tests:
//   1. GET /healthz
//   2. POST /suggest?stream=0 with the current work-mode payload
//   3. POST /suggest?stream=1 through response.body.getReader()
//   4. POST /transcribe?lang=zh&gated=1 with a binary Blob body
//
// Run: npm run test:webkit
// Requires:
//   - npx playwright install webkit (one-time)
//   - SHARED_SECRET env var or a mode-600 /tmp/exo-shared-secret.txt
//   - a deployed Worker (override with EXO_WORKER_URL when needed)

import { existsSync, readFileSync } from 'node:fs'
import { webkit } from 'playwright'

const WORKER_URL =
  process.env.EXO_WORKER_URL ||
  process.env.CUE_WORKER_URL ||
  'https://cue-worker.jiazuo.workers.dev'
const SECRET_FILES = ['/tmp/exo-shared-secret.txt', '/tmp/cue-shared-secret.txt']
const REQUEST_TIMEOUT_MS = 60_000
const secretFile = SECRET_FILES.find(path => existsSync(path))
const SHARED_SECRET =
  process.env.SHARED_SECRET ||
  (secretFile ? readFileSync(secretFile, 'utf8').trim() : '')

if (!SHARED_SECRET) {
  console.error('✗ no SHARED_SECRET. Set the environment variable or write it to /tmp/exo-shared-secret.txt')
  process.exit(2)
}

const SUGGEST_BODY = {
  mode: 'work',
  transcript: '請用一句話說明你今天完成的工作。',
  model: 'claude-haiku-4-5',
  length: 'short',
  lang: 'zh',
}

const PASS = []
const FAIL = []

function ok(name, detail = '') {
  console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ''}`)
  PASS.push(name)
}

function fail(name, detail) {
  console.log(`  ✗ ${name} — ${detail}`)
  FAIL.push({ name, detail })
}

console.log('Launching Playwright/WebKit for Exo HTTP transport checks…')
const browser = await webkit.launch({ headless: true })
const context = await browser.newContext()
const page = await context.newPage()

try {
page.on('console', message => {
  if (message.type() === 'error' || message.type() === 'warning') {
    console.log(`  page.${message.type()}: ${message.text()}`)
  }
})
page.on('pageerror', error => console.log(`  page.error: ${error.message}`))

await page.goto('about:blank')

// Test 1: unauthenticated health check.
try {
  const result = await page.evaluate(async args => {
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), args.timeoutMs)
    try {
      const response = await fetch(`${args.url}/healthz`, { signal: controller.signal })
      return { status: response.status, body: await response.json() }
    } finally {
      clearTimeout(timeoutId)
    }
  }, { url: WORKER_URL, timeoutMs: REQUEST_TIMEOUT_MS })

  if (result.status === 200 && result.body?.ok === true) {
    ok('GET /healthz from WebKit')
  } else {
    fail('GET /healthz from WebKit', JSON.stringify(result))
  }
} catch (error) {
  fail('GET /healthz from WebKit', error instanceof Error ? error.message : String(error))
}

// Test 2: JSON fallback response.
try {
  const result = await page.evaluate(async args => {
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), args.timeoutMs)
    try {
      const response = await fetch(`${args.url}/suggest?stream=0`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${args.bearer}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(args.body),
        signal: controller.signal,
      })
      return {
        status: response.status,
        contentType: response.headers.get('content-type') ?? '',
        body: await response.json(),
      }
    } finally {
      clearTimeout(timeoutId)
    }
  }, { url: WORKER_URL, bearer: SHARED_SECRET, body: SUGGEST_BODY, timeoutMs: REQUEST_TIMEOUT_MS })

  if (
    result.status === 200 &&
    result.contentType.includes('application/json') &&
    result.body?.ok === true &&
    Array.isArray(result.body?.suggestions)
  ) {
    ok('POST /suggest?stream=0 from WebKit', `${result.body.suggestions.length} suggestions`)
  } else {
    fail('POST /suggest?stream=0 from WebKit', `status=${result.status} body=${JSON.stringify(result.body).slice(0, 120)}`)
  }
} catch (error) {
  fail('POST /suggest?stream=0 from WebKit', error instanceof Error ? error.message : String(error))
}

// Test 3: production chunked-text response and WebKit ReadableStream reader.
try {
  const result = await page.evaluate(async args => {
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), args.timeoutMs)
    try {
      const response = await fetch(`${args.url}/suggest?stream=1`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${args.bearer}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(args.body),
        signal: controller.signal,
      })

      if (!response.body) {
        return {
          status: response.status,
          contentType: response.headers.get('content-type') ?? '',
          chunks: 0,
          text: '',
          error: 'response.body is null',
        }
      }

      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let chunks = 0
      let text = ''
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        chunks += 1
        text += decoder.decode(value, { stream: true })
      }
      text += decoder.decode()

      return {
        status: response.status,
        contentType: response.headers.get('content-type') ?? '',
        chunks,
        text,
      }
    } finally {
      clearTimeout(timeoutId)
    }
  }, { url: WORKER_URL, bearer: SHARED_SECRET, body: SUGGEST_BODY, timeoutMs: REQUEST_TIMEOUT_MS })

  if (
    result.status === 200 &&
    result.contentType.includes('text/plain') &&
    result.chunks > 0 &&
    result.text.trim().length > 0
  ) {
    ok('POST /suggest?stream=1 from WebKit', `${result.chunks} chunks, ${result.text.length} chars`)
  } else {
    fail(
      'POST /suggest?stream=1 from WebKit',
      `status=${result.status} type=${result.contentType} chunks=${result.chunks} error=${result.error ?? 'none'}`,
    )
  }
} catch (error) {
  fail('POST /suggest?stream=1 from WebKit', error instanceof Error ? error.message : String(error))
}

// Test 4: current gated Chinese transcription route with binary request body.
try {
  const result = await page.evaluate(async args => {
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), args.timeoutMs)
    try {
      // One second of silence at 16 kHz, 16-bit mono = 32,000 bytes.
      const pcm = new Uint8Array(32_000)
      const blob = new Blob([pcm], { type: 'application/octet-stream' })
      const response = await fetch(`${args.url}/transcribe?lang=zh&gated=1`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${args.bearer}` },
        body: blob,
        signal: controller.signal,
      })
      let body
      try {
        body = await response.json()
      } catch {
        body = '<non-json>'
      }
      return { status: response.status, body }
    } finally {
      clearTimeout(timeoutId)
    }
  }, { url: WORKER_URL, bearer: SHARED_SECRET, timeoutMs: REQUEST_TIMEOUT_MS })

  if (result.status === 200 && result.body?.ok === true) {
    ok('POST /transcribe?lang=zh&gated=1 from WebKit', `text="${(result.body.text ?? '').slice(0, 30)}"`)
  } else {
    fail(
      'POST /transcribe?lang=zh&gated=1 from WebKit',
      `status=${result.status} body=${JSON.stringify(result.body).slice(0, 120)}`,
    )
  }
} catch (error) {
  fail('POST /transcribe?lang=zh&gated=1 from WebKit', error instanceof Error ? error.message : String(error))
}
} finally {
  await browser.close()
}

console.log()
console.log(`Result: ${PASS.length} passed, ${FAIL.length} failed`)
if (FAIL.length > 0) {
  console.log('Failures:')
  for (const failure of FAIL) console.log(`  - ${failure.name}: ${failure.detail}`)
  process.exit(1)
}
