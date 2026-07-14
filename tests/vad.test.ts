// VAD 狀態機純函式測試（now 全程注入，不碰真實時鐘）。
// 改寫自 tntpsu/even-voice-shim；只作用於自動收音模式（邊界測試在
// audio.bridge.test.ts）。

import { describe, expect, it } from 'vitest'
import { DEFAULT_VAD_THRESHOLD, Vad, rmsPcm16, synthFrame } from '../src/vad'

const VOICED = synthFrame(160, 0.2)   // RMS 0.2 > 0.04 閾值
const SILENT = synthFrame(160, 0.001) // RMS 0.001 < 0.04

describe('rmsPcm16', () => {
  it('合成 frame 的 RMS 接近指定 level', () => {
    expect(rmsPcm16(VOICED)).toBeGreaterThan(0.15)
    expect(rmsPcm16(VOICED)).toBeLessThan(0.25)
    expect(rmsPcm16(SILENT)).toBeLessThan(DEFAULT_VAD_THRESHOLD)
  })

  it('空 frame 回 0', () => {
    expect(rmsPcm16(new Uint8Array(0))).toBe(0)
  })
})

describe('Vad 狀態機', () => {
  it('PRE_VOICE 逾時無人聲 → no-speech', () => {
    const vad = new Vad()
    vad.start(0)
    expect(vad.push(SILENT, 1_000)).toBeNull()
    expect(vad.push(SILENT, 2_600)).toBe('no-speech')
  })

  it('人聲 → 靜音撐過 hold → voice-end', () => {
    const vad = new Vad()
    vad.start(0)
    expect(vad.push(VOICED, 100)).toBeNull()   // PRE_VOICE → VOICE
    expect(vad.push(SILENT, 200)).toBeNull()   // VOICE → POST_VOICE
    expect(vad.push(SILENT, 700)).toBeNull()   // 500ms 靜音 < 700 hold
    expect(vad.push(SILENT, 950)).toBe('voice-end') // 750ms ≥ hold
  })

  it('POST_VOICE 中人聲恢復 → 回 VOICE 不收束', () => {
    const vad = new Vad()
    vad.start(0)
    vad.push(VOICED, 100)
    vad.push(SILENT, 200)
    expect(vad.push(VOICED, 600)).toBeNull() // 恢復說話
    expect(vad.current()).toBe('VOICE')
    // 再靜音也要重新計時
    vad.push(SILENT, 700)
    expect(vad.push(SILENT, 1_200)).toBeNull() // 500ms < hold
    expect(vad.push(SILENT, 1_450)).toBe('voice-end')
  })

  it('總時長超過 maxRecordMs → hard-cap（持續噪音防護）', () => {
    const vad = new Vad()
    vad.start(0)
    vad.push(VOICED, 100)
    for (let t = 200; t < 7_900; t += 500) expect(vad.push(VOICED, t)).toBeNull()
    expect(vad.push(VOICED, 8_100)).toBe('hard-cap')
  })

  it('CLOSED 後 push 回 null；start 重啟後恢復偵測', () => {
    const vad = new Vad()
    vad.start(0)
    vad.push(SILENT, 2_600) // no-speech → CLOSED
    expect(vad.push(VOICED, 3_000)).toBeNull()
    vad.start(3_000)
    vad.push(VOICED, 3_100)
    vad.push(SILENT, 3_200)
    expect(vad.push(SILENT, 3_950)).toBe('voice-end')
  })
})
