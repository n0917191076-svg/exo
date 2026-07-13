#!/usr/bin/env node
// Local stub of the Cue Worker. Lets you exercise the full chunked-POST
// audio pipeline from the dev preview without deploying a Cloudflare
// Worker or burning Deepgram credits.
//
// Usage:
//   node scripts/dev-worker.mjs                 # default port 8787, 200ms latency
//   PORT=9000 node scripts/dev-worker.mjs       # custom port
//   LATENCY_MS=800 node scripts/dev-worker.mjs  # simulate Deepgram batch delay
//
// Then in Cue's phone settings:
//   Worker URL: http://localhost:8787
//   Bearer:    anything-non-empty (token is not validated locally)
//
// What it returns:
//   GET  /healthz   → "ok"
//   POST /transcribe → canned 2-speaker utterances, rotating, timestamped
//                      so each call shows new text on the glasses.
//   POST /suggest    → mode-aware canned suggestions (3-tuple).
//
// Pure Node http — no dependencies. Logs each request with byte count
// and wall-clock latency so you can see chunking happen in real time.

import { createServer } from 'node:http'

// Two-speaker conversational fixtures. Rotated round-robin per /transcribe
// call so the glasses see fresh text on every chunk. Each entry is one
// "chunk's worth" of utterances — speaker IDs alternate to demonstrate
// diarization end-to-end.
const TRANSCRIBE_FIXTURES = [
  {
    text: 'How was your day at work',
    utterances: [{ speaker: 1, text: 'How was your day at work', confidence: 0.94 }],
  },
  {
    text: 'It was pretty good thanks for asking',
    utterances: [{ speaker: 0, text: 'It was pretty good thanks for asking', confidence: 0.92 }],
  },
  {
    text: 'Did you finish the report you were stressed about',
    utterances: [{ speaker: 1, text: 'Did you finish the report you were stressed about', confidence: 0.93 }],
  },
  {
    text: 'Yeah I sent it just before lunch the team seemed happy',
    utterances: [{ speaker: 0, text: 'Yeah I sent it just before lunch the team seemed happy', confidence: 0.95 }],
  },
  {
    text: 'Hey want to get dinner this week',
    utterances: [
      { speaker: 1, text: 'Hey want to get dinner this week', confidence: 0.91 },
    ],
  },
  {
    text: 'Sure how about Thursday what is your schedule like',
    utterances: [
      { speaker: 0, text: 'Sure how about Thursday', confidence: 0.93 },
      { speaker: 1, text: 'what is your schedule like', confidence: 0.88 },
    ],
  },
]

// Per-mode canned suggestions. Stand-ins for the LLM output the real
// worker produces — kept short and shape-correct so the glasses render
// matches what the user will see in production.
const SUGGEST_FIXTURES = {
  work: [
    '結論：我有八年產線管理經驗。',
    '我在 AI 投資競賽拿過第一名。',
    '我的強項是數據分析與風控。',
  ],
  daily: [
    '最近在忙求職，還算充實。',
    '有在研究投資和 AI 的東西。',
    '你呢？最近過得怎樣？',
  ],
  custom: [
    '（自訂 prompt — 第一條回覆）',
    '（自訂 prompt — 第二條回覆）',
    '（自訂 prompt — 第三條回覆）',
  ],
}

function send(res, status, body, contentType = 'application/json') {
  res.writeHead(status, {
    'Content-Type': contentType,
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  })
  res.end(typeof body === 'string' ? body : JSON.stringify(body))
}

async function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', c => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

/**
 * Build an http.Server with the dev-worker request handler. Exported so
 * tests can spawn an instance on an ephemeral port, hit it, and close.
 *
 * Options:
 *   latencyMs: simulated batch delay before responding (default 0 in
 *              factory; the CLI entry below defaults to 200 for realism).
 *   logger:    function called for every handled request. Defaults to
 *              no-op so tests don't litter output; the CLI sets a console
 *              logger.
 */
export function createDevWorker({ latencyMs = 0, logger = () => {} } = {}) {
  let transcribeIdx = 0
  return createServer(async (req, res) => {
    const t0 = Date.now()
    // 路由只看 path — Phase 1 起 /transcribe 會帶 ?lang= query
    const url = (req.url ?? '/').split('?')[0]
    const method = req.method ?? 'GET'

    if (method === 'OPTIONS') {
      return send(res, 204, '')
    }

    if (method === 'GET' && url === '/healthz') {
      logger({ method, url, status: 200 })
      return send(res, 200, 'ok', 'text/plain')
    }

    if (method === 'POST' && url === '/transcribe') {
      const body = await readBody(req)
      if (latencyMs > 0) await new Promise(r => setTimeout(r, latencyMs))
      const fixture = TRANSCRIBE_FIXTURES[transcribeIdx % TRANSCRIBE_FIXTURES.length]
      transcribeIdx += 1
      logger({ method, url, status: 200, bytes: body.byteLength, ms: Date.now() - t0, summary: fixture.text.slice(0, 50) })
      return send(res, 200, { ok: true, ...fixture })
    }

    if (method === 'POST' && url === '/suggest') {
      const body = await readBody(req)
      let payload = {}
      try { payload = JSON.parse(body.toString('utf8')) } catch { /* ignore */ }
      const mode = payload.mode ?? 'work'
      const suggestions = SUGGEST_FIXTURES[mode] ?? SUGGEST_FIXTURES.work
      if (latencyMs > 0) await new Promise(r => setTimeout(r, latencyMs))
      logger({ method, url, status: 200, mode, transcript: payload.transcript ?? '', ms: Date.now() - t0 })
      return send(res, 200, { ok: true, suggestions })
    }

    logger({ method, url, status: 404 })
    return send(res, 404, { ok: false, error: 'not found' })
  })
}

// CLI entry — run `node scripts/dev-worker.mjs` (or `npm run dev:worker`).
// Skipped when imported as a module (e.g., from a test).
const isCli = import.meta.url === `file://${process.argv[1]}`
if (isCli) {
  const PORT = Number.parseInt(process.env.PORT ?? '8787', 10)
  const LATENCY_MS = Number.parseInt(process.env.LATENCY_MS ?? '200', 10)
  const server = createDevWorker({
    latencyMs: LATENCY_MS,
    logger: (e) => {
      const ts = new Date().toISOString()
      if (e.url === '/transcribe') {
        console.log(`${ts}  POST /transcribe  ${(e.bytes / 1024).toFixed(1)}KB  ${e.ms}ms  → "${e.summary}"`)
      } else if (e.url === '/suggest') {
        console.log(`${ts}  POST /suggest     mode=${e.mode} transcript="${e.transcript.slice(0, 40)}…"  ${e.ms}ms`)
      } else {
        console.log(`${ts}  ${e.method} ${e.url}  → ${e.status}`)
      }
    },
  })
  server.listen(PORT, () => {
    console.log(`Cue dev-worker listening on http://localhost:${PORT}`)
    console.log(`  Latency:  ${LATENCY_MS}ms (set LATENCY_MS to change)`)
    console.log(`  Endpoints: /healthz  /transcribe  /suggest`)
    console.log(`  Configure phone settings:`)
    console.log(`    Worker URL: http://localhost:${PORT}`)
    console.log(`    Bearer:     anything-non-empty`)
    console.log(``)
  })
}
