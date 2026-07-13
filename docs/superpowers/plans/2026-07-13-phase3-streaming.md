# Phase 3 — 逐字串流顯示 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** /suggest 改串流——Worker 轉發 Anthropic SSE 文字增量為 chunked 純文字流；plugin 逐字讀取，手機側即時渲染、眼鏡側 ≥300ms 節流渲染（一律經 `enqueue()`），保留非串流 fallback。

**Architecture:** Worker 開 `stream: true`，SSE 解析後把 `text_delta` 直接寫進 TransformStream 回傳（`Content-Type: text/plain`）。Plugin 端 transport 新增 `requestSuggestionsStream()`（fetch + `getReader()`），以 Content-Type 判別串流／JSON（舊 Worker 自動 fallback）。main.ts 串流中把累積文字即時渲染到手機 DOM，眼鏡渲染經 300ms 節流器；串流結束用純函式 `parseNumberedList`（移入 utterance.ts）切回建議陣列。

**Tech Stack:** 同前。Anthropic SSE 事件：`content_block_delta`（`delta.type === 'text_delta'`）、`message_stop`。

## Global Constraints

- **眼鏡渲染一律走 `even.ts` 的 `enqueue()`；串流渲染節流 ≥300ms**（併發 textContainerUpgrade 會弄壞 BLE — KNOWN_QUIRKS）。不動 `enqueue()` 本體。
- 手機側 DOM 渲染**不節流**（那是 BLE 限制，DOM 便宜）。
- 保留非串流路徑：Worker `?stream=0` 回舊 JSON；plugin 收到 `application/json` 自動走舊解析（相容舊 Worker／OpenAI fallback／dev-worker 舊版）。
- 每次改動後 `npm test`；不自動 commit（等 Evan 確認後照拆法提交）。
- BLE 實機穩定性與首字延遲由 Evan 驗證；本機驗證節流邏輯與串流讀取（單元＋jsdom）。

## 介面契約

utterance.ts 新增（純函式）：
```ts
export function parseNumberedList(text: string): string[]   // 與 Worker 同邏輯：只留編號行；無編號行時整段當一條
export interface RenderThrottle { push(fn: () => void): void; flush(): void }
export function createRenderThrottle(intervalMs: number, now?: () => number, schedule?: (fn: () => void, ms: number) => void): RenderThrottle
// push：立即執行（距上次 ≥interval）或排程 trailing-edge 執行最後一筆；flush：立即執行未決的最後一筆（串流結束時用）
```

transport.ts 新增：
```ts
requestSuggestionsStream: (
  params: /* 同 requestSuggestions */,
  cb: { onDelta: (accumulated: string) => void },
) => Promise<{ ok: true; suggestions: string[]; streamed: boolean } | { ok: false; error: string }>
// 內部：POST `${base}/suggest?stream=1`；resp Content-Type 含 json → 讀 JSON 走舊格式（streamed:false）；
// 否則 getReader() 循環 decode 累積並回呼 onDelta；結束後 parseNumberedList(accumulated)
```

Worker：`handleSuggest` 在 `?stream=0` 或無 ANTHROPIC_API_KEY 時走現行 JSON 路徑；否則 `callAnthropicStream()` 回 `text/plain; charset=utf-8` chunked 流。

### Task 1: utterance.ts — parseNumberedList ＋ createRenderThrottle（TDD）

- [ ] tests/utterance.test.ts 追加：parseNumberedList（標準 1./2)/雜訊行/無編號 fallback/空字串→[]）；createRenderThrottle 用注入的 fake now/schedule 測：首次立即、間隔內只排一次 trailing、trailing 執行最後一筆、flush 立即清空、interval 後再 push 又立即。
- [ ] 紅燈 → 實作（throttle 不依賴全域 timer，`now`/`schedule` 參數預設 `Date.now`/`setTimeout`，純邏輯可測）→ 綠燈。

### Task 2: Worker — Anthropic 串流轉發＋`?stream=0` fallback

- [ ] `handleSuggest`：`const wantStream = new URL(request.url).searchParams.get('stream') !== '0'`；`wantStream && env.ANTHROPIC_API_KEY` → `callAnthropicStream(apiKey, systemPrompt, transcript, model, lang)`，否則走現行 `callAnthropic`（JSON）。
- [ ] `callAnthropicStream`：fetch Anthropic `stream: true`；`TransformStream` 立即回 `new Response(readable, { headers: { 'Content-Type': 'text/plain; charset=utf-8', ...corsHeaders() } })`；背景讀 SSE（buffer 按 `\n` 切、`data: ` 行 JSON.parse、`content_block_delta` 且 `delta.type==='text_delta'` → write `delta.text`、`message_stop`／reader done → close）；Anthropic 非 200 → 回 JSON 錯誤（尚未開流所以安全）。
- [ ] worker tsc 過；`worker-template/scripts/test-worker.mjs` 加兩案：`?stream=0` 回 JSON 形狀不變、預設回 text/plain（wrangler dev on-demand，部署前跑）。

### Task 3: dev-worker.mjs — 本地串流模擬

- [ ] `/suggest`（非 `?stream=0`）改為 chunked 純文字：把 fixture 建議組成 `1. …\n2. …\n3. …`，以 3–5 段 `res.write` 間隔 ~30ms 送出（模擬逐字）；`?stream=0` 維持 JSON。
- [ ] tests/dev-worker.test.ts：串流路徑 Content-Type text/plain 且全文含 3 條編號行；`?stream=0` 回 JSON 3 條。

### Task 4: transport — requestSuggestionsStream（TDD）

- [ ] tests/transport.test.ts 追加：mock fetch 回 ReadableStream（兩個 chunk）→ onDelta 至少 2 次且遞增累積、最終 suggestions 解析正確、streamed:true；mock 回 application/json → 不呼叫 onDelta、回舊格式、streamed:false；網路錯誤 → ok:false。
- [ ] 紅燈 → 實作（POST `?stream=1`、TextDecoder 增量 decode、AbortController 30s 上限）→ 綠燈。

### Task 5: main.ts — 串流貫穿＋眼鏡 300ms 節流

- [ ] `maybeRequestSuggestions` 改用 `requestSuggestionsStream`：
  - 模組層 `const glassesThrottle = createRenderThrottle(300)`。
  - onDelta：`suggestions = [accumulated]`（串流中整段顯示）→ 手機 DOM 立即更新；眼鏡 `glassesThrottle.push(() => void paint())`。
  - 完成：`suggestions = result.suggestions`；`glassesThrottle.flush()`；最後 `await paint()`。
  - ok:false → 現行錯誤顯示不變。mock 模式不走串流（不變）。
- [ ] jsdom 測試（main.dom 或 audio.bridge 樣式）：mock 串流 fetch → 手機側建議區在串流中就有文字、結束後為解析後條列。
- [ ] 全套 `npm test` 綠、`npm run build` 過。

### Task 6: 驗證與清單

- [ ] `npm test`、`npm run build`、worker tsc、瀏覽器 dev-worker 串流實測（手機側逐字出現）。
- [ ] 「請 Evan 實機測試」：首字上眼鏡時間明顯早於完整生成（驗收條款）；BLE 串流期間不斷線（節流 300ms 的實效）；`wrangler deploy` 後跑 test-worker.mjs 串流兩案。

## Self-Review

規格 3 條全覆蓋：Worker 串流＋fallback=T2、plugin getReader＋300ms enqueue 節流=T4/T5、手機不節流=T5。`parseNumberedList`/`createRenderThrottle`/`requestSuggestionsStream` 名稱與簽名各 Task 一致。無佔位語。
