# Phase 1 — 中文化與核心設定 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 Cue 的模式庫換成 Evan 的三模式（work/daily/custom）、Deepgram 切中文、新增場景/模型/長度/語言四項設定並貫穿 plugin → transport → Worker 全鏈路。

**Architecture:** 不改三層分工。plugin 端 `modes.ts` 重寫 + `storage.ts` 加四個設定 + `main.ts` 設定 UI；`transport.ts` 的 /suggest payload 擴充、/transcribe 帶 `?lang=`；Worker 端依 lang 組 Deepgram URL、依 payload 組 prompt 並轉發 model。

**Tech Stack:** TypeScript + Vite、Vitest（node + jsdom）、Cloudflare Worker（worker-template/index.ts）。

## Global Constraints

- 每次改動後必跑 `npm test`，紅燈不進下一步（專案 CLAUDE.md）。
- **不自動 commit**（使用者全域規則）；計畫內的 commit 步驟一律改為「改動累積，待 Evan 確認後提交」。
- 不動 `src/even.ts`；不用 WebSocket；API key 只在 Worker secrets。
- 程式碼註解用繁體中文（新寫的部分）；沿用檔案的既有風格。
- 基準測試數：91（Phase 0 驗收值），完成後只增不減。

## 已查證的外部事實（Deepgram 官方文件，2026-07-13 via Context7）

- **nova-3 自 2026-03-31 起支援繁中**：`model=nova-3&language=zh-TW`（亦接受 `zh-Hant`）。
- **英文**：`model=nova-3&language=en`。`language=multi`（code-switching）只涵蓋 en/es/fr/de/hi/ru/pt/ja/it/nl **十種語言、不含中文**，不適用本案 → 英文模式用 `language=en`。
- **Diarization 是語言無關的**（2023-06 新架構起），`diarize=true&utterances=true` 對 zh-TW 照常可用。
- 備援：若實測 nova-3 中文品質不佳，退 `model=nova-2&language=zh-TW`（nova-2 亦支援）。

## 規格偏差備忘（實作時照此做）

1. CLAUDE.md 說 /transcribe 的 lang「由請求 body 帶入」，但 /transcribe 的 body 是 **raw PCM 二進位**，塞不了 JSON 欄位 → 改用 **query 參數 `?lang=zh|en`**。/suggest 維持 body 欄位。
2. 英文模式的「譯：」行若獨立一行會被 Worker 的 `parseNumberedList()`（只留編號行）濾掉 → prompt 指示 LLM 把翻譯放在**第 1 條編號項**（`1. 譯：…`），第 2、3 條為英文回答。

## 新 /suggest 請求合約（v2，Phase 2 再加 KB 欄位）

```jsonc
{
  "mode": "work" | "daily" | "custom",
  "transcript": "...",              // 必填
  "customPrompt": "...",            // custom 模式才帶
  "recentSuggestions": ["..."],     // 沿用 v0.4.2 去重
  "sceneNote": "面試：主管面，補一句",  // 選填
  "model": "claude-sonnet-4-6",     // 允許清單：claude-haiku-4-5 / claude-sonnet-4-6
  "length": "short" | "medium" | "long",
  "lang": "zh" | "en"
}
```

Worker prompt 組裝順序（固定）：模式 systemPrompt（或 customPrompt）→ 場景 `【目前場景】…` → 長度規則 → 英文模式分支 → 去重清單。

---

### Task 1: 重寫 `src/modes.ts`（work/daily/custom）

**Files:**
- Modify: `src/modes.ts`（整檔重寫，保留結構與函式簽名）
- Test: `tests/modes.test.ts`（更新既有測試 + 新增三模式斷言）

**Interfaces:**
- Produces: `type ModeId = 'work' | 'daily' | 'custom'`；`MODES`、`modeById()`、`nextMode()`、`DEFAULT_MODE: ModeId = 'work'` 簽名不變。後續 Task 全部依賴這個 `ModeId`。

- [ ] **Step 1: 改寫測試**（先寫測試 — 既有 6 測試改成對新模式的斷言）

