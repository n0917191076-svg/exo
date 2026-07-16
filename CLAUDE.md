# CLAUDE.md — Exo（AI 外骨骼）

本檔案是給 Claude Code 的完整開發指南。開工前先把本檔案全部讀完，再讀 `KNOWN_QUIRKS.md`。回答格式一律以「## 回答輸出契約」為準。

## 這個專案是什麼

**Exo** — 使用者 Evan 的個人「AI 外骨骼」：Even Realities G2 智慧眼鏡上的即時對話輔助 App。
眼鏡麥克風收音 → Deepgram 轉文字（中文為主）→ Claude 依「模式 + 場景 + 知識庫」生成建議回答 → 逐字顯示在眼鏡鏡片上，Evan 照著講。

本專案 fork 自開源專案 **Cue**（github.com/tntpsu/Cue），架構、測試、踩坑筆記全部沿用。我們的工作是在它之上做中文化與客製功能，**不是重寫**。

## 使用者是誰（寫 prompt 與預設值時要用到）

- 葉家佐（Evan），26 歲，台灣新莊，母語繁體中文，英文有限
- 輔大經濟系進修部三年級；東寶馬達製造產線督導約 8 年
- 成就：輔大 AI 投資競賽第一名（Stacking 集成模型，Sharpe 1.57）、WorldQuant Gold、書卷獎
- 求職方向：金融後台／數據分析／風控／投研
- 溝通風格：先結論後細節、極簡、不要廢話

## 三層架構（不要改變這個分工）

1. **Plugin（本 repo）** — TypeScript + Vite 單頁應用，跑在 Even Realities 手機 App 的 WKWebView 裡。手機側是設定畫面＋大按鈕控制；眼鏡側是文字顯示。
   - `src/main.ts` 狀態機（收音 session、渲染迴圈）
   - `src/even.ts` 眼鏡橋接（顯示、手勢、`enqueue()` 序列化渲染）——**高危檔案，非必要不動**
   - `src/transport.ts` 音訊切塊（~2.5s）→ HTTP POST 到 Worker
   - `src/utterance.ts` 純函式：斷句偵測、逐字稿修剪、語者標籤
   - `src/modes.ts` 模式庫（每模式一個 system prompt）——**我們主要改這裡**
   - `src/storage.ts` 手機側設定持久化
2. **Worker（`worker-template/`）** — Evan 自己部署的 Cloudflare Worker，持有 Deepgram + Anthropic 金鑰。端點：`POST /transcribe`、`POST /suggest`、`GET /healthz`。Plugin 永遠不碰 API key。
3. **眼鏡硬體** — 收音（PCM 16kHz mono 16bit，經 `audioControl(true)`）與顯示（`textContainerUpgrade`）。你的程式碼不在眼鏡上跑。

## 產品需求（Evan 的 10 點，逐條對應）

| # | 需求 | 實作位置 |
|---|------|---------|
| 1 | 跑在 Even 原生 App 內 | 本架構天生如此（Even Hub plugin），不需另做手機 App |
| 2 | 手機設定好即收起；常用操作用媒體鍵戒指 | Phase 4：大按鈕 UI + 媒體鍵實驗 |
| 3 | 模式（工作/日常/自訂）＋場景說明＋可換知識庫 | Phase 1 + Phase 2 |
| 4 | 預設中文；英文模式＝中文翻譯＋英文回答 | Phase 1（Deepgram language 參數 + prompt 分支）|
| 5 | 可調模型（速度） | Phase 1：settings → /suggest payload（haiku/sonnet）|
| 6 | 可調回答長度（短/中/長） | Phase 1：settings → prompt 附加規則 |
| 7 | 可持續迭代更新 | 開發流程本身（QR sideload / dev portal 上傳）|
| 8 | 手動收音：大按鈕＋媒體鍵；自動收音：安靜場合持續聽 | Phase 4 |
| 9 | 偵測到問題就開始思考回答 | Phase 4：final transcript 問句偵測 → 立即觸發 /suggest |
| 10 | 回答逐字顯示，越快越好 | Phase 3：Anthropic streaming → Worker 串流 → plugin 節流渲染 |

## 沿用 Cue 的設計決策（已確認，不要移除這些）

