# Phase 4 — 觸發與控制（閘門收音）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 閘門收音（gated capture）成為預設互動：只在對方說話時開麥，收到的音訊全數視為「對方」，取代語者分離。觸發來源統一走 `TriggerSource` 抽象（眼鏡觸控／手機大按鈕／R1／媒體鍵／自動收音），並依「模式切換只在手機」決策移除眼鏡雙擊循環模式。

**Architecture:** 手勢→語意的對應抽成純函式 `gestureMapFor()`（可測），實際來源做成薄配接器發語意事件給 main.ts 的單一 dispatcher。閘門狀態經 `?gated=1` 傳到 Worker，Worker 據此拿掉 Deepgram 的 diarize/utterances（省成本與延遲）。問句偵測純函式放 utterance.ts，自動收音模式命中即觸發 /suggest。

## Global Constraints

- 不動 `even.ts` 的 `enqueue()`；渲染節流沿用 Phase 3 的 `glassesThrottle`。
- 隱私鐵律不變：麥克風預設 OFF、同意畫面、收音中指示可見。
- 每次改動 `npm test`；不自動 commit（完成後提拆法等確認）。
- MediaSession 是實驗 feature flag **預設關**；實測結論（成/敗）必須記錄。
- iPhone 動作鍵/音量鍵不嘗試（規格明令）。

---

## A. 閘門模式下 Worker 參數的變化

`/transcribe` 的 query 加 `gated=1|0`（body 是 raw PCM，沿用 Phase 1 的 query 慣例；預設 `1`）：

| | 閘門開（gated=1，預設） | 閘門關（gated=0，Cue 原流程） |
|---|---|---|
| Deepgram URL | `model=nova-3&punctuate=true&smart_format=true&language=…`（**移除 `diarize=true&utterances=true`**） | `model=nova-3&punctuate=true&diarize=true&utterances=true&smart_format=true&language=…` |
| Worker 回應 | `{ ok, text }`（無 utterances 欄位） | `{ ok, text, utterances[] }`（現行） |
| Plugin 語者標記 | 整段 text 直接標為「對方」（固定 speaker=OTHER，全部進 LLM context；wearer 過濾邏輯跳過） | 現行 diarize 流程（[A]/[B] 標籤＋wearer 過濾） |
| 成本/延遲 | 較低（Deepgram diarization 是加價項且增加處理時間） | 現行 |

Worker 實作：`deepgramHttpUrl(lang, gated)` — gated 時不串 `&diarize=true&utterances=true`。語者錨定程式碼（wearer-speaker-id）**保留不刪**（沿用 Cue 設計決策 #2：自動收音模式依賴它）。

## B. TriggerSource 介面設計

新檔 `src/triggers.ts`：

```ts
// 語意事件 — 所有觸發來源最終都化約成這四種
export type TriggerEvent =
  | 'gate-start'   // 開始收音（閘門開）
  | 'gate-stop'    // 結束收音並送出（觸發 /suggest）
  | 'cancel'       // 丟棄本段收音（不送出）
  | 'proactive'    // 主動救場：要 2 個可聊話題（daily/custom）
  | 'extend'       // 延伸：回答顯示中雙擊，帶前輪問答 context 接續深入

export type TriggerSourceId = 'glasses' | 'phone-button' | 'r1' | 'media-key' | 'auto'

export interface TriggerSource {
  id: TriggerSourceId
  /** 註冊底層事件，把手勢翻成語意事件丟給 dispatch；回傳解除函式。 */
  attach(dispatch: (ev: TriggerEvent) => void): () => void
}

// 手勢 → 語意的純函式（模式作用域）。配接器不含邏輯，全部查這張表 —
// Phase 8 的 guide/talk 模式加自己的分支即可，不影響其他模式。
export function gestureMapFor(input: {
  mode: ModeId
  micOn: boolean
  /** 螢幕上有回答顯示中（上一輪建議尚未清除）。優先序：micOn > hasAnswer > 純待命 */
  hasAnswer: boolean
  source: 'glasses' | 'ring'
  gesture: 'tap' | 'double-tap'
  /** 自動收音模式下且距上次 transcript ≥ PROACTIVE_SILENT_MS（常數，v1=8000） */
  silentIdle: boolean
}): TriggerEvent | 'exit' | null
```

