export type SuggestLanguage = 'zh' | 'en'

export interface DialogTurn {
  them: string // 對方說的話（solve＝使用者的提問）
  me: string // 當時給的回答／建議
}

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
  history?: DialogTurn[] // 最近幾輪對話，讓追問接得上（全模式共用）
}

const BASE_PROMPTS: Record<'work' | 'daily' | 'custom' | 'solve' | 'guide', string> = {
  work:
    '你是使用者的即時對話助手。逐字稿是對方剛說的話，請替使用者形成下一段可直接說出口的回答。' +
    '情境是工作場合（面試、會議、簡報）：講話口語、像正常人在對話，不要書面語或一般人平常不會用的生硬字詞；' +
    '但內容一定要有料——有觀點、有依據、站得住腳，不講空話。' +
    '可以偶爾穿插相關的英文專有名詞顯得專業，但別堆砌、別為秀而秀。' +
    '不用「我覺得」「可能」「應該吧」這類沒把握的口頭禪。',
  daily:
    '你是使用者的即時對話助手。逐字稿是對方剛說的話，請替使用者形成下一段可直接說出口的回答。' +
    '情境是日常交談，語氣自然、口語、像真人聊天，但仍要回答實質內容，不用空泛附和。',
  custom:
    '你是使用者的即時對話助手。逐字稿是對方剛說的話，請形成一段可直接說出口、內容完整的回答。',
  solve:
    '你是使用者的即時解題助手。逐字稿是使用者本人剛說出的問題，請直接把答案講出來、讓使用者能照著念；不是建議怎麼回話。',
  guide:
    '你是使用者的即時步驟教學助手。逐字稿是使用者說「想做的事」，請產生清楚、可照做的分步教學。',
}

// guide（步驟教學）契約：總覽先行＋編號步驟，每步簡短到眼鏡一頁放得下。
const GUIDE_CONTRACT = `

【回答契約】
第一行輸出「總覽：共 N 步」，可在同一行後面補一句所需材料或前置條件。
接著逐行輸出編號步驟，每行開頭「步驟 K：」，每步只做一個動作、簡短（每步 ≤2 行、≤60 字），眼鏡一頁要放得下。
只輸出總覽與步驟，不要前言、不要結語、不要在步驟之外多寫東西。
可以使用通用專業知識；假設或替代做法用「例如」標示。不得虛構不存在的步驟、規格或數據。`

// solve（直答）專用契約：答案先行、可多行，語意與對話模式相反。
const SOLVE_CONTRACT = `

【回答契約】
第一行就是答案或結論，直接給出，不要前言、不要重述問題。
之後最多 2–3 行補關鍵步驟或理由，每行簡短、可照著念。
程式或數學題：先給最終答案，再給關鍵思路，不逐行列出程式碼。
可以使用通用專業知識。假設案例必須明確使用「例如」標示。
只有逐字稿、目前場景或知識庫明確提供時，才可聲稱我、我們或公司做過、驗證過或達成某結果；不得虛構經歷、成果、百分比或其他具體數字。
資料不足時說明前提或條件，不得虛構。`

const COMMON_CONTRACT = `

【回答契約】
只輸出一個完整答案，不使用編號、標題、前言或多個選項；整段必須可直接照著念。
開頭 1–2 句直接提出判斷或立場，不要只重述問題。後續依題目說明原因、機制、影響、演進或例子，形成連續論述。
題目適合時，自然加入 2–4 個相關英文術語，但最多只能使用 4 個不同的英文術語；其他概念優先使用中文，不得堆砌。適合時在結尾補一個關鍵風險或落地條件，不要硬塞正反兩面。
可以使用通用專業知識。假設案例必須明確使用「例如」標示。
只有逐字稿、目前場景或知識庫明確提供時，才可聲稱我、我們或公司做過、驗證過或達成某結果；不得虛構經歷、成果、百分比或其他具體數字。
缺乏上述資料時，不得聲稱我、我們或公司做過、驗證過或達成某結果。
資料不足時改談機制、原則、條件或風險，不得為湊字數重複或虛構。`

const LENGTH_RULES: Record<string, { zh: string; en: string }> = {
  short: {
    zh: '單一答案全文以 40–70 個中文字為目標。硬性上限為 70 個字元，絕對不得超過；計數包含標點符號與英文術語。只用一個段落，不得換行或加入空白行。最多 2 句，每句不得超過 40 個字元。輸出前在內部自我檢查句數、每句字元數與全文字元數；若任何一句或全文可能超過上限，刪除次要例子、重複內容或次要細節，並在上限內保持答案完整。不得輸出檢查過程；完整性與事實正確性優先於達到目標下限。',
    en: 'The single English answer should target 20–30 words, excluding the translation line. The hard maximum is 30 words, excluding the translation line, and must never be exceeded. Delete secondary details to keep the answer complete within that maximum. Completeness and factual accuracy take priority over reaching the lower target.',
  },
  medium: {
    zh: '單一答案全文以 80–110 個中文字為目標。硬性上限為 110 個字元，絕對不得超過；計數包含標點符號與英文術語。只用一個段落，不得換行或加入空白行。最多 3 句，每句不得超過 45 個字元。輸出前在內部自我檢查句數、每句字元數與全文字元數；若任何一句或全文可能超過上限，刪除次要例子、重複內容或次要細節，並在上限內保持答案完整。不得輸出檢查過程；完整性與事實正確性優先於達到目標下限。',
    en: 'The single English answer should target 35–50 words, excluding the translation line. The hard maximum is 50 words, excluding the translation line, and must never be exceeded. Delete secondary details to keep the answer complete within that maximum. Completeness and factual accuracy take priority over reaching the lower target.',
  },
  long: {
    zh: '單一答案全文以 110–140 個中文字為目標。硬性上限為 140 個字元，絕對不得超過；計數包含標點符號與英文術語。只用一個段落，不得換行或加入空白行。最多 4 句，每句不得超過 45 個字元。輸出前在內部自我檢查句數、每句字元數與全文字元數；若任何一句或全文可能超過上限，刪除次要例子、重複內容或次要細節，並在上限內保持答案完整。不得輸出檢查過程；完整性與事實正確性優先於達到目標下限。',
    en: 'The single English answer should target 50–70 words, excluding the translation line. The hard maximum is 70 words, excluding the translation line, and must never be exceeded. Delete secondary details to keep the answer complete within that maximum. Completeness and factual accuracy take priority over reaching the lower target.',
  },
}

