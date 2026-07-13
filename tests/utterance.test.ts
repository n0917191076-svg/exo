// Pure-logic tests for utterance.ts. No SDK, no DOM, no fetch — just heuristics.

import { describe, expect, it } from 'vitest'
import {
  DEFAULT_TRIGGER,
  batteryHeaderSuffix,
  createRenderThrottle,
  endsOnSentenceFinalPunct,
  parseNumberedList,
  shouldRequestSuggestion,
  trimToSentences,
  wrapWords,
  type UtteranceSignal,
} from '../src/utterance'

const baseState: UtteranceSignal = {
  lastChunkText: '',
  lastChunkAt: 0,
  lastSuggestionAt: 0,
  inFlight: false,
  transcriptLen: 100,
}

describe('endsOnSentenceFinalPunct', () => {
  it('matches normal terminal punctuation', () => {
    expect(endsOnSentenceFinalPunct('Yes.')).toBe(true)
    expect(endsOnSentenceFinalPunct('Really!')).toBe(true)
    expect(endsOnSentenceFinalPunct('Are you sure?')).toBe(true)
    expect(endsOnSentenceFinalPunct('Right…')).toBe(true)
  })
  it('tolerates trailing whitespace', () => {
    expect(endsOnSentenceFinalPunct('Done.   ')).toBe(true)
  })
  it('rejects mid-sentence text', () => {
    expect(endsOnSentenceFinalPunct('I think we')).toBe(false)
    expect(endsOnSentenceFinalPunct('hello, then')).toBe(false)
  })
})

describe('shouldRequestSuggestion', () => {
  it('blocks while a request is in flight', () => {
    expect(shouldRequestSuggestion({ ...baseState, inFlight: true }, 100_000)).toBe(false)
  })
  it('blocks if transcript too short', () => {
    expect(shouldRequestSuggestion({ ...baseState, transcriptLen: 5 }, 100_000)).toBe(false)
  })
  it('blocks under min debounce, even on sentence-final', () => {
    const s: UtteranceSignal = {
      ...baseState,
      lastChunkText: 'OK.',
      lastChunkAt: 100_000,
      lastSuggestionAt: 99_000, // 1s ago, below 3s minDebounce
    }
    expect(shouldRequestSuggestion(s, 100_000)).toBe(false)
  })
  it('fires immediately on sentence-final past min debounce', () => {
    const s: UtteranceSignal = {
      ...baseState,
      lastChunkText: 'Are you sure about that?',
      lastChunkAt: 100_000,
      lastSuggestionAt: 96_000, // 4s ago
    }
    expect(shouldRequestSuggestion(s, 100_000)).toBe(true)
  })
  it('fires on silence gap with no sentence-final', () => {
    const s: UtteranceSignal = {
      ...baseState,
      lastChunkText: 'I was saying',
      lastChunkAt: 96_000, // last chunk 4s ago, > 1.5s silenceGapMs
      lastSuggestionAt: 95_000, // 5s ago, > minDebounce
    }
    expect(shouldRequestSuggestion(s, 100_000)).toBe(true)
  })
  it('fires after maxWait even mid-sentence with no silence', () => {
    const s: UtteranceSignal = {
      ...baseState,
      lastChunkText: 'and then we and then',
      lastChunkAt: 99_900, // very recent — no silence
      lastSuggestionAt: 86_000, // 14s ago, > maxWaitMs (12s)
    }
    expect(shouldRequestSuggestion(s, 100_000)).toBe(true)
  })
  it('blocks when not yet sentence-final, no silence, under maxWait', () => {
    const s: UtteranceSignal = {
      ...baseState,
      lastChunkText: 'I was just thinking',
      lastChunkAt: 99_700, // 300ms ago
      lastSuggestionAt: 95_000, // 5s ago
    }
    expect(shouldRequestSuggestion(s, 100_000)).toBe(false)
  })
  it('respects custom config overrides', () => {
    const s: UtteranceSignal = {
      ...baseState,
      lastChunkText: 'still talking',
      lastChunkAt: 99_500,
      lastSuggestionAt: 99_000,
    }
    expect(
      shouldRequestSuggestion(s, 100_000, {
        ...DEFAULT_TRIGGER,
        minDebounceMs: 500,
        silenceGapMs: 400,
      }),
    ).toBe(true)
  })
})

describe('trimToSentences', () => {
  it('returns input unchanged when within budget', () => {
    expect(trimToSentences('Hello there.', 100)).toBe('Hello there.')
  })
  it('drops leading sentences to fit', () => {
    const long = 'First. Second. Third. Fourth. Fifth.'
    const trimmed = trimToSentences(long, 20)
    expect(trimmed.length).toBeLessThanOrEqual(20)
    expect(trimmed.endsWith('Fifth.')).toBe(true)
    expect(trimmed.includes('First.')).toBe(false)
  })
  it('keeps the trailing sentence intact', () => {
    const t = 'A long opener with extra words. Tail.'
    expect(trimToSentences(t, 10)).toBe('Tail.')
  })
  it('falls back to char-tail when single sentence exceeds budget', () => {
    const monolith = 'a'.repeat(50)
    const trimmed = trimToSentences(monolith, 20)
    expect(trimmed.length).toBe(20)
  })
})

