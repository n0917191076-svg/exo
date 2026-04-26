// Cue — multi-mode conversation coach for Even G2 glasses.
//
// v0.1.0 (this file): scaffold + privacy opt-in + mode picker +
// MOCK suggestion driver. The whole flow is exercisable on real glasses
// without any API keys or Worker deployment — suggestions appear on a
// timer using a small canned script, just to demonstrate the UX.
//
// v0.2.0+ (planned): real Deepgram STT via Worker, real LLM via Worker.
// See ~/Documents/Pulse/ROADMAP.md § "Plan: Cue".

import { connectEvenRuntime, type EvenRuntime, type InputSource, type SwipeDir } from './even'
import { DEFAULT_MODE, MODES, type Mode, type ModeId, modeById, nextMode } from './modes'
import { nextMockExchange, nextMockProactiveTopics, resetMock } from './mock'
import {
  getCustomPrompt,
  getMode,
  getWorkerToken,
  getWorkerUrl,
  hasAgreedToPrivacy,
  setCustomPrompt,
  setMode,
  setPrivacyAgreed,
  setStorageBridge,
  setWorkerToken,
  setWorkerUrl,
} from './storage'
import { createTransport, type CueTransport, type TranscriptEvent } from './transport'

// --- module state ---

let even: EvenRuntime | null = null
let currentMode: ModeId = DEFAULT_MODE
let micOn = false
let agreedToPrivacy = false
let lastTranscript = ''
let suggestions: string[] = []
let proactiveActive = false // true when user just ring-tapped for topics
let mockTimer: number | null = null
// Repainting timer that lets the diagnostic stats line refresh while
// mic is on but no transcripts are flowing yet (early frames-flow check).
let realStatsTimer: number | null = null

// Honest cadence for v0.1.0 mock mode. v0.2.0+ replaces the timer with
// real STT-driven triggers (silence detection, partial-transcript pulses).
const MOCK_TICK_MS = 8_000

// Real-mode tuning — when Worker is configured.
// - request a fresh suggestion every N seconds of new transcript
const SUGGEST_DEBOUNCE_MS = 6_000
// - sliding transcript window we send to the LLM (tail of last N chars)
const TRANSCRIPT_WINDOW_CHARS = 1200

let transport: CueTransport | null = null
let isRealMode = false // true when transport.ready (Worker configured)
let liveTranscript = '' // accumulated final transcripts
let lastSuggestionAt = 0
let suggestionInFlight = false

// --- DOM scaffold (phone-side) ---

const root = document.querySelector<HTMLDivElement>('#app')
if (!root) throw new Error('App root missing')