// solve 長度：字數上限沿用（對齊眼鏡單一視窗），但允許「答案行＋數行說明」的多行結構。
const SOLVE_LENGTH_RULES: Record<string, { zh: string; en: string }> = {
  short: {
    zh: '全文（含所有行）以 40–70 個中文字為目標，硬性上限 70 字。答案行後最多再補 2 行說明。',
    en: 'The whole answer targets 20–30 words, hard maximum 30. The answer line plus at most two short lines.',
  },
  medium: {
    zh: '全文（含所有行）以 80–110 個中文字為目標，硬性上限 110 字。答案行後最多再補 3 行說明。',
    en: 'The whole answer targets 35–50 words, hard maximum 50. The answer line plus at most three short lines.',
  },
  long: {
    zh: '全文（含所有行）以 110–140 個中文字為目標，硬性上限 140 字。答案行後最多再補 3 行說明。',
    en: 'The whole answer targets 50–70 words, hard maximum 70. The answer line plus at most three short lines.',
  },
}

function tailTruncate(value: string, max: number): string {
  return value.length > max ? value.slice(value.length - max) : value
}

function normalizedMode(mode?: string): 'work' | 'daily' | 'custom' | 'solve' | 'guide' {
  if (mode === 'daily' || mode === 'custom' || mode === 'solve' || mode === 'guide') return mode
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
  // solve（直答）走自己的契約與長度；其餘模式走對話單一答案契約。
  const isSolve = mode === 'solve'
  // 最近對話脈絡（全模式）：讓追問接得上。solve＝問答；對話模式＝對方/你的回應。
  const historyTurns = (input.history ?? [])
    .filter((h): h is DialogTurn =>
      !!h && typeof h.them === 'string' && typeof h.me === 'string' &&
      (h.them.trim().length > 0 || h.me.trim().length > 0))
    .slice(-6)
  const historyBlock = historyTurns.length
    ? `\n\n【最近對話】\n` +
      historyTurns.map(h => isSolve
        ? `問：${h.them.trim()}\n答：${h.me.trim()}`
        : `對方：${h.them.trim()}\n你的回應：${h.me.trim()}`).join('\n') +
      '\n（以上是稍早的脈絡，供你理解追問；只需針對最新這句回應，不要重述舊內容。）'
    : ''
  const isGuide = mode === 'guide'
  const contract = isGuide ? GUIDE_CONTRACT : isSolve ? SOLVE_CONTRACT : COMMON_CONTRACT
  // guide 由契約控制每步長度，不套單一答案字數上限
  const lengthRules = isSolve ? SOLVE_LENGTH_RULES : LENGTH_RULES
  const lengthRule = lengthRules[input.length ?? 'medium'] ?? lengthRules.medium!
  const lengthBlock = isGuide ? '' : `\n\n【長度】${lang === 'en' ? lengthRule.en : lengthRule.zh}`
  const language = (lang === 'en' && !isGuide)
    ? (isSolve
        ? '\n\n【英文格式】用英文作答，CEFR B1 以內；第一行就是答案。'
        : '\n\n【英文格式】第一行必須是「譯：<對方那句話的中文翻譯>」。空一行後，只輸出一個完整英文回答；使用 CEFR B1 以內詞彙與句型。')
    : ''
  const recent = (input.recentSuggestions ?? [])
    .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    .slice(-12)
  const dedupe = recent.length
    ? `\n\n【最近回答】\n${recent.map(item => `- ${item}`).join('\n')}\n避免逐字或近似重複，改用不同分析角度。`
    : ''

  return {
    lang,
    systemPrompt: base + scene + kb + historyBlock + extend + contract + lengthBlock + language + dedupe,
  }
}

// 依模式組 user message：solve＝使用者本人的提問（問題→答案）；
// 對話模式＝對方說的話（逐字稿→建議）。export 供測試與 worker 共用。
export function buildUserMessage(
  mode: string | undefined,
  transcript: string,
  lang: SuggestLanguage,
): string {
  if (normalizedMode(mode) === 'solve') {
    return lang === 'en'
      ? `The user's own question:\n\n"${transcript}"\n\nAnswer:`
      : `使用者的問題：\n\n「${transcript}」\n\n答案：`
  }
  return lang === 'en'
    ? `Recent conversation transcript (the other person's voice):\n\n"${transcript}"\n\nSuggestions:`
    : `最近的對話逐字稿（對方說的話）：\n\n「${transcript}」\n\n建議：`
}

export function singleAnswerFromText(text: string): string[] {
  const answer = text.trim()
  return answer ? [answer] : []
}