1. **Proactive 主動救場**：納入 `daily` 模式——收音待命且偵測靜默時，單擊＝請 AI 給 2 個可聊的話題（沿用 Cue 的 proactive 機制與 ring-tap 流程）。
2. **語者自動錨定**：保留 Cue 的 wearer-speaker 錨定程式碼（storage 的 wearer-speaker-id 與相關過濾），閘門模式用不到，但「自動收音模式」依賴它。
3. **模式 glyph**：每模式單字元符號顯示於眼鏡，沿用。
4. **法律警示畫面**：首次啟動的錄音合法性同意畫面，保留，不得移除。
5. **工程工具鏈**：`scripts/` 全部腳本（deploy-portal、upload-dev、lint-app-json、regression、test-webkit 等）沿用並維持可用。
6. **Interview prompt 技巧吸收進 `work` 模式**：headline 先行、禁 hedging 語（「我覺得」「可能」「應該吧」類）、STAR 架構僅在自然時使用。

**模式切換只在手機上**：眼鏡手勢不做模式循環切換（Cue 原本 tap 循環切模式的行為移除），眼鏡手勢全數保留給高頻操作（收音閘門、翻頁/步驟前進、proactive 救場）。各模式的手勢映射依 Phase 4/8 的模式作用域設計。

## 眼鏡顯示硬限制與 UI 慣例（官方文件驗證 2026-07-14，來源 /docs/build/display 與 design guidelines）

**顯示限制（設計任何眼鏡畫面前先看這張表）：**
- 畫布 576×288／眼，4-bit 綠階（16 階）。
- 文字更新**一律用 `textContainerUpgrade`**：上限 2,000 字元、原地更新、硬體無閃爍；一律經 `even.ts` 的 `enqueue()` 序列化與 300ms 節流。`createStartUpPageContainer`／`rebuildPageContainer` 上限 1,000 字元。
- **全螢幕文字容器實際可見僅約 400–500 字元**——更長內容必須分頁或尾端滾動窗，超出部分不是截斷而是根本看不到。
- list 容器：≤20 項、每項 ≤64 字元、**無原地更新**（任何改動＝整頁重建）——頻繁更新的內容不要用 list。
- 影像容器 ≤4 個/頁（各 ≤288×144），其他容器 ≤8 個/頁。
- 註：Device APIs 頁曾讀到「512 bytes/次」上限，與 display 頁的 2,000 字元矛盾——以 display 為準，實機覆核前程式維持保守的 512-byte 尾端窗（詳 KNOWN_QUIRKS）。

**字型（中文可用性生死線）：**單一 LVGL 字型、無字級、非等寬；**字型集外的字元被靜默丟棄**（不顯示豆腐，直接消失）。實機測試第 0 項見下。

**UI 慣例（官方認證 Unicode，UI 符號只從這裡挑）：**
- 進度：`━ ─ █▇▆▅▄▃▂▁`；導航：`▲△▶▷▼▽◀◁`；選取：`●○ ■□ ★☆`；邊框：`╭╮╯╰ │─`；花色：`♠♣♥♦`。
- 假按鈕：文字前綴 `>` 作游標指示。
- **模式 glyph 修訂**（原字元不在認證集，可能被字型丟棄）：work `■`（原▣）、daily `●`（不變）、custom `★`（原◆）、solve `☆`（原✦）、guide `▶`（原➤）、talk `█`（原◉）。電池 `◼`→`■`、裁切提示 `…`→`▲`、提示列改 `>` 前綴——**程式碼配合改動待批准後實作**。

**實機測試第 0 項——LVGL 繁中字型覆蓋（最優先，眼鏡到貨第一件事）：**
把下列測試字串經自訂模式或除錯管道渲染上眼鏡，逐字核對；缺字→Worker prompt 加「避免罕用字」規則或建立替換表：
> 台灣新莊經濟系督導產線製造，數據分析風控投資競賽第一名。你好嗎？請說明：目標、風險（含％與＄）、結論！「引號」『書名』…破音字：銀行行走、長大成長、重要重複、快樂音樂、覺得得到、方便便宜。較罕用：尷尬、囉嗦、瞭解、鑑於、迄今、褪色、欸、齁、咦、嗯、喔、餒。數字０１２３４５６７８９與半形0123456789，標點，。、；：？！～

## 回答輸出契約（單一答案設計，取代舊「2–3 條建議」）

