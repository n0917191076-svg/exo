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
      '70–100 words',
      '譯：',
      '【最近回答】',
    ]
    for (let i = 1; i < markers.length; i += 1) {
      expect(systemPrompt.indexOf(markers[i - 1]!)).toBeLessThan(systemPrompt.indexOf(markers[i]!))
    }
  })

  it.each([
    ['short', '80–120 個中文字'],
    ['medium', '180–240 個中文字'],
    ['long', '320–420 個中文字'],
  ])('maps Chinese %s length', (length, expected) => {
    expect(buildSuggestPrompt({ mode: 'work', lang: 'zh', length }).systemPrompt).toContain(expected)
  })

  it.each([
    ['short', '30–45 words'],
    ['medium', '70–100 words'],
    ['long', '130–170 words'],
  ])('maps English %s length', (length, expected) => {
    const prompt = buildSuggestPrompt({ mode: 'work', lang: 'en', length }).systemPrompt
    expect(prompt).toContain(expected)
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
