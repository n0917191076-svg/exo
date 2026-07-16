// Exo 模式庫。每個模式綁一個 system prompt 決定 LLM 建議的口吻，
// 加上模式層級的行為旗標（reactive vs proactive）。
//
// 模式同時出現在眼鏡（單擊循環）與手機設定頁（radio）。custom 模式
// 由使用者在手機端自填 prompt（沿用 Cue 原設計）。

export type ModeId = 'work' | 'daily' | 'custom' | 'solve' | 'guide'

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
  '輸出規則：只輸出一個完整答案，不使用編號、標題、前言或多個選項；整段可直接照著念。' +
  '開頭直接提出判斷或立場，不只重述問題；後續說明原因、機制、影響、演進或例子。' +
  '可使用通用專業知識；假設案例必須標示「例如」。' +
  '除非逐字稿、場景或知識庫明確提供，不得聲稱我、我們或公司做過、驗證過或達成具體數字。'

// 單一樞紐 — 改這裡，全 app 生效。順序有意義：眼鏡上單擊循環的順序。
export const MODES: Mode[] = [
  {
    id: 'work',
    label: '工作',
    glyph: '■',
    description: '面試、會議、簡報用。口語但有料、站得住腳，偶爾穿插英文術語顯專業。',
    systemPrompt:
      '你是使用者的即時對話助手。逐字稿是對方剛說的話，請替使用者形成下一段可直接說出口的回答。' +
      '情境是工作場合（面試、會議、簡報）：講話口語、像正常人在對話，不要書面語或一般人平常不會用的生硬字詞；' +
      '但內容一定要有料——有觀點、有依據、站得住腳，不講空話。' +
      '可以偶爾穿插相關的英文專有名詞顯得專業，但別堆砌、別為秀而秀。' +
      '不用「我覺得」「可能」「應該吧」這類沒把握的口頭禪。' +
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
  {
    id: 'solve',
    label: '直答',
    glyph: '☆',
    description: '我直接問，AI 把答案顯示在眼鏡上（答案先行）。',
    // solve 語意翻轉：收到的聲音＝使用者本人的提問，直接回答問題本身。
    // 不附加 COMMON_RULES（那是對話模式的單一答案契約）；Worker 端 solve
    // 有自己的答案先行契約。
    systemPrompt:
      '你是使用者的即時解題助手。逐字稿是使用者本人剛說出的問題，請直接把答案講出來、讓使用者能照著念；' +
      '不是建議怎麼回話。答案先行：第一行就是答案或結論，之後最多 2–3 行關鍵步驟或理由。' +
      '除非逐字稿、場景或知識庫明確提供，不得虛構經歷、成果或具體數字。',
    proactiveSupported: false,
  },
  {
    id: 'guide',
    label: '教學',
    glyph: '▶',
    description: '說「我要做 X」，AI 生成分步教學，一次一步照著做。',
    // guide 輸出是「總覽＋編號步驟」清單（非單一答案）；Worker 端有自己的
    // 步驟契約，plugin 解析成步驟陣列一次顯示一步。
    systemPrompt:
      '你是使用者的即時步驟教學助手。使用者說想做的事，請產生「總覽：共 N 步」＋逐行編號步驟，' +
      '每步開頭「步驟 K：」、只做一個動作、簡短到眼鏡一頁放得下。不得虛構不存在的步驟或數據。',
    proactiveSupported: false,
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