> 已實作於分支 `codex/single-answer-quality`（main + 6 commits、測試綠、尚未 merge 進 main）。本節為唯一真相；`src/modes.ts`、`worker-template/suggestion-policy.ts` 與本節不一致時，以本節為準。

**適用範圍**：「單一答案結構」只套用於 reactive 對話模式 **work / daily / custom**。Phase 7 `solve`（答案先行）、Phase 8 `guide`（分步清單）、`talk`（長串流分頁）各有自己的輸出格式，不受單一答案結構約束。但下方「內容與事實政策」**全模式共用**。

**API 契約（避免大規模重構）**：
- 手機端照舊傳 `mode / transcript / customPrompt / sceneNote / length / lang / 勾選的 KB / extendContext`，API 形狀不變。
- Worker 回傳型別維持 `{ suggestions: string[] }`，但 work/daily/custom 的成功回覆**固定只有一個元素**。
- 串流維持 `text/plain` chunked；plugin 累積全文當唯一答案即時顯示，**完成後不補 `1.` 編號**。空白模型回覆＝error，不建立空 `suggestions[0]`。

**輸出格式（work/daily/custom）**：
- 一段完整答案、可直接照念；不用編號、標題、前言或多個選項。
- 開頭 1–2 句直接表態／給判斷，不重述問題湊字數；後續以原因、機制、影響、演進或例子展開成連續論述。中文為單一段落，不換行、不加空白行。
- custom：使用者自填 prompt 決定角色語氣，但 Worker 仍在其後附加**不可覆寫**的本契約。

**英文模式**：第一行固定 `譯：<對方那句話的中文翻譯>`，空一行後只給一個完整英文回答（CEFR B1 以內）。翻譯與答案共存於 `suggestions[0]`，不拆多元素；長度不計翻譯行。

**內容與事實政策（全模式共用）**：
1. 直接回答核心問題、只講一個核心觀點，不只換句話說。
2. 題目適合時自然加入 2–4 個相關英文術語（如 `LLM`、`MCP`、`API`、`human-in-the-loop`），不堆砌。
3. 可用通用專業知識與公開概念；假設案例必須用「例如」明確標示。
4. 除非逐字稿、場景說明或已掛載 KB 明確提供，**不得聲稱「我／我們／公司做過、驗證過」或給具體成效數字**。
5. 資料不足時改談機制、原則、條件或風險，不用虛構內容填滿字數。
6. 適合時結尾補一個關鍵風險或落地條件，不硬塞正反兩面。

**長度規則（針對單一答案全文，非每條）**：

| 設定 | 中文（目標／硬上限／句數） | 英文（不含譯行） |
|---|---|---|
| 短 | 40–70 字／上限 70／≤2 句、每句 ≤40 字 | 20–30 words／上限 30 |
| 中（預設） | 80–110 字／上限 110／≤3 句、每句 ≤45 字 | 35–50 words／上限 50 |
| 長 | 110–140 字／上限 140／≤4 句、每句 ≤45 字 | 50–70 words／上限 70 |

硬上限計入標點與英文術語，絕對不得超過；模型須內部自我檢查後刪次要內容維持在上限內，不得輸出檢查過程。完整性與事實正確優先於湊到下限。長度全數壓短，是為了讓全文落在眼鏡單一視窗內（見下方顯示段）。

**眼鏡顯示（實機修正 2026-07-16：尾端捲動窗證偽 → 改開頭定錨＋壓短長度，方案 B）**：
- 實機發現：串流時尾端窗跟著「生成速度」捲，快過朗讀——使用者還沒念完開頭、畫面已被推到尾巴。故改用 **`fitHeadByBytes` 開頭定錨窗**（`src/utterance.ts`）：答案定錨開頭、串流時自動 hold 第一頁，由朗讀節奏推進、不跟生成往尾端捲。裁切提示 `▼`＝下方還有內容。
- 實測可視：mic-off 答案窗 ≈148 中文字、自動收音 live 窗 ≈94 字。**長度已壓短對齊此上限**（見長度表），讓全文落在單一視窗、不需捲動。此為方案 B——**不做 swipe 分頁**（分頁仍歸 Phase 8 `talk`）；代價是放棄眼鏡上的長篇答案，手機端仍顯示全文。
- 若日後要恢復長答案，走 Phase 8 reader-paced 分頁（下滑翻頁），**不要退回尾端捲動窗**。

