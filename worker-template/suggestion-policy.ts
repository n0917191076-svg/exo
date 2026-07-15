export type SuggestLanguage = 'zh' | 'en'

export interface SuggestPromptInput {
  mode?: string
  customPrompt?: string
  recentSuggestions?: string[]
  sceneNote?: string
  length?: string
  lang?: string
  kbPersonal?: string
  kbExtra?: string
  extendContext?: string
}

const BASE_PROMPTS: Record<'work' | 'daily' | 'custom', string> = {
  work:
    '你是使用者的即時對話助手。逐字稿是對方剛說的話，請替使用者形成下一段可直接說出口的回答。' +
    '情境是工作場合（面試、會議、簡報），回答要專業、有結構、有明確觀點。' +
    '不用「我覺得」「可能」「應該吧」等無意義猶疑語；描述真實經歷時可自然使用 STAR，但不要硬套。',
  daily:
    '你是使用者的即時對話助手。逐字稿是對方剛說的話，請替使用者形成下一段可直接說出口的回答。' +
    '情境是日常交談，語氣自然、口語、像真人聊天，但仍要回答實質內容，不用空泛附和。',
  custom:
    '你是使用者的即時對話助手。逐字稿是對方剛說的話，請形成一段可直接說出口、內容完整的回答。',
}

const COMMON_CONTRACT = `

【回答契約】
只輸出一個完整答案，不使用編號、標題、前言或多個選項；整段必須可直接照著念。
開頭 1–2 句直接提出判斷或立場，不要只重述問題。後續依題目說明原因、機制、影響、演進或例子，形成連續論述。
題目適合時，自然加入 2–4 個相關英文術語，但不得堆砌；適合時在結尾補一個關鍵風險或落地條件，不要硬塞正反兩面。
可以使用通用專業知識。假設案例必須明確使用「例如」標示。
只有逐字稿、目前場景或知識庫明確提供時，才可聲稱我、我們或公司做過、驗證過或達成某結果；不得虛構經歷、成果、百分比或其他具體數字。
缺乏上述資料時，不得聲稱我、我們或公司做過、驗證過或達成某結果。
資料不足時改談機制、原則、條件或風險，不得為湊字數重複或虛構。`

const LENGTH_RULES: Record<string, { zh: string; en: string }> = {
  short: {
    zh: '單一答案全文以 80–120 個中文字為目標。',
    en: 'The single English answer should be 30–45 words, excluding the translation line.',
  },
  medium: {
    zh: '單一答案全文以 180–240 個中文字為目標。',
    en: 'The single English answer should be 70–100 words, excluding the translation line.',
  },
  long: {
    zh: '單一答案全文以 320–420 個中文字為目標。',
    en: 'The single English answer should be 130–170 words, excluding the translation line.',
  },
}

function tailTruncate(value: string, max: number): string {
  return value.length > max ? value.slice(value.length - max) : value
}

function normalizedMode(mode?: string): 'work' | 'daily' | 'custom' {
  if (mode === 'daily' || mode === 'custom') return mode
  return 'work'
}

export function buildSuggestPrompt(input: SuggestPromptInput): {
  systemPrompt: string
  lang: SuggestLanguage
} {
  const mode = normalizedMode(input.mode)
  const lang: SuggestLanguage = input.lang === 'en' ? 'en' : 'zh'
  const custom = input.customPrompt?.trim() ?? ''
  const base = mode === 'custom' && custom ? custom : BASE_PROMPTS[mode]
  const scene = input.sceneNote?.trim()
    ? `\n\n【目前場景】${input.sceneNote.trim()}`
    : ''
  const personal = tailTruncate((input.kbPersonal ?? '').trim(), 6000)
  const extra = tailTruncate((input.kbExtra ?? '').trim(), 6000)
  const kb =
    (personal ? `\n\n【個人資訊】\n${personal}` : '') +
    (extra ? `\n\n【補充資料】\n${extra}` : '')
  const extend = input.extendContext?.trim()
    ? `\n\n【延伸要求】\n請在以下回答基礎上接續深入，不要重複已說內容：\n${input.extendContext.trim()}`
    : ''
  const length = LENGTH_RULES[input.length ?? 'medium'] ?? LENGTH_RULES.medium!
  const lengthBlock = `\n\n【長度】${lang === 'en' ? length.en : length.zh}`
  const language = lang === 'en'
    ? '\n\n【英文格式】第一行必須是「譯：<對方那句話的中文翻譯>」。空一行後，只輸出一個完整英文回答；使用 CEFR B1 以內詞彙與句型。'
    : ''
  const recent = (input.recentSuggestions ?? [])
    .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    .slice(-12)
  const dedupe = recent.length
    ? `\n\n【最近回答】\n${recent.map(item => `- ${item}`).join('\n')}\n避免逐字或近似重複，改用不同分析角度。`
    : ''

  return {
    lang,
    systemPrompt: base + scene + kb + extend + COMMON_CONTRACT + lengthBlock + language + dedupe,
  }
}