```ts
import { describe, expect, it } from 'vitest'
import { DEFAULT_MODE, MODES, modeById, nextMode } from '../src/modes'

describe('mode registry', () => {
  it('恰好三個模式：work / daily / custom', () => {
    expect(MODES.map(m => m.id)).toEqual(['work', 'daily', 'custom'])
  })

  it('glyph 符合規格：work ▣、daily ●、custom ◆', () => {
    expect(modeById('work').glyph).toBe('▣')
    expect(modeById('daily').glyph).toBe('●')
    expect(modeById('custom').glyph).toBe('◆')
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

  it('非 custom 模式的 systemPrompt 是繁中且含共同規則', () => {
    for (const m of MODES.filter(x => x.id !== 'custom')) {
      expect(m.systemPrompt).toMatch(/2–3 條/)
      expect(m.systemPrompt).toMatch(/先結論|先講結論/)
      expect(m.systemPrompt).toMatch(/照著念/)
    }
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
```

- [ ] **Step 2: 跑測試確認紅燈**

Run: `npx vitest run tests/modes.test.ts`
Expected: FAIL（MODES 還是舊的七模式）

- [ ] **Step 3: 重寫 `src/modes.ts`**

```ts
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
    glyph: '▣',
    description: '面試、會議、簡報用。回答精準、有結構、顯得專業，可含關鍵數字。',
    systemPrompt:
      '你是使用者的即時對話助手。逐字稿是對方剛說的話，請建議使用者接下來怎麼回應。' +
      '情境是工作場合（面試、會議、簡報），目標是顯得專業：回答精準、有結構，' +
      '有把握時帶入關鍵數字或具體事實，不確定的數字寧可不說。' +
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
    glyph: '◆',
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
```

- [ ] **Step 4: 跑 modes 測試綠燈；全套測試會紅（mock.ts / main.ts 還引用舊 id）— 預期中，下一個 Task 修**

Run: `npx vitest run tests/modes.test.ts`
Expected: PASS（其餘檔案的 TypeScript 錯誤在 Task 2、3 修）

---

### Task 2: 更新 `src/mock.ts` 為中文腳本 + 修 `main.ts` 的模式引用

**Files:**
- Modify: `src/mock.ts`（腳本換繁中、鍵換新模式）
- Modify: `src/main.ts`（`MODE_BULLET`、persisted-mode 驗證）
- Test: `tests/mock.test.ts`、`tests/main.bridge.test.ts:216`

**Interfaces:**
- Consumes: Task 1 的 `ModeId`。
- Produces: `nextMockExchange(mode)` fallback 改為 `.work`；main.ts 對壞掉的持久化 mode 回退 `DEFAULT_MODE`（後續測試依賴此行為）。

- [ ] **Step 1: 更新 `tests/mock.test.ts`**（'date'→'work'、'argue-calm'→'work'，proactive 測試改 daily 有 / work 無）

```ts
import { beforeEach, describe, expect, it } from 'vitest'
import { nextMockExchange, nextMockProactiveTopics, resetMock } from '../src/mock'
import { MODES } from '../src/modes'

describe('mock driver', () => {
  beforeEach(() => resetMock())

  it('每個模式都拿得到 transcript + suggestions', () => {
    for (const mode of MODES) {
      resetMock()
      const ex = nextMockExchange(mode.id)
      expect(ex.transcript.length).toBeGreaterThan(5)
      expect(ex.suggestions.length).toBeGreaterThan(0)
      for (const s of ex.suggestions) {
        expect(typeof s).toBe('string')
        expect(s.length).toBeGreaterThan(2)
        expect(s.length).toBeLessThan(200)
      }
    }
  })

  it('腳本會循環（長度 > 1）', () => {
    const a = nextMockExchange('work').transcript
    const b = nextMockExchange('work').transcript
    expect(a).not.toBe(b)
  })

  it('daily 模式有 proactive 話題', () => {
    const topics = nextMockProactiveTopics('daily')
    expect(topics.length).toBeGreaterThan(0)
    for (const t of topics) expect(t.length).toBeGreaterThan(3)
  })

  it('沒有 proactive 話題的模式優雅降級', () => {
    const topics = nextMockProactiveTopics('work')
    expect(topics.length).toBe(1)
    expect(topics[0]).toMatch(/not available|尚無/i)
  })
})
```

- [ ] **Step 2: 跑測試確認紅燈** — `npx vitest run tests/mock.test.ts`

- [ ] **Step 3: 重寫 `src/mock.ts` 腳本區**（結構不動，換內容；繁中、貼 Evan 情境）

```ts
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
```

（`nextMockExchange` 內 fallback 兩處 `entry.suggestionsByMode.date` → `entry.suggestionsByMode.work`；其餘函式不動。）

- [ ] **Step 4: 修 `src/main.ts` 兩處**

`MODE_BULLET`（`src/main.ts:383` 附近）：