**延伸（extend，承 Phase 4）**：回答顯示中雙擊＝在**該段完整答案**基礎上接續深入、不重複（base 從舊「多條建議 join」改為單一答案全文）。

## 開發階段（嚴格照順序，每階段驗收後才進下一階段）

### Phase 0 — 環境驗證（不寫新功能）
1. `npm install`；`npm test` 全綠（基準 76 tests）。
2. `npm run dev` 起本地伺服器，開瀏覽器確認 mock 模式跑得動（無 Worker 時的假建議）。
3. `cd worker-template && npm install`，讀完 `worker-template/README.md`。
4. 讀 `KNOWN_QUIRKS.md` 全文。
**驗收**：測試全綠 + mock 模式在瀏覽器可操作。

### Phase 1 — 中文化與核心設定
1. **Deepgram 中文**：`worker-template/index.ts` 的 Deepgram URL 加 `language=zh-TW`。/suggest 與 /transcribe 的語言參數改為由請求 body 帶入（`lang: 'zh' | 'en'`），zh → `language=zh-TW`，en → 先查 Deepgram 官方文件確認 nova 系列目前對 multi/en 的建議參數再實作，不要憑記憶猜。**Deepgram model 用 `nova-3`**（2026-03 起支援 zh-TW；`language=multi` 不含中文，故英文模式用 `language=en`）；實機中文品質不佳時退 `nova-2`（同樣支援 zh-TW）。diarization 與 nova-3 的相容性見 `worker-template/index.ts` 註解。
2. **重寫 `modes.ts`**：刪除 date/sting/sales/listen，保留結構。新模式：
   - `work`（工作）glyph `■`：目標是顯得專業。回答精準、有結構、可含關鍵數字。
   - `daily`（日常）glyph `●`：依 Evan 個人背景自然回答，口語、放鬆。
   - `custom`（自訂）glyph `★`：使用者自填 prompt（沿用 Cue 原設計）。
   每個 systemPrompt 用繁體中文撰寫，共同規則見「## 回答輸出契約」（單一完整答案，非 2–3 條）。
3. **場景說明（scene note）**：settings 新增一個文字欄「目前場景」（例：面試 / 簡報 / 會議＋一句補充）。/suggest 時原樣附進 prompt：`【目前場景】...`。
4. **模型選擇**：settings 下拉 — Claude：`claude-haiku-4-5`（快）/ `claude-sonnet-4-6`（預設，聰明）；ChatGPT：`gpt-4o`（聰明）/ `gpt-4o-mini`（快）。傳給 Worker，Worker 依 model 前綴路由（`isOpenAIModel`：`gpt/o1/o3`→OpenAI Chat Completions，其餘→Anthropic Messages）。**ChatGPT 需在 Worker 設 `wrangler secret put OPENAI_API_KEY`**，未設時選 ChatGPT 會回明確錯誤。OpenAI 路徑亦支援串流（`callOpenAIStream`，對稱 `callAnthropicStream`），與 Claude 同樣逐字上屏；`?stream=0` 回 JSON。
5. **回答長度**：settings 三選一 短/中/長 → 依「## 回答輸出契約」長度表附加（中文 40–70／80–110／110–140 字；英文 20–30／35–50／50–70 words，已壓短對齊眼鏡單一視窗）。
6. **語言模式**：settings 切換 中文/英文。英文模式：第一行『譯：<對方那句話的中文翻譯>』，空一行後給**一個**完整英文回答（CEFR B1 內）。詳見「## 回答輸出契約」。
**驗收**：mock 或真 Worker 下，切換模式/模型/長度/語言，/suggest 的 payload 與回覆格式正確；`npm test` 綠（修掉因刪模式而壞的測試，比照原測試風格補新模式的測試）。