- **配接器薄**：GlassesTriggerSource 只是把 `even.onTap/onDoubleTap` 轉成 `gestureMapFor()` 查表結果；PhoneButtonTriggerSource 把 pointerdown/up 轉成 `gate-start`/`gate-stop`；R1 進 SDK 手勢後與眼鏡同表（source='ring'）；MediaKeyTriggerSource 把 play/pause 轉 `gate-start`/`gate-stop`；AutoListenTriggerSource 把「final transcript 命中問句偵測」轉成內部觸發（不經手勢表）。
- main.ts 只有一個 `dispatchTrigger(ev)`，不再分散在 onTap/onDoubleTap 各自寫邏輯。
- `'exit'` 不算 TriggerEvent（不是收音語意），由 glasses 配接器直接呼叫 `even.exitApp()`。

## C. 手勢對照表（移除模式循環後；模式切換只在手機 radio）

**眼鏡觸控（R1 戒指同表，source='ring' 除註記外行為一致）：**

狀態優先序：收音中 > 回答顯示中 > 純待命。

| 手勢 × 狀態 | work ▣ | daily ● | custom ◆ |
|---|---|---|---|
| 單擊・純待命（無回答） | 開始閘門收音 | 開始閘門收音；**自動收音中且靜默 ≥PROACTIVE_SILENT_MS → proactive 話題** | 同 daily |
| 單擊・回答顯示中 | 開始新一輪收音（清屏） | 同 | 同 |
| 單擊・收音中 | 結束收音＋送出（/suggest） | 同 | 同 |
| 雙擊・純待命（無回答） | 退出 app（glasses）；ring 無作用 | 同 | 同 |
| 雙擊・回答顯示中 | **延伸（extend）**：帶前輪問答 context 發「接續深入」，串流接在原回答後加「── 延伸 ──」分隔，可連續雙擊逐層加深 | 同 | 同 |
| 雙擊・收音中 | **取消本段**（丟棄不送） | glasses 同左；**ring 雙擊 → proactive 話題**（沿用 Cue ring-tap） | 同 daily |
| 滑動 | 無作用（保留給 Phase 8 翻頁/步驟） | 同 | 同 |

**誤觸保護**：退出只在「純待命且無回答」的雙擊——回答顯示中雙擊一律是延伸，不會誤退。長按退出待 SDK 事件查證（even.ts 現只處理 tap/double/scroll；Task 4 查官方文件，有支援再加，不憑記憶編 API）。extend 適用 work/daily/custom（Phase 7 的 solve 沿用同語意）。

**其他來源（全模式一致）：**

| 來源 | 對應 |
|---|---|
| 手機大按鈕（全螢幕 ≥60%、高對比） | 按住＝收音（gate-start）、放開＝送出（gate-stop）；按住中滑出按鈕區＝取消（cancel） |
| 媒體鍵戒指（feature flag，預設關） | play＝gate-start、pause＝gate-stop（無 cancel） |
| 自動收音模式（settings 開關） | 持續收音；每個 final transcript 過 `isQuestionZh()` 命中 → 立即 /suggest（繞過 6s debounce）；沿用 idle 自動暫停 |

與 Cue 的差異：①雙擊待命不再循環模式（改手機 radio）②收音中雙擊從「退出」改為「取消本段」——閘門互動下誤觸收音很常見，取消比退出高頻；退出移到待命雙擊。

---

## Tasks

### Task 1: 純函式 — `isQuestionZh` ＋ `gestureMapFor`（TDD）
（`gestureMapFor` 含 hasAnswer 維度與 extend；`PROACTIVE_SILENT_MS = 8_000` 抽常數；custom 的 proactive 比照 daily）
- `utterance.ts`：`isQuestionZh(text)` — 句尾 `？/嗎/呢`（含全半形）或含疑問詞（什麼/如何/為什麼/怎麼/多少/幾/哪/能不能/可不可以/是不是）。測試覆蓋常見句型＋反例（「我幾乎完成了」的「幾」誤判防範——疑問詞取詞邊界可行性 v1 從簡：先允許誤判、測試記錄已知限制）。
- `triggers.ts`：`gestureMapFor()` 按上表窮舉測試（3 模式 × 手勢 × 狀態 × source）。