```ts
const MODE_BULLET: Record<ModeId, string> = {
  work: '▣',
  daily: '●',
  custom: '◆',
}
```

bootstrap 的持久化 mode 驗證（`src/main.ts:949` 附近）— 舊使用者存的 `date` 等 id 已不存在，直接用會讓 `modeById` 拋錯：

```ts
  const persistedMode = await getMode()
  if (persistedMode && MODES.some(m => m.id === persistedMode)) currentMode = persistedMode
```

- [ ] **Step 5: 修 `tests/main.bridge.test.ts:216`**：`'cue:mode:v1': 'date'` → `'cue:mode:v1': 'work'`。若該測試斷言模式 label/描述文字，一併改為新模式文案。

- [ ] **Step 6: 全套測試** — `npm test`，Expected: PASS（91 基準內的舊斷言全數更新完畢）。若 `tests/main.dom.test.ts` 有舊模式文案斷言，比照更新。

---

### Task 3: `src/storage.ts` 新增四個設定（scene/model/length/lang）

**Files:**
- Modify: `src/storage.ts`（檔尾追加）
- Test: `tests/storage.phase1.test.ts`（新檔，比照 storage.v04.test.ts 的 jsdom + in-memory localStorage 樣式）

**Interfaces:**
- Produces（Task 4、6 依賴）：

```ts
export type ModelChoice = 'claude-haiku-4-5' | 'claude-sonnet-4-6'
export type AnswerLength = 'short' | 'medium' | 'long'
export type LangMode = 'zh' | 'en'
export const DEFAULT_MODEL: ModelChoice = 'claude-sonnet-4-6'
export const DEFAULT_ANSWER_LENGTH: AnswerLength = 'medium'
export const DEFAULT_LANG: LangMode = 'zh'
getSceneNote(): Promise<string> / setSceneNote(note: string)
getModelChoice(): Promise<ModelChoice> / setModelChoice(m: ModelChoice)
getAnswerLength(): Promise<AnswerLength> / setAnswerLength(l: AnswerLength)
getLang(): Promise<LangMode> / setLang(l: LangMode)
```

- [ ] **Step 1: 寫 `tests/storage.phase1.test.ts`（先紅）**

```ts
// Phase 1 新設定的 round-trip 測試（場景說明 / 模型 / 回答長度 / 語言）。
// jsdom + in-memory localStorage，比照 storage.v04.test.ts。

/// <reference types="vitest/globals" />
// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_ANSWER_LENGTH,
  DEFAULT_LANG,
  DEFAULT_MODEL,
  getAnswerLength,
  getLang,
  getModelChoice,
  getSceneNote,
  setAnswerLength,
  setLang,
  setModelChoice,
  setSceneNote,
  setStorageBridge,
} from '../src/storage'

beforeEach(() => {
  const store: Record<string, string> = {}
  globalThis.localStorage = {
    getItem: (k: string) => store[k] ?? null,
    setItem: (k: string, v: string) => { store[k] = v },
    removeItem: (k: string) => { delete store[k] },
    clear: () => { for (const k of Object.keys(store)) delete store[k] },
    key: (i: number) => Object.keys(store)[i] ?? null,
    get length() { return Object.keys(store).length },
  } as Storage
  setStorageBridge(null)
})

afterEach(() => setStorageBridge(null))

describe('scene note round-trip', () => {
  it('預設空字串', async () => {
    expect(await getSceneNote()).toBe('')
  })
  it('存取一致', async () => {
    await setSceneNote('面試：金融後台主管面')
    expect(await getSceneNote()).toBe('面試：金融後台主管面')
  })
})

describe('model choice round-trip', () => {
  it('預設 claude-sonnet-4-6', async () => {
    expect(await getModelChoice()).toBe(DEFAULT_MODEL)
    expect(DEFAULT_MODEL).toBe('claude-sonnet-4-6')
  })
  it('存 haiku 取回 haiku', async () => {
    await setModelChoice('claude-haiku-4-5')
    expect(await getModelChoice()).toBe('claude-haiku-4-5')
  })
  it('儲存的非法值回退預設', async () => {
    globalThis.localStorage.setItem('cue:model:v1', 'gpt-9000')
    expect(await getModelChoice()).toBe(DEFAULT_MODEL)
  })
})

describe('answer length round-trip', () => {
  it('預設 medium', async () => {
    expect(await getAnswerLength()).toBe(DEFAULT_ANSWER_LENGTH)
  })
  it('存 short 取回 short', async () => {
    await setAnswerLength('short')
    expect(await getAnswerLength()).toBe('short')
  })
  it('非法值回退預設', async () => {
    globalThis.localStorage.setItem('cue:answer-length:v1', 'xxl')
    expect(await getAnswerLength()).toBe(DEFAULT_ANSWER_LENGTH)
  })
})

describe('lang round-trip', () => {
  it('預設 zh', async () => {
    expect(await getLang()).toBe(DEFAULT_LANG)
    expect(DEFAULT_LANG).toBe('zh')
  })
  it('存 en 取回 en', async () => {
    await setLang('en')
    expect(await getLang()).toBe('en')
  })
  it('非法值回退 zh', async () => {
    globalThis.localStorage.setItem('cue:lang:v1', 'fr')
    expect(await getLang()).toBe('zh')
  })
})
```