### Phase 2 — 知識庫
1. settings 新增兩個大文字框：**個人資訊 KB**、**補充資料 KB**（皆存 `storage.ts`，比照現有設定的存法）。
2. 每個模式可勾選要掛哪些 KB（work 預設兩個都掛；daily 預設只掛個人資訊）。
3. /suggest 的 prompt 組裝順序：模式 systemPrompt → 場景說明 → 勾選的 KB 內容 → 最近逐字稿。KB 過長時**從頭截斷保留尾端**，上限先設 6000 字元並在 UI 顯示目前字數。
4. Evan 的工作流是 Obsidian 寫好 → 複製貼進文字框。**不要**在 v1 做任何雲端同步／檔案上傳功能。
**驗收**：貼入 KB 後，問到個人背景相關問題，建議內容明顯引用 KB；換掉 KB 內容後行為跟著變。

### Phase 3 — 逐字串流顯示
1. Worker /suggest 改為向 Anthropic 開 `stream: true`，把 SSE 的文字增量以 chunked response 直接轉發（純文字流即可，不必轉 JSON）。保留舊的非串流路徑作為 fallback（query 參數 `?stream=0`）。
2. Plugin 端用 `fetch` + `response.body.getReader()` 讀增量。**渲染節流：每 ≥300ms 才呼叫一次眼鏡渲染**，一律走 `even.ts` 的 `enqueue()`。原因見 KNOWN_QUIRKS：併發 `textContainerUpgrade` 會弄壞 BLE 連線。
3. 手機側畫面同步逐字顯示（不節流，DOM 便宜）。
**驗收**：講完一句話後，眼鏡上第一批字出現的時間明顯早於完整回答生成完畢；BLE 不斷線（實機由 Evan 驗證，你先在模擬器與單元測試驗證節流邏輯）。

### Phase 4 — 觸發與控制（閘門收音是本產品核心設計）
**核心概念：精準閘門收音（gated capture）**。使用者只在「對方說話期間」開麥，收到的音訊即可確定全部是對方的話——這取代了語者分離。實作要求：
- 新增 settings 開關「閘門模式」（預設開）。閘門模式下 /transcribe 請求帶 `gated: true`，Worker 收到後 **Deepgram 參數移除 `diarize=true&utterances=true`**（省成本與延遲），plugin 端把該段逐字稿直接標記為「對方」。
- 關閉閘門模式時退回 Cue 原本的 diarize 流程（連續收音、語者標籤）。

觸發來源做成統一抽象（`TriggerSource` 介面：`start`/`stop` 事件），以下來源全部接進同一個介面：
1. **眼鏡觸控（保證可用）**：單擊開始、單擊停止。沿用 Cue 現有邏輯。
2. **手機大按鈕頁（保證可用）**：全螢幕「按住收音」按鈕（佔螢幕 ≥60%，高對比，可盲按），按住收音、放開送出＋觸發 /suggest。
3. **R1 戒指（若使用者購買）**：SDK 原生手勢事件，比照眼鏡觸控接入。
4. **媒體鍵戒指（MediaSession 駭法，實驗性 feature flag，預設關）**：
   - 實作方式：App 進入閘門待命時，播放一段無聲循環 `<audio>`（1 秒靜音 loop），使本 WebView 成為系統「正在播放」對象；註冊 `navigator.mediaSession.setActionHandler('play', ...)` 與 `('pause', ...)`，把戒指的 play/pause 按鍵事件映射為收音 開/關。
   - 已知風險（實測前不保證）：Even App 宿主層可能攔截音訊 session；無聲播放與 `audioControl(true)` 麥克風可能衝突。實測任一項失敗→記錄到 KNOWN_QUIRKS，該路線關閉，明確告知使用者改用 R1。
   - （iPhone 動作鍵與音量鍵無法把事件送進 WebView，**不要嘗試**。）
5. **自動收音模式**：settings 開關。安靜少人環境用：持續收音，對每個 final transcript 跑問句偵測，命中即自動觸發 /suggest。
   - 問句偵測 v1 用純函式規則（放 `utterance.ts`，補測試）：句尾「？/嗎/呢」或含「什麼/如何/為什麼/怎麼/多少/幾/哪/能不能/可不可以/是不是」等疑問詞。
   - 沿用 Cue 現有 idle 自動暫停，避免忘記關。
**驗收**：閘門模式開關正確改變 Worker 參數與語者標記；四種觸發來源都經由 `TriggerSource` 介面運作；MediaSession 路線有明確的實測結論（成或敗都要記錄）；問句偵測測試覆蓋常見句型。

