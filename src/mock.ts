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
        '我是葉家佐，有八年製造產線督導經驗，也持續累積數據分析與金融風控能力。我曾以 Stacking 集成模型拿下輔大 AI 投資競賽第一名，並取得 WorldQuant Gold；我希望把現場異常管理、量化分析與風險意識，轉化成金融後台或數據職務的實際價值。',
      ],
      daily: [
        '我叫家佐，住在新莊，平常一邊工作一邊讀經濟系，最近正在準備金融與數據相關的求職。工作之外我喜歡研究投資和 AI，也會把新學到的方法做成小實驗。',
      ],
      custom: [
        '我會依照你在手機設定的角色、立場與語氣，組成一段可以直接照著說的完整回答；不會再用多個選項或編號清單打斷口語節奏。',
      ],
    },
  },
  {
    transcript: '你為什麼想轉到金融後台？',
    suggestionsByMode: {
      work: [
        '我想轉到金融後台，因為產線異常管理與金融風險監控的核心都是及早發現警訊、量化影響並追蹤改善。我已用 Stacking 模型與投資競賽驗證數據能力，下一步就是把八年現場管理經驗轉成風控價值。',
      ],
      daily: [
        '我一直對金融和投資有興趣，也發現自己很喜歡用數據找問題。在製造現場累積了八年後，我想換到更能發揮分析能力的環境，所以這幾年一直用課程和競賽做準備。',
      ],
    },
  },
  {
    transcript: '最近有看什麼有趣的東西嗎？',
    suggestionsByMode: {
      work: [
        '最近我在追蹤聯準會的利率路徑，特別關注市場如何從通膨、就業與官員談話重新定價。我會把這些變化和資產波動串起來看，當作訓練風險判斷的日常練習。',
      ],
      daily: [
        '最近我在玩量化回測，會用 AI 幫忙整理想法，再自己驗證策略是不是真的有效。這種從一個問題一路追到結果的過程蠻有趣的；你最近有沒有看到什麼值得推薦的東西？',
      ],
    },
  },
  {
    // 長回答刻意觸發換行路徑（LINE_WIDTH = 38）
    transcript: '這個專案時程有點趕，你覺得來得及嗎？',
    suggestionsByMode: {
      work: [
        '來得及，但今天就要鎖定核心範圍，把兩個非必要項目延後。依我帶產線的經驗，後續每天用短站會盯住瓶頸、責任人與交付時點，只要早點暴露風險，時程仍然可控。',
      ],
      daily: [
        '有點趕，不過還是來得及。我們先把一定要交的部分圈出來，其他功能能延就延，再把每天要完成的小目標排好；這樣大家會比較知道現在最該先處理什麼。',
      ],
      custom: [
        '依照你設定的角色與語氣，我會把這個時程問題整理成一段有明確立場、可執行行動與風險提醒的完整回答，讓你可以直接照著說，不需要臨時拼接多個選項。',
      ],
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
