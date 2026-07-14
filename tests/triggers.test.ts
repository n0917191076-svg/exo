// Phase 4：手勢 → 語意事件對照表（gestureMapFor）的窮舉測試。
// 純函式、無 DOM、無 SDK — 這張表是所有觸發來源的單一事實來源。

import { describe, expect, it } from 'vitest'
import { PROACTIVE_SILENT_MS, gestureMapFor } from '../src/triggers'
import type { ModeId } from '../src/modes'

const MODES: ModeId[] = ['work', 'daily', 'custom']

function base(over: Partial<Parameters<typeof gestureMapFor>[0]> = {}) {
  return {
    mode: 'work' as ModeId,
    micOn: false,
    hasAnswer: false,
    source: 'glasses' as const,
    gesture: 'tap' as const,
    silentIdle: false,
    ...over,
  }
}

describe('gestureMapFor — 單擊', () => {
  it('純待命：所有模式單擊＝開始收音', () => {
    for (const mode of MODES) {
      expect(gestureMapFor(base({ mode }))).toBe('gate-start')
    }
  })

  it('回答顯示中：單擊＝開始新一輪收音（清屏由 dispatcher 處理）', () => {
    for (const mode of MODES) {
      expect(gestureMapFor(base({ mode, hasAnswer: true }))).toBe('gate-start')
    }
  })

  it('收音中：單擊＝結束並送出', () => {
    for (const mode of MODES) {
      expect(gestureMapFor(base({ mode, micOn: true }))).toBe('gate-stop')
    }
  })

  it('自動收音靜默窗（silentIdle）：daily/custom 單擊＝proactive，work 照常', () => {
    expect(gestureMapFor(base({ mode: 'daily', micOn: true, silentIdle: true }))).toBe('proactive')
    expect(gestureMapFor(base({ mode: 'custom', micOn: true, silentIdle: true }))).toBe('proactive')
    // work 不支援 proactive — 靜默窗不改變語意
    expect(gestureMapFor(base({ mode: 'work', micOn: true, silentIdle: true }))).toBe('gate-stop')
  })

  it('ring 單擊與眼鏡同語意', () => {
    expect(gestureMapFor(base({ source: 'ring' }))).toBe('gate-start')
    expect(gestureMapFor(base({ source: 'ring', micOn: true }))).toBe('gate-stop')
  })
})

describe('gestureMapFor — 雙擊', () => {
  it('純待命（無回答）：glasses 雙擊＝退出、ring 無作用', () => {
    for (const mode of MODES) {
      expect(gestureMapFor(base({ mode, gesture: 'double-tap' }))).toBe('exit')
      expect(gestureMapFor(base({ mode, gesture: 'double-tap', source: 'ring' }))).toBeNull()
    }
  })

  it('回答顯示中：雙擊＝延伸（誤觸保護——不是退出）', () => {
    for (const mode of MODES) {
      expect(gestureMapFor(base({ mode, gesture: 'double-tap', hasAnswer: true }))).toBe('extend')
      expect(gestureMapFor(base({ mode, gesture: 'double-tap', hasAnswer: true, source: 'ring' }))).toBe('extend')
    }
  })

  it('收音中：glasses 雙擊＝取消本段', () => {
    for (const mode of MODES) {
      expect(gestureMapFor(base({ mode, gesture: 'double-tap', micOn: true }))).toBe('cancel')
    }
  })

  it('收音中 ring 雙擊：daily/custom＝proactive（沿用 Cue），work＝取消', () => {
    expect(gestureMapFor(base({ mode: 'daily', gesture: 'double-tap', micOn: true, source: 'ring' }))).toBe('proactive')
    expect(gestureMapFor(base({ mode: 'custom', gesture: 'double-tap', micOn: true, source: 'ring' }))).toBe('proactive')
    expect(gestureMapFor(base({ mode: 'work', gesture: 'double-tap', micOn: true, source: 'ring' }))).toBe('cancel')
  })

  it('狀態優先序：收音中 > 回答顯示中（收音中即使有回答也不是 extend）', () => {
    expect(gestureMapFor(base({ gesture: 'double-tap', micOn: true, hasAnswer: true }))).toBe('cancel')
  })
})

describe('PROACTIVE_SILENT_MS', () => {
  it('v1 常數為 8000ms（日後可調）', () => {
    expect(PROACTIVE_SILENT_MS).toBe(8_000)
  })
})