- [ ] **Step 2: 紅燈確認** — `npx vitest run tests/storage.phase1.test.ts`

- [ ] **Step 3: `src/storage.ts` 檔尾追加**

```ts
// ── Phase 1（Exo）：場景說明 / 模型 / 回答長度 / 語言 ──────────────
// 皆為手機端設定，比照既有 key 命名（cue: 前綴沿用，避免舊資料失聯）。

const KEY_SCENE_NOTE = 'cue:scene-note:v1'
const KEY_MODEL = 'cue:model:v1'
const KEY_ANSWER_LENGTH = 'cue:answer-length:v1'
const KEY_LANG = 'cue:lang:v1'

export type ModelChoice = 'claude-haiku-4-5' | 'claude-sonnet-4-6'
export type AnswerLength = 'short' | 'medium' | 'long'
export type LangMode = 'zh' | 'en'

export const DEFAULT_MODEL: ModelChoice = 'claude-sonnet-4-6'
export const DEFAULT_ANSWER_LENGTH: AnswerLength = 'medium'
export const DEFAULT_LANG: LangMode = 'zh'

const MODEL_CHOICES: ModelChoice[] = ['claude-haiku-4-5', 'claude-sonnet-4-6']
const ANSWER_LENGTHS: AnswerLength[] = ['short', 'medium', 'long']
const LANG_MODES: LangMode[] = ['zh', 'en']

export async function getSceneNote(): Promise<string> {
  return (await readRaw(KEY_SCENE_NOTE)) ?? ''
}
export async function setSceneNote(note: string): Promise<void> {
  await writeRaw(KEY_SCENE_NOTE, note)
}

// 非法儲存值一律回退預設 — 手機端下拉理論上擋得住，但儲存層可能被
// 舊版本或手動改動污染，防禦性驗證便宜。
export async function getModelChoice(): Promise<ModelChoice> {
  const raw = await readRaw(KEY_MODEL)
  return MODEL_CHOICES.includes(raw as ModelChoice) ? (raw as ModelChoice) : DEFAULT_MODEL
}
export async function setModelChoice(m: ModelChoice): Promise<void> {
  await writeRaw(KEY_MODEL, m)
}

export async function getAnswerLength(): Promise<AnswerLength> {
  const raw = await readRaw(KEY_ANSWER_LENGTH)
  return ANSWER_LENGTHS.includes(raw as AnswerLength) ? (raw as AnswerLength) : DEFAULT_ANSWER_LENGTH
}
export async function setAnswerLength(l: AnswerLength): Promise<void> {
  await writeRaw(KEY_ANSWER_LENGTH, l)
}

export async function getLang(): Promise<LangMode> {
  const raw = await readRaw(KEY_LANG)
  return LANG_MODES.includes(raw as LangMode) ? (raw as LangMode) : DEFAULT_LANG
}
export async function setLang(l: LangMode): Promise<void> {
  await writeRaw(KEY_LANG, l)
}
```

- [ ] **Step 4: 綠燈 + 全套** — `npx vitest run tests/storage.phase1.test.ts && npm test`

---

### Task 4: `src/transport.ts` — /suggest payload v2 + /transcribe `?lang=`

**Files:**
- Modify: `src/transport.ts`
- Test: `tests/transport.test.ts`（追加，不刪既有）

**Interfaces:**
- Consumes: Task 3 的 `LangMode`。
- Produces（Task 6 依賴）：
  - `createTransport(workerUrl, bearerToken, opts?: { lang?: 'zh' | 'en' })` — lang 進 /transcribe URL query；預設 `'zh'`。
  - `requestSuggestions(params)` 新增選填欄位 `sceneNote?: string; model?: string; length?: string; lang?: string`，原樣進 JSON body。

