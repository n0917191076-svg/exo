import { describe, expect, it } from 'vitest'
import { DEFAULT_MODE, MODES, modeById, nextMode } from '../src/modes'

describe('mode registry', () => {
  it('恰好三個模式：work / daily / custom', () => {
    expect(MODES.map(m => m.id)).toEqual(['work', 'daily', 'custom'])
  })

  it('glyph 符合規格：work ▣、daily ●、custom ◆', () => {
    expect(modeById('work').glyph).toBe('▣')
    expect(modeById('daily').glyph).toBe('●')
    expect(modeById('custom').glyph).toBe('◆')
  })

  it('每個模式必要欄位齊全', () => {
    for (const m of MODES) {
      expect(m.id).toBeTruthy()
      expect(m.label).toBeTruthy()
      expect(m.glyph.length).toBeGreaterThan(0)
      expect(m.description).toBeTruthy()
      if (m.id === 'custom') {
        expect(m.systemPrompt).toBe('')
      } else {
        expect(m.systemPrompt.length).toBeGreaterThan(20)
      }
      expect(typeof m.proactiveSupported).toBe('boolean')
    }
  })

  it('work 模式吸收 interview 技巧：禁 hedging 語 + STAR 僅自然時使用', () => {
    const p = modeById('work').systemPrompt
    expect(p).toMatch(/我覺得/)   // 禁用語需點名列出，LLM 才躲得掉
    expect(p).toMatch(/可能/)
    expect(p).toMatch(/情境.*任務.*行動.*結果|STAR/)
    expect(p).toMatch(/自然/)     // 「僅在自然時使用」的限定
  })

  it('非 custom 模式的 systemPrompt 是繁中且含共同規則', () => {
    for (const m of MODES.filter(x => x.id !== 'custom')) {
      expect(m.systemPrompt).toMatch(/2–3 條/)
      expect(m.systemPrompt).toMatch(/先結論|先講結論/)
      expect(m.systemPrompt).toMatch(/照著念/)
    }
  })

  it('所有模式 id 唯一', () => {
    const ids = new Set(MODES.map(m => m.id))
    expect(ids.size).toBe(MODES.length)
  })

  it('預設模式是 work 且在註冊表內', () => {
    expect(DEFAULT_MODE).toBe('work')
    expect(MODES.find(m => m.id === DEFAULT_MODE)).toBeTruthy()
  })

  it('modeById 對未知 id 拋錯', () => {
    expect(() => modeById('nonexistent' as 'work')).toThrow()
  })

  it('nextMode 循環全部模式後回到起點', () => {
    let cur = MODES[0]!.id
    const visited = new Set<string>([cur])
    for (let i = 0; i < MODES.length; i += 1) {
      cur = nextMode(cur)
      visited.add(cur)
    }
    expect(visited.size).toBe(MODES.length)
    expect(cur).toBe(MODES[0]!.id)
  })
})