root.innerHTML = `
  <main style="font-family: system-ui; padding: 1rem; max-width: 720px; margin: 0 auto; color: #232323;">
    <h1 style="margin: 0 0 .25rem 0;">Cue <span style="font-size: .55em; color: #7b7b7b; font-weight: 400;">v${__APP_VERSION__}</span></h1>
    <p style="color: #7b7b7b; margin: 0 0 1rem 0;">Helps you say the right thing.</p>
    <p id="status" style="margin: 0 0 1rem 0;">Connecting…</p>

    <div id="privacy-modal" style="display: none; position: fixed; inset: 0; background: rgba(0,0,0,.6); align-items: center; justify-content: center; z-index: 100;">
      <div style="background: #fff; max-width: 520px; padding: 1.5rem; border-radius: 8px; box-shadow: 0 10px 40px rgba(0,0,0,.3);">
        <h2 style="margin: 0 0 .5rem 0;">Before you start</h2>
        <p>
          Cue records audio from the glasses microphone to suggest responses.
          Audio streams to a transcription service and is dropped — Cue never
          stores recordings.
        </p>
        <p style="font-weight: 600;">
          You are responsible for ensuring this is legal where you are.
          Recording someone without their knowledge is illegal in some
          jurisdictions (CA, FL, IL, MD, MA, MT, NH, PA, WA in the US, and
          many countries).
        </p>
        <p>
          The mic is OFF by default and requires explicit opt-in each
          session. The mic indicator stays visible whenever Cue is listening.
        </p>
        <div style="display: flex; gap: .5rem; justify-content: flex-end; margin-top: 1rem;">
          <button id="privacy-decline" type="button" style="padding: .5rem 1rem; cursor: pointer; background: #eee;">No thanks</button>
          <button id="privacy-accept" type="button" style="padding: .5rem 1rem; cursor: pointer; background: #232323; color: #fff;">I understand — continue</button>
        </div>
      </div>
    </div>

    <section>
      <h2 style="font-size: 1.1em; margin: 1rem 0 .5rem 0;">Mode</h2>
      <div id="mode-list" style="display: grid; gap: .5rem; max-width: 520px;"></div>
    </section>

    <section>
      <h2 style="font-size: 1.1em; margin: 1.5rem 0 .5rem 0;">Custom prompt (used when Mode = Custom)</h2>
      <textarea id="custom-prompt" rows="4" style="width: 100%; max-width: 520px; padding: .5rem; box-sizing: border-box; font-family: ui-monospace, monospace; font-size: .9em;" placeholder="You are a... Suggest 2-3 short responses, numbered, no preamble."></textarea>
      <button id="save-custom" type="button" style="margin-top: .35rem; padding: .35rem .7rem; cursor: pointer;">Save custom prompt</button>
    </section>

    <section>
      <h2 style="font-size: 1.1em; margin: 1.5rem 0 .5rem 0;">Worker (v0.2.0+)</h2>
      <p style="color: #7b7b7b; font-size: .9em; max-width: 520px;">
        v0.1.0 uses MOCK suggestions on a timer — no API keys needed.
        v0.2.0 onwards routes mic audio through your personal Cloudflare Worker
        for real STT + LLM. Set those credentials here in advance.
      </p>
      <div style="display: grid; gap: .25rem; max-width: 520px;">
        <label>Worker URL <input id="worker-url" type="url" placeholder="https://cue-worker.your-sub.workers.dev" style="padding: .35rem; width: 100%; box-sizing: border-box;" /></label>
        <label>Bearer token <input id="worker-token" type="password" placeholder="(SHARED_SECRET from Worker)" style="padding: .35rem; width: 100%; box-sizing: border-box; font-family: monospace;" /></label>
        <button id="save-worker" type="button" style="margin-top: .25rem; padding: .35rem .7rem; cursor: pointer; max-width: 200px;">Save Worker config</button>
        <p id="worker-status" style="color: #2a2; font-size: .85em; min-height: 1.2em;"></p>
      </div>
    </section>

    <section style="margin-top: 2rem; color: #7b7b7b; font-size: .85em;">
      <h3 style="font-size: 1em; margin: 0 0 .5rem 0;">How to use</h3>
      <ol style="padding-left: 1.25rem; line-height: 1.5;">
        <li>Pick a mode from the list above.</li>
        <li>Put on the glasses and open Cue from the Even Hub launcher.</li>
        <li>Tap glasses to toggle mic on/off (privacy escape: glasses double-tap or remove glasses).</li>
        <li>v0.1.0 produces mock suggestions on a timer so you can try the flow. Real STT + LLM lands in v0.2+.</li>
      </ol>
    </section>
  </main>
`

const status = document.querySelector<HTMLParagraphElement>('#status')!
const modeList = document.querySelector<HTMLDivElement>('#mode-list')!
const customPromptInput = document.querySelector<HTMLTextAreaElement>('#custom-prompt')!
const saveCustomBtn = document.querySelector<HTMLButtonElement>('#save-custom')!
const workerUrlInput = document.querySelector<HTMLInputElement>('#worker-url')!
const workerTokenInput = document.querySelector<HTMLInputElement>('#worker-token')!
const saveWorkerBtn = document.querySelector<HTMLButtonElement>('#save-worker')!
const workerStatus = document.querySelector<HTMLParagraphElement>('#worker-status')!
const privacyModal = document.querySelector<HTMLDivElement>('#privacy-modal')!
const privacyAccept = document.querySelector<HTMLButtonElement>('#privacy-accept')!
const privacyDecline = document.querySelector<HTMLButtonElement>('#privacy-decline')!

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
}

