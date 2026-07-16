// Pure-logic tests for utterance.ts. No SDK, no DOM, no fetch — just heuristics.

import { describe, expect, it } from 'vitest'
import {
  DEFAULT_TRIGGER,
  GLASSES_CONTENT_MAX_BYTES,
  fitHeadByBytes,
  fitTailByBytes,
  batteryHeaderSuffix,
  createRenderThrottle,
  endsOnSentenceFinalPunct,
  isQuestionZh,
  normalizeSuggestionArray,
  parseNumberedList,
  singleAnswerFromText,
  shouldRequestSuggestion,
  trimToSentences,
  wrapAnswerLines,
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
  it('uses solid glyph above 20%（認證字元 ■）', () => {
    expect(batteryHeaderSuffix(75)).toBe('■75%')
  })
  it('uses warning glyph below 20%', () => {
    expect(batteryHeaderSuffix(12)).toBe('○12%')
  })
  it('clamps out-of-range values', () => {
    expect(batteryHeaderSuffix(150)).toBe('■100%')
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

describe('Plugin single-answer normalization', () => {
  it('wraps a full multiline response as exactly one element', () => {
    expect(singleAnswerFromText('譯：你好\n\nHello, it is good to meet you.')).toEqual([
      '譯：你好\n\nHello, it is good to meet you.',
    ])
  })

  it('joins a legacy Worker array without adding numbering', () => {
    expect(normalizeSuggestionArray(['甲', '乙'])).toEqual(['甲\n乙'])
  })

  it('rejects empty text and empty legacy arrays', () => {
    expect(singleAnswerFromText('   ')).toEqual([])
    expect(normalizeSuggestionArray([' ', ''])).toEqual([])
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

// ─── Phase 4: 中文問句偵測（自動收音模式的觸發條件） ────────────────

describe('isQuestionZh', () => {
  it('句尾問號（全形/半形）', () => {
    expect(isQuestionZh('這個要多少錢？')).toBe(true)
    expect(isQuestionZh('Is this correct?')).toBe(true)
  })

  it('句尾「嗎/呢」（含後接標點）', () => {
    expect(isQuestionZh('你吃飽了嗎')).toBe(true)
    expect(isQuestionZh('你吃飽了嗎。')).toBe(true)
    expect(isQuestionZh('為什麼會這樣呢')).toBe(true)
  })

  it('疑問詞命中', () => {
    expect(isQuestionZh('你叫什麼名字')).toBe(true)
    expect(isQuestionZh('這要如何操作')).toBe(true)
    expect(isQuestionZh('為什麼延誤了')).toBe(true)
    expect(isQuestionZh('這個怎麼用')).toBe(true)
    expect(isQuestionZh('總共多少')).toBe(true)
    expect(isQuestionZh('你在第幾組')).toBe(true)
    expect(isQuestionZh('哪一間公司')).toBe(true)
    expect(isQuestionZh('能不能再說一次')).toBe(true)
    expect(isQuestionZh('可不可以幫我看一下')).toBe(true)
    expect(isQuestionZh('你是不是新來的')).toBe(true)
  })

  it('非問句', () => {
    expect(isQuestionZh('我知道了')).toBe(false)
    expect(isQuestionZh('好的沒問題')).toBe(false)
    expect(isQuestionZh('')).toBe(false)
    expect(isQuestionZh('   ')).toBe(false)
  })

  it('「幾乎」不誤判為疑問（已知限制的防範）', () => {
    expect(isQuestionZh('我幾乎完成了')).toBe(false)
  })

  it('已知限制（v1 接受的誤判）：轉述句含疑問詞會命中', () => {
    // 「他問我什麼時候到」是轉述不是提問 — v1 純規則無法區分，記錄之
    expect(isQuestionZh('他問我什麼時候到')).toBe(true)
  })
})

describe('wrapAnswerLines', () => {
  it('chunks a Chinese paragraph without losing characters', () => {
    const text = '甲'.repeat(85)
    const lines = wrapAnswerLines(text, 38)
    expect(lines).toHaveLength(3)
    expect(lines.every(line => line.length <= 38)).toBe(true)
    expect(lines.join('')).toBe(text)
  })

  it('wraps English on a word boundary when possible', () => {
    const lines = wrapAnswerLines('READ ONLY becomes TAKE ACTION, through connected tools', 20)
    expect(lines.every(line => line.length <= 20)).toBe(true)
    expect(lines.join(' ')).toBe('READ ONLY becomes TAKE ACTION, through connected tools')
    expect(lines.some(line => line.includes('TAKE ACTION,'))).toBe(true)
  })

  it('does not group an uppercase word with a mixed-case following word', () => {
    expect(wrapAnswerLines('one two three READ Agent follows', 20)).toEqual([
      'one two three READ',
      'Agent follows',
    ])
  })

  it('preserves one blank separator between translation and English answer', () => {
    expect(wrapAnswerLines('譯：你好\n\nHello there.', 38)).toEqual([
      '譯：你好',
      '',
      'Hello there.',
    ])
  })
})

// ─── textContainerUpgrade 512-byte 上限的尾端滾動窗 ─────────────────

describe('fitTailByBytes', () => {
  const bytes = (t: string) => new TextEncoder().encode(t).length

  it('總量在預算內時原樣返回', () => {
    const lines = ['甲', '乙', '丙']
    expect(fitTailByBytes(lines, 100)).toEqual(lines)
  })

  it('超過預算時保留最新（尾端）行，開頭補「…」', () => {
    // 每行「x」.repeat 產生固定位元組數，方便算
    const lines = ['old-old-old-old', 'mid-mid-mid-mid', 'new-new-new-new']
    const out = fitTailByBytes(lines, 36) // 塞不下三行
    expect(out[0]).toBe('▲') // 認證字元（… 不在 LVGL 認證集，可能被丟）
    expect(out[out.length - 1]).toBe('new-new-new-new')
    expect(out).not.toContain('old-old-old-old')
    expect(bytes(out.join('\n'))).toBeLessThanOrEqual(36)
  })

  it('中文以 UTF-8 位元組計（每字 3 bytes）', () => {
    const lines = ['一二三四五', '六七八九十'] // 各 15 bytes，join 後 31
    expect(fitTailByBytes(lines, 31)).toEqual(lines)
    const out = fitTailByBytes(lines, 30)
    expect(out[out.length - 1]).toBe('六七八九十')
    expect(out).not.toContain('一二三四五')
  })

  it('單行就超過預算時截該行頭部保留尾端', () => {
    const long = '甲'.repeat(100) + '結尾'
    const out = fitTailByBytes([long], 30)
    expect(out).toHaveLength(1)
    expect(out[0]!.startsWith('▲')).toBe(true)
    expect(out[0]!.endsWith('結尾')).toBe(true)
    expect(bytes(out[0]!)).toBeLessThanOrEqual(30)
  })

  it('空陣列與 0 預算不炸', () => {
    expect(fitTailByBytes([], 100)).toEqual([])
    expect(fitTailByBytes(['x'], 0)).toEqual([])
  })
})

describe('fitHeadByBytes（提詞機開頭定錨窗）', () => {
  const bytes = (t: string) => new TextEncoder().encode(t).length

  it('總量在預算內時原樣返回', () => {
    const lines = ['甲', '乙', '丙']
    expect(fitHeadByBytes(lines, 100)).toEqual(lines)
  })

  it('超過預算時保留開頭行、末尾補「▼」（下方還有內容）', () => {
    const lines = ['new-new-new-new', 'mid-mid-mid-mid', 'old-old-old-old']
    const out = fitHeadByBytes(lines, 36) // 塞不下三行
    expect(out[0]).toBe('new-new-new-new')
    expect(out[out.length - 1]).toBe('▼')
    expect(out).not.toContain('old-old-old-old')
    expect(bytes(out.join('\n'))).toBeLessThanOrEqual(36)
  })

  it('串流成長時開頭窗穩定不變（不 racing）', () => {
    const width = 40
    const partial = ['第一頁開頭內容', '第一頁第二行內容']
    const grown = [...partial, '後來才生成的第三行', '第四行']
    // 兩者的開頭窗（budget 只夠前兩行）應相同 → 畫面 hold，不被生成推走
    expect(fitHeadByBytes(partial, width)).toEqual(fitHeadByBytes(grown, width))
  })

  it('單行就超過預算時截該行尾部保留頭部', () => {
    const long = '開頭' + '甲'.repeat(100)
    const out = fitHeadByBytes([long], 30)
    expect(out).toHaveLength(1)
    expect(out[0]!.startsWith('開頭')).toBe(true)
    expect(out[0]!.endsWith('▼')).toBe(true)
    expect(bytes(out[0]!)).toBeLessThanOrEqual(30)
  })

  it('空陣列與 0 預算不炸', () => {
    expect(fitHeadByBytes([], 100)).toEqual([])
    expect(fitHeadByBytes(['x'], 0)).toEqual([])
  })

  it('GLASSES_CONTENT_MAX_BYTES 為 512（官方 textContainerUpgrade 上限）', () => {
    expect(GLASSES_CONTENT_MAX_BYTES).toBe(512)
  })
})