### Phase 5 — 收尾
1. `app.json`：`package_id` 改 `com.evan.exo`、`name` 改 `Exo`、`supported_languages` 用 `zh`（**注意**：`lint-app-json.mjs` 的 BCP-47 allowlist 只收 `en/de/fr/es/it/zh/ja/ko`，**不收 `zh-TW`**——Deepgram 才用 `zh-TW`，app.json 用 `zh`）、whitelist 換成 Evan 的 Worker 網址（**絕不能留佔位網址**，`lint-app-json.mjs` 會擋）。麥克風權限描述改為符合實際行為的繁中說明。
2. `npm run pack` 產出 `.ehpk`；跑 `npm run test:e2e` 與 `npm run test:webkit`。
3. 更新 README：一頁「Evan 的日常使用說明」。

### Phase 6 — 獨立網頁版（無眼鏡模式：電腦/手機/平板瀏覽器直接用）
**概念**：同一份程式碼、同一個 Worker、同樣的模式與知識庫，差別只在「收音來源」與「顯示目標」。抽一層平台配接器：

```
interface PlatformAdapter {
  mic: { start(): void; stop(): void; onChunk(cb): void }   // 音訊來源
  hud: { render(text): void; clear(): void }                 // 顯示目標
  triggers: TriggerSource[]                                   // 可用觸發
}
```
- **EvenAdapter**（既有行為）：mic=SDK `audioControl` PCM、hud=`even.ts enqueue()`、triggers=眼鏡觸控/R1/MediaSession。
- **WebAdapter**（新增）：
  - mic：`getUserMedia` + `MediaRecorder`（`audio/webm;codecs=opus`，同樣 ~2.5s 切塊）。Worker `/transcribe` 需接受 WAV 與 webm 兩種（原樣轉發 Content-Type 給 Deepgram，Deepgram 自動辨識容器）。
  - hud：頁面上的大字提詞區（沿用手機 demo 的黑底綠字風格即可），逐字串流渲染**不需要**300ms 節流（DOM 便宜，那是 BLE 限制）。
  - triggers：按住收音大按鈕＋鍵盤空白鍵（桌面）。
- **模式偵測**：啟動時偵測 Even SDK bridge 是否存在→存在走 EvenAdapter，否則自動進 WebAdapter（同一個 build，零設定切換）。
- **部署**：`npm run build` 產出靜態檔，部署到 Cloudflare Pages（跟 Worker 同帳號，免費）。Evan 已有 Netlify 經驗，兩者皆可。
- settings 與 KB 存 localStorage，**跨裝置不同步**是 v1 已知限制；提供「匯出/匯入設定 JSON」按鈕讓 Evan 手動搬。
**驗收**：同一份 build 在瀏覽器開＝完整可用（收音→建議→逐字顯示）；在 Even App 內開＝眼鏡版行為不變；`npm test` 全綠。

### Phase 7 — 圖片問答與直答模式
**概念**：前面所有模式都是「聽對方→建議我怎麼回」；本階段新增「**直答**」——我拍照或直接問，AI 把答案顯示在眼鏡上。G2 無相機，影像一律來自手機。

1. **新模式 `solve`（直答）glyph `✦`**：語意翻轉——閘門收到的聲音視為「使用者本人的提問」，prompt 目標是**直接回答問題本身**，不是建議怎麼回話。回答格式：答案先行（第一行就是答案/結論），之後最多 2–3 行關鍵步驟或理由。（solve/guide/talk 的輸出格式獨立於「## 回答輸出契約」的單一答案結構，但沿用其「內容與事實政策」。）程式/數學題：先給最終答案，再給關鍵思路，不逐行列程式碼（眼鏡念不動）。
   - **三種提問輸入，共用同一個 /suggest（solve prompt）流程**：
     a. 眼鏡/手機收音（既有閘門收音，語者=本人）
     b. **手機打字**：solve 模式頁面加一個文字輸入框＋送出鍵（聊天式介面，頁面保留本次 session 的問答記錄）；送出後答案同時串流到手機頁面與眼鏡 HUD
     c. 拍照/選圖（見下）
   - **對話記憶**：solve 模式保留最近 6 輪問答作為 context 傳給 Worker，讓「那第二題呢」這類追問接得上；切換模式或手動清除時歸零。
