// Worker 端 Deepgram URL 組裝的契約測試 — 閘門模式必須拿掉
// diarize/utterances（省成本與延遲），非閘門保留完整參數。
// 直接 import worker-template 的 export（頂層無副作用，node 環境可載）。

import { describe, expect, it } from 'vitest'
import { deepgramHttpUrl, isOpenAIModel } from '../worker-template/index'

describe('deepgramHttpUrl（gated 參數）', () => {
  it('閘門開：無 diarize/utterances，保留 punctuate/smart_format/nova-3', () => {
    const url = deepgramHttpUrl('zh', true)
    expect(url).not.toContain('diarize')
    expect(url).not.toContain('utterances')
    expect(url).toContain('model=nova-3')
    expect(url).toContain('punctuate=true')
    expect(url).toContain('smart_format=true')
    expect(url).toContain('language=zh-TW')
  })

  it('閘門關：完整 diarize/utterances（Cue 原流程）', () => {
    const url = deepgramHttpUrl('zh', false)
    expect(url).toContain('diarize=true')
    expect(url).toContain('utterances=true')
    expect(url).toContain('language=zh-TW')
  })

  it('英文模式 language=en，gated 邏輯相同', () => {
    expect(deepgramHttpUrl('en', true)).toContain('language=en')
    expect(deepgramHttpUrl('en', true)).not.toContain('diarize')
    expect(deepgramHttpUrl('en', false)).toContain('diarize=true')
  })
})

describe('isOpenAIModel（模型服務商路由）', () => {
  it('gpt / o1 / o3 前綴 → OpenAI', () => {
    expect(isOpenAIModel('gpt-4o')).toBe(true)
    expect(isOpenAIModel('gpt-4o-mini')).toBe(true)
    expect(isOpenAIModel('o1')).toBe(true)
    expect(isOpenAIModel('o3-mini')).toBe(true)
  })
  it('claude 模型 → 非 OpenAI', () => {
    expect(isOpenAIModel('claude-sonnet-4-6')).toBe(false)
    expect(isOpenAIModel('claude-haiku-4-5')).toBe(false)
  })
})