describe('wrapWords', () => {
  it('returns one line when short enough', () => {
    expect(wrapWords('Tell me more.', 30, 2)).toEqual(['Tell me more.'])
  })
  it('wraps on word boundaries within line width', () => {
    const result = wrapWords('What got you into that hobby anyway', 12, 4)
    expect(result.every(l => l.length <= 12)).toBe(true)
    expect(result.join(' ')).toBe('What got you into that hobby anyway')
  })
  it('caps total lines and ends with ellipsis when overflowing', () => {
    const r = wrapWords('one two three four five six seven eight nine ten', 8, 2)
    expect(r.length).toBe(2)
    expect(r[1]!.endsWith('…')).toBe(true)
  })
  it('breaks an oversized single word at width', () => {
    const r = wrapWords('supercalifragilistic stuff', 10, 3)
    expect(r[0]!.length).toBe(10)
  })
})

describe('batteryHeaderSuffix', () => {
  it('returns empty when level missing', () => {
    expect(batteryHeaderSuffix(undefined)).toBe('')
    expect(batteryHeaderSuffix(NaN)).toBe('')
  })
  it('uses solid glyph above 20%', () => {
    expect(batteryHeaderSuffix(75)).toBe('◼75%')
  })
  it('uses warning glyph below 20%', () => {
    expect(batteryHeaderSuffix(12)).toBe('○12%')
  })
  it('clamps out-of-range values', () => {
    expect(batteryHeaderSuffix(150)).toBe('◼100%')
    expect(batteryHeaderSuffix(-10)).toBe('○0%')
  })
})

// ─── Phase 3: parseNumberedList ────────────────────────────────────

describe('parseNumberedList', () => {
  it('解析 1. / 2) 兩種編號格式', () => {
    expect(parseNumberedList('1. 甲\n2) 乙\n3. 丙')).toEqual(['甲', '乙', '丙'])
  })

  it('忽略前言與雜訊行，只留編號行', () => {
    const text = '以下是建議：\n1. 先講結論。\n（補充說明）\n2. 帶關鍵數字。'
    expect(parseNumberedList(text)).toEqual(['先講結論。', '帶關鍵數字。'])
  })

  it('沒有任何編號行時整段當一條', () => {
    expect(parseNumberedList('就照實回答即可')).toEqual(['就照實回答即可'])
  })

  it('空字串回空陣列', () => {
    expect(parseNumberedList('')).toEqual([])
    expect(parseNumberedList('   \n  ')).toEqual([])
  })
})

// ─── Phase 3: createRenderThrottle（300ms 眼鏡渲染節流） ────────────

describe('createRenderThrottle', () => {
  // 注入 fake now/schedule，不依賴真實計時器
  function harness(intervalMs: number) {
    let t = 0
    const scheduled: Array<{ at: number; fn: () => void }> = []
    const throttle = createRenderThrottle(
      intervalMs,
      () => t,
      (fn, ms) => { scheduled.push({ at: t + ms, fn }) },
    )
    const advance = (ms: number) => {
      t += ms
      for (const s of scheduled.splice(0)) {
        if (s.at <= t) s.fn()
        else scheduled.push(s)
      }
    }
    return { throttle, advance, scheduled }
  }

  it('首次 push 立即執行', () => {
    const { throttle } = harness(300)
    let calls = 0
    throttle.push(() => { calls += 1 })
    expect(calls).toBe(1)
  })

  it('間隔內的多次 push 只排一次 trailing，且執行最後一筆', () => {
    const { throttle, advance, scheduled } = harness(300)
    const log: string[] = []
    throttle.push(() => log.push('a'))   // 立即
    throttle.push(() => log.push('b'))   // 排程
    throttle.push(() => log.push('c'))   // 覆蓋 b
    expect(log).toEqual(['a'])
    expect(scheduled.length).toBe(1)     // 只排一次
    advance(300)
    expect(log).toEqual(['a', 'c'])      // trailing 執行最後一筆
  })

  it('interval 過後再 push 又是立即執行', () => {
    const { throttle, advance } = harness(300)
    const log: string[] = []
    throttle.push(() => log.push('a'))
    advance(300)
    throttle.push(() => log.push('b'))
    expect(log).toEqual(['a', 'b'])
  })

  it('flush 立即執行未決的最後一筆，之後不重複執行', () => {
    const { throttle, advance } = harness(300)
    const log: string[] = []
    throttle.push(() => log.push('a'))
    throttle.push(() => log.push('b'))
    throttle.flush()
    expect(log).toEqual(['a', 'b'])
    advance(300)                          // 原排程到期不得重跑 b
    expect(log).toEqual(['a', 'b'])
  })

  it('沒有未決項時 flush 是 no-op', () => {
    const { throttle } = harness(300)
    expect(() => throttle.flush()).not.toThrow()
  })
})
