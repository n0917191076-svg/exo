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

const PORT = Number.parseInt(process.env.PORT ?? '8787', 10)
const LATENCY_MS = Number.parseInt(process.env.LATENCY_MS ?? '200', 10)

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
  date: [
    'Ask what made today feel long',
    'Mirror the feeling: "sounds draining"',
    'Pivot to a lighter topic — weekend plans?',
  ],
  'argue-calm': [
    'Acknowledge: "I hear that mattered to you"',
    'Ask what outcome would feel right',
    'Name the shared goal you both want',
  ],
  'sales-close': [
    'Confirm the value they just named',
    'Ask which of two next steps fits better',
    'Move to a small commitment first',
  ],
  sting: [
    'Reframe with a quick question back',
    'Lighten with self-deprecating wit',
    'Hold ground with one calm sentence',
  ],
  listen: [
    'Reflect the last word they emphasized',
    'Stay quiet — leave a 3-second pause',
    'Ask one open-ended question',
  ],
  interview: [
    'Tie answer to a measurable outcome',
    'Ask what success looks like at 90 days',
    'Bridge to your relevant experience',
  ],
  custom: [
    '(custom prompt — first reply)',
    '(custom prompt — second reply)',
    '(custom prompt — third reply)',
  ],
}

let transcribeIdx = 0

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

const server = createServer(async (req, res) => {
  const t0 = Date.now()
  const url = req.url ?? '/'
  const method = req.method ?? 'GET'

  if (method === 'OPTIONS') {
    return send(res, 204, '')
  }

  if (method === 'GET' && url === '/healthz') {
    console.log(`${new Date().toISOString()}  GET  /healthz`)
    return send(res, 200, 'ok', 'text/plain')
  }

  if (method === 'POST' && url === '/transcribe') {
    const body = await readBody(req)
    if (LATENCY_MS > 0) await new Promise(r => setTimeout(r, LATENCY_MS))
    const fixture = TRANSCRIBE_FIXTURES[transcribeIdx % TRANSCRIBE_FIXTURES.length]
    transcribeIdx += 1
    console.log(
      `${new Date().toISOString()}  POST /transcribe  ${(body.byteLength / 1024).toFixed(1)}KB  ${Date.now() - t0}ms  → "${fixture.text.slice(0, 50)}"`,
    )
    return send(res, 200, { ok: true, ...fixture })
  }

  if (method === 'POST' && url === '/suggest') {
    const body = await readBody(req)
    let payload = {}
    try { payload = JSON.parse(body.toString('utf8')) } catch { /* ignore */ }
    const mode = payload.mode ?? 'date'
    const suggestions = SUGGEST_FIXTURES[mode] ?? SUGGEST_FIXTURES.date
    if (LATENCY_MS > 0) await new Promise(r => setTimeout(r, LATENCY_MS))
    console.log(
      `${new Date().toISOString()}  POST /suggest     mode=${mode} transcript="${(payload.transcript ?? '').slice(0, 40)}…"  ${Date.now() - t0}ms`,
    )
    return send(res, 200, { ok: true, suggestions })
  }

  console.log(`${new Date().toISOString()}  ${method} ${url}  → 404`)
  return send(res, 404, { ok: false, error: 'not found' })
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