function renderModeList(): void {
  modeList.innerHTML = MODES.map(
    m => `
    <label style="display: flex; gap: .75rem; align-items: flex-start; padding: .6rem .75rem; background: ${m.id === currentMode ? '#fef991' : '#eee'}; border-radius: 4px; cursor: pointer;">
      <input type="radio" name="mode" value="${m.id}" ${m.id === currentMode ? 'checked' : ''} style="margin-top: .2rem;" />
      <div style="flex: 1;">
        <div><span style="margin-right: .5rem;">${m.glyph}</span><strong>${escapeHtml(m.label)}</strong></div>
        <div style="color: #555; font-size: .85em; margin-top: .15rem;">${escapeHtml(m.description)}</div>
      </div>
    </label>
  `,
  ).join('')
  modeList.querySelectorAll<HTMLInputElement>('input[name="mode"]').forEach(input => {
    input.addEventListener('change', async () => {
      currentMode = input.value as ModeId
      await setMode(currentMode)
      renderModeList()
      await paint()
    })
  })
}

// --- glasses display ---

function trunc(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s
}

function renderGlasses(): string {
  const mode: Mode = modeById(currentMode)
  const micGlyph = micOn ? '●' : '○'
  const header = `${mode.glyph} ${mode.label.toUpperCase()}    ${micGlyph} ${micOn ? 'LIVE' : 'mic off'}`
  if (!agreedToPrivacy) {
    return [
      header,
      '',
      'Cue needs your consent before',
      'turning on the mic. Open Cue',
      'on your phone first to review',
      'and accept the privacy notice.',
    ].join('\n')
  }
  if (!micOn) {
    return [
      header,
      '',
      `Mode: ${mode.label}`,
      mode.description.length > 64 ? trunc(mode.description, 64) : mode.description,
      '',
      `${isRealMode ? '◉ live' : '◌ mock'} ready`,
      '[tap] start mic',
      '[2x] cycle mode',
    ].join('\n')
  }
  // Live view.
  const lines: string[] = [header, '']
  if (lastTranscript) {
    lines.push(trunc(lastTranscript, 100))
  } else {
    lines.push(proactiveActive ? 'Fresh topics:' : 'Listening…')
  }
  // Diagnostic stats — only shown in real mode while micOn. Lets the
  // operator see whether audio frames are flowing from the SDK to the
  // transport, and whether chunks are reaching the worker. If frames=0
  // after several seconds of speech, the SDK isn't emitting audioPcm
  // events; if frames>0 but chunks=0 or chunks-ok=0, the issue is
  // worker-side.
  if (isRealMode && transport) {
    const s = transport.stats()
    lines.push(`audio frames=${s.framesReceived} chunks=${s.chunksFlushed}/${s.chunksOk}ok`)
    if (s.lastError) {
      lines.push(`err: ${s.lastError}`)
    }
  }
  lines.push('')
  lines.push('—'.repeat(20))
  if (suggestions.length > 0) {
    suggestions.slice(0, 3).forEach((s, i) => {
      lines.push(`${i + 1}. ${trunc(s, 38)}`)
    })
  } else {
    lines.push('(suggestions appear here)')
  }
  lines.push('')
  lines.push(mode.proactiveSupported ? '[ring 2x] topics  [tap] mic' : '[tap] toggle mic')
  return lines.join('\n')
}

async function paint(): Promise<void> {
  if (!even) return
  const tag = !agreedToPrivacy ? 'gate' : !micOn ? 'idle' : proactiveActive ? 'proactive' : 'live'
  // eslint-disable-next-line no-console
  console.log(`[cue:state] mode=${currentMode} mic=${micOn ? 'on' : 'off'} stage=${tag} suggestions=${suggestions.length}`)
  await even.render(renderGlasses())
}

// --- mock-mode driver ---

function startMockTimer(): void {
  stopMockTimer()
  // Fire one immediately so the user sees something on tap-to-start.
  void runMockTick()
  mockTimer = window.setInterval(() => void runMockTick(), MOCK_TICK_MS)
}

function stopMockTimer(): void {
  if (mockTimer !== null) {
    window.clearInterval(mockTimer)
    mockTimer = null
  }
}

async function runMockTick(): Promise<void> {
  if (!micOn) return
  if (proactiveActive) return // ring-tap-driven topics override the reactive cycle until cleared
  const next = nextMockExchange(currentMode)
  lastTranscript = next.transcript
  suggestions = next.suggestions
  await paint()
}

async function showProactiveTopics(): Promise<void> {
  if (!micOn) return
  const mode = modeById(currentMode)
  if (!mode.proactiveSupported) return
  proactiveActive = true
  lastTranscript = '' // hide transcript area while showing fresh topics
  suggestions = nextMockProactiveTopics(currentMode)
  await paint()
  // Auto-clear after 12s and resume reactive cycle.
  window.setTimeout(() => {
    proactiveActive = false
    void paint()
  }, 12_000)
}