- [ ] **Step 1: 追加測試（先紅）** — `tests/transport.test.ts` 檔尾：

```ts
  // ─── Phase 1: lang 進 /transcribe query、新設定進 /suggest body ────
  it('flush 的 /transcribe URL 帶 ?lang=', async () => {
    const urls: string[] = []
    globalThis.fetch = vi.fn(async (url: string) => {
      urls.push(String(url))
      if (String(url).includes('/healthz')) return new Response('ok', { status: 200 })
      return new Response(JSON.stringify({ ok: true, text: '' }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      })
    }) as unknown as typeof fetch
    const t = createTransport('https://cue.example.workers.dev', 'secret', { lang: 'en' })
    await t.startMicSession(() => {}, () => {})
    t.sendAudioFrame(new Uint8Array(20_000))
    await t.endMicSession()
    const transcribeUrl = urls.find(u => u.includes('/transcribe'))
    expect(transcribeUrl).toBe('https://cue.example.workers.dev/transcribe?lang=en')
  })

  it('未指定 lang 時 /transcribe 預設 zh', async () => {
    const urls: string[] = []
    globalThis.fetch = vi.fn(async (url: string) => {
      urls.push(String(url))
      if (String(url).includes('/healthz')) return new Response('ok', { status: 200 })
      return new Response(JSON.stringify({ ok: true, text: '' }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      })
    }) as unknown as typeof fetch
    const t = createTransport('https://cue.example.workers.dev', 'secret')
    await t.startMicSession(() => {}, () => {})
    t.sendAudioFrame(new Uint8Array(20_000))
    await t.endMicSession()
    expect(urls.find(u => u.includes('/transcribe'))).toContain('?lang=zh')
  })

  it('requestSuggestions 帶 sceneNote/model/length/lang 進 body', async () => {
    const fetchSpy = vi.fn(async () => new Response(
      JSON.stringify({ ok: true, suggestions: ['一', '二'] }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ))
    globalThis.fetch = fetchSpy as unknown as typeof fetch
    const t = createTransport('https://cue.example.workers.dev', 'secret')
    await t.requestSuggestions({
      mode: 'work',
      transcript: '請自我介紹',
      sceneNote: '面試：主管面',
      model: 'claude-haiku-4-5',
      length: 'short',
      lang: 'zh',
    })
    const [, init] = fetchSpy.mock.calls[0]! as [string, RequestInit]
    const body = JSON.parse(init.body as string)
    expect(body.sceneNote).toBe('面試：主管面')
    expect(body.model).toBe('claude-haiku-4-5')
    expect(body.length).toBe('short')
    expect(body.lang).toBe('zh')
  })
```

- [ ] **Step 2: 紅燈確認** — `npx vitest run tests/transport.test.ts`

- [ ] **Step 3: 實作**（最小 diff）
  - `createTransport(workerUrl: string, bearerToken: string, opts: { lang?: 'zh' | 'en' } = {})`；函式內 `const lang = opts.lang ?? 'zh'`。
  - `flush()` 內 `const url = `${baseHttp}/transcribe?lang=${lang}``。
  - `CueTransport.requestSuggestions` 參數型別加 `sceneNote?: string; model?: string; length?: string; lang?: string`；`JSON.stringify` 的 body 展開這些欄位（undefined 會被 JSON.stringify 自然剔除）。

- [ ] **Step 4: 綠燈 + 全套** — `npx vitest run tests/transport.test.ts && npm test`

---

### Task 5: Worker — lang-aware Deepgram + prompt 組裝 + 模型轉發

**Files:**
- Modify: `worker-template/index.ts`
- Modify: `worker-template/scripts/test-worker.mjs`（mode `'date'` → `'work'`，共 4 處）

**Interfaces:**
- Consumes: Task 4 的請求形狀（`?lang=`、/suggest body v2）。
- Produces: /suggest 回應形狀不變 `{ ok, suggestions[] }`；/transcribe 回應形狀不變。

- [ ] **Step 1: Deepgram URL 依 lang 組裝** — 取代 `DEEPGRAM_HTTP` 常數：

