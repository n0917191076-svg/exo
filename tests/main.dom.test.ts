// JSDOM tests for the Cue plugin's phone-side state machine.
//
// Why this exists: the simulator and unit-tests-with-mocked-fetch can't
// see DOM-level state-machine bugs like "save handler updates internal
// state but never repaints" or "tap mic but isRealMode wasn't yet true."
// JSDOM lets us mount the actual page, drive the same event handlers
// the user would, and assert on the rendered glasses content.
//
// The test does NOT exercise the BLE / mic / network paths — those go
// through `connectEvenRuntime()` which returns null in jsdom (no Even
// bridge) and through `transport` which we mock. The point is to cover
// state-transition correctness only.

/// <reference types="vitest/globals" />
// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// We re-import main.ts on every test to reset its module-level state.
// vitest's `vi.resetModules()` makes each `import('../src/main')` fresh.
async function bootPlugin(opts: {
  storage?: Record<string, string>
  fetchMock?: (url: string, init?: RequestInit) => Promise<Response>
} = {}) {
  vi.resetModules()
  // Stub localStorage with the provided values.
  const store = { ...(opts.storage ?? {}) }
  globalThis.localStorage = {
    getItem: (k: string) => store[k] ?? null,
    setItem: (k: string, v: string) => { store[k] = v },
    removeItem: (k: string) => { delete store[k] },
    clear: () => { for (const k of Object.keys(store)) delete store[k] },
    key: (i: number) => Object.keys(store)[i] ?? null,
    get length() { return Object.keys(store).length },
  } as Storage

  if (opts.fetchMock) {
    globalThis.fetch = opts.fetchMock as typeof fetch
  }

  // Provide a minimal #app root so main.ts has somewhere to render.
  document.body.innerHTML = '<div id="app"></div>'

  // Boot. main.ts' top-level bootstrap will run; connectEvenRuntime()
  // returns null in jsdom (the bridge isn't there). We await a tick so
  // bootstrap's async work settles.
  // @ts-expect-error — define is normally injected by Vite at build time
  globalThis.__APP_VERSION__ = '0.0.0-test'
  await import('../src/main')
  await new Promise(r => setTimeout(r, 50))
}

afterEach(() => {
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

describe('Cue plugin DOM state machine', () => {
  it('dev-mode auto-accepts the privacy gate (no modal in vitest)', async () => {
    // In dev mode (vitest uses it) main.ts auto-sets agreedToPrivacy=true
    // so the simulator regression isn't blocked by the modal. We assert
    // this dev-only path still works — if someone deletes the
    // import.meta.env.DEV branch, this test fails. Production .ehpk runs
    // with DEV=false and surfaces the modal correctly.
    await bootPlugin()
    const modal = document.querySelector<HTMLDivElement>('#privacy-modal')
    expect(modal).not.toBeNull()
    expect(modal!.style.display).toBe('none')
  })

  it('hides the privacy modal when an agreement is already stored', async () => {
    await bootPlugin({ storage: { 'cue:privacy-agreed:v1': '1' } })
    const modal = document.querySelector<HTMLDivElement>('#privacy-modal')
    // Modal default style is display:none; we expect it to STAY none.
    expect(modal!.style.display).toBe('none')
  })

  it('save-worker button updates worker status text immediately', async () => {
    await bootPlugin({ storage: { 'cue:privacy-agreed:v1': '1' } })
    const url = document.querySelector<HTMLInputElement>('#worker-url')!
    const token = document.querySelector<HTMLInputElement>('#worker-token')!
    const save = document.querySelector<HTMLButtonElement>('#save-worker')!
    const status = document.querySelector<HTMLElement>('#worker-status')!

    url.value = 'https://example.workers.dev'
    token.value = 'super-secret-bearer'
    save.click()
    // Allow microtask + storage write.
    await new Promise(r => setTimeout(r, 30))

    expect(status.textContent ?? '').toMatch(/Saved/i)
  })

  it('save-worker with both fields blank sets the "incomplete" status', async () => {
    await bootPlugin({ storage: { 'cue:privacy-agreed:v1': '1' } })
    const save = document.querySelector<HTMLButtonElement>('#save-worker')!
    const status = document.querySelector<HTMLElement>('#worker-status')!
    save.click()
    await new Promise(r => setTimeout(r, 30))
    expect(status.textContent ?? '').toMatch(/incomplete|mock/i)
  })

  it('mode list renders all built-in modes', async () => {
    await bootPlugin({ storage: { 'cue:privacy-agreed:v1': '1' } })
    const list = document.querySelector<HTMLDivElement>('#mode-list')!
    // Each mode is a <label> wrapping a radio input. Count the radios.
    const radios = list.querySelectorAll<HTMLInputElement>('input[type="radio"][name="mode"]')
    expect(radios.length).toBeGreaterThanOrEqual(6)
  })
})
