// Phase 4 三開關的 round-trip 測試（閘門模式／自動收音／媒體鍵 flag）。
// jsdom + in-memory localStorage，比照 storage.phase1.test.ts。

/// <reference types="vitest/globals" />
// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  getAudioSource,
  getAutoListen,
  getGatedMode,
  getMediaKeyFlag,
  setAudioSource,
  setAutoListen,
  setGatedMode,
  setMediaKeyFlag,
  setStorageBridge,
} from '../src/storage'

beforeEach(() => {
  const store: Record<string, string> = {}
  globalThis.localStorage = {
    getItem: (k: string) => store[k] ?? null,
    setItem: (k: string, v: string) => { store[k] = v },
    removeItem: (k: string) => { delete store[k] },
    clear: () => { for (const k of Object.keys(store)) delete store[k] },
    key: (i: number) => Object.keys(store)[i] ?? null,
    get length() { return Object.keys(store).length },
  } as Storage
  setStorageBridge(null)
})

afterEach(() => setStorageBridge(null))

describe('閘門模式開關', () => {
  it('預設開（true）— 閘門收音是產品核心設計', async () => {
    expect(await getGatedMode()).toBe(true)
  })
  it('可關可開', async () => {
    await setGatedMode(false)
    expect(await getGatedMode()).toBe(false)
    await setGatedMode(true)
    expect(await getGatedMode()).toBe(true)
  })
})

describe('自動收音開關', () => {
  it('預設關（false）— 隱私鐵律：麥克風預設 OFF', async () => {
    expect(await getAutoListen()).toBe(false)
  })
  it('round-trip', async () => {
    await setAutoListen(true)
    expect(await getAutoListen()).toBe(true)
  })
})

describe('媒體鍵 feature flag', () => {
  it('預設關（實驗性路線）', async () => {
    expect(await getMediaKeyFlag()).toBe(false)
  })
  it('round-trip', async () => {
    await setMediaKeyFlag(true)
    expect(await getMediaKeyFlag()).toBe(true)
  })
})

describe('收音來源（audioControl 第二參數）', () => {
  it('預設眼鏡', async () => {
    expect(await getAudioSource()).toBe('glasses')
  })
  it('round-trip phone', async () => {
    await setAudioSource('phone')
    expect(await getAudioSource()).toBe('phone')
  })
  it('非法值回退 glasses', async () => {
    globalThis.localStorage.setItem('cue:audio-source:v1', 'toaster')
    expect(await getAudioSource()).toBe('glasses')
  })
})