```ts
// 批次（HTTP）Deepgram 端點 — nova-3 自 2026-03 起支援繁中（zh-TW）。
// diarization 為語言無關（Deepgram 2023-06 新架構），zh 照常可用。
// 若實測 nova-3 中文品質不佳，退 nova-2（同樣支援 zh-TW）。
const DEEPGRAM_HTTP_BASE =
  'https://api.deepgram.com/v1/listen?model=nova-3&punctuate=true&diarize=true&utterances=true&smart_format=true'

function deepgramHttpUrl(lang: 'zh' | 'en'): string {
  return `${DEEPGRAM_HTTP_BASE}&language=${lang === 'en' ? 'en' : 'zh-TW'}`
}
```

`handleTranscribe` 內（fetch 之前）：

```ts
  const lang = new URL(request.url).searchParams.get('lang') === 'en' ? 'en' as const : 'zh' as const
  // ...
  const dgRes = await fetch(deepgramHttpUrl(lang), { ... })  // 原 DEEPGRAM_HTTP 改此
```

- [ ] **Step 2: /suggest body v2 + prompt 組裝** — `handleSuggest` 的 body 型別與組裝改為：

```ts
  let body: {
    mode?: string
    transcript?: string
    customPrompt?: string
    recentSuggestions?: string[]
    sceneNote?: string
    model?: string
    length?: string
    lang?: string
  }
```

`baseSystem` 之後、`dedupeNote` 之前插入：

```ts
  // Phase 1：場景說明 → 長度規則 → 語言分支，依序附加在 system prompt 後
  const lang = body.lang === 'en' ? 'en' : 'zh'
  const sceneBlock = body.sceneNote?.trim()
    ? `\n\n【目前場景】${body.sceneNote.trim()}`
    : ''
  const LENGTH_RULES: Record<string, { zh: string; en: string }> = {
    short:  { zh: '每條建議 ≤10 個字。',  en: 'Each suggestion must be at most 10 words.' },
    medium: { zh: '每條建議 ≤20 個字。',  en: 'Each suggestion must be at most 20 words.' },
    long:   { zh: '每條建議 ≤40 個字。',  en: 'Each suggestion must be at most 40 words.' },
  }
  const lengthRule = LENGTH_RULES[body.length ?? 'medium'] ?? LENGTH_RULES.medium!
  const lengthBlock = `\n\n${lang === 'en' ? lengthRule.en : lengthRule.zh}`
  // 英文模式：翻譯必須放第 1 條編號項，否則會被 parseNumberedList 濾掉
  const langBlock = lang === 'en'
    ? '\n\n對方說的是英文。輸出格式：第 1 條必須是「譯：<對方那句話的中文翻譯>」；' +
      '第 2、3 條為英文回答建議，用簡單詞彙（CEFR B1 以內），使用者可直接照念。'
    : ''
  const systemPrompt = baseSystem + sceneBlock + lengthBlock + langBlock + dedupeNote
```

（`dedupeNote` 既有邏輯不動，只改最後串接順序。）

- [ ] **Step 3: 模型允許清單 + 轉發** — `callAnthropic` 加 `model` 參數：

```ts
// 只轉發允許清單內的模型 — plugin 傳什麼不可信（bearer 洩漏時的保險）。
const ALLOWED_MODELS = ['claude-haiku-4-5', 'claude-sonnet-4-6']
const DEFAULT_MODEL = 'claude-sonnet-4-6'
```

`handleSuggest` 內：

```ts
  const model = ALLOWED_MODELS.includes(body.model ?? '') ? body.model! : DEFAULT_MODEL
  if (env.ANTHROPIC_API_KEY) {
    return await callAnthropic(env.ANTHROPIC_API_KEY, systemPrompt, body.transcript, model, lang)
  }
```

`callAnthropic` 簽名 `(apiKey, systemPrompt, transcript, model: string, lang: 'zh' | 'en')`；請求 body 的 `model: model`、`max_tokens: 400`（長答案 3×40 繁中字約 240 tokens，200 會截斷）；user content 依 lang：

