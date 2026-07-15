# Even G2 / Even Hub 開發參考

最後核對：2026-07-15

這份文件記錄 Exo 可直接採用的平台約束與參考來源。遇到衝突時，採用順序為：

1. Even Hub 官方文件
2. Even Realities 官方 npm 套件 README／版本資訊
3. Even Realities 公開 Figma 設計指南
4. 社群文件與工具庫
5. 本專案的實機觀察（寫入 `KNOWN_QUIRKS.md`）

社群資料只作交叉驗證與尋找實作模式；不可覆蓋官方規格或本專案已驗證的實機結論。

## 官方 Even Hub 文件

來源：<https://hub.evenrealities.com/docs/get-started/overview>

### 架構與網路

- Plugin 是跑在 Even Realities 手機 App WebView 的網頁；眼鏡只負責顯示與輸入，沒有 App 業務邏輯。
- iOS 使用 WKWebView，Android 使用 Chromium WebView。跨平台行為不能只用桌面 Chromium 推論。
- `app.json` 的 network whitelist 是宿主權限檢查，不會繞過瀏覽器 CORS。
- 正式環境的 `fetch()` 必須同時滿足：目標 origin 在 whitelist，且 Worker 回傳正確 CORS／OPTIONS headers。
- whitelist 使用完整 origin，例如 `https://example.workers.dev`；正式環境不使用 HTTP 或 wildcard。
- Exo 的 API key 仍只放 Cloudflare Worker secrets，Plugin 只保存 Worker URL 與 bearer token。

參考頁：

- <https://hub.evenrealities.com/docs/get-started/architecture>
- <https://hub.evenrealities.com/docs/build/networking>

### 眼鏡顯示

- 每眼畫布 `576 × 288`，4-bit 綠階（16 階）。
- 每頁最多 4 個 image containers、8 個其他 containers；全頁恰好一個 container 使用 `isEventCapture: 1`。
- SDK 0.0.12 的 `zOrderIndex` 是全有或全無：同頁只要一個 container 設定，全部 container 都要設定，而且值不可重複。
- `createStartUpPageContainer`／`rebuildPageContainer` 上限 1,000 字元；`textContainerUpgrade` 上限 2,000 字元。
- 全螢幕文字實際約容納 400–500 字元；長文必須分頁或使用受控尾端窗。
- 頻繁更新使用 `textContainerUpgrade`；Exo 仍須經 `even.ts` 的 `enqueue()` 序列化並維持至少 300ms BLE 節流。
- List 最多 20 項、每項最多 64 字元，且無原地更新；不適合串流回答。
- Image container 最大 `288 × 144`。影像建立後再呼叫 `updateImageRawData`，不可併發傳圖。
- 韌體只有單一 LVGL 字型，無字級／字型選擇；字型集外字元會直接消失。繁中覆蓋仍必須實機驗證。

參考頁：<https://hub.evenrealities.com/docs/build/display>

### 輸入、音訊與手機影像

- G2 與 R1 都提供單擊、雙擊、上滑、下滑；事件類型相同，但 source 可區分。
- 官方公開的事件值為 `CLICK_EVENT=0`、`SCROLL_TOP_EVENT=1`、`SCROLL_BOTTOM_EVENT=2`、`DOUBLE_CLICK_EVENT=3`。目前公開 SDK 仍未列出可用的 long-press enum。
- `audioControl(true, AudioInputSource.Glasses)` 使用眼鏡麥克風；`AudioInputSource.Phone` 使用手機麥克風。
- Glasses 音訊開始前必須已建立 startup page；Phone 音訊沒有這項前置。
- 兩種來源皆透過 `onEvenHubEvent` 的 `audioEvent` 傳入，格式是 PCM 16kHz、signed 16-bit little-endian、mono。
- SDK 提供 `pickImageFromAlbum()` 與 `captureImageFromCamera()`，回傳含 base64 的 `AppImageAsset`；Phase 7 可直接使用，不自行猜 bridge API。

參考頁：<https://hub.evenrealities.com/docs/build/device-apis>

### Manifest、權限與語言碼

- `supported_languages` 只接受 `en`, `de`, `fr`, `es`, `it`, `zh`, `ja`, `ko`。
- 因此 Exo 的 manifest 應維持 `"zh"`；`"zh-TW"` 是 Deepgram 轉錄參數，不是 Even manifest 合法值。
- 合法 permission 名稱包含 `network`, `location`, `g2-microphone`, `phone-microphone`, `album`, `camera`。
- 只宣告實際使用的權限；未使用的權限會在審查被標記。
- `min_sdk_version` 應對應實際使用的 SDK 功能版本，不預先提高。
- 提交新版本必須有非空 changelog；首次啟動不能黑屏，設定要持久化，privacy policy 必須涵蓋所有權限。

參考頁：

- <https://hub.evenrealities.com/docs/ship/packaging>
- <https://hub.evenrealities.com/docs/ship/app-submission>
- <https://hub.evenrealities.com/docs/reference/versioning>

### 模擬器與實機邊界

