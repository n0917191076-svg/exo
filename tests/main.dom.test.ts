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
    expect(radios.length).toBe(3)
  })

  it('idle-auto-pause input hydrates from storage and persists changes', async () => {
    await bootPlugin({
      storage: {
        'cue:privacy-agreed:v1': '1',
        'cue:idle-auto-pause-min:v1': '12',
      },
    })
    const input = document.querySelector<HTMLInputElement>('#idle-auto-pause-min')!
    const save = document.querySelector<HTMLButtonElement>('#save-idle')!
    const status = document.querySelector<HTMLElement>('#idle-status')!

    expect(input.value).toBe('12')
    input.value = '0'
    save.click()
    await new Promise(r => setTimeout(r, 30))
    expect(globalThis.localStorage.getItem('cue:idle-auto-pause-min:v1')).toBe('0')
    expect(status.textContent ?? '').toMatch(/disabled/i)

    input.value = '7'
    save.click()
    await new Promise(r => setTimeout(r, 30))
    expect(globalThis.localStorage.getItem('cue:idle-auto-pause-min:v1')).toBe('7')
    expect(status.textContent ?? '').toMatch(/7 min/)
  })

  it('idle-auto-pause input rejects negative values, falls back to default', async () => {
    await bootPlugin({ storage: { 'cue:privacy-agreed:v1': '1' } })
    const input = document.querySelector<HTMLInputElement>('#idle-auto-pause-min')!
    const save = document.querySelector<HTMLButtonElement>('#save-idle')!
    input.value = '-3'
    save.click()
    await new Promise(r => setTimeout(r, 30))
    // -3 is non-finite-or-negative → falls back to default 5
    expect(globalThis.localStorage.getItem('cue:idle-auto-pause-min:v1')).toBe('5')
  })

  // ─── Phase 1: 對話設定（場景 / 語言 / 模型 / 長度） ────────────────
  it('對話設定從 storage 補水', async () => {
    await bootPlugin({
      storage: {
        'cue:privacy-agreed:v1': '1',
        'cue:scene-note:v1': '面試：主管面',
        'cue:lang:v1': 'en',
        'cue:model:v1': 'claude-haiku-4-5',
        'cue:answer-length:v1': 'short',
      },
    })
    expect(document.querySelector<HTMLInputElement>('#scene-note')!.value).toBe('面試：主管面')
    expect(document.querySelector<HTMLSelectElement>('#lang-mode')!.value).toBe('en')
    expect(document.querySelector<HTMLSelectElement>('#model-choice')!.value).toBe('claude-haiku-4-5')
    expect(document.querySelector<HTMLSelectElement>('#answer-length')!.value).toBe('short')
  })

  it('儲存對話設定會寫入 storage 並顯示狀態', async () => {
    await bootPlugin({ storage: { 'cue:privacy-agreed:v1': '1' } })
    const scene = document.querySelector<HTMLInputElement>('#scene-note')!
    const lang = document.querySelector<HTMLSelectElement>('#lang-mode')!
    const model = document.querySelector<HTMLSelectElement>('#model-choice')!
    const len = document.querySelector<HTMLSelectElement>('#answer-length')!
    const save = document.querySelector<HTMLButtonElement>('#save-convo')!
    const status = document.querySelector<HTMLElement>('#convo-status')!

    scene.value = '簡報：季度回顧'
    lang.value = 'en'
    model.value = 'claude-haiku-4-5'
    len.value = 'long'
    save.click()
    await new Promise(r => setTimeout(r, 30))

    expect(globalThis.localStorage.getItem('cue:scene-note:v1')).toBe('簡報：季度回顧')
    expect(globalThis.localStorage.getItem('cue:lang:v1')).toBe('en')
    expect(globalThis.localStorage.getItem('cue:model:v1')).toBe('claude-haiku-4-5')
    expect(globalThis.localStorage.getItem('cue:answer-length:v1')).toBe('long')
    expect(status.textContent ?? '').toMatch(/已儲存/)
  })

  it('對話設定預設值：zh / sonnet / medium / 空場景', async () => {
    await bootPlugin({ storage: { 'cue:privacy-agreed:v1': '1' } })
    expect(document.querySelector<HTMLInputElement>('#scene-note')!.value).toBe('')
    expect(document.querySelector<HTMLSelectElement>('#lang-mode')!.value).toBe('zh')
    expect(document.querySelector<HTMLSelectElement>('#model-choice')!.value).toBe('claude-sonnet-4-6')
    expect(document.querySelector<HTMLSelectElement>('#answer-length')!.value).toBe('medium')
  })

  // ─── Phase 2: 知識庫 ───────────────────────────────────────────
  it('KB 文字框從 storage 補水且字數正確顯示', async () => {
    await bootPlugin({
      storage: {
        'cue:privacy-agreed:v1': '1',
        'cue:kb-personal:v1': '葉家佐，26 歲',
        'cue:kb-extra:v1': '風控職缺筆記',
      },
    })
    expect(document.querySelector<HTMLTextAreaElement>('#kb-personal')!.value).toBe('葉家佐，26 歲')
    expect(document.querySelector<HTMLTextAreaElement>('#kb-extra')!.value).toBe('風控職缺筆記')
    expect(document.querySelector<HTMLElement>('#kb-personal-count')!.textContent).toContain('8/6000')
    expect(document.querySelector<HTMLElement>('#kb-extra-count')!.textContent).toContain('6/6000')
  })

  it('儲存 KB 會寫入 storage 並顯示狀態', async () => {
    await bootPlugin({ storage: { 'cue:privacy-agreed:v1': '1' } })
    document.querySelector<HTMLTextAreaElement>('#kb-personal')!.value = '個人背景 v2'
    document.querySelector<HTMLTextAreaElement>('#kb-extra')!.value = '補充 v2'
    document.querySelector<HTMLButtonElement>('#save-kb')!.click()
    await new Promise(r => setTimeout(r, 30))
    expect(globalThis.localStorage.getItem('cue:kb-personal:v1')).toBe('個人背景 v2')
    expect(globalThis.localStorage.getItem('cue:kb-extra:v1')).toBe('補充 v2')
    expect(document.querySelector<HTMLElement>('#kb-status')!.textContent ?? '').toMatch(/已儲存/)
  })

  it('每模式掛載勾選：預設 work 全勾、daily 只勾個人、custom 全不勾', async () => {
    await bootPlugin({ storage: { 'cue:privacy-agreed:v1': '1' } })
    expect(document.querySelector<HTMLInputElement>('#kb-attach-work-personal')!.checked).toBe(true)
    expect(document.querySelector<HTMLInputElement>('#kb-attach-work-extra')!.checked).toBe(true)
    expect(document.querySelector<HTMLInputElement>('#kb-attach-daily-personal')!.checked).toBe(true)
    expect(document.querySelector<HTMLInputElement>('#kb-attach-daily-extra')!.checked).toBe(false)
    expect(document.querySelector<HTMLInputElement>('#kb-attach-custom-personal')!.checked).toBe(false)
    expect(document.querySelector<HTMLInputElement>('#kb-attach-custom-extra')!.checked).toBe(false)
  })

  it('改掛載勾選並儲存後寫入 storage', async () => {
    await bootPlugin({ storage: { 'cue:privacy-agreed:v1': '1' } })
    const dailyExtra = document.querySelector<HTMLInputElement>('#kb-attach-daily-extra')!
    dailyExtra.checked = true
    document.querySelector<HTMLButtonElement>('#save-kb')!.click()
    await new Promise(r => setTimeout(r, 30))
    const saved = JSON.parse(globalThis.localStorage.getItem('cue:kb-attach:v1')!)
    expect(saved.daily).toEqual({ personal: true, extra: true })
    expect(saved.work).toEqual({ personal: true, extra: true })
  })
})