2. **圖片輸入（手機側與網頁版共用）**：
   - UI：模式頁加「📷 拍照」與「🖼 選圖」按鈕，用**官方 API** `bridge.captureImageFromCamera()` 與 `bridge.pickImageFromAlbum()`（SDK ≥0.0.12，回傳 `AppImageAsset` 含 base64）。`app.json` 權限加 `camera`、`album`（實作時以 evenhub pack 實測權限名，比照 phone-microphone 的驗證方式）。原 `<input type="file">` 方案作廢。
   - 前處理：官方文件明示大圖 base64 很肥——維持 canvas 縮圖：長邊 ≤1568px、JPEG 品質 0.8、上限 ~1.5MB。畫面顯示縮圖確認後才送出。
   - Worker 新端點 `POST /vision`：接收 `{ image_base64, media_type, question?, mode, lang, length, kb... }`，組 Anthropic messages（image content block + 文字指示），沿用串流回傳。圖片預設指示：「先辨識圖中的題目/問題，再依 solve 模式格式作答」；若同時附了語音提問文字，以提問為主、圖為輔。
   - 顯示：眼鏡端沿用 300ms 節流串流；長答案沿用現有捲動/翻頁。
3. **成本備忘**：一張 1.15MP 圖約 ~1,600 tokens，比純文字貴；縮圖上限就是為此設的，不要放寬。
4. **風險註記（實機驗證項）**：官方相機/相簿 API 的實機行為（權限彈窗時機、大圖回傳耗時）待驗證；網頁版（WebAdapter）無 bridge，改用 `<input type="file">` 作為網頁版專屬路徑。
**驗收**：solve 模式語音直答運作；手機拍照→眼鏡顯示答案全流程可用（或已明確記錄 WKWebView 限制並完成網頁版 fallback）；縮圖與大小上限有測試。

### Phase 8 — 教學模式與演講模式
兩個模式都屬「主動發起」型（同 solve，語者=本人），但互動迴圈不同。**手勢語意是模式作用域的**：透過 `TriggerSource` 抽象讓每個模式定義自己的 tap 意義，不得影響其他模式的收音閘門。

1. **模式 `guide`（步驟教學）glyph `➤`**：我說/打「我要做 X」（裝軟體、煮一道菜、操作流程皆可），AI 生成分步教學，眼鏡上一次只顯示一步，我做完才前進。
   - Worker：prompt 要求輸出編號步驟清單，每步 ≤2 行（眼鏡可讀），開頭先給一行「總覽：共 N 步＋所需材料/前置」。一次生成完整清單回傳（非串流也可）。
   - Plugin：存步驟陣列，顯示格式「步驟 3/8：...」（進度列用認證字元 `━─` 或 `▶`）。**下滑＝下一步、上滑＝上一步**（官方 SCROLL_TOP/BOTTOM_EVENT，比單擊自然；G2 與 R1 事件帶不同 source 可分流），單擊保留給收音閘門；長按＝退出教學回待命（SDK 暴露 LONG_PRESS 前先用雙擊，見 KNOWN_QUIRKS）。
   - **每步內容必須單頁容得下**（≤400 字元含標頭）——Worker prompt 直接約束每步字數，超長步驟生成時就拆成兩步。
   - **過程中提問**：教學進行中按住大按鈕（或眼鏡長按後說話）＝閘門提問，context 自動附上「目前正在做：步驟 N 的內容」，答完顯示「↩ 回到步驟 N」。
2. **模式 `talk`（即興演講/申論）glyph `◉`**：我給一個議題，AI 立刻給第一段，我開始照念的同時它持續生成下文，永遠供稿在我前面。
   - 實作本質＝**一次長串流＋分頁緩衝**：Claude 生成速度遠快於朗讀速度，客戶端把串流內容切成頁緩衝，**下滑＝下一段、上滑＝回看**；緩衝進度用認證字元（如 `▇▇▇▁▁▁▁` 或「3/7」）。
   - **長度設定與眼鏡顯示脫節的修正**：全螢幕文字容器僅約 400–500 字元可見——中（≈800字）/長（≈1500字）回答**必須分頁**，分頁邊界設在 400–500 字元（在句界切），翻頁時以 `textContainerUpgrade` 整頁重建；**手機側顯示全文，眼鏡側一定分頁**。
   - 長度沿用全域設定：短≈300字／中≈800字／長≈1500字。念到緩衝末端再單擊＝自動帶前文脈絡發「繼續寫」請求，無縫接龍。
   - prompt 要求：口語化、句子短、適合朗讀；第一段必須 3 秒內可開始顯示（串流首段優先）。
   - 手機側同步顯示全文（可滑動預覽），供不戴眼鏡時當提詞機用（網頁版同樣受益）。