### Task 2: storage — 三開關（TDD）
`cue:gated-mode:v1`（預設 '1'）、`cue:auto-listen:v1`（預設 '0'）、`cue:media-key:v1`（預設 '0'）＋ round-trip 測試。

### Task 3: transport ＋ Worker — gated 參數（TDD）
- `createTransport(url, token, { lang, gated })` → `/transcribe?lang=…&gated=1|0`；測 URL。
- Worker `deepgramHttpUrl(lang, gated)`：gated 不串 diarize/utterances；`handleTranscribe` 讀 query；tsc＋test-worker 兩案（gated=1 URL 無 diarize —— 以 mock 或旁路驗證參數組裝函式，抽 export 供 import 測試）。
- Worker /suggest body 加 `extendContext?: string`（目前螢幕上的完整回答）：有值時 system prompt 附「使用者要求在以下回答基礎上接續深入，不重複已說過的內容」＋原回答；transport 的 SuggestParams 同步加欄位。

### Task 4: TriggerSource 配接器＋main.ts dispatcher
- glasses/R1 配接器接 `gestureMapFor`；移除 `cycleMode`（連同眼鏡端提示文字「[2x] cycle mode」改為新對照）；`dispatchTrigger` 實作 gate-start/stop/cancel/proactive；gated 模式語者標記「對方」。
- cancel 語意：閘門收音中丟棄 pending buffer＋不觸發 /suggest（transport 需要 `discard()` 或 endMicSession(sendTail=false) 參數）。
- extend 語意：`dispatchTrigger('extend')` → 以原 transcript ＋ `extendContext=螢幕上完整回答` 發 requestSuggestionsStream，增量接在原回答後（先插一行「── 延伸 ──」），眼鏡沿用 300ms 節流；連續 extend 的 extendContext 含前次延伸全文（逐層累積）。
- 更新 `scripts/regression.mjs`：移除模式循環步驟，改測「單擊開收音→建議→單擊關」「雙擊收音中取消（無 /suggest 觸發，state log 註記 cancel）」；`tests/main.bridge.test.ts` 的雙擊循環測試改為新語意。

### Task 5: 手機大按鈕頁
設定頁頂部加「大按鈕」區（或獨立分頁鈕切換全螢幕 overlay）：pointerdown/up/leave → phone-button TriggerSource；高對比、佔幅 ≥60%、收音中明顯視覺狀態（紅框＋文字）。jsdom 測 pointer 事件 → dispatcher 呼叫。

### Task 6: 自動收音模式
settings 開關；開啟時 mic session 常開（非閘門流程、走 diarize 路徑）、每個 final transcript `isQuestionZh` 命中 → 立即 maybeRequestSuggestions（繞過 debounce 的 force 參數）；沿用 idle 自動暫停。jsdom 測：問句 transcript 進來 → /suggest 立即發。

### Task 7: MediaSession 實驗（flag 預設關）
無聲 1s loop `<audio>`＋`navigator.mediaSession.setActionHandler('play'/'pause')` → gate-start/stop；只在 flag 開時啟動。jsdom 只測「flag 關不註冊」；實測風險（宿主攔截 audio session、與 `audioControl(true)` 衝突）列 Evan 清單，失敗即記 KNOWN_QUIRKS 並關閉路線。

### Task 8: 驗證
`npm test` 全綠、build、worker tsc、e2e（新 regression 流程）、瀏覽器 mock 驗證。Evan 實機清單：閘門實聽品質、cancel 手感、R1（若購入）、MediaSession 成敗結論、自動收音誤觸率。

## Self-Review
規格逐條：閘門開關＋Worker 參數＝A/T3、語者標記＝T4、四種觸發來源經 TriggerSource＝B/T4-7、MediaSession 結論＝T7、自動收音＋問句偵測＝T1/T6、idle 沿用＝T6；新增決策「模式切換只在手機」＝C/T4。名稱一致：`TriggerEvent`/`gestureMapFor`/`isQuestionZh` 全文統一。
