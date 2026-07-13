// Phase 1 新設定的 round-trip 測試（場景說明 / 模型 / 回答長度 / 語言）。
// jsdom + in-memory localStorage，比照 storage.v04.test.ts。

/// <reference types="vitest/globals" />
// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_ANSWER_LENGTH,
  DEFAULT_LANG,
  DEFAULT_MODEL,
  getAnswerLength,
  getLang,
  getModelChoice,
  getSceneNote,
  setAnswerLength,
  setLang,
  setModelChoice,
  setSceneNote,
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

describe('scene note round-trip', () => {
  it('預設空字串', async () => {
    expect(await getSceneNote()).toBe('')
  })
  it('存取一致', async () => {
    await setSceneNote('面試：金融後台主管面')
    expect(await getSceneNote()).toBe('面試：金融後台主管面')
  })
})

describe('model choice round-trip', () => {
  it('預設 claude-sonnet-4-6', async () => {
    expect(await getModelChoice()).toBe(DEFAULT_MODEL)
    expect(DEFAULT_MODEL).toBe('claude-sonnet-4-6')
  })
  it('存 haiku 取回 haiku', async () => {
    await setModelChoice('claude-haiku-4-5')
    expect(await getModelChoice()).toBe('claude-haiku-4-5')
  })
  it('儲存的非法值回退預設', async () => {
    globalThis.localStorage.setItem('cue:model:v1', 'gpt-9000')
    expect(await getModelChoice()).toBe(DEFAULT_MODEL)
  })
})

describe('answer length round-trip', () => {
  it('預設 medium', async () => {
    expect(await getAnswerLength()).toBe(DEFAULT_ANSWER_LENGTH)
    expect(DEFAULT_ANSWER_LENGTH).toBe('medium')
  })
  it('存 short 取回 short', async () => {
    await setAnswerLength('short')
    expect(await getAnswerLength()).toBe('short')
  })
  it('非法值回退預設', async () => {
    globalThis.localStorage.setItem('cue:answer-length:v1', 'xxl')
    expect(await getAnswerLength()).toBe(DEFAULT_ANSWER_LENGTH)
  })
})

describe('lang round-trip', () => {
  it('預設 zh', async () => {
    expect(await getLang()).toBe(DEFAULT_LANG)
    expect(DEFAULT_LANG).toBe('zh')
  })
  it('存 en 取回 en', async () => {
    await setLang('en')
    expect(await getLang()).toBe('en')
  })
  it('非法值回退 zh', async () => {
    globalThis.localStorage.setItem('cue:lang:v1', 'fr')
    expect(await getLang()).toBe('zh')
  })
})