// --- input handlers ---

async function toggleMic(): Promise<void> {
  if (!agreedToPrivacy) return
  micOn = !micOn
  suggestions = []
  lastTranscript = ''
  liveTranscript = ''
  proactiveActive = false
  if (micOn) {
    if (isRealMode && transport && even) {
      await startRealSession()
    } else {
      resetMock()
      startMockTimer()
    }
  } else {
    stopMockTimer()
    if (realStatsTimer !== null) {
      window.clearInterval(realStatsTimer)
      realStatsTimer = null
    }
    if (transport) await transport.endMicSession()
    if (even) await even.stopMic()
  }
  await paint()
}

// --- real (Worker-backed) session ---

async function startRealSession(): Promise<void> {
  if (!transport || !even) return
  liveTranscript = ''
  lastSuggestionAt = 0
  // Transport now uses chunked HTTP POST instead of WebSocket (the WebView
  // blocks outbound WS handshakes — see transport.ts header comment).
  // startMicSession throws on worker-unreachable / probe-failed; per-chunk
  // network blips during the session come back via the onError callback.
  try {
    await transport.startMicSession(onTranscriptFrame, msg => {
      // Per-chunk transport error mid-session. Log but don't kill the
      // session; the next chunk still has a chance.
      // eslint-disable-next-line no-console
      console.warn('[cue] transcribe error:', msg)
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    lastTranscript = `(real-mode unavailable: ${msg.slice(0, 80)})`
    // eslint-disable-next-line no-console
    console.error('[cue] real-mode startMicSession failed:', msg)
    isRealMode = false
    resetMock()
    startMockTimer()
    await paint()
    return
  }
  // Ask the SDK to start the mic. PCM frames flow into transport via
  // sendAudioFrame; transport buffers and POSTs every CHUNK_MS.
  const ok = await even.startMic(frame => {
    transport?.sendAudioFrame(frame)
  })
  if (!ok) {
    lastTranscript = '(mic permission denied)'
    isRealMode = false
    await transport.endMicSession()
    resetMock()
    startMockTimer()
    await paint()
    return
  }
  lastTranscript = '(listening — say something)'
  // Repaint every 1.5s while real-mode mic is on so the diagnostic stats
  // line (audio frames=N chunks=X/Yok) updates even if no transcript
  // event has fired yet. Cleared when mic stops.
  if (realStatsTimer === null) {
    realStatsTimer = window.setInterval(() => { void paint() }, 1500)
  }
  await paint()
}

function onTranscriptFrame(e: TranscriptEvent): void {
  // Show the latest interim transcript to the user. On final, append to
  // the rolling window we send to the LLM.
  lastTranscript = e.text
  if (e.isFinal) {
    liveTranscript = `${liveTranscript} ${e.text}`.slice(-TRANSCRIPT_WINDOW_CHARS).trim()
    void maybeRequestSuggestions()
  }
  void paint()
}

async function maybeRequestSuggestions(): Promise<void> {
  if (!transport || !isRealMode) return
  if (suggestionInFlight) return
  if (Date.now() - lastSuggestionAt < SUGGEST_DEBOUNCE_MS) return
  if (liveTranscript.length < 16) return // too short to be useful
  suggestionInFlight = true
  lastSuggestionAt = Date.now()
  try {
    const customPrompt = currentMode === 'custom' ? await getCustomPrompt() : undefined
    const result = await transport.requestSuggestions({
      mode: currentMode,
      transcript: liveTranscript,
      customPrompt,
    })
    if (result.ok) {
      suggestions = result.suggestions
    } else {
      suggestions = [`(LLM error: ${result.error.slice(0, 40)})`]
    }
    await paint()
  } finally {
    suggestionInFlight = false
  }
}

async function cycleMode(): Promise<void> {
  currentMode = nextMode(currentMode)
  await setMode(currentMode)
  renderModeList()
  await paint()
}

function onTap(_src: InputSource): void {
  if (!agreedToPrivacy) return // require phone-side opt-in first
  if (!micOn) {
    void toggleMic()
    return
  }
  // Mic on: tap toggles mic off (so the user can pause quickly).
  void toggleMic()
}

function onDoubleTap(source: InputSource): void {
  if (!agreedToPrivacy) {
    if (even) void even.exitApp()
    return
  }
  if (!micOn) {
    // Idle: cycle mode regardless of source.
    void cycleMode()
    return
  }
  // Mic on, ring 2x = proactive topics; glasses 2x = exit (stops mic too).
  if (source === 'ring') {
    void showProactiveTopics()
    return
  }
  if (even) {
    micOn = false
    stopMockTimer()
    void even.exitApp()
  }
}

function onSwipe(_dir: SwipeDir): void {
  // Reserved for v0.2+ — could let the user scroll back through the
  // transcript buffer or page through more suggestions.
}

// --- privacy modal handlers ---

privacyAccept.addEventListener('click', async () => {
  agreedToPrivacy = true
  await setPrivacyAgreed()
  privacyModal.style.display = 'none'
  await paint()
})
privacyDecline.addEventListener('click', () => {
  privacyModal.style.display = 'none'
  status.textContent = 'Privacy notice declined. You can re-open Cue anytime to accept.'
})

// --- form handlers ---

saveCustomBtn.addEventListener('click', async () => {
  await setCustomPrompt(customPromptInput.value)
  saveCustomBtn.textContent = 'Saved ✓'
  window.setTimeout(() => { saveCustomBtn.textContent = 'Save custom prompt' }, 2000)
})

saveWorkerBtn.addEventListener('click', async () => {
  await setWorkerUrl(workerUrlInput.value)
  await setWorkerToken(workerTokenInput.value)
  // Re-initialize transport so the next mic session uses the new config.
  transport = createTransport(workerUrlInput.value.trim(), workerTokenInput.value.trim())
  isRealMode = transport.ready
  workerStatus.style.color = '#2a2'
  workerStatus.textContent = isRealMode
    ? 'Saved. Real STT + LLM active on next mic session.'
    : 'Saved (URL + token incomplete — mock mode will run).'
  window.setTimeout(() => { workerStatus.textContent = '' }, 4000)
  // Force an immediate glasses repaint so the ◉ live / ◌ mock indicator
  // reflects the new state without waiting for the next user gesture.
  void paint()
})

// --- bootstrap ---

async function bootstrap(): Promise<void> {
  // eslint-disable-next-line no-console
  console.log('[cue] bootstrap start')
  status.textContent = 'Connecting to glasses…'
  even = await connectEvenRuntime(`Cue v${__APP_VERSION__}\n\nLoading…`)

  if (even) {
    setStorageBridge({ getStorage: even.getStorage, setStorage: even.setStorage })
  }

  // Hydrate state.
  agreedToPrivacy = await hasAgreedToPrivacy()
  // In dev mode (Vite dev server), auto-accept the privacy gate so the
  // simulator regression test and developer workflow aren't blocked by
  // the phone-side modal. Production .ehpk installs run with
  // import.meta.env.DEV === false and require explicit user opt-in.
  if (!agreedToPrivacy && import.meta.env.DEV) {
    agreedToPrivacy = true
    await setPrivacyAgreed()
    // eslint-disable-next-line no-console
    console.log('[cue:state] dev-mode auto-accepted privacy (production requires real opt-in)')
  }
  const persistedMode = await getMode()
  if (persistedMode) currentMode = persistedMode
  customPromptInput.value = await getCustomPrompt()
  const wUrl = await getWorkerUrl()
  const wTok = await getWorkerToken()
  workerUrlInput.value = wUrl
  workerTokenInput.value = wTok
  // Set up transport if both Worker URL + token are configured. If they're
  // unset or change later, mock mode runs.
  transport = createTransport(wUrl, wTok)
  isRealMode = transport.ready
  renderModeList()

  if (!agreedToPrivacy) {
    privacyModal.style.display = 'flex'
  }

  if (!even) {
    status.textContent = 'Running outside the Even runtime — browser preview only.'
    return
  }
  status.textContent = agreedToPrivacy
    ? 'Glasses connected. Use them to start a session.'
    : 'Glasses connected. Accept the privacy notice to enable mic.'

  even.onTap(onTap)
  even.onSwipe(onSwipe)
  even.onDoubleTap(onDoubleTap)
  even.onForeground(() => { void paint() })

  await paint()
}

void bootstrap().catch(err => {
  // eslint-disable-next-line no-console
  console.error('[cue] bootstrap threw:', err?.message ?? err, err?.stack)
})
