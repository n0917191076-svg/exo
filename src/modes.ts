// Exo 模式庫。每個模式綁一個 system prompt 決定 LLM 建議的口吻，
// 加上模式層級的行為旗標（reactive vs proactive）。
//
// 模式同時出現在眼鏡（單擊循環）與手機設定頁（radio）。custom 模式
// 由使用者在手機端自填 prompt（沿用 Cue 原設計）。

export type ModeId = 'work' | 'daily' | 'custom'

export interface Mode {
  id: ModeId
  label: string // 使用者看到的名稱
  glyph: string // 眼鏡上的單字元指示（需為已驗證安全字元）
  description: string // 手機設定頁說明
  systemPrompt: string // 送給 LLM
  proactiveSupported: boolean // true = 靜默時 ring 雙擊可要新話題
}

// 共同輸出規則 — 附加在每個內建模式 prompt 尾端。custom 模式不附加
// （使用者全權掌控措辭）。
const COMMON_RULES =
  '輸出規則：給 2–3 條建議，每條都要能直接照著念出口；先講結論；' +
  '不加任何前言或說明；以編號清單輸出（1. 2. 3.），每條一行。'

// 單一樞紐 — 改這裡，全 app 生效。順序有意義：眼鏡上單擊循環的順序。
export const MODES: Mode[] = [
  {
    id: 'work',
    label: '工作',
    glyph: '■',
    description: '面試、會議、簡報用。回答精準、有結構、顯得專業，可含關鍵數字。',
    systemPrompt:
      '你是使用者的即時對話助手。逐字稿是對方剛說的話，請建議使用者接下來怎麼回應。' +
      '情境是工作場合（面試、會議、簡報），目標是顯得專業：回答精準、有結構，' +
      '有把握時帶入關鍵數字或具體事實，不確定的數字寧可不說。' +
      '不用猶疑語（「我覺得」「可能」「應該吧」這類）；' +
      '描述經歷時可用「情境—任務—行動—結果」（STAR）結構，但僅在自然時使用，不硬套。' +
      COMMON_RULES,
    proactiveSupported: false,
  },
  {
    id: 'daily',
    label: '日常',
    glyph: '●',
    description: '日常閒聊用。依你的個人背景自然回答，口語、放鬆。',
    systemPrompt:
      '你是使用者的即時對話助手。逐字稿是對方剛說的話，請建議使用者接下來怎麼回應。' +
      '情境是日常閒聊，請依使用者的個人背景自然回答，口語、放鬆、像朋友聊天，' +
      '不要書面語。' +
      COMMON_RULES,
    proactiveSupported: true,
  },
  {
    id: 'custom',
    label: '自訂',
    glyph: '★',
    description: '用你自己的 system prompt（在手機設定頁填寫）。',
    systemPrompt: '', // 使用者自填；空值時 Worker 端有通用 fallback
    proactiveSupported: true,
  },
]

export function modeById(id: ModeId): Mode {
  const m = MODES.find(x => x.id === id)
  if (!m) throw new Error(`unknown mode: ${id}`)
  return m
}

// 眼鏡單擊循環用。
export function nextMode(current: ModeId): ModeId {
  const idx = MODES.findIndex(m => m.id === current)
  const next = (idx + 1) % MODES.length
  return MODES[next]!.id
}

export const DEFAULT_MODE: ModeId = 'work'