```ts
      content: lang === 'en'
        ? `Recent conversation transcript (the other person's voice):\n\n"${transcript}"\n\nSuggestions:`
        : `最近的對話逐字稿（對方說的話）：\n\n「${transcript}」\n\n建議：`,
```

- [ ] **Step 4: Worker 端 fallback prompts 換新模式**（`systemPromptForMode`）：

```ts
function systemPromptForMode(mode: string): string {
  // plugin 端 src/modes.ts 的鏡像 — plugin 沒帶 customPrompt 時的保底。
  const PROMPTS: Record<string, string> = {
    work:
      '你是使用者的即時對話助手，情境是工作場合，目標是顯得專業：回答精準、有結構。' +
      '給 2–3 條建議，每條能直接照著念；先講結論；不加前言；編號清單輸出。',
    daily:
      '你是使用者的即時對話助手，情境是日常閒聊，口語、放鬆。' +
      '給 2–3 條建議，每條能直接照著念；先講結論；不加前言；編號清單輸出。',
  }
  return PROMPTS[mode] ?? PROMPTS.work!
}
```

- [ ] **Step 5: `worker-template/scripts/test-worker.mjs`** — 4 處 `mode: 'date'` → `mode: 'work'`。

- [ ] **Step 6: 型別檢查 + 全套** — `cd worker-template && npx tsc --noEmit`（若無 tsconfig 則以 `npm test` 的建置為準）；回根目錄 `npm test`。
  註：`scripts/test-worker.mjs` 需要 wrangler dev 起本地 Worker，屬 on-demand 驗證（KNOWN_QUIRKS 測試矩陣），部署前由 Evan 跑或另行執行。

---

### Task 6: `src/main.ts` 設定 UI + payload 貫穿；dev-worker fixtures

**Files:**
- Modify: `src/main.ts`（新設定區塊 + 綁定 + hydration + requestSuggestions 帶新欄位 + createTransport 帶 lang）
- Modify: `scripts/dev-worker.mjs`（SUGGEST_FIXTURES 換 work/daily/custom，fallback `.date` → `.work`）
- Test: `tests/dev-worker.test.ts`（mode 引用更新）、`tests/main.dom.test.ts`（若有舊文案斷言則更新）

**Interfaces:**
- Consumes: Task 3 的 getters/setters 與型別、Task 4 的 `createTransport(url, token, { lang })` 與 requestSuggestions 欄位。

- [ ] **Step 1: module state + hydration** — main.ts 模組層新增：

```ts
// Phase 1 設定 — bootstrap 時從 storage 補水
let sceneNote = ''
let modelChoice: ModelChoice = DEFAULT_MODEL
let answerLength: AnswerLength = DEFAULT_ANSWER_LENGTH
let langMode: LangMode = DEFAULT_LANG
```

（import 對應符號自 `./storage`。）bootstrap 內、`createTransport` 之前：

```ts
  sceneNote = await getSceneNote()
  modelChoice = await getModelChoice()
  answerLength = await getAnswerLength()
  langMode = await getLang()
  sceneNoteInput.value = sceneNote
  modelSelect.value = modelChoice
  answerLengthSelect.value = answerLength
  langSelect.value = langMode
```

兩處 `createTransport(...)`（bootstrap 與 saveWorkerBtn handler）都改成第三參數 `{ lang: langMode }`。

- [ ] **Step 2: 設定 UI 區塊** — 在「Mode」section 之後插入（沿用現有 inline-style 風格）：

```html
    <section>
      <h2 style="font-size: 1.1em; margin: 1.5rem 0 .5rem 0;">對話設定</h2>
      <div style="display: grid; gap: .5rem; max-width: 520px;">
        <label>目前場景（會原樣附進 prompt）
          <input id="scene-note" type="text" placeholder="例：面試——金融後台主管面" style="padding: .35rem; width: 100%; box-sizing: border-box;" />
        </label>
        <label>語言
          <select id="lang-mode" style="padding: .35rem; margin-left: .5rem;">
            <option value="zh">中文</option>
            <option value="en">英文（譯＋英文建議）</option>
          </select>
        </label>
        <label>模型
          <select id="model-choice" style="padding: .35rem; margin-left: .5rem;">
            <option value="claude-sonnet-4-6">Sonnet（預設，聰明）</option>
            <option value="claude-haiku-4-5">Haiku（快）</option>
          </select>
        </label>
        <label>回答長度
          <select id="answer-length" style="padding: .35rem; margin-left: .5rem;">
            <option value="short">短（≤10 字）</option>
            <option value="medium">中（≤20 字）</option>
            <option value="long">長（≤40 字）</option>
          </select>
        </label>
        <button id="save-convo" type="button" style="margin-top: .25rem; padding: .35rem .7rem; cursor: pointer; max-width: 200px;">儲存對話設定</button>
        <p id="convo-status" style="color: #2a2; font-size: .85em; min-height: 1.2em; margin: 0;"></p>
      </div>
    </section>
```

元素綁定（比照既有 querySelector 區）＋儲存 handler：

```ts
const sceneNoteInput = document.querySelector<HTMLInputElement>('#scene-note')!
const langSelect = document.querySelector<HTMLSelectElement>('#lang-mode')!
const modelSelect = document.querySelector<HTMLSelectElement>('#model-choice')!
const answerLengthSelect = document.querySelector<HTMLSelectElement>('#answer-length')!
const saveConvoBtn = document.querySelector<HTMLButtonElement>('#save-convo')!
const convoStatus = document.querySelector<HTMLParagraphElement>('#convo-status')!

saveConvoBtn.addEventListener('click', async () => {
  sceneNote = sceneNoteInput.value
  langMode = (langSelect.value === 'en' ? 'en' : 'zh')
  modelChoice = (modelSelect.value === 'claude-haiku-4-5' ? 'claude-haiku-4-5' : 'claude-sonnet-4-6')
  answerLength = (['short', 'long'].includes(answerLengthSelect.value)
    ? answerLengthSelect.value as AnswerLength : 'medium')
  await setSceneNote(sceneNote)
  await setLang(langMode)
  await setModelChoice(modelChoice)
  await setAnswerLength(answerLength)
  // lang 影響 /transcribe URL — 重建 transport 讓下一次 mic session 生效
  const wUrl = await getWorkerUrl()
  const wTok = await getWorkerToken()
  transport = createTransport(wUrl, wTok, { lang: langMode })
  isRealMode = transport.ready
  convoStatus.textContent = '已儲存。下次收音生效。'
  window.setTimeout(() => { convoStatus.textContent = '' }, 4000)
})
```

- [ ] **Step 3: requestSuggestions 帶新欄位** — `maybeRequestSuggestions()` 內：

```ts
    const result = await transport.requestSuggestions({
      mode: currentMode,
      transcript: liveTranscript,
      customPrompt,
      recentSuggestions: recentSuggestionsRing.slice(),
      sceneNote,
      model: modelChoice,
      length: answerLength,
      lang: langMode,
    })
```

- [ ] **Step 4: `scripts/dev-worker.mjs`** — `SUGGEST_FIXTURES` 鍵換成 `work` / `daily` / `custom`（各 3 條繁中假建議），fallback `SUGGEST_FIXTURES.date` → `SUGGEST_FIXTURES.work`；`payload.mode ?? 'date'` → `?? 'work'`。

- [ ] **Step 5: `tests/dev-worker.test.ts`** — `'date'` → `'work'`、第二個模式 → `'daily'`（斷言兩模式建議不同、unknown mode fallback 仍 3 條）。

- [ ] **Step 6: 全套測試 + 建置** — `npm test && npm run build`，Expected: 全綠、tsc 無錯。

---

### Task 7: 收尾驗證（Phase 1 驗收）

- [ ] **Step 1: `npm test` 全綠**，測試數 ≥ 91。
- [ ] **Step 2: `npm run build` 過**（tsc + vite）。
- [ ] **Step 3: 瀏覽器 mock 驗證** — `npm run dev` + Playwright：切模式（工作/日常/自訂）、改場景/模型/長度/語言並儲存、開 mic 確認 mock 建議顯示、重整確認設定持久化。
- [ ] **Step 4:（可選）dev-worker 驗證** — `npm run dev:worker` 起本地假 Worker，設定頁填 `http://localhost:8787`，確認 /suggest payload 含新欄位（dev-worker log 會印 mode）。
- [ ] **Step 5: 更新「請 Evan 實機測試」清單** — nova-3 zh-TW 實際收音品質（不佳退 nova-2）；英文模式「1. 譯：…」格式在眼鏡上的可讀性；真 Worker 部署後 /suggest 各設定組合的回覆格式。
- [ ] **Step 6: 彙報改動清單，等 Evan 確認後才 commit**（使用者全域規則：不自動 commit）。

## Self-Review 紀錄

- 規格覆蓋：Phase 1 六項 → 1 Deepgram 中文＋lang 參數（Task 5）、2 modes.ts（Task 1–2）、3 場景說明（Task 3/5/6）、4 模型選擇（Task 3/5/6）、5 回答長度（Task 3/5/6）、6 語言模式（Task 3/4/5/6）。驗收條件由 Task 7 覆蓋。
- 型別一致：`ModeId`（Task 1）、`ModelChoice/AnswerLength/LangMode`（Task 3）在 Task 4/5/6 引用處拼字一致；`createTransport` 第三參數形狀 Task 4 定義 = Task 6 使用。
- 佔位語檢查：無 TBD/TODO；所有步驟含實碼。