- Simulator 只適合 UI、輸入路由與邏輯測試，不能取代實機／Beta Testing。
- `--automation-port` 自 simulator 0.7.0 起提供 HTTP 控制面，可注入 Up／Down／Click／Double Click、抓畫面與讀 console。
- Simulator 不完整模擬權限、背景生命週期、真實字型、BLE 與 SDK 0.0.12 image LZ4 傳輸。
- Exo 的 BLE 穩定性、MediaSession、繁中字型、相機／相簿權限與實際音訊品質仍列為 Evan 實機驗證項目。

參考頁：<https://hub.evenrealities.com/docs/test/simulator>

## 官方 npm 套件

### `@evenrealities/even_hub_sdk`

來源：<https://www.npmjs.com/package/@evenrealities/even_hub_sdk>

- 2026-07-15 最新版與本專案安裝版皆為 `0.0.12`。
- Node 需求為 `^20.0.0 || >=22.0.0`；目前開發環境 Node `22.22.1` 符合。
- 0.0.11 加入 location、album、camera 與麥克風來源選擇；0.0.12 加入 `zOrderIndex` 與 image LZ4 傳輸。
- 官方 production 建議 exact pin；本專案目前使用 `^0.0.12`。若要改為 exact pin，獨立提交並跑完整回歸，不和功能開發混在一起。

### `@evenrealities/evenhub-simulator`

來源：<https://www.npmjs.com/package/@evenrealities/evenhub-simulator>

- 2026-07-15 最新版是 `0.8.0`；本專案安裝 `0.7.3`。
- 0.7.3 已具備 Exo regression 使用的 automation HTTP API，所以不因「有新版」直接升級。
- 如需升級 0.8.0，先查看 release 差異，再獨立執行 simulator e2e 與畫面比較。

### `@evenrealities/evenhub-cli`

來源：<https://www.npmjs.com/package/@evenrealities/evenhub-cli>

- 2026-07-15 最新版與本專案安裝版皆為 `0.1.13`。
- Exo 使用的 `qr`、`init`、`pack` 指令都是官方支援路徑；`pack` 仍需先完成 build 並讓 manifest entrypoint 存在於 `dist/`。

## 公開 Figma 設計指南

來源：<https://www.figma.com/design/X82y5uJvqMH95jgOfmV34j/Even-Realities---Software-Design-Guidelines--Public->

- 公開畫布已於 2026-07-15 開啟核對，可見 Colors、Typography、Iconography、Layout 與 Even OS template 等區塊。
- 眼鏡端的可執行規則以官方文件的 Design Guidelines 摘要為準：假按鈕用 `>`、進度使用 `━`／`─`、長文約 400–500 字元分頁。
- 官方認證 UI 字元：進度 `━ ─ █▇▆▅▄▃▂▁`；導航 `▲△▶▷▼▽◀◁`；選取 `●○ ■□ ★☆`；邊框 `╭╮╯╰ │─`；花色 `♠♣♥♦`。
- 24×24 store icon 是 1-bit monochrome、以 2×2 blocks 構成；細線、漸層、陰影與抗鋸齒不適用。

官方文字版：<https://hub.evenrealities.com/docs/build/design-guidelines>

## 社群參考

### `fabioglimb/even-toolkit`

來源：<https://github.com/fabioglimb/even-toolkit>

- MIT 授權的社群元件庫，包含眼鏡 screen router、display builders、文字量測／截斷、分頁、手勢與手機 Web UI 元件。
- `pretext` 的像素文字量測、`slidingWindowStart`、pagination 與 gesture debounce 模式可作 Phase 6–8 的設計參考。
- Exo 是既有 plain TypeScript/Vite 專案，不為了套用元件而引入 React/Tailwind，也不替換 `even.ts` bridge／`enqueue()`。
- 若引用程式碼，先核對對應版本、授權與測試，再用小型獨立提交吸收必要純函式。

### `nickustinov/even-g2-notes`

來源：<https://github.com/nickustinov/even-g2-notes/blob/main/G2.md>

- `G2.md` 已移至 `docs/` 分章；內容明確標示為非官方、由公開 SDK 逆向研究而來。
- 可用於查 glyph 表、錯誤碼、page lifecycle、UI patterns、simulator 差異與範例專案。
- 與官方文件衝突時一律採官方值；與 `KNOWN_QUIRKS.md` 的實機觀察衝突時保留實機結論並註明版本與日期。

## 對 Exo 的立即決策

1. 保持 `app.json.supported_languages = ["en", "zh"]`；Worker 中文轉錄繼續送 Deepgram `language=zh-TW`。
2. 保持 SDK `0.0.12`、CLI `0.1.13`、simulator `0.7.3`，不在功能提交中升級依賴。
3. 保持所有眼鏡串流更新經 `enqueue()` 與至少 300ms 節流。
4. 不引入 even-toolkit；只在 Phase 6–8 評估可獨立測試的純函式模式。
5. 修正仍描述 Cue WebSocket 的 Worker README 與 WebKit 測試，改成 Exo 現行 HTTP `/transcribe`、`/suggest` 串流契約。
6. 真實 Worker WebKit 測試需要 bearer secret 時，由 Evan 在本機環境／暫存檔設定；密鑰不貼進對話、不寫入 repo。
