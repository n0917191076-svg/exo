import { describe, expect, it } from 'vitest'
import { buildSuggestPrompt, singleAnswerFromText } from '../worker-template/suggestion-policy'

describe('single-answer Worker prompt policy', () => {
  it.each(['work', 'daily', 'custom'])('%s enforces one unnumbered answer', mode => {
    const { systemPrompt } = buildSuggestPrompt({
      mode,
      customPrompt: mode === 'custom' ? '你是一位策略顧問，語氣直接。' : undefined,
    })
    expect(systemPrompt).toMatch(/只輸出一個完整答案/)
    expect(systemPrompt).toMatch(/不使用.*編號|不要.*編號/)
    expect(systemPrompt).toMatch(/可直接照著念/)
  })

  it('keeps a custom role but appends the non-overridable common contract', () => {
    const { systemPrompt } = buildSuggestPrompt({
      mode: 'custom',
      customPrompt: '你是一位策略顧問，使用商業分析語氣。',
    })
    expect(systemPrompt.indexOf('你是一位策略顧問')).toBeLessThan(systemPrompt.indexOf('【回答契約】'))
    expect(systemPrompt).toMatch(/只輸出一個完整答案/)
    expect(systemPrompt).toMatch(/不得聲稱.*我.*我們.*公司|不得.*做過.*驗證過/)
  })

  it('orders mode, scene, KB, contract, length, language, then dedupe', () => {
    const { systemPrompt } = buildSuggestPrompt({
      mode: 'work',
      sceneNote: '董事會簡報',
      kbPersonal: '個人資料標記',
      kbExtra: '補充資料標記',
      length: 'medium',
      lang: 'en',
      recentSuggestions: ['上一個完整回答'],
    })
    const markers = [
      '工作場合',
      '【目前場景】董事會簡報',
      '【個人資訊】',
      '【補充資料】',
      '【回答契約】',
      '35–50 words',
      '譯：',
      '【最近回答】',
    ]
    for (let i = 1; i < markers.length; i += 1) {
      expect(systemPrompt.indexOf(markers[i - 1]!)).toBeLessThan(systemPrompt.indexOf(markers[i]!))
    }
  })

  it.each([
    ['short', '40–70 個中文字', 70, 2, 40],
    ['medium', '80–110 個中文字', 110, 3, 45],
    ['long', '110–140 個中文字', 140, 4, 45],
  ])('maps Chinese %s length to enforceable structure bounds', (length, range, maximum, sentenceLimit, sentenceMaximum) => {
    const prompt = buildSuggestPrompt({ mode: 'work', lang: 'zh', length }).systemPrompt
    expect(prompt).toContain(range)
    expect(prompt).toContain(`硬性上限為 ${maximum} 個字元，絕對不得超過`)
    expect(prompt).toMatch(/計數包含標點符號與英文術語/)
    expect(prompt).toContain('只用一個段落，不得換行或加入空白行')
    expect(prompt).toContain(`最多 ${sentenceLimit} 句，每句不得超過 ${sentenceMaximum} 個字元`)
    expect(prompt).toContain('輸出前在內部自我檢查句數、每句字元數與全文字元數')
    expect(prompt).toContain('若任何一句或全文可能超過上限，刪除次要例子、重複內容或次要細節')
    expect(prompt).toContain('不得輸出檢查過程')
  })

  it('caps distinct English terminology while retaining the useful target', () => {
    const prompt = buildSuggestPrompt({ mode: 'work', lang: 'zh', length: 'medium' }).systemPrompt
    expect(prompt).toContain('適合時，自然加入 2–4 個相關英文術語')
    expect(prompt).toContain('最多只能使用 4 個不同的英文術語')
    expect(prompt).toContain('其他概念優先使用中文')
  })

  it.each([
    ['short', '20–30 words', 30],
    ['medium', '35–50 words', 50],
    ['long', '50–70 words', 70],
  ])('maps English %s length with a mandatory hard ceiling', (length, range, maximum) => {
    const prompt = buildSuggestPrompt({ mode: 'work', lang: 'en', length }).systemPrompt
    expect(prompt).toContain(range)
    expect(prompt).toContain(`The hard maximum is ${maximum} words, excluding the translation line, and must never be exceeded.`)
    expect(prompt).toContain('Delete secondary details to keep the answer complete within that maximum.')
    expect(prompt).toMatch(/第一行.*譯：/)
    expect(prompt).toMatch(/一個完整英文回答/)
    expect(prompt).toMatch(/CEFR B1/)
  })

  it('states the factual boundary and hypothetical-example marker', () => {
    const { systemPrompt } = buildSuggestPrompt({ mode: 'work' })
    expect(systemPrompt).toMatch(/通用專業知識/)
    expect(systemPrompt).toMatch(/例如/)
    expect(systemPrompt).toMatch(/不得.*具體.*數字|不得.*精確.*數據/)
    expect(systemPrompt).toMatch(/逐字稿.*場景.*知識庫/)
  })
})

describe('Worker single-answer normalization', () => {
  it('keeps all model text as one answer even if it contains numbered lines', () => {
    expect(singleAnswerFromText('1. 第一段\n2. 第二段')).toEqual(['1. 第一段\n2. 第二段'])
  })

  it('rejects whitespace-only model text', () => {
    expect(singleAnswerFromText(' \n ')).toEqual([])
  })
})
