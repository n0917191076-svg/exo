// Phase 2 知識庫 storage 測試（KB 內容 round-trip、尾端截斷、per-mode 掛載表）。
// jsdom + in-memory localStorage，比照 storage.phase1.test.ts。

/// <reference types="vitest/globals" />
// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  KB_MAX_CHARS,
  getKbAttach,
  getKbExtra,
  getKbPersonal,
  setKbAttach,
  setKbExtra,
  setKbPersonal,
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

describe('KB 內容 round-trip', () => {
  it('預設皆空字串', async () => {
    expect(await getKbPersonal()).toBe('')
    expect(await getKbExtra()).toBe('')
  })

  it('存取一致', async () => {
    await setKbPersonal('葉家佐，26 歲，新莊人')
    await setKbExtra('公司簡介：東寶馬達')
    expect(await getKbPersonal()).toBe('葉家佐，26 歲，新莊人')
    expect(await getKbExtra()).toBe('公司簡介：東寶馬達')
  })

  it('超過 6000 字元時從頭截斷保留尾端', async () => {
    expect(KB_MAX_CHARS).toBe(6000)
    const head = 'A'.repeat(1000)
    const tail = 'B'.repeat(6000)
    await setKbPersonal(head + tail) // 7000 字
    const got = await getKbPersonal()
    expect(got.length).toBe(6000)
    expect(got).toBe(tail) // 尾端保留、開頭被截
  })

  it('補充資料 KB 同樣截斷', async () => {
    await setKbExtra('x'.repeat(6001))
    expect((await getKbExtra()).length).toBe(6000)
  })
})

describe('per-mode KB 掛載表', () => {
  it('預設：work 全掛、daily 只掛個人、custom 不掛', async () => {
    const m = await getKbAttach()
    expect(m.work).toEqual({ personal: true, extra: true })
    expect(m.daily).toEqual({ personal: true, extra: false })
    expect(m.custom).toEqual({ personal: false, extra: false })
  })

  it('round-trip', async () => {
    await setKbAttach({
      work: { personal: true, extra: false },
      daily: { personal: false, extra: false },
      custom: { personal: true, extra: true },
    })
    const m = await getKbAttach()
    expect(m.work).toEqual({ personal: true, extra: false })
    expect(m.daily).toEqual({ personal: false, extra: false })
    expect(m.custom).toEqual({ personal: true, extra: true })
  })

  it('儲存的壞 JSON 回退預設', async () => {
    globalThis.localStorage.setItem('cue:kb-attach:v1', '{not json')
    const m = await getKbAttach()
    expect(m.work).toEqual({ personal: true, extra: true })
  })

  it('缺欄位時逐模式合併預設', async () => {
    globalThis.localStorage.setItem('cue:kb-attach:v1', JSON.stringify({ work: { personal: false } }))
    const m = await getKbAttach()
    expect(m.work).toEqual({ personal: false, extra: true }) // 缺 extra → 補預設 true
    expect(m.daily).toEqual({ personal: true, extra: false }) // 整組缺 → 預設
  })
})
