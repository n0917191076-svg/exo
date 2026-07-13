// Mock 建議驅動 — 沒設定 Worker 時用計時器產生假逐字稿與建議，
// 讓使用者不用金鑰就能體驗流程。真實 STT + LLM 走 transport.ts。

import type { ModeId } from './modes'

interface MockEntry {
  transcript: string // 「對方」剛說的話
  suggestionsByMode: Partial<Record<ModeId, string[]>>
}

// 幾組合理的對話輪替。transcript 模式無關；建議依模式不同。
const SCRIPT: MockEntry[] = [
  {
    transcript: '可以簡單自我介紹一下嗎？',
    suggestionsByMode: {
      work: [
        '好的，我是葉家佐，八年產線督導經驗。',
        '我拿過輔大 AI 投資競賽第一名。',
        '我的強項是數據分析與風控。',
      ],
      daily: ['我叫家佐，最近在忙求職。', '平常喜歡研究投資和 AI。'],
      custom: ['（自訂模式：建議格式由你手機端的 prompt 決定）'],
    },
  },
  {
    transcript: '你為什麼想轉到金融後台？',
    suggestionsByMode: {
      work: [
        '結論：我要把八年製造管理帶進風控。',
        '產線異常管理跟風險監控本質相同。',
        '我已用 Stacking 模型驗證過能力。',
      ],
      daily: ['想換個更能發揮數據能力的環境。', '一直對金融有興趣，也準備很久了。'],
    },
  },
  {
    transcript: '最近有看什麼有趣的東西嗎？',
    suggestionsByMode: {
      work: ['最近在追蹤聯準會利率路徑的研究。'],
      daily: [
        '在看量化回測的東西，蠻好玩的。',
        '最近迷上用 AI 做投資實驗。',
        '你呢？有什麼推薦的？',
      ],
    },
  },
  {
    // 長建議刻意觸發換行路徑（LINE_WIDTH = 38）
    transcript: '這個專案時程有點趕，你覺得來得及嗎？',
    suggestionsByMode: {
      work: [
        '結論：可以，但要先砍掉兩個非核心項目，我建議今天就定優先序。',
        '依我帶產線的經驗，關鍵是每日站會盯瓶頸工序。',
      ],
      daily: ['應該還行啦，先把最重要的做完。', '有點趕，不過拆小一點就還好。'],
      custom: ['（自訂模式建議照你的 prompt 逐字輸出）'],
    },
  },
]

const PROACTIVE_TOPICS_BY_MODE: Partial<Record<ModeId, string[][]>> = {
  daily: [
    ['問：最近有去哪裡玩嗎？', '問：週末都怎麼過？', '聊：最近看的劇或電影。'],
    ['問：最近工作還順嗎？', '聊：分享一件今天的小事。'],
  ],
  custom: [['問對方一個開放式問題。', '分享一件你今天遇到的小事。']],
}

let scriptIdx = 0
let proactiveIdx = 0

export function nextMockExchange(mode: ModeId): { transcript: string; suggestions: string[] } {
  const entry = SCRIPT[scriptIdx % SCRIPT.length]!
  scriptIdx += 1
  const suggestions =
    entry.suggestionsByMode[mode] ??
    entry.suggestionsByMode.work ?? // 該模式沒配建議時退回 work
    ['(no suggestions configured for this mode)']
  return { transcript: entry.transcript, suggestions }
}

export function nextMockProactiveTopics(mode: ModeId): string[] {
  const list = PROACTIVE_TOPICS_BY_MODE[mode]
  if (!list || list.length === 0) {
    return ['(proactive topics not available in this mode)']
  }
  const topics = list[proactiveIdx % list.length]!
  proactiveIdx += 1
  return topics
}

export function resetMock(): void {
  scriptIdx = 0
  proactiveIdx = 0
}
