import { beforeEach, describe, expect, it } from 'vitest'
import { nextMockExchange, nextMockProactiveTopics, resetMock } from '../src/mock'
import { MODES } from '../src/modes'

describe('mock driver', () => {
  beforeEach(() => resetMock())

  it('每個模式都拿得到 transcript + suggestions', () => {
    for (const mode of MODES) {
      resetMock()
      const ex = nextMockExchange(mode.id)
      expect(ex.transcript.length).toBeGreaterThan(5)
      expect(ex.suggestions.length).toBeGreaterThan(0)
      expect(ex.suggestions).toHaveLength(1)
      for (const s of ex.suggestions) {
        expect(typeof s).toBe('string')
        expect(s.length).toBeGreaterThan(2)
        expect(s.length).toBeLessThan(200)
      }
    }
  })

  it('腳本會循環（長度 > 1）', () => {
    const a = nextMockExchange('work').transcript
    const b = nextMockExchange('work').transcript
    expect(a).not.toBe(b)
  })

  it('work 與 daily 有各自的建議（非 fallback 共用）', () => {
    const work = nextMockExchange('work').suggestions
    resetMock()
    const daily = nextMockExchange('daily').suggestions
    expect(work).not.toEqual(daily)
  })

  it('daily 模式有 proactive 話題（非降級訊息）', () => {
    const topics = nextMockProactiveTopics('daily')
    expect(topics.length).toBeGreaterThan(1)
    expect(topics.join('')).not.toMatch(/not available|尚無/i)
    for (const t of topics) expect(t.length).toBeGreaterThan(3)
  })

  it('沒有 proactive 話題的模式優雅降級', () => {
    const topics = nextMockProactiveTopics('work')
    expect(topics.length).toBe(1)
    expect(topics[0]).toMatch(/not available|尚無/i)
  })
})
