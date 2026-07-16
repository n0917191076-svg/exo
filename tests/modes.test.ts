import { describe, expect, it } from 'vitest'
import { DEFAULT_MODE, MODES, modeById, nextMode } from '../src/modes'

describe('mode registry', () => {
  it('四個模式：work / daily / custom / solve', () => {
    expect(MODES.map(m => m.id)).toEqual(['work', 'daily', 'custom', 'solve'])
  })

  it('glyph 符合規格（官方認證字元集）：work ■、daily ●、custom ★、solve ☆', () => {
    expect(modeById('work').glyph).toBe('■')
    expect(modeById('daily').glyph).toBe('●')
    expect(modeById('custom').glyph).toBe('★')
    expect(modeById('solve').glyph).toBe('☆')
  })

  it('所有 glyph 都在官方認證 Unicode 集內（LVGL 字型保證有）', () => {
    const CERTIFIED = new Set([...'━─█▇▆▅▄▃▂▁▲△▶▷▼▽◀◁●○■□★☆╭╮╯╰│♠♣♥♦'])
    for (const m of MODES) {
      expect(CERTIFIED.has(m.glyph), `${m.id} glyph ${m.glyph}`).toBe(true)
    }
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

  it('work 模式語氣：口語、有料、禁沒把握口頭禪、偶爾英文術語、不公式化', () => {
    const p = modeById('work').systemPrompt
    expect(p).toMatch(/口語/)                 // 口語化
    expect(p).toMatch(/有料|有內容|有觀點/)     // 內容要有料
    expect(p).toMatch(/生硬|書面語/)           // 避免一般人不用的生硬詞
    expect(p).toMatch(/英文專有名詞|英文術語/)  // 偶爾穿插英文顯專業
    expect(p).toMatch(/我覺得/)                // 仍禁沒把握口頭禪（需點名 LLM 才躲得掉）
    expect(p).toMatch(/可能/)
    expect(p).not.toMatch(/STAR/)              // 拿掉公式化框架
  })

  it('對話模式（work/daily）的 systemPrompt 含單一完整回答規則', () => {
    for (const m of MODES.filter(x => x.id === 'work' || x.id === 'daily')) {
      expect(m.systemPrompt).toMatch(/只輸出一個完整答案/)
      expect(m.systemPrompt).toMatch(/不使用.*編號|不要.*編號/)
      expect(m.systemPrompt).toMatch(/先結論|直接.*判斷|直接.*立場/)
      expect(m.systemPrompt).toMatch(/照著念/)
    }
  })

  it('solve 模式：答案先行、語意翻轉（回答問題本身，非建議怎麼回話）', () => {
    const p = modeById('solve').systemPrompt
    expect(p).toMatch(/使用者本人.*問題|直接把答案/)
    expect(p).toMatch(/答案先行|第一行就是答案/)
    expect(p).not.toMatch(/只輸出一個完整答案/) // 不套對話模式契約
    expect(modeById('solve').proactiveSupported).toBe(false)
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
