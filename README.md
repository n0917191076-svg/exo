# Exo — Evan 的 AI 外骨骼

Even Realities G2 智慧眼鏡上的即時對話輔助。對方說話 → 轉文字 → Claude 依「模式＋場景＋知識庫」生成建議 → 逐字顯示在鏡片上，照著講就行。

Fork 自 [Cue](https://github.com/tntpsu/Cue)；開發指南見 `CLAUDE.md`，踩坑筆記見 `KNOWN_QUIRKS.md`。

## 日常使用（Evan 版）

### 事前設定（手機，設定一次）
1. 在 Even Hub 開啟 Exo，接受錄音同意畫面。
2. **Worker**：貼上 Worker URL（`https://cue-worker.jiazuo.workers.dev`）與 Bearer token（Worker 的 SHARED_SECRET）。
3. **對話設定**：語言（中文／英文＝譯＋英文建議）、模型（Sonnet 聰明／Haiku 快）、回答長度（短≤10字／中≤20字／長≤40字）、目前場景（例：「面試——金融後台主管面」，會原樣進 prompt）。
4. **知識庫**：Obsidian 寫好 → 貼進「個人資訊」「補充資料」兩框（各上限 6000 字，超過保留尾端）。勾選各模式要掛哪個 KB（工作預設全掛、日常只掛個人、自訂不掛）。

### 現場操作（眼鏡手勢，閘門收音）
| 手勢 | 狀態 | 效果 |
|---|---|---|
| 單擊 | 待命 | 開始收音（對方開始說話時按） |
| 單擊 | 收音中 | 結束收音＋生成建議（對方說完時按） |
| 雙擊 | 收音中 | 取消本段（誤觸時用，丟棄不送） |
| 雙擊 | 回答顯示中 | **延伸**：接續深入一層（可連按逐層加深） |
| 單擊 | 回答顯示中 | 開始新一輪（清屏） |
| 雙擊 | 純待命（無回答） | 離開 App |

手機大按鈕：**按住收音、放開送出、滑出取消**（可盲按）。模式切換只在手機（工作▣／日常●／自訂◆）。建議串流逐字上屏——第一批字出現得比完整生成早。

### 進階開關（設定頁）
- **閘門模式**（預設開）：只收對方說話的片段，整段視為對方——省語者分離的成本與延遲。關閉→連續收音＋[A]/[B] 語者標籤與「Calibrate me」錨定。
- **自動收音**（預設關）：安靜場合用。持續聽，偵測到問句自動生成建議；靜默 8 秒後單擊＝要聊天話題（日常／自訂）；idle 過久自動暫停。
- **媒體鍵戒指**（實驗，預設關）：藍牙媒體鍵 play/pause＝收音開/關；重啟 App 生效，被宿主擋掉就改用 R1 戒指。

### 隱私
麥克風預設關；每段收音都要主動觸發；收音中眼鏡與手機都有指示；音訊經你自己的 Worker 轉文字後即丟棄，API 金鑰只存在 Worker secrets。錄音合法性依所在地法規自負。

## 開發

```bash
npm install
npm run dev          # Vite :5176
npm test             # vitest（182 tests）
npm run test:e2e     # 模擬器回歸（先起 dev ＋ npx evenhub-simulator --automation-port 9897 http://localhost:5176）
npm run test:webkit  # WebKit harness（需 SHARED_SECRET，打線上 Worker）
npm run pack         # lint + 打包 exo.ehpk
cd worker-template && npx wrangler deploy   # 部署 Worker
```

Worker 端點：`POST /transcribe?lang=zh|en&gated=1|0`、`POST /suggest`（預設串流純文字，`?stream=0` 回 JSON）、`GET /healthz`。secrets：`SHARED_SECRET`、`DEEPGRAM_API_KEY`、`ANTHROPIC_API_KEY`（各自 `npx wrangler secret put <名稱>`）。

實機 QR 熱載：`npx evenhub qr --url http://<LAN-IP>:5176`

## 原始碼地圖

| 檔案 | 職責 |
|---|---|
| `src/main.ts` | 狀態機、手機設定 UI、眼鏡渲染、觸發 dispatcher |
| `src/even.ts` | 眼鏡橋接（`enqueue()` 序列化渲染——高危勿動） |
| `src/transport.ts` | 音訊切塊 HTTP POST、/suggest 串流讀取 |
| `src/triggers.ts` | 手勢→語意對照表（`gestureMapFor`）、TriggerSource 介面 |
| `src/modes.ts` | 模式庫（work／daily／custom，繁中 prompt） |
| `src/utterance.ts` | 純函式：斷句、問句偵測、渲染節流、換行 |
| `src/storage.ts` | 設定持久化（bridge KV＋localStorage fallback） |
| `worker-template/` | Cloudflare Worker（Deepgram＋Anthropic 代理） |

進度：Phase 0–5 完成（環境／中文化／知識庫／串流／閘門觸發／打包）。待做：Phase 6 網頁版、Phase 7 圖片直答（solve）、Phase 8 教學（guide）與演講（talk）模式——規格見 `CLAUDE.md`。
