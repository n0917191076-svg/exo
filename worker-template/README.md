# Exo personal Cloudflare Worker

Exo 的 Plugin 只透過 HTTPS 與這個 Worker 溝通。Worker 保管 Deepgram 與 LLM 金鑰；API key 不會進入 Plugin、`app.json` 或瀏覽器儲存空間。

## 前置需求

- Cloudflare 帳號
- Node.js 20 或 22
- Deepgram API key
- Anthropic API key（建議）或 OpenAI API key（非串流 fallback）

## 安裝與部署

```bash
cd worker-template
npm install
npx wrangler login

# 自訂一組至少 32 字元的 Bearer token；同一值填進 Exo 設定頁。
npx wrangler secret put SHARED_SECRET
npx wrangler secret put DEEPGRAM_API_KEY
npx wrangler secret put ANTHROPIC_API_KEY

npx wrangler deploy
```

如果只設定 OpenAI fallback，將第三個 secret 指令換成：

```bash
npx wrangler secret put OPENAI_API_KEY
```

`wrangler deploy` 會輸出 Worker URL，例如 `https://cue-worker.<account>.workers.dev`。把完整 HTTPS URL 與 `SHARED_SECRET` 分別填進 Exo 手機設定頁的 Worker URL 與 Bearer token。不要把 secret 寫入任何 repo 檔案。

## Exo 使用的正式 HTTP 流程

所有 POST 都使用 `Authorization: Bearer <SHARED_SECRET>`。

### POST `/transcribe?lang=zh|en&gated=1|0`

- Request headers：`Authorization: Bearer <SHARED_SECRET>`、`Content-Type: application/octet-stream`。
- Request body：16 kHz、mono、16-bit signed little-endian raw PCM。
- `lang=zh` 會使用 Deepgram `language=zh-TW`；`lang=en` 使用 `language=en`。
- `gated=1` 是預設閘門模式，不啟用語者分離；`gated=0` 才啟用 `diarize` 與 `utterances`。
- Response：`{ "ok": true, "text": "...", "utterances": [...] }`。

### POST `/suggest?stream=1`

- Request headers：`Authorization: Bearer <SHARED_SECRET>`、`Content-Type: application/json`。
- Request body 是 JSON，必要欄位為 `transcript`；目前也接受 `mode`、`customPrompt`、`recentSuggestions`、`sceneNote`、`model`、`length`、`lang`、`kbPersonal`、`kbExtra` 與 `extendContext`。
- Anthropic 路徑會回傳 `text/plain; charset=utf-8` 的 chunked 純文字流，Plugin 用 `response.body.getReader()` 增量讀取。
- 這是 Exo 的預設建議路徑。

### POST `/suggest?stream=0`

- Request headers：`Authorization: Bearer <SHARED_SECRET>`、`Content-Type: application/json`。
- 使用與串流路徑相同的 JSON request body。
- Response：`{ "ok": true, "suggestions": ["..."] }`。
- 供 fallback、診斷與 WebKit smoke test 使用。

### GET `/healthz`

- 不需驗證。
- Response：`{ "ok": true }`。

### Legacy `/ws`

Worker 暫時保留 `/ws?token=<SHARED_SECRET>` 作為舊版相容／診斷端點。Exo 的 Even App Plugin 不使用它；WKWebView 正式流程一律走上述 chunked HTTP 端點。

## 本機驗證

不需要真實 API key 的離線 Worker 測試：

```bash
cd ..
npm run test:worker
```

已部署 Worker 的 WebKit smoke test 需要 Bearer token。請用環境變數或權限為 `600` 的 `/tmp/exo-shared-secret.txt` 傳入，測完立即刪除；不要把 secret 貼進聊天、shell history 或 commit。

```bash
npm run test:webkit
```

## 隱私與限制

- Worker 不持久化逐字稿；每段音訊只為當次轉錄送往 Deepgram。
- Plugin 端不可改用 WebSocket；Even App 的 WKWebView 路徑使用 HTTP。
- `/transcribe` 目前只接受 raw PCM。Phase 6 WebAdapter 若改送 WebM，必須先擴充 Worker 並補測試。
- 真實收音、BLE 穩定性與眼鏡顯示仍須用 G2 實機驗證。