**驗收**：guide 模式步驟前進/後退/中途提問/返回流程完整；talk 模式首段顯示延遲 <3 秒、念完緩衝可無縫續寫；兩模式的手勢映射不影響其他模式；相關純函式（步驟解析、分段緩衝）有測試。

## 給 Claude Code 的守則（重要）

- **每次改動後必跑 `npm test`**，紅燈不進下一步。
- **小步提交**：一個功能一個 commit，訊息寫清楚改了什麼、為什麼。
- **不要大規模重構**、不要改檔案結構、不要換框架、不要升級依賴版本，除非任務明確要求。
- **不要動 `src/even.ts` 的 `enqueue()` 序列化機制**；所有眼鏡渲染必須經過它。
- **不要在 plugin 端使用 WebSocket**（WKWebView 會無聲失敗，見 KNOWN_QUIRKS）；一律 chunked HTTP。
- **API key 只存在 Worker secrets**（`wrangler secret put`），任何情況下不得出現在 plugin 程式碼、app.json、commit 歷史。
- 拿不準 SDK 行為時：先查官方文件與模板，不要憑記憶編 API。
- 需要實機才能驗證的事（BLE 穩定性、實際收音品質、媒體鍵事件），明確列出「請 Evan 實機測試」清單，不要假裝已驗證。
- 隱私功能是產品需求不是裝飾：**麥克風預設 OFF、首次使用同意畫面、收音中指示永遠可見**，不得移除。

## 疑難排解（先查這裡再上網）

| 症狀 | 原因與解法 |
|---|---|
| plugin fetch Worker 失敗 | `app.json` whitelist 沒列該 host、或列了佔位網址。列出完整 `https://xxx.workers.dev` |
| `audioControl(true)` 回傳成功但沒聲音 | 回傳值不可信；以「是否持續收到 audio PCM frames」為準（Cue 已有計數邏輯） |
| 眼鏡顯示後 BLE 斷線 | 渲染沒走 `enqueue()` 或頻率太高；檢查節流 ≥300ms |
| WebSocket 連不上 | 平台限制，放棄，用 HTTP |
| Deepgram 中文亂碼/空白 | 檢查 `language=zh-TW`、`encoding=linear16&sample_rate=16000`、WAV 包裝是否沿用原函式 |
| Anthropic 401/403 | Worker secret 沒設或打錯：`wrangler secret put ANTHROPIC_API_KEY` 重設 |
| wrangler 部署失敗 | `wrangler login` 過期重登；或 `wrangler.toml` name 撞名，改名重部 |
| 模擬器跑不起來 | Node 版本 ≥18；砍 node_modules 重裝 |

## 資源

- Even Hub 開發文件：hub.evenrealities.com/docs（含 Claude Code 專頁 /docs/AI-tooling/claude-code、Device APIs、Networking、Background & Lifecycle）
- 官方模板：`evenhub-templates`（asr 與 text-heavy 兩個模板是本專案的參考實作）
- 模擬器：`@evenrealities/evenhub-simulator`；CLI：`evenhub-cli`
- 上游專案 Cue：github.com/tntpsu/Cue（有問題先看它的 issues 與 commit 歷史）
- 社群元件庫：even-toolkit（GitHub 搜尋）
- Deepgram 文件：developers.deepgram.com（語言支援、streaming 參數）
- Anthropic API：docs.claude.com（Messages API、streaming）
- Cloudflare Workers：developers.cloudflare.com/workers（wrangler、secrets、KV）
- Even 官方開發者 Discord：實機行為問題最快的解答來源

## 成本備忘（供估算，不用寫進程式）

- Deepgram nova 系列語音轉文字約 $0.004–0.005/分鐘，新帳號有免費額度
- Claude Haiku 每次建議約 <NT$0.1；Sonnet 約其 3–5 倍
- Cloudflare Workers 免費方案每日 10 萬請求，個人使用綽綽有餘
- 日常中度使用估計每月 NT$100–400
