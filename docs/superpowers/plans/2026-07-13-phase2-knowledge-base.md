# Phase 2 — 知識庫 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 兩個 KB 文字框（個人資訊／補充資料）＋每模式勾選掛載＋prompt 組裝順序（模式 prompt → 場景 → KB → 逐字稿），KB 上限 6000 字元從頭截斷保留尾端。

**Architecture:** storage 存兩個 KB 字串與 per-mode 掛載表；main.ts 新「知識庫」設定區（字數即時顯示）；transport /suggest payload 加 `kbPersonal`/`kbExtra`（只送當前模式勾選的）；Worker 在場景區塊後插入 KB 區塊。

**Tech Stack:** 同 Phase 1。

## Global Constraints

- 每次改動後必跑 `npm test`；不自動 commit（待 Evan 確認）。
- v1 不做雲端同步／檔案上傳（Evan 工作流：Obsidian 寫好→貼上）。
- KB 上限 6000 字元／框，**從頭截斷保留尾端**（新資訊通常貼在後面）。
- 預設掛載：work＝兩個都掛；daily＝只掛個人資訊；custom＝都不掛（使用者自控 prompt，需要就勾）。

## 介面契約

storage 新增：
```ts
export const KB_MAX_CHARS = 6000
getKbPersonal(): Promise<string> / setKbPersonal(s)   // set 時截斷保留尾端
getKbExtra(): Promise<string> / setKbExtra(s)
export interface KbAttach { personal: boolean; extra: boolean }
getKbAttach(): Promise<Record<ModeId, KbAttach>> / setKbAttach(map)  // 非法/缺欄回退預設
```

transport `requestSuggestions` params 加：`kbPersonal?: string; kbExtra?: string`（原樣進 body）。

Worker /suggest body 加同名欄位；system prompt 組裝順序改為：
`baseSystem → sceneBlock → kbBlock → lengthBlock → langBlock → dedupeNote`
kbBlock =（有值才加）`\n\n【個人資訊】\n...` + `\n\n【補充資料】\n...`，Worker 端防禦性再截尾端 6000。

### Task 1: storage — KB 內容與掛載表

- [ ] tests/storage.phase2.test.ts（比照 phase1 樣式）：兩 KB round-trip、超長截斷保留尾端（存 7000 字取回 6000 且是尾端）、attach 預設值（work 全掛/daily 個人/custom 不掛）、attach round-trip、壞 JSON 回退預設。
- [ ] 紅燈 → 實作 storage.ts（KEY `cue:kb-personal:v1` / `cue:kb-extra:v1` / `cue:kb-attach:v1`；attach 存 JSON，讀取時逐模式逐欄位驗證合併預設）→ 綠燈。

### Task 2: transport — payload 加 KB 欄位

- [ ] transport.test.ts 追加：`requestSuggestions` 帶 `kbPersonal`/`kbExtra` 進 body。
- [ ] 紅燈 → params 型別與 JSON.stringify 展開加兩欄 → 綠燈。

### Task 3: Worker — KB 區塊插入 prompt

- [ ] body 型別加 `kbPersonal?: string; kbExtra?: string`。
- [ ] `tailTruncate(s, max)` helper（保留尾端）；kbBlock 組裝插在 sceneBlock 後；worker tsc 過。

### Task 4: main.ts — 知識庫 UI 與貫穿

- [ ] main.dom.test.ts 追加：KB 文字框補水、儲存寫入 storage、字數顯示、per-mode 勾選預設與儲存。
- [ ] 紅燈 → UI：「知識庫」section（兩個 textarea＋字數 `x/6000`＋每模式勾選格＋儲存鈕）；bootstrap 補水；`maybeRequestSuggestions` 依 currentMode 的 attach 決定帶哪些 KB → 綠燈。

### Task 5: 驗證

- [ ] `npm test` 全綠、`npm run build` 過、worker tsc 過。
- [ ] 瀏覽器：貼 KB → 存 → 重整補水 → 字數正確。
- [ ] 「請 Evan 實機測試」：真 Worker 下貼個人 KB，問背景問題確認建議引用 KB；換 KB 內容行為跟著變（驗收條款需 LLM 實測）。

## Self-Review

規格 4 條全覆蓋（兩文字框=T1/T4、每模式勾選=T1/T4、組裝順序與截斷=T1/T3、不做同步=不實作）。型別 `KbAttach`/欄位名 kbPersonal/kbExtra 各 Task 一致。無佔位語。
