#!/usr/bin/env node
// End-to-end regression test for Cue via the Even Hub simulator HTTP API.
// Verifies the UX flow only — privacy gate, gated capture toggle, answer
// persistence (Phase 4), mock suggestion ticks. Real audio capture / STT / LLM cannot be exercised in
// the simulator (no audio input injection); that path is tested via the
// offline Worker round-trip (scripts/worker-test.mjs) and manually on
// real glasses with a deployed Worker.
//
// Prereqs (run manually first):
//   1. cd ~/Documents/Cue && npm run dev          # Vite on :5176
//   2. npx evenhub-simulator --automation-port 9897 http://localhost:5176
//
// Then: npm run test:e2e

import { writeFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SIM_BASE = 'http://127.0.0.1:9897'
const HERE = dirname(fileURLToPath(import.meta.url))
const OUT_DIR = join(HERE, '..', 'tests', 'screenshots-regression')

let lastConsoleId = -1
let pass = 0
let fail = 0
const failures = []

async function ping() {
  const r = await fetch(`${SIM_BASE}/api/ping`)
  if (!r.ok) throw new Error(`simulator not reachable on ${SIM_BASE}`)
}
async function input(action) {
  const r = await fetch(`${SIM_BASE}/api/input`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action }),
  })
  if (!r.ok) throw new Error(`input ${action} failed: ${r.status}`)
}
async function fetchConsoleEntries() {
  const r = await fetch(`${SIM_BASE}/api/console`)
  const body = await r.json()
  return body.entries ?? []
}
async function waitForState(predicate, { timeoutMs = 15_000, label } = {}) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const entries = await fetchConsoleEntries()
    const fresh = entries.filter(e => e.id > lastConsoleId)
    for (const e of fresh) {
      if (typeof e.message === 'string' && e.message.includes('[cue:state]') && predicate(e.message)) {
        lastConsoleId = e.id
        return e
      }
      if (e.id > lastConsoleId) lastConsoleId = e.id
    }
    await new Promise(r => setTimeout(r, 200))
  }
  throw new Error(`timed out waiting for state: ${label ?? '(unlabeled)'}`)
}
// Sample over `durationMs`, return count of [cue:state] logs that
// appeared during the window. Lets us catch the silent-render-loop
// regression where the app emits the right state once and then stops.
// Pattern lifted from lyrics-glow (which has the most fragile render
// cadence of the four apps).
async function countStateLogs(durationMs) {
  const before = await fetchConsoleEntries()
  const startId = before.length > 0 ? before[before.length - 1].id : -1
  await new Promise(r => setTimeout(r, durationMs))
  const after = await fetchConsoleEntries()
  const fresh = after.filter(e => e.id > startId && typeof e.message === 'string' && e.message.includes('[cue:state]'))
  if (fresh.length > 0) lastConsoleId = Math.max(lastConsoleId, fresh[fresh.length - 1].id)
  return fresh.length
}

async function screenshot(name) {
  await mkdir(OUT_DIR, { recursive: true })
  const r = await fetch(`${SIM_BASE}/api/screenshot/glasses`)
  const buf = Buffer.from(await r.arrayBuffer())
  await writeFile(join(OUT_DIR, `${name}.png`), buf)
}
function check(label, condition, detail = '') {
  if (condition) {
    console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`)
    pass += 1
  } else {
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`)
    failures.push(label)
    fail += 1
  }
}

async function main() {
  console.log('Cue regression test')
  console.log(`  simulator: ${SIM_BASE}`)
  console.log()

  await ping()
  const initial = await fetchConsoleEntries()
  if (initial.length > 0) lastConsoleId = initial[initial.length - 1].id

  // The privacy gate is the first visible state. To progress past it
  // automatically we'd need to drive the phone-side accept button; the
  // simulator API only injects glasses input. So this test assumes the
  // user has already accepted privacy on a previous run (storage
  // persists across simulator restarts in the local dev preview).
  console.log('1. Initial idle view (mic off)')
  await screenshot('01-initial')
  // WSL 模擬器偶發「幽靈 tap」（開機 ~8s 自發單擊，見 KNOWN_QUIRKS）—
  // 先歸零：若最後一筆狀態是 mic=on，補一次 click 關掉再開始。
  const boot = await fetchConsoleEntries()
  const lastState = [...boot].reverse().find(e => typeof e.message === 'string' && e.message.includes('[cue:state]'))
  if (lastState && lastState.message.includes('mic=on')) {
    console.log('   (normalize: phantom tap left mic on — clicking it off first)')
    await input('click')
    await waitForState(m => m.includes('mic=off'), { label: 'normalize mic off', timeoutMs: 4_000 })
  }
  // Phase 4 起雙擊待命＝退出（不再循環模式），不能拿它當 baseline。
  // 直接用單擊開閘門收音取得第一筆狀態。
  console.log('2. Tap to start gated capture (mock session)')
  await input('click')
  const live = await waitForState(
    m => m.includes('mic=on') && m.includes('stage=live'),
    { label: 'mic-on live state', timeoutMs: 5_000 },
  )
  check('tap opens the gate (mic on, mock mode)', live.message.includes('mic=on'), live.message)
  await screenshot('02-live')

  console.log('3. Wait for mock suggestions to populate')
  const withSuggestions = await waitForState(
    m => m.includes('mic=on') && m.includes('suggestions=') && !m.includes('suggestions=0'),
    { label: 'mock suggestions populated', timeoutMs: 4_000 },
  )
  const sm = withSuggestions.message.match(/suggestions=(\d+)/)
  const suggCount = sm ? parseInt(sm[1], 10) : 0
  check('mock driver populates suggestions on tick', suggCount > 0, `${suggCount} suggestions`)
  await screenshot('03-suggestions')

  console.log('4. Tap to close the gate — answer must stay on screen')
  await input('click')
  const answerShown = await waitForState(
    m => m.includes('mic=off'),
    { label: 'gate closed', timeoutMs: 3_000 },
  )
  // Phase 4 核心：gate-stop 後建議保留（回答顯示中），不歸零。
  const am = answerShown.message.match(/suggestions=(\d+)/)
  const answerCount = am ? parseInt(am[1], 10) : 0
  check('answer persists after gate-stop (hasAnswer)', answerCount > 0, answerShown.message)
  await screenshot('04-answer-kept')

  console.log('5. Double-tap while answer shown must NOT exit (extend semantics)')
  await input('double_click')
  await new Promise(r => setTimeout(r, 500))
  // mock 模式 extend 是 no-op，但 app 必須還活著：再開一次閘門驗證。
  await input('click')
  const aliveAgain = await waitForState(
    m => m.includes('mic=on'),
    { label: 'app alive after double-tap on answer', timeoutMs: 4_000 },
  )
  check('double-tap on answer does not exit the app', aliveAgain.message.includes('mic=on'), aliveAgain.message)

  console.log('6. Render loop liveness (3s sample, mic on)')
  const ticks = await countStateLogs(3_000)
  check('render loop emits state logs while mic on', ticks >= 2, `${ticks} state logs in 3s`)
  await input('click') // gate off
  await waitForState(m => m.includes('mic=off'), { label: 'mic off after liveness', timeoutMs: 3_000 })

  console.log()
  console.log(`Result: ${pass} passed, ${fail} failed`)
  if (fail > 0) {
    console.log('Failures:')
    for (const f of failures) console.log(`  - ${f}`)
    process.exit(1)
  }
}

main().catch(err => {
  console.error('FATAL:', err.message)
  process.exit(1)
})
