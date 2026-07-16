// Cue — multi-mode conversation coach for Even G2 glasses.
//
// See ~/Documents/Pulse/ROADMAP.md § "Plan: Cue" for the full plan.

import { connectEvenRuntime, type EvenRuntime, type InputSource, type SwipeDir } from './even'
import { DEFAULT_MODE, MODES, type Mode, type ModeId, modeById } from './modes'
import { nextMockExchange, nextMockProactiveTopics, resetMock } from './mock'
import {
  DEFAULT_ANSWER_LENGTH,
  DEFAULT_IDLE_AUTO_PAUSE_MIN,
  DEFAULT_LANG,
  DEFAULT_MODEL,
  DEFAULT_WEARER_SPEAKER_ID,
  KB_MAX_CHARS,
  getAnswerLength,
  getCustomPrompt,
  getKbAttach,
  getKbExtra,
  getKbPersonal,
  getLang,
  coerceModelChoice,
  getModelChoice,
  getSceneNote,
  getIdleAutoPauseMin,
  getMode,
  getShowDebugOverlay,
  getWearerSpeakerId,
  getWorkerToken,
  getWorkerUrl,
  hasAgreedToPrivacy,
  setAnswerLength,
  setAudioSource,
  setAutoListen,
  setCustomPrompt,
  setGatedMode,
  setMediaKeyFlag,
  setIdleAutoPauseMin,
  setKbAttach,
  setKbExtra,
  setKbPersonal,
  setLang,
  setMode,
  setModelChoice,
  setSceneNote,
  setPrivacyAgreed,
  appendSessionRecord,
  clearSessionHistory,
  getAudioSource,
  getAutoListen,
  getCalibrating,
  getGatedMode,
  getMediaKeyFlag,
  loadSessionHistory,
  setCalibrating,
  setShowDebugOverlay,
  setStorageBridge,
  setWearerSpeakerId,
  setWorkerToken,
  setWorkerUrl,
  type AnswerLength,
  type AudioSource,
  type KbAttach,
  type LangMode,
  type ModelChoice,
} from './storage'
import { createTransport, setTransportLogger, type CueFetchLog, type CueTransport, type DialogTurn, type TranscriptEvent } from './transport'
import { downscaleFromBase64, downscaleImage, type DownscaledImage } from './imaging'
import { parseGuideSteps, type GuidePlan } from './utterance'
import { PROACTIVE_SILENT_MS, gestureMapFor, type TriggerEvent } from './triggers'
import { Vad } from './vad'
import {
  appendTurn,
  batteryHeaderSuffix,
  GLASSES_CONTENT_MAX_BYTES,
  createRenderThrottle,
  fitHeadByBytes,
  isQuestionZh,
  pruneTurns,
  shouldRequestSuggestion,
  speakerLabel,
  trimToSentences,
  wrapAnswerLines,
  type ConversationTurn,
} from './utterance'

// --- module state ---

let even: EvenRuntime | null = null
let currentMode: ModeId = DEFAULT_MODE
let micOn = false
let agreedToPrivacy = false
let lastTranscript = ''
let suggestions: string[] = []
let proactiveActive = false // true when user just ring-tapped for topics
let mockTimer: number | null = null
// Single tick while mic is on — handles the silence-based suggestion
// trigger, idle auto-pause, battery refresh, and stats-line repaint.
let micTickTimer: number | null = null

const MOCK_TICK_MS = 8_000

// Sliding transcript window we send to the LLM. Char budget is soft —
// trimToSentences may emit slightly less to keep sentence boundaries clean.
const TRANSCRIPT_WINDOW_CHARS = 1500
// How often the mic-tick fires while listening. 1s is fast enough to feel
// reactive on a sentence-final pause, slow enough not to hammer BLE.
const MIC_TICK_MS = 1_000
// Auto-pause after this much idle. Idle = no non-empty transcript chunk.
// 0 disables. Sourced from phone settings on bootstrap; falls back to default.
let idleAutoPauseMs = DEFAULT_IDLE_AUTO_PAUSE_MIN * 60_000

let transport: CueTransport | null = null
let isRealMode = false // true when transport.ready (Worker configured)
let liveTranscript = '' // accumulated final transcripts
let lastSuggestionAt = 0
let suggestionInFlight = false
// Tracking for shouldRequestSuggestion — set on each non-empty transcript chunk.
let lastChunkText = ''
let lastChunkAt = 0
// Tracking for idle auto-pause — set on every non-empty transcript chunk
// AND on mic-on (so the timer doesn't fire instantly on a quiet start).
let lastTranscriptAt = 0
// Cached so renderGlasses doesn't have to await. Refreshed on the mic tick.
let cachedBatteryLevel: number | undefined
// One-shot reason string shown on the idle screen after auto-pause.
// Cleared when the user manually re-engages the mic.
let autoPausedReason = ''

// v0.4.0 settings — hydrated from storage on bootstrap.
let showDebugOverlay = false  // diagnostic stats line on glasses
let wearerSpeakerId = DEFAULT_WEARER_SPEAKER_ID  // -1 = none / no filter
// v0.4.2: when true, the next non-empty utterance's speaker is anchored
// as wearer + the flag is cleared. Set by phone-side "Calibrate me".
let calibratingNow = false

// v0.4.3: session-record bookkeeping — captures mic-on → mic-off as
// one entry in the persisted session-history. Resets on each mic-on.
let sessionStartedAt = 0
let sessionSuggestionCount = 0

// Phase 1（Exo）設定 — bootstrap 時從 storage 補水
let sceneNote = ''
let modelChoice: ModelChoice = DEFAULT_MODEL
let answerLength: AnswerLength = DEFAULT_ANSWER_LENGTH
let langMode: LangMode = DEFAULT_LANG

// Phase 3（Exo）：眼鏡渲染節流器。串流增量最多每 300ms 觸發一次眼鏡
// 渲染（皆經 even.ts enqueue()）— 高頻 textContainerUpgrade 會弄壞
// BLE（KNOWN_QUIRKS）。手機 DOM 渲染不受此限。
const glassesThrottle = createRenderThrottle(300)

// Phase 4（Exo）：閘門模式（預設開）— 收音整段視為「對方」，Worker
// 拿掉 diarize/utterances。extendedText 是「延伸」逐層累積的螢幕全文。
let gatedMode = true
// 自動收音（預設關）：持續聽、問句偵測命中即觸發。依賴語者錨定 —
// /transcribe 走 diarize 路徑（effectiveGated 為 false）。
let autoListen = false
// 收音來源（audioControl 第二參數）：眼鏡（預設）或手機麥克風
let audioSource: AudioSource = 'glasses'
let extendedText = ''

// 自動收音開啟時強制 diarize 流程（語者錨定依賴 utterances）
function effectiveGated(): boolean {
  return gatedMode && !autoListen
}
let extendInFlight = false

// 螢幕上的完整回答（延伸優先；否則保留 Worker 原始內容）
function currentAnswerText(): string {
  if (extendedText) return extendedText
  return suggestions.join('\n')
}

// 「回答顯示中」狀態 — 手勢表的 hasAnswer 維度
function hasAnswerOnScreen(): boolean {
  return !micOn && (extendedText !== '' || suggestions.length > 0)
}

// Phase 2（Exo）知識庫 — 內容與每模式掛載表，bootstrap 補水
let kbPersonal = ''
let kbExtra = ''
let kbAttach: Record<ModeId, KbAttach> = {
  work: { personal: true, extra: true },
  daily: { personal: true, extra: false },
  custom: { personal: false, extra: false },
  solve: { personal: true, extra: true },
  guide: { personal: false, extra: true },
}

// v0.4.0 transcript display: per-speaker rolling buffer. Pure helpers
// in utterance.ts (appendTurn / pruneTurns / speakerLabel) — covered
// by unit tests there.
const conversation: ConversationTurn[] = []
const MAX_DISPLAYED_TURNS = 4

// Phone-side fetch debug log. Captures every /transcribe + /suggest
// call so we can see exactly what URL / status / error is happening
// when mic-on doesn't produce transcripts. In-memory, capped.
const FETCH_LOG_CAP = 50
const fetchLog: CueFetchLog[] = []
function pushFetchLog(entry: CueFetchLog): void {
  fetchLog.unshift(entry)
  if (fetchLog.length > FETCH_LOG_CAP) fetchLog.length = FETCH_LOG_CAP
  renderFetchLog()
}

function fmtAgo(ts: number): string {
  const sec = Math.round((Date.now() - ts) / 1000)
  if (sec < 60) return `${sec}s ago`
  if (sec < 3600) return `${Math.round(sec / 60)}m ago`
  return `${Math.round(sec / 3600)}h ago`
}

function renderFetchLog(): void {
  if (!fetchLogEl) return
  if (fetchLog.length === 0) {
    fetchLogEl.innerHTML = '<div style="color: #7b7b7b;">No fetches yet. Tap to start a mic session — chunks POST to /transcribe every ~2.5s.</div>'
    return
  }
  fetchLogEl.innerHTML = fetchLog
    .map(e => {
      const statusBadge = e.ok
        ? `<span style="color: #2a2;">${e.status ?? '?'}</span>`
        : `<span style="color: #c00;">${e.status ?? 'NET'}</span>`
      const ms = `${e.ms}ms`
      const bytes = e.bytes !== undefined ? ` ${(e.bytes / 1024).toFixed(1)}KB` : ''
      const err = e.error ? `<div style="color: #c00; margin-top: .15rem;">↳ ${escapeHtml(e.error)}</div>` : ''
      const url = e.url.length > 70 ? `${e.url.slice(0, 67)}…` : e.url
      return `<div style="padding: .35rem 0; border-bottom: 1px solid #f0f0f0;">
        <div style="display: flex; gap: .5rem; align-items: center;">
          <span style="color: #999; min-width: 6em;">${fmtAgo(e.ts)}</span>
          ${statusBadge}
          <span style="color: #555;">${e.method} ${ms}${bytes}</span>
        </div>
        <div style="color: #232323; word-break: break-all;">${escapeHtml(url)}</div>
        ${err}
      </div>`
    })
    .join('')
}

// --- DOM scaffold (phone-side) ---

const root = document.querySelector<HTMLDivElement>('#app')
if (!root) throw new Error('App root missing')

root.innerHTML = `
  <main style="font-family: system-ui; padding: 1rem; max-width: 720px; margin: 0 auto; color: #232323;">
    <h1 style="margin: 0 0 .25rem 0;">Exo <span style="font-size: .55em; color: #7b7b7b; font-weight: 400;">v${__APP_VERSION__}</span></h1>
    <p style="color: #7b7b7b; margin: 0 0 1rem 0;">Helps you say the right thing.</p>
    <p id="status" style="margin: 0 0 1rem 0;">Connecting…</p>

    <section>
      <button id="hold-to-talk" type="button" style="width: 100%; min-height: 42vh; font-size: 1.6em; font-weight: 700; border: 4px solid #232323; border-radius: 12px; background: #ffe95c; color: #232323; cursor: pointer; touch-action: none; user-select: none; -webkit-user-select: none;">
        按住收音<br /><span style="font-size: .6em; font-weight: 400;">放開送出・滑出取消</span>
      </button>
    </section>

    <section>
      <h2 style="font-size: 1.1em; margin: 1rem 0 .5rem 0;">即時建議</h2>
      <div id="live-suggestions" style="max-width: 520px; min-height: 3.5em; padding: .5rem; background: #101010; color: #7CFC00; font-family: ui-monospace, monospace; font-size: .9em; white-space: pre-wrap; border-radius: 4px;">（收音中這裡會逐字顯示建議）</div>
    </section>

    <section>
      <h2 style="font-size: 1.1em; margin: 1rem 0 .5rem 0;">打字直答（solve）</h2>
      <p style="color: #7b7b7b; font-size: .85em; margin: 0 0 .5rem 0;">直接打字問，AI 把答案顯示在上方與眼鏡（用 solve 直答格式，接得上對話記憶）。</p>
      <div style="display: flex; gap: .5rem; max-width: 520px;">
        <input id="solve-input" type="text" placeholder="輸入問題，Enter 送出…" style="flex: 1; padding: .45rem; border-radius: 4px; border: 1px solid #bbb;" />
        <button id="solve-send" type="button" style="padding: .45rem .9rem; cursor: pointer;">送出</button>
      </div>
    </section>

    <section>
      <h2 style="font-size: 1.1em; margin: 1rem 0 .5rem 0;">圖片問答（拍照／選圖）</h2>
      <p style="color: #7b7b7b; font-size: .85em; margin: 0 0 .5rem 0;">上傳一張照片即可——AI 會自己辨識圖中的題目/問題並直接作答（縮圖後上傳，長邊 ≤1568）。</p>
      <div style="display: flex; gap: .5rem; align-items: center; max-width: 520px; flex-wrap: wrap;">
        <button id="vision-camera" type="button" style="padding: .45rem .7rem; cursor: pointer;">📷 拍照</button>
        <button id="vision-album" type="button" style="padding: .45rem .7rem; cursor: pointer;">🖼 選圖</button>
        <input id="vision-file" type="file" accept="image/*" />
        <button id="vision-send" type="button" disabled style="padding: .45rem .9rem; cursor: pointer;">問這張圖</button>
      </div>
      <p style="color: #9b9b9b; font-size: .8em; margin: .3rem 0 0 0;">📷/🖼 用眼鏡 App 的原生相機/相簿；瀏覽器請用「選擇檔案」。</p>
      <img id="vision-preview" alt="預覽" style="display: none; margin-top: .5rem; max-width: 240px; max-height: 240px; border-radius: 4px; border: 1px solid #ccc;" />
    </section>

    <section>
      <h2 style="font-size: 1.1em; margin: 1rem 0 .5rem 0;">步驟教學（guide）</h2>
      <p style="color: #7b7b7b; font-size: .85em; margin: 0 0 .5rem 0;">說「我要做 X」，AI 生成分步教學，一次顯示一步（手機／眼鏡）。</p>
      <div style="display: flex; gap: .5rem; max-width: 520px;">
        <input id="guide-input" type="text" placeholder="我要做…（例：換機車電瓶），Enter 產生" style="flex: 1; padding: .45rem; border-radius: 4px; border: 1px solid #bbb;" />
        <button id="guide-gen" type="button" style="padding: .45rem .9rem; cursor: pointer;">產生</button>
      </div>
      <div style="display: flex; gap: .5rem; align-items: center; margin-top: .5rem;">
        <button id="guide-prev" type="button" disabled style="padding: .35rem .8rem; cursor: pointer;">◀ 上一步</button>
        <span id="guide-progress" style="color: #7b7b7b; font-size: .9em;">—</span>
        <button id="guide-next" type="button" disabled style="padding: .35rem .8rem; cursor: pointer;">下一步 ▶</button>
      </div>
    </section>

    <div id="privacy-modal" style="display: none; position: fixed; inset: 0; background: rgba(0,0,0,.6); align-items: center; justify-content: center; z-index: 100;">
      <div style="background: #fff; max-width: 520px; padding: 1.5rem; border-radius: 8px; box-shadow: 0 10px 40px rgba(0,0,0,.3);">
        <h2 style="margin: 0 0 .5rem 0;">Before you start</h2>
        <p>
          Cue records audio from the glasses microphone to suggest responses.
          Audio streams to a transcription service and is dropped — Cue never
          stores recordings.
        </p>
        <p style="font-weight: 600;">
          You are responsible for ensuring this is legal where you are.
          Recording someone without their knowledge is illegal in some
          jurisdictions (CA, FL, IL, MD, MA, MT, NH, PA, WA in the US, and
          many countries).
        </p>
        <p>
          The mic is OFF by default and requires explicit opt-in each
          session. The mic indicator stays visible whenever Cue is listening.
        </p>
        <div style="display: flex; gap: .5rem; justify-content: flex-end; margin-top: 1rem;">
          <button id="privacy-decline" type="button" style="padding: .5rem 1rem; cursor: pointer; background: #eee;">No thanks</button>
          <button id="privacy-accept" type="button" style="padding: .5rem 1rem; cursor: pointer; background: #232323; color: #fff;">I understand — continue</button>
        </div>
      </div>
    </div>

    <section>
      <h2 style="font-size: 1.1em; margin: 1rem 0 .5rem 0;">Mode</h2>
      <div id="mode-list" style="display: grid; gap: .5rem; max-width: 520px;"></div>
    </section>

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
            <optgroup label="Claude">
              <option value="claude-sonnet-4-6">Sonnet（預設，聰明）</option>
              <option value="claude-haiku-4-5">Haiku（快）</option>
            </optgroup>
            <optgroup label="ChatGPT（需 Worker 設 OPENAI_API_KEY）">
              <option value="gpt-4o">GPT-4o（聰明）</option>
              <option value="gpt-4o-mini">GPT-4o mini（快）</option>
            </optgroup>
          </select>
        </label>
        <label>回答長度
          <select id="answer-length" style="padding: .35rem; margin-left: .5rem;">
            <option value="short">短（40–70 字）</option>
            <option value="medium">中（80–110 字）</option>
            <option value="long">長（110–140 字）</option>
          </select>
        </label>
        <button id="save-convo" type="button" style="margin-top: .25rem; padding: .35rem .7rem; cursor: pointer; max-width: 200px;">儲存對話設定</button>
        <p id="convo-status" style="color: #2a2; font-size: .85em; min-height: 1.2em; margin: 0;"></p>
      </div>
    </section>

    <section>
      <h2 style="font-size: 1.1em; margin: 1.5rem 0 .5rem 0;">知識庫</h2>
      <p style="color: #7b7b7b; font-size: .9em; max-width: 520px; margin: 0 0 .5rem 0;">
        從 Obsidian 等筆記複製貼上即可。超過上限時保留尾端（新資訊貼在後面）。
      </p>
      <div style="display: grid; gap: .5rem; max-width: 520px;">
        <label>個人資訊 KB <span id="kb-personal-count" style="color: #7b7b7b; font-size: .85em;"></span>
          <textarea id="kb-personal" rows="6" style="width: 100%; padding: .5rem; box-sizing: border-box; font-size: .9em;" placeholder="背景、經歷、成就、正在準備的東西…"></textarea>
        </label>
        <label>補充資料 KB <span id="kb-extra-count" style="color: #7b7b7b; font-size: .85em;"></span>
          <textarea id="kb-extra" rows="6" style="width: 100%; padding: .5rem; box-sizing: border-box; font-size: .9em;" placeholder="這場面試的公司資料、簡報講稿、會議背景…"></textarea>
        </label>
        <div>各模式掛載哪些 KB：</div>
        <div id="kb-attach-grid" style="display: grid; grid-template-columns: 5em 1fr 1fr; gap: .25rem; align-items: center; font-size: .9em;">
          <div></div><div style="color: #7b7b7b;">個人資訊</div><div style="color: #7b7b7b;">補充資料</div>
          <div>工作</div>
          <label><input id="kb-attach-work-personal" type="checkbox" /></label>
          <label><input id="kb-attach-work-extra" type="checkbox" /></label>
          <div>日常</div>
          <label><input id="kb-attach-daily-personal" type="checkbox" /></label>
          <label><input id="kb-attach-daily-extra" type="checkbox" /></label>
          <div>自訂</div>
          <label><input id="kb-attach-custom-personal" type="checkbox" /></label>
          <label><input id="kb-attach-custom-extra" type="checkbox" /></label>
          <div>直答</div>
          <label><input id="kb-attach-solve-personal" type="checkbox" /></label>
          <label><input id="kb-attach-solve-extra" type="checkbox" /></label>
          <div>教學</div>
          <label><input id="kb-attach-guide-personal" type="checkbox" /></label>
          <label><input id="kb-attach-guide-extra" type="checkbox" /></label>
        </div>
        <button id="save-kb" type="button" style="margin-top: .25rem; padding: .35rem .7rem; cursor: pointer; max-width: 200px;">儲存知識庫</button>
        <p id="kb-status" style="color: #2a2; font-size: .85em; min-height: 1.2em; margin: 0;"></p>
      </div>
    </section>

    <section>
      <h2 style="font-size: 1.1em; margin: 1.5rem 0 .5rem 0;">Custom prompt (used when Mode = Custom)</h2>
      <textarea id="custom-prompt" rows="4" style="width: 100%; max-width: 520px; padding: .5rem; box-sizing: border-box; font-family: ui-monospace, monospace; font-size: .9em;" placeholder="描述角色、立場與語氣；Exo 會套用單一完整回答與事實規則。"></textarea>
      <button id="save-custom" type="button" style="margin-top: .35rem; padding: .35rem .7rem; cursor: pointer;">Save custom prompt</button>
    </section>

    <section>
      <h2 style="font-size: 1.1em; margin: 1.5rem 0 .5rem 0;">Worker (v0.2.0+)</h2>
      <p style="color: #7b7b7b; font-size: .9em; max-width: 520px;">
        v0.1.0 uses MOCK suggestions on a timer — no API keys needed.
        v0.2.0 onwards routes mic audio through your personal Cloudflare Worker
        for real STT + LLM. Set those credentials here in advance.
      </p>
      <div style="display: grid; gap: .25rem; max-width: 520px;">
        <label>Worker URL <input id="worker-url" type="url" placeholder="https://cue-worker.your-sub.workers.dev" style="padding: .35rem; width: 100%; box-sizing: border-box;" /></label>
        <label>Bearer token <input id="worker-token" type="password" placeholder="(SHARED_SECRET from Worker)" style="padding: .35rem; width: 100%; box-sizing: border-box; font-family: monospace;" /></label>
        <button id="save-worker" type="button" style="margin-top: .25rem; padding: .35rem .7rem; cursor: pointer; max-width: 200px;">Save Worker config</button>
        <p id="worker-status" style="color: #2a2; font-size: .85em; min-height: 1.2em;"></p>
      </div>
    </section>

    <section>
      <h2 style="font-size: 1.1em; margin: 1.5rem 0 .5rem 0;">Behavior</h2>
      <div style="display: grid; gap: .5rem; max-width: 520px;">
        <label>Auto-pause after idle (minutes; 0 disables) <input id="idle-auto-pause-min" type="number" min="0" step="1" style="padding: .35rem; width: 6em; box-sizing: border-box;" /></label>
        <button id="save-idle" type="button" style="padding: .35rem .7rem; cursor: pointer; max-width: 200px;">Save</button>
        <p id="idle-status" style="color: #2a2; font-size: .85em; min-height: 1.2em; margin: 0;"></p>

        <hr style="border: 0; border-top: 1px solid #eee; margin: .5rem 0;" />

        <label style="display: flex; align-items: center; gap: .5rem; cursor: pointer;">
          <input id="gated-mode" type="checkbox" checked />
          閘門模式（預設開）：只在對方說話時收音，整段視為對方——省語者分離的成本與延遲
        </label>
        <p style="color: #7b7b7b; font-size: .85em; margin: 0;">關閉後退回連續收音＋語者標籤（[A]/[B]）流程。</p>

        <label style="display: flex; align-items: center; gap: .5rem; cursor: pointer;">
          <input id="auto-listen" type="checkbox" />
          自動收音模式（安靜場合用）：持續聽，偵測到問句就自動生成建議
        </label>
        <p style="color: #7b7b7b; font-size: .85em; margin: 0;">開啟時走語者標籤流程（略過閘門），沿用 idle 自動暫停避免忘記關。</p>

        <label>收音來源
          <select id="audio-source" style="padding: .35rem; margin-left: .5rem;">
            <option value="glasses">眼鏡麥克風（預設）</option>
            <option value="phone">手機麥克風</option>
          </select>
        </label>
        <p style="color: #7b7b7b; font-size: .85em; margin: 0;">下次收音生效。手機麥克風適合眼鏡收音不穩或想省眼鏡電量時。</p>

        <label style="display: flex; align-items: center; gap: .5rem; cursor: pointer;">
          <input id="media-key" type="checkbox" />
          媒體鍵戒指（實驗性）：藍牙媒體鍵 play/pause＝收音開/關
        </label>
        <p style="color: #7b7b7b; font-size: .85em; margin: 0;">重新開啟 App 生效。實測可能被宿主 App 擋掉——失敗會記錄並建議改用 R1 戒指。</p>

        <hr style="border: 0; border-top: 1px solid #eee; margin: .5rem 0;" />

        <label style="display: flex; align-items: center; gap: .5rem; cursor: pointer;">
          <input id="show-debug-overlay" type="checkbox" />
          Show diagnostic overlay on glasses (audio frames / chunks / errors)
        </label>
        <p style="color: #7b7b7b; font-size: .85em; margin: 0;">Off by default. Turn on when something isn't working and you want to see what's happening on-glasses.</p>

        <hr style="border: 0; border-top: 1px solid #eee; margin: .5rem 0;" />

        <label>Which speaker is you?
          <select id="wearer-speaker-id" style="padding: .35rem; margin-left: .5rem;">
            <option value="-1">None / auto-detect (don't filter)</option>
            <option value="0">Speaker A is me</option>
            <option value="1">Speaker B is me</option>
            <option value="2">Speaker C is me</option>
            <option value="3">Speaker D is me</option>
          </select>
        </label>
        <p style="color: #7b7b7b; font-size: .85em; margin: 0;">When set, your own speech is shown but excluded from the suggestion prompt — Cue suggests responses TO the other person, not echoes of you. Watch the glasses for [A]/[B]/etc labels in a real conversation, then pick yours.</p>
        <p id="wearer-status" style="color: #2a2; font-size: .85em; min-height: 1.2em; margin: 0;"></p>

        <button id="calibrate-me" type="button" style="padding: .35rem .7rem; cursor: pointer; max-width: 220px; margin-top: .25rem;">Calibrate me (one-tap)</button>
        <p style="color: #7b7b7b; font-size: .85em; margin: 0;">Tap, put on glasses, say "this is me" — the next utterance Deepgram detects becomes your speaker ID. Replaces the dropdown above.</p>
        <p id="calibrate-status" style="color: #2a2; font-size: .85em; min-height: 1.2em; margin: 0;"></p>
      </div>
    </section>

    <section style="margin-top: 2rem;">
      <details>
        <summary style="cursor: pointer; color: #232323;">Past sessions (review your conversations)</summary>
        <p style="color: #7b7b7b; margin: .5rem 0; font-size: .85em; max-width: 520px;">
          Last 50 mic sessions. Stored locally on this device (Even Hub's
          per-app storage) — never sent to any server beyond what the live
          /transcribe + /suggest calls already do.
        </p>
        <div style="display: flex; gap: .5rem; margin-bottom: .5rem;">
          <button id="session-history-clear" type="button" style="padding: .35rem .7rem; cursor: pointer; background: #eee;">Clear all</button>
          <button id="session-history-refresh" type="button" style="padding: .35rem .7rem; cursor: pointer; background: #eee;">Refresh</button>
        </div>
        <div id="session-history" style="max-width: 720px; max-height: 360px; overflow-y: auto; font-size: .85em; border: 1px solid #ddd; padding: .5rem;"></div>
      </details>
    </section>

    <section style="margin-top: 2rem;">
      <details>
        <summary style="cursor: pointer; color: #232323;">Recent fetches (debug)</summary>
        <p style="color: #7b7b7b; margin: .5rem 0; font-size: .85em; max-width: 520px;">
          Last 50 calls to your Worker (/transcribe + /suggest) with status, latency,
          and any error message. Use this to figure out why mic-on isn't producing
          transcripts — 405 = wrong/old worker URL, 401 = bearer mismatch,
          500 with "DEEPGRAM_API_KEY" = worker secret missing.
        </p>
        <div style="display: flex; gap: .5rem; margin-bottom: .5rem;">
          <button id="fetch-log-clear" type="button" style="padding: .35rem .7rem; cursor: pointer; background: #eee;">Clear</button>
          <button id="fetch-log-refresh" type="button" style="padding: .35rem .7rem; cursor: pointer; background: #eee;">Refresh</button>
        </div>
        <div id="fetch-log" style="max-width: 720px; max-height: 320px; overflow-y: auto; font-family: ui-monospace, monospace; font-size: .8em; border: 1px solid #ddd; padding: .5rem;"></div>
      </details>
    </section>

    <section style="margin-top: 2rem; color: #7b7b7b; font-size: .85em;">
      <h3 style="font-size: 1em; margin: 0 0 .5rem 0;">How to use</h3>
      <ol style="padding-left: 1.25rem; line-height: 1.5;">
        <li>從上方清單挑一個模式。</li>
        <li>戴上眼鏡，從 Even Hub 啟動器開啟 Exo。</li>
        <li>單擊眼鏡開關收音（隱私緊急退出：眼鏡雙擊或摘下眼鏡）。</li>
        <li>未接 Worker 時用計時器假建議讓你試流程；設好個人 Worker 後即為真實語音轉文字＋LLM。</li>
      </ol>
    </section>
  </main>
`

const status = document.querySelector<HTMLParagraphElement>('#status')!
const modeList = document.querySelector<HTMLDivElement>('#mode-list')!
const customPromptInput = document.querySelector<HTMLTextAreaElement>('#custom-prompt')!
const saveCustomBtn = document.querySelector<HTMLButtonElement>('#save-custom')!
const workerUrlInput = document.querySelector<HTMLInputElement>('#worker-url')!
const workerTokenInput = document.querySelector<HTMLInputElement>('#worker-token')!
const saveWorkerBtn = document.querySelector<HTMLButtonElement>('#save-worker')!
const workerStatus = document.querySelector<HTMLParagraphElement>('#worker-status')!
const privacyModal = document.querySelector<HTMLDivElement>('#privacy-modal')!
const privacyAccept = document.querySelector<HTMLButtonElement>('#privacy-accept')!
const privacyDecline = document.querySelector<HTMLButtonElement>('#privacy-decline')!
const idleAutoPauseInput = document.querySelector<HTMLInputElement>('#idle-auto-pause-min')!
const saveIdleBtn = document.querySelector<HTMLButtonElement>('#save-idle')!
const idleStatus = document.querySelector<HTMLParagraphElement>('#idle-status')!
const showDebugOverlayInput = document.querySelector<HTMLInputElement>('#show-debug-overlay')!
const wearerSpeakerSelect = document.querySelector<HTMLSelectElement>('#wearer-speaker-id')!
const wearerStatus = document.querySelector<HTMLParagraphElement>('#wearer-status')!
const calibrateBtn = document.querySelector<HTMLButtonElement>('#calibrate-me')!
const calibrateStatus = document.querySelector<HTMLParagraphElement>('#calibrate-status')!
const liveSuggestionsEl = document.querySelector<HTMLDivElement>('#live-suggestions')!
const solveInput = document.querySelector<HTMLInputElement>('#solve-input')!
const solveSend = document.querySelector<HTMLButtonElement>('#solve-send')!
function submitSolveText(): void {
  const q = solveInput.value
  solveInput.value = ''
  void runSolveTextQuery(q)
}
solveSend.addEventListener('click', submitSolveText)
solveInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') { e.preventDefault(); submitSolveText() }
})

// Phase 7：圖片問答 — 選圖→縮圖→預覽→送出。
const visionFile = document.querySelector<HTMLInputElement>('#vision-file')!
const visionSend = document.querySelector<HTMLButtonElement>('#vision-send')!
const visionPreview = document.querySelector<HTMLImageElement>('#vision-preview')!
let pendingImage: DownscaledImage | null = null
visionFile.addEventListener('change', async () => {
  const f = visionFile.files?.[0]
  if (!f) { pendingImage = null; visionSend.disabled = true; visionPreview.style.display = 'none'; return }
  try {
    pendingImage = await downscaleImage(f)
    visionPreview.src = pendingImage.dataUrl
    visionPreview.style.display = 'block'
    visionSend.disabled = false
  } catch (err) {
    pendingImage = null
    visionSend.disabled = true
    liveSuggestionsEl.textContent = `（讀圖失敗：${err instanceof Error ? err.message : String(err)}）`
  }
})
visionSend.addEventListener('click', () => { void runVisionQuery() })

// Phase 7：原生相機/相簿（僅眼鏡 App 內有 bridge；瀏覽器用檔案上傳）。
async function nativePickImage(kind: 'camera' | 'album'): Promise<void> {
  if (!even) {
    liveSuggestionsEl.textContent = '（拍照/選圖需在眼鏡 App 內使用；瀏覽器請用「選擇檔案」）'
    return
  }
  try {
    const asset = kind === 'camera'
      ? await even.captureImageFromCamera()
      : await even.pickImageFromAlbum()
    if (!asset || !asset.base64) return // 使用者取消或無資料
    pendingImage = await downscaleFromBase64(asset.base64, asset.mimeType)
    visionPreview.src = pendingImage.dataUrl
    visionPreview.style.display = 'block'
    visionSend.disabled = false
  } catch (err) {
    liveSuggestionsEl.textContent = `（取圖失敗：${err instanceof Error ? err.message : String(err)}）`
  }
}
document.querySelector<HTMLButtonElement>('#vision-camera')!.addEventListener('click', () => { void nativePickImage('camera') })
document.querySelector<HTMLButtonElement>('#vision-album')!.addEventListener('click', () => { void nativePickImage('album') })

// Phase 4：手機大按鈕（phone-button TriggerSource）— 按住收音、放開送出、
// 滑出取消。可盲按：狀態靠底色與文字反映。
const holdToTalkBtn = document.querySelector<HTMLButtonElement>('#hold-to-talk')!
let holdActive = false
function setHoldVisual(on: boolean): void {
  holdToTalkBtn.style.background = on ? '#e33' : '#ffe95c'
  holdToTalkBtn.style.color = on ? '#fff' : '#232323'
  holdToTalkBtn.innerHTML = on
    ? '● 收音中<br /><span style="font-size: .6em; font-weight: 400;">放開送出・滑出取消</span>'
    : '按住收音<br /><span style="font-size: .6em; font-weight: 400;">放開送出・滑出取消</span>'
}
holdToTalkBtn.addEventListener('pointerdown', () => {
  if (holdActive || micOn) return
  holdActive = true
  setHoldVisual(true)
  void dispatchTrigger('gate-start')
})
holdToTalkBtn.addEventListener('pointerup', () => {
  if (!holdActive) return
  holdActive = false
  setHoldVisual(false)
  void dispatchTrigger('gate-stop')
})
holdToTalkBtn.addEventListener('pointerleave', () => {
  if (!holdActive) return
  holdActive = false
  setHoldVisual(false)
  void dispatchTrigger('cancel')
})
const sceneNoteInput = document.querySelector<HTMLInputElement>('#scene-note')!
const langSelect = document.querySelector<HTMLSelectElement>('#lang-mode')!
const modelSelect = document.querySelector<HTMLSelectElement>('#model-choice')!
const answerLengthSelect = document.querySelector<HTMLSelectElement>('#answer-length')!
const saveConvoBtn = document.querySelector<HTMLButtonElement>('#save-convo')!
const convoStatus = document.querySelector<HTMLParagraphElement>('#convo-status')!

saveConvoBtn.addEventListener('click', async () => {
  sceneNote = sceneNoteInput.value
  langMode = langSelect.value === 'en' ? 'en' : 'zh'
  modelChoice = coerceModelChoice(modelSelect.value)
  answerLength = answerLengthSelect.value === 'short' || answerLengthSelect.value === 'long'
    ? answerLengthSelect.value
    : 'medium'
  await setSceneNote(sceneNote)
  await setLang(langMode)
  await setModelChoice(modelChoice)
  await setAnswerLength(answerLength)
  // lang 影響 /transcribe 的 ?lang= — 重建 transport 讓下一次收音生效
  const wUrl = await getWorkerUrl()
  const wTok = await getWorkerToken()
  transport = createTransport(wUrl, wTok, { lang: langMode, gated: effectiveGated() })
  isRealMode = transport.ready
  convoStatus.textContent = '已儲存。下次收音生效。'
  window.setTimeout(() => { convoStatus.textContent = '' }, 4000)
})

// ── Phase 2：知識庫 UI ─────────────────────────────────────────
const kbPersonalInput = document.querySelector<HTMLTextAreaElement>('#kb-personal')!
const kbExtraInput = document.querySelector<HTMLTextAreaElement>('#kb-extra')!
const kbPersonalCount = document.querySelector<HTMLSpanElement>('#kb-personal-count')!
const kbExtraCount = document.querySelector<HTMLSpanElement>('#kb-extra-count')!
const saveKbBtn = document.querySelector<HTMLButtonElement>('#save-kb')!
const kbStatus = document.querySelector<HTMLParagraphElement>('#kb-status')!

function kbCheckbox(mode: ModeId, which: 'personal' | 'extra'): HTMLInputElement {
  return document.querySelector<HTMLInputElement>(`#kb-attach-${mode}-${which}`)!
}

function renderKbCounts(): void {
  kbPersonalCount.textContent = `${kbPersonalInput.value.length}/${KB_MAX_CHARS}`
  kbExtraCount.textContent = `${kbExtraInput.value.length}/${KB_MAX_CHARS}`
}
kbPersonalInput.addEventListener('input', renderKbCounts)
kbExtraInput.addEventListener('input', renderKbCounts)

function renderKbAttach(): void {
  for (const mode of ['work', 'daily', 'custom', 'solve', 'guide'] as ModeId[]) {
    kbCheckbox(mode, 'personal').checked = kbAttach[mode].personal
    kbCheckbox(mode, 'extra').checked = kbAttach[mode].extra
  }
}

saveKbBtn.addEventListener('click', async () => {
  // setKbPersonal/Extra 會截尾端 6000 — 存完讀回，讓 UI 反映截斷後的實況
  await setKbPersonal(kbPersonalInput.value)
  await setKbExtra(kbExtraInput.value)
  kbPersonal = await getKbPersonal()
  kbExtra = await getKbExtra()
  kbPersonalInput.value = kbPersonal
  kbExtraInput.value = kbExtra
  renderKbCounts()
  for (const mode of ['work', 'daily', 'custom', 'solve', 'guide'] as ModeId[]) {
    kbAttach[mode] = {
      personal: kbCheckbox(mode, 'personal').checked,
      extra: kbCheckbox(mode, 'extra').checked,
    }
  }
  await setKbAttach(kbAttach)
  kbStatus.textContent = '已儲存。'
  window.setTimeout(() => { kbStatus.textContent = '' }, 4000)
})

calibrateBtn.addEventListener('click', async () => {
  await setCalibrating(true)
  calibratingNow = true
  calibrateStatus.style.color = '#2a2'
  calibrateStatus.textContent = 'Listening for your voice — say "this is me" within ~10s.'
  window.setTimeout(() => { calibrateStatus.textContent = '' }, 12_000)
})

const gatedModeInput = document.querySelector<HTMLInputElement>('#gated-mode')!
const autoListenInput = document.querySelector<HTMLInputElement>('#auto-listen')!
const audioSourceSelect = document.querySelector<HTMLSelectElement>('#audio-source')!
audioSourceSelect.addEventListener('change', async () => {
  audioSource = audioSourceSelect.value === 'phone' ? 'phone' : 'glasses'
  await setAudioSource(audioSource)
})
const mediaKeyInput = document.querySelector<HTMLInputElement>('#media-key')!
mediaKeyInput.addEventListener('change', async () => {
  await setMediaKeyFlag(mediaKeyInput.checked)
})
autoListenInput.addEventListener('change', async () => {
  autoListen = autoListenInput.checked
  await setAutoListen(autoListen)
  const wUrl = await getWorkerUrl()
  const wTok = await getWorkerToken()
  transport = createTransport(wUrl, wTok, { lang: langMode, gated: effectiveGated() })
  isRealMode = transport.ready
  void paint()
})
gatedModeInput.addEventListener('change', async () => {
  gatedMode = gatedModeInput.checked
  await setGatedMode(gatedMode)
  // gated 影響 /transcribe query — 重建 transport 讓下一次收音生效
  const wUrl = await getWorkerUrl()
  const wTok = await getWorkerToken()
  transport = createTransport(wUrl, wTok, { lang: langMode, gated: effectiveGated() })
  isRealMode = transport.ready
  void paint()
})

showDebugOverlayInput.addEventListener('change', async () => {
  showDebugOverlay = showDebugOverlayInput.checked
  await setShowDebugOverlay(showDebugOverlay)
  void paint()
})

wearerSpeakerSelect.addEventListener('change', async () => {
  const id = Number.parseInt(wearerSpeakerSelect.value, 10)
  wearerSpeakerId = Number.isFinite(id) ? id : DEFAULT_WEARER_SPEAKER_ID
  await setWearerSpeakerId(wearerSpeakerId)
  wearerStatus.style.color = '#2a2'
  wearerStatus.textContent = wearerSpeakerId < 0
    ? 'Auto-detect: no filter applied; suggestions consider all speech.'
    : `Speaker ${speakerLabel(wearerSpeakerId)} = you. Your lines won't be sent to the suggestion model.`
  window.setTimeout(() => { wearerStatus.textContent = '' }, 5000)
  void paint()
})

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
}

function renderModeList(): void {
  modeList.innerHTML = MODES.map(
    m => `
    <label style="display: flex; gap: .75rem; align-items: flex-start; padding: .6rem .75rem; background: ${m.id === currentMode ? '#fef991' : '#eee'}; border-radius: 4px; cursor: pointer;">
      <input type="radio" name="mode" value="${m.id}" ${m.id === currentMode ? 'checked' : ''} style="margin-top: .2rem;" />
      <div style="flex: 1;">
        <div><span style="margin-right: .5rem;">${m.glyph}</span><strong>${escapeHtml(m.label)}</strong></div>
        <div style="color: #555; font-size: .85em; margin-top: .15rem;">${escapeHtml(m.description)}</div>
      </div>
    </label>
  `,
  ).join('')
  modeList.querySelectorAll<HTMLInputElement>('input[name="mode"]').forEach(input => {
    input.addEventListener('change', async () => {
      currentMode = input.value as ModeId
      await setMode(currentMode)
      resetDialogHistory() // 換模式＝新對話脈絡，清空對話記憶
      renderModeList()
      await paint()
    })
  })
}

// --- glasses display ---

function trunc(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s
}

// Width budget per line on the 576-px greyscale display, derived from the
// existing trunc-to-38 the v0.2 build used.
const LINE_WIDTH = 38

function renderGlasses(): string {
  const mode: Mode = modeById(currentMode)
  const micGlyph = micOn ? '●' : '○'
  const battery = batteryHeaderSuffix(cachedBatteryLevel)
  // Header is fixed-width-ish: mode label left, mic state center, battery right.
  const header = `${mode.glyph} ${mode.label.toUpperCase()}  ${micGlyph} ${micOn ? 'LIVE' : 'mic off'}${battery ? `  ${battery}` : ''}`
  if (!agreedToPrivacy) {
    return [
      header,
      '',
      'Cue needs your consent before',
      'turning on the mic. Open Cue',
      'on your phone first to review',
      'and accept the privacy notice.',
    ].join('\n')
  }
  if (!micOn) {
    // Phase 4：回答顯示中 — 停止收音後答案留在屏上，雙擊可延伸。
    // 官方 textContainerUpgrade 上限 512 bytes/次（超過無聲截斷），延伸
    // 逐層累積必爆 — 眼鏡端用尾端滾動窗只留最新內容；手機端仍顯示全文。
    if (hasAnswerOnScreen()) {
      const fixedTop: string[] = [header, '']
      if (autoPausedReason) {
        fixedTop.push(autoPausedReason)
        fixedTop.push('')
      }
      const fixedBottom = ['', '[tap] 新一輪  [2x] 延伸']
      const fixedBytes = new TextEncoder().encode(
        [...fixedTop, ...fixedBottom].join('\n'),
      ).length + 1 // +1：answer 區與上下區之間的換行
      const budget = GLASSES_CONTENT_MAX_BYTES - fixedBytes
      // 提詞機：定錨開頭、由朗讀節奏推進，串流時自動 hold 第一頁（不跟生成往尾端捲）
      const answerLines = fitHeadByBytes(
        wrapAnswerLines(currentAnswerText(), LINE_WIDTH),
        budget,
      )
      return [...fixedTop, ...answerLines, ...fixedBottom].join('\n')
    }
    const idleLines: string[] = [
      header,
      '',
      `Mode: ${mode.label}`,
      mode.description.length > 64 ? trunc(mode.description, 64) : mode.description,
      '',
    ]
    if (autoPausedReason) {
      idleLines.push(autoPausedReason)
      idleLines.push('')
    }
    idleLines.push(`${isRealMode ? '◉ live' : '◌ mock'} ready`)
    idleLines.push('> 單擊 收音')
    idleLines.push('> 雙擊 離開')
    return idleLines.join('\n')
  }
  // Live view.
  const lines: string[] = [header, '']
  // v0.4.0: render up to MAX_DISPLAYED_TURNS of the rolling conversation
  // with [A]/[B] speaker labels. Wearer's turns marked "(you)" so the
  // user knows we're filtering them from the suggestion context.
  pruneTurns(conversation, Date.now())
  const recent = conversation.slice(-MAX_DISPLAYED_TURNS)
  if (recent.length > 0) {
    for (const turn of recent) {
      // Phase 4 閘門模式：整段都是對方，不做 [A]/[B] 與 (you) 標記
      const label = effectiveGated() ? '對方' : speakerLabel(turn.speaker)
      const youMarker = !effectiveGated() && turn.speaker === wearerSpeakerId ? ' (you)' : ''
      lines.push(trunc(`[${label}${youMarker}] ${turn.text}`, 76))
    }
  } else if (lastTranscript) {
    // Mock mode + early frames before any conversation turn lands.
    lines.push(trunc(lastTranscript, 100))
  } else {
    lines.push(proactiveActive ? 'Fresh topics:' : 'Listening…')
  }
  // Diagnostic stats — gated on showDebugOverlay. Default OFF; toggle
  // on via phone-side "Show diagnostic overlay on glasses." Same info
  // as before: audio frames flowing, chunk success rate, last error.
  if (showDebugOverlay && isRealMode && transport) {
    const s = transport.stats()
    lines.push(`audio frames=${s.framesReceived} chunks=${s.chunksFlushed}/${s.chunksOk}ok`)
    if (s.lastError) {
      lines.push(`err: ${s.lastError}`)
    }
  }
  const footer = mode.proactiveSupported
    ? '> 單擊 送出   > 雙擊 取消   > 戒指雙擊 話題'
    : '> 單擊 送出   > 雙擊 取消'
  lines.push('')
  lines.push('─'.repeat(20)) // 認證字元（em-dash 不在集內）
  if (suggestions.length > 0) {
    const reserved = new TextEncoder().encode([...lines, '', footer].join('\n')).length + 1
    const budget = Math.max(0, GLASSES_CONTENT_MAX_BYTES - reserved)
    lines.push(...fitHeadByBytes(
      wrapAnswerLines(currentAnswerText(), LINE_WIDTH),
      budget,
    ))
  } else {
    lines.push('(answer appears here)')
  }
  lines.push('')
  lines.push(footer)
  return lines.join('\n')
}

async function paint(): Promise<void> {
  if (!even) return
  const tag = !agreedToPrivacy ? 'gate' : !micOn ? 'idle' : proactiveActive ? 'proactive' : 'live'
  // eslint-disable-next-line no-console
  console.log(`[cue:state] mode=${currentMode} mic=${micOn ? 'on' : 'off'} stage=${tag} suggestions=${suggestions.length}`)
  await even.render(renderGlasses())
}

// --- mock-mode driver ---

function startMockTimer(): void {
  stopMockTimer()
  // Fire one immediately so the user sees something on tap-to-start.
  void runMockTick()
  mockTimer = window.setInterval(() => void runMockTick(), MOCK_TICK_MS)
}

function stopMockTimer(): void {
  if (mockTimer !== null) {
    window.clearInterval(mockTimer)
    mockTimer = null
  }
}

async function runMockTick(): Promise<void> {
  if (!micOn) return
  if (proactiveActive) return // ring-tap-driven topics override the reactive cycle until cleared
  const next = nextMockExchange(currentMode)
  lastTranscript = next.transcript
  suggestions = next.suggestions
  liveSuggestionsEl.textContent = suggestions.join('\n')
  await paint()
}

async function showProactiveTopics(): Promise<void> {
  if (!micOn) return
  const mode = modeById(currentMode)
  if (!mode.proactiveSupported) return
  proactiveActive = true
  lastTranscript = '' // hide transcript area while showing fresh topics
  suggestions = nextMockProactiveTopics(currentMode)
  await paint()
  // Auto-clear after 12s and resume reactive cycle.
  window.setTimeout(() => {
    proactiveActive = false
    void paint()
  }, 12_000)
}

// --- input handlers ---

async function toggleMic(): Promise<void> {
  if (!agreedToPrivacy) return
  micOn = !micOn
  proactiveActive = false
  if (micOn) {
    // Phase 4：只在開始新一輪時清屏 — 停止後答案要留著（回答顯示中）
    suggestions = []
    extendedText = ''
    lastTranscript = ''
    liveTranscript = ''
    conversation.length = 0
    // User re-engaged after auto-pause — clear the stale notice.
    autoPausedReason = ''
    lastTranscriptAt = Date.now()
    lastChunkAt = Date.now()
    lastChunkText = ''
    // v0.4.3: start a new session record; reset counters
    sessionStartedAt = Date.now()
    sessionSuggestionCount = 0
    // Reset the LLM transcript window so the new session starts fresh
    liveTranscript = ''
    if (isRealMode && transport && even) {
      await startRealSession()
    } else {
      resetMock()
      startMockTimer()
    }
    startMicTick()
  } else {
    stopMockTimer()
    stopMicTick()
    if (transport) await transport.endMicSession()
    if (even) await even.stopMic()
    // v0.4.3: persist the session record (only if we accumulated something —
    // skip empty sessions where the user toggled mic on/off in <1s).
    if (sessionStartedAt > 0 && liveTranscript.trim().length > 0) {
      void appendSessionRecord({
        startedAt: sessionStartedAt,
        endedAt: Date.now(),
        mode: currentMode,
        transcript: liveTranscript,
        suggestionCount: sessionSuggestionCount,
      }).then(() => renderSessionHistory())
    }
    // Phase 4 閘門語意：gate-stop ＝ 送出。endMicSession 的尾端 flush 已
    // 把最後一段 transcript 收進 liveTranscript — 強制觸發，不等 debounce。
    if (isRealMode && effectiveGated() && liveTranscript.trim().length > 0) {
      await maybeRequestSuggestions(true)
    }
  }
  await paint()
}

// Phase 4：媒體鍵戒指（MediaSession 駭法，實驗性 feature flag 預設關）。
// 播一段無聲循環 <audio> 讓本 WebView 成為系統「正在播放」對象，把
// 戒指的 play/pause 鍵映射為收音開/關。已知風險（宿主攔截 audio
// session、與 audioControl(true) 衝突）待實機驗證 — 失敗即記
// KNOWN_QUIRKS 並關閉此路線改用 R1。
function silentWavDataUri(): string {
  // 0.1s 8kHz mono 8-bit 無聲 WAV，程式組出來省得塞一大串 base64 字面值
  const dataSize = 800
  const bytes = new Uint8Array(44 + dataSize)
  const dv = new DataView(bytes.buffer)
  const ascii = (off: number, str: string) => { for (let i = 0; i < str.length; i++) bytes[off + i] = str.charCodeAt(i) }
  ascii(0, 'RIFF'); dv.setUint32(4, 36 + dataSize, true); ascii(8, 'WAVE'); ascii(12, 'fmt ')
  dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true)
  dv.setUint32(24, 8000, true); dv.setUint32(28, 8000, true); dv.setUint16(32, 1, true); dv.setUint16(34, 8, true)
  ascii(36, 'data'); dv.setUint32(40, dataSize, true)
  bytes.fill(128, 44) // 8-bit PCM 的靜音是 128
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return `data:audio/wav;base64,${btoa(bin)}`
}

function setupMediaKeyTrigger(): void {
  if (!('mediaSession' in navigator)) return
  const audio = document.createElement('audio')
  audio.id = 'media-key-audio'
  audio.loop = true
  audio.src = silentWavDataUri()
  document.body.appendChild(audio)
  try {
    const pr = audio.play()
    // 部分環境（jsdom / 舊 WebView）play() 不回 Promise
    if (pr && typeof pr.catch === 'function') pr.catch(() => { /* 自動播放被擋 — 使用者互動後再試 */ })
  } catch { /* 同上 */ }
  navigator.mediaSession.setActionHandler('play', () => { void dispatchTrigger('gate-start') })
  navigator.mediaSession.setActionHandler('pause', () => { void dispatchTrigger('gate-stop') })
}

// Phase 4：取消本段收音 — 丟棄 pending 音訊與本段 transcript，不觸發
// /suggest、不記 session record。收音中雙擊（glasses）觸發。
async function cancelGate(): Promise<void> {
  if (!micOn) return
  micOn = false
  stopMockTimer()
  stopMicTick()
  if (transport) await transport.endMicSession({ discard: true })
  if (even) await even.stopMic()
  conversation.length = 0
  liveTranscript = ''
  lastTranscript = ''
  suggestions = []
  extendedText = ''
  // eslint-disable-next-line no-console
  console.log('[cue:gate] cancelled — 本段已丟棄')
  await paint()
}

// Phase 4：延伸 — 回答顯示中雙擊。帶前輪問答 context 發「接續深入」，
// 串流接在原回答後（加「── 延伸 ──」分隔），可連續雙擊逐層加深。
async function runExtend(): Promise<void> {
  if (!transport || !isRealMode) return // mock 模式無 LLM — 忽略（不退出即可）
  if (extendInFlight || suggestionInFlight) return
  extendInFlight = true
  const base = currentAnswerText()
  const prefix = `${base}\n── 延伸 ──\n`
  let lastAcc = ''
  try {
    const customPrompt = currentMode === 'custom' ? await getCustomPrompt() : undefined
    const result = await transport.requestSuggestionsStream({
      mode: currentMode,
      transcript: liveTranscript,
      customPrompt,
      recentSuggestions: recentSuggestionsRing.slice(),
      history: dialogHistory.slice(),
      sceneNote,
      model: modelChoice,
      length: answerLength,
      lang: langMode,
      kbPersonal: kbAttach[currentMode].personal && kbPersonal ? kbPersonal : undefined,
      kbExtra: kbAttach[currentMode].extra && kbExtra ? kbExtra : undefined,
      extendContext: base,
    }, {
      onDelta(accumulated) {
        lastAcc = accumulated
        extendedText = prefix + accumulated
        liveSuggestionsEl.textContent = extendedText
        glassesThrottle.push(() => { void paint() })
      },
    })
    if (result.ok) {
      glassesThrottle.flush()
      // 串流時保留原始全文（延伸內容不一定是編號清單）；JSON fallback 用解析結果
      const finalPart = result.streamed && lastAcc
        ? lastAcc
        : result.suggestions.join('\n')
      extendedText = prefix + finalPart
      liveSuggestionsEl.textContent = extendedText
    } else {
      extendedText = base // 失敗 — 回復原回答
    }
    await paint()
  } finally {
    extendInFlight = false
  }
}

function startMicTick(): void {
  stopMicTick()
  micTickTimer = window.setInterval(() => void micTick(), MIC_TICK_MS)
}

function stopMicTick(): void {
  if (micTickTimer !== null) {
    window.clearInterval(micTickTimer)
    micTickTimer = null
  }
}

async function micTick(): Promise<void> {
  if (!micOn) return
  const now = Date.now()
  // Idle auto-pause: no non-empty transcript for idleAutoPauseMs.
  // 0 disables — user can opt out via phone settings.
  if (idleAutoPauseMs > 0 && now - lastTranscriptAt > idleAutoPauseMs) {
    autoPausedReason = `Auto-paused after ${Math.round(idleAutoPauseMs / 60_000)} min idle`
    await toggleMic() // turns mic off + repaints
    return
  }
  // Refresh battery cache (cheap — usually returns the pushed value).
  if (even) {
    try { cachedBatteryLevel = await even.getBatteryLevel() } catch { /* ignore */ }
  }
  // Silence-driven suggestion trigger — sentence-final fires on transcript
  // arrival; this catches the case where the user simply stops talking.
  if (isRealMode) void maybeRequestSuggestions()
  await paint()
}

// --- real (Worker-backed) session ---

async function startRealSession(): Promise<void> {
  if (!transport || !even) return
  liveTranscript = ''
  lastSuggestionAt = 0
  // Transport now uses chunked HTTP POST instead of WebSocket (the WebView
  // blocks outbound WS handshakes — see transport.ts header comment).
  // startMicSession throws on worker-unreachable / probe-failed; per-chunk
  // network blips during the session come back via the onError callback.
  try {
    await transport.startMicSession(onTranscriptFrame, msg => {
      // Per-chunk transport error mid-session. Log but don't kill the
      // session; the next chunk still has a chance.
      // eslint-disable-next-line no-console
      console.warn('[cue] transcribe error:', msg)
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    lastTranscript = `(real-mode unavailable: ${msg.slice(0, 80)})`
    // eslint-disable-next-line no-console
    console.error('[cue] real-mode startMicSession failed:', msg)
    isRealMode = false
    resetMock()
    startMockTimer()
    await paint()
    return
  }
  // Ask the SDK to start the mic. PCM frames flow into transport via
  // sendAudioFrame; transport buffers and POSTs every CHUNK_MS.
  // VAD 只在自動收音模式啟用 — 音訊層偵測「說完了」提早送轉寫；
  // 閘門模式的開/關就是人手，完全不經 VAD（邊界有測試鎖定）。
  const sessionVad = autoListen ? new Vad() : null
  sessionVad?.start()
  const ok = await even.startMic(frame => {
    transport?.sendAudioFrame(frame)
    if (sessionVad) {
      const reason = sessionVad.push(frame)
      if (reason) {
        if (reason === 'voice-end') transport?.flushNow()
        sessionVad.start() // 連續偵測：每輪收束後重啟
      }
    }
  }, audioSource)
  if (!ok) {
    lastTranscript = '(mic permission denied)'
    isRealMode = false
    await transport.endMicSession()
    resetMock()
    startMockTimer()
    await paint()
    return
  }
  lastTranscript = '(listening — say something)'
  await paint()
}

function onTranscriptFrame(e: TranscriptEvent): void {
  // v0.4.0: prefer per-speaker utterances when available so we can show
  // [A]/[B] labels and exclude the wearer's own words from the suggestion
  // prompt. Falls back to whole-chunk text when the worker / Deepgram
  // didn't return utterances (older worker or single-speaker chunk).
  const turns = e.utterances && e.utterances.length > 0
    ? e.utterances.map(u => ({ speaker: u.speaker, text: u.text }))
    : (e.text.trim().length > 0 ? [{ speaker: 0, text: e.text.trim() }] : [])

  // Accumulate into the conversation (same-speaker turns merge so words
  // stream in until the speaker actually changes).
  for (const t of turns) {
    appendTurn(conversation, t.speaker, t.text, Date.now())
  }

  // v0.4.2 calibrate-me: if the user just tapped "Calibrate me" on the
  // phone, anchor the FIRST non-empty speaker we see as wearer + clear
  // the one-shot flag. Persists to storage so it survives reload.
  if (calibratingNow && turns.length > 0) {
    const firstSpeaker = turns[0].speaker
    wearerSpeakerId = firstSpeaker
    calibratingNow = false
    void setWearerSpeakerId(firstSpeaker)
    void setCalibrating(false)
    // Reflect in the UI immediately
    if (wearerSpeakerSelect) wearerSpeakerSelect.value = String(firstSpeaker)
    if (calibrateStatus) {
      calibrateStatus.style.color = '#2a2'
      calibrateStatus.textContent = `Got it — Speaker ${speakerLabel(firstSpeaker)} is you.`
      window.setTimeout(() => { calibrateStatus.textContent = '' }, 5_000)
    }
  }

  // Build the rolling LLM-context buffer EXCLUDING the wearer's lines
  // (so suggestions are responses TO the other person, not echoes of
  // what the wearer just said).
  if (e.isFinal) {
    const otherLines = turns
      // Phase 4 閘門模式：整段保證是對方 — 跳過 wearer 過濾
      .filter(t => effectiveGated() || wearerSpeakerId < 0 || t.speaker !== wearerSpeakerId)
      .map(t => t.text)
      .join(' ')
    if (otherLines.trim().length > 0) {
      liveTranscript = trimToSentences(`${liveTranscript} ${otherLines}`, TRANSCRIPT_WINDOW_CHARS)
      lastChunkText = otherLines
      lastChunkAt = Date.now()
    }
    // Idle auto-pause is "any speech," not "other-only" — we don't want
    // a wearer-only chunk to be considered idle.
    if (e.text.trim().length > 0) lastTranscriptAt = Date.now()
    // Phase 4 自動收音：對方的話命中問句偵測 → 立即觸發（繞過 debounce）
    if (autoListen && otherLines.trim().length > 0 && isQuestionZh(otherLines)) {
      void maybeRequestSuggestions(true)
    } else {
      void maybeRequestSuggestions()
    }
  }
  // Keep lastTranscript for the (now-deprecated) single-line fallback,
  // but renderGlasses now reads from `conversation` directly.
  lastTranscript = e.text
  void paint()
}

async function maybeRequestSuggestions(force = false): Promise<void> {
  if (!transport || !isRealMode) return
  // 併發保護對 forced 也生效 — gate-stop 的強制觸發不與 debounce 觸發重疊
  if (suggestionInFlight) return
  const fire = force || shouldRequestSuggestion(
    {
      lastChunkText,
      lastChunkAt,
      lastSuggestionAt,
      inFlight: suggestionInFlight,
      transcriptLen: liveTranscript.length,
    },
    Date.now(),
  )
  if (!fire) return
  suggestionInFlight = true
  lastSuggestionAt = Date.now()
  sessionSuggestionCount += 1
  try {
    const customPrompt = currentMode === 'custom' ? await getCustomPrompt() : undefined
    // 對話記憶：閒置太久＝新對話，先清空；送出當下的逐字稿另存，成功後成一輪
    maybeResetHistoryOnIdle(Date.now())
    const sentTranscript = liveTranscript
    // Phase 3：串流版 — 手機側每個增量即時渲染（DOM 便宜），眼鏡側經
    // 300ms 節流；舊 Worker 回 JSON 時自動 fallback（不會有 onDelta）。
    const result = await transport.requestSuggestionsStream({
      mode: currentMode,
      transcript: liveTranscript,
      customPrompt,
      // v0.4.2: send recent suggestions so worker can dedupe — no LLM
      // re-emitting the same advice 3 times in a row.
      recentSuggestions: recentSuggestionsRing.slice(),
      // 對話記憶（全模式）：最近幾輪問答，讓追問接得上
      history: dialogHistory.slice(),
      // Phase 1：場景 / 模型 / 長度 / 語言
      sceneNote,
      model: modelChoice,
      length: answerLength,
      lang: langMode,
      // Phase 2：依當前模式的掛載勾選帶 KB（沒勾＝不帶，省 tokens）
      kbPersonal: kbAttach[currentMode].personal && kbPersonal ? kbPersonal : undefined,
      kbExtra: kbAttach[currentMode].extra && kbExtra ? kbExtra : undefined,
    }, {
      onDelta(accumulated) {
        // 串流中：整段累積文字持續當作單一完整回答顯示
        suggestions = [accumulated]
        liveSuggestionsEl.textContent = accumulated
        glassesThrottle.push(() => { void paint() })
      },
    })
    if (result.ok) {
      // 未決的串流渲染立即出清，再畫最終完整回答
      glassesThrottle.flush()
      liveSuggestionsEl.textContent = result.suggestions.join('\n')
      suggestions = result.suggestions
      // Track the new suggestions for next-call dedupe.
      for (const s of result.suggestions) {
        recentSuggestionsRing.push(s)
      }
      while (recentSuggestionsRing.length > RECENT_SUGGESTIONS_CAP) {
        recentSuggestionsRing.shift()
      }
      // 對話記憶：把「這句話 → 給的回答」收成一輪，供下次追問接續
      pushDialogTurn(sentTranscript, result.suggestions.join('\n'))
    } else {
      suggestions = [`(LLM error: ${result.error.slice(0, 40)})`]
    }
    await paint()
  } finally {
    suggestionInFlight = false
  }
}

// Rolling buffer of recent LLM suggestions, sent with each /suggest call
// so the worker can instruct the LLM "don't repeat these." Capped to a
// reasonable history; older suggestions roll off naturally.
const RECENT_SUGGESTIONS_CAP = 12
const recentSuggestionsRing: string[] = []

// 對話記憶（全模式）：最近幾輪 {them,me}，讓對方追問接得上。跨閘門收音保留，
// 切模式或閒置過久（視為新對話）才清空；in-memory，App 重啟即歸零。
const DIALOG_HISTORY_CAP = 6
const DIALOG_IDLE_RESET_MS = 3 * 60_000
let dialogHistory: DialogTurn[] = []
let lastExchangeAt = 0

function resetDialogHistory(): void {
  dialogHistory = []
  lastExchangeAt = 0
}
function maybeResetHistoryOnIdle(now: number): void {
  if (lastExchangeAt > 0 && now - lastExchangeAt > DIALOG_IDLE_RESET_MS) resetDialogHistory()
}
function pushDialogTurn(them: string, me: string): void {
  const t = them.trim()
  const m = me.trim()
  if (!t && !m) return
  dialogHistory.push({ them: t, me: m })
  while (dialogHistory.length > DIALOG_HISTORY_CAP) dialogHistory.shift()
  lastExchangeAt = Date.now()
}

// Phase 7：打字直答 — 不用收音，直接打字問。一律用 solve 直答格式（獨立於
// 眼鏡收音選的模式），串流到手機 #live-suggestions 與眼鏡答案視圖，並接對話記憶。
async function runSolveTextQuery(question: string): Promise<void> {
  const q = question.trim()
  if (!q) return
  if (!transport || !isRealMode) {
    liveSuggestionsEl.textContent = '（打字直答需先在下方設定 Worker URL 與 token）'
    return
  }
  if (suggestionInFlight || extendInFlight) return
  suggestionInFlight = true
  try {
    maybeResetHistoryOnIdle(Date.now())
    extendedText = '' // 清掉延伸殘留，讓這題成為新答案
    liveSuggestionsEl.textContent = '…'
    const result = await transport.requestSuggestionsStream({
      mode: 'solve',
      transcript: q,
      recentSuggestions: recentSuggestionsRing.slice(),
      history: dialogHistory.slice(),
      sceneNote,
      model: modelChoice,
      length: answerLength,
      lang: langMode,
      kbPersonal: kbAttach.solve.personal && kbPersonal ? kbPersonal : undefined,
      kbExtra: kbAttach.solve.extra && kbExtra ? kbExtra : undefined,
    }, {
      onDelta(accumulated) {
        suggestions = [accumulated]
        liveSuggestionsEl.textContent = accumulated
        glassesThrottle.push(() => { void paint() })
      },
    })
    if (result.ok) {
      glassesThrottle.flush()
      liveSuggestionsEl.textContent = result.suggestions.join('\n')
      suggestions = result.suggestions
      pushDialogTurn(q, result.suggestions.join('\n'))
    } else {
      liveSuggestionsEl.textContent = `(LLM error: ${result.error.slice(0, 60)})`
      suggestions = []
    }
    await paint()
  } finally {
    suggestionInFlight = false
  }
}

// Phase 7：圖片問答 — 送 pendingImage 到 /vision，模型自己辨識圖中問題並作答，
// 串流到手機與眼鏡，接對話記憶。
async function runVisionQuery(): Promise<void> {
  if (!pendingImage) return
  if (!transport || !isRealMode) {
    liveSuggestionsEl.textContent = '（圖片問答需先在下方設定 Worker URL 與 token）'
    return
  }
  if (suggestionInFlight || extendInFlight) return
  suggestionInFlight = true
  try {
    maybeResetHistoryOnIdle(Date.now())
    extendedText = ''
    liveSuggestionsEl.textContent = '（辨識圖片中…）'
    const result = await transport.requestVisionStream({
      imageBase64: pendingImage.base64,
      mediaType: pendingImage.mediaType,
      mode: 'solve',
      lang: langMode,
      length: answerLength,
      history: dialogHistory.slice(),
      kbPersonal: kbAttach.solve.personal && kbPersonal ? kbPersonal : undefined,
      kbExtra: kbAttach.solve.extra && kbExtra ? kbExtra : undefined,
    }, {
      onDelta(accumulated) {
        suggestions = [accumulated]
        liveSuggestionsEl.textContent = accumulated
        glassesThrottle.push(() => { void paint() })
      },
    })
    if (result.ok) {
      glassesThrottle.flush()
      liveSuggestionsEl.textContent = result.answer
      suggestions = [result.answer]
      pushDialogTurn('（圖片提問）', result.answer)
    } else {
      liveSuggestionsEl.textContent = `(圖片問答失敗：${result.error.slice(0, 60)})`
      suggestions = []
    }
    await paint()
  } finally {
    suggestionInFlight = false
  }
}

// Phase 8：步驟教學 — 生成「總覽＋步驟」清單，一次顯示一步（手機＋眼鏡）。
let guidePlan: GuidePlan | null = null
let guideIdx = 0

function renderGuideStep(): void {
  const prevBtn = document.querySelector<HTMLButtonElement>('#guide-prev')!
  const nextBtn = document.querySelector<HTMLButtonElement>('#guide-next')!
  const prog = document.querySelector<HTMLSpanElement>('#guide-progress')!
  if (!guidePlan || guidePlan.steps.length === 0) {
    prevBtn.disabled = true
    nextBtn.disabled = true
    prog.textContent = '—'
    return
  }
  const n = guidePlan.steps.length
  guideIdx = Math.max(0, Math.min(n - 1, guideIdx))
  const stepText = `步驟 ${guideIdx + 1}/${n}：${guidePlan.steps[guideIdx]}`
  const shown = guideIdx === 0 && guidePlan.overview
    ? `總覽：${guidePlan.overview}\n${stepText}`
    : stepText
  suggestions = [shown]
  extendedText = ''
  liveSuggestionsEl.textContent = shown
  prog.textContent = `${guideIdx + 1} / ${n}`
  prevBtn.disabled = guideIdx === 0
  nextBtn.disabled = guideIdx === n - 1
  void paint()
}

async function runGuide(topic: string): Promise<void> {
  const t = topic.trim()
  if (!t) return
  if (!transport || !isRealMode) {
    liveSuggestionsEl.textContent = '（步驟教學需先在下方設定 Worker URL 與 token）'
    return
  }
  if (suggestionInFlight || extendInFlight) return
  suggestionInFlight = true
  try {
    liveSuggestionsEl.textContent = '（生成教學中…）'
    const result = await transport.requestSuggestions({
      mode: 'guide',
      transcript: t,
      model: modelChoice,
      length: answerLength,
      lang: langMode,
      kbPersonal: kbAttach.guide.personal && kbPersonal ? kbPersonal : undefined,
      kbExtra: kbAttach.guide.extra && kbExtra ? kbExtra : undefined,
    })
    if (result.ok) {
      guidePlan = parseGuideSteps(result.suggestions.join('\n'))
      guideIdx = 0
      if (guidePlan.steps.length === 0) {
        liveSuggestionsEl.textContent = result.suggestions.join('\n') // 解析不出步驟就原樣顯示
      } else {
        renderGuideStep()
      }
    } else {
      liveSuggestionsEl.textContent = `(教學生成失敗：${result.error.slice(0, 60)})`
    }
  } finally {
    suggestionInFlight = false
  }
}

const guideInput = document.querySelector<HTMLInputElement>('#guide-input')!
document.querySelector<HTMLButtonElement>('#guide-gen')!.addEventListener('click', () => { void runGuide(guideInput.value) })
guideInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') { e.preventDefault(); void runGuide(guideInput.value) }
})
document.querySelector<HTMLButtonElement>('#guide-prev')!.addEventListener('click', () => { guideIdx -= 1; renderGuideStep() })
document.querySelector<HTMLButtonElement>('#guide-next')!.addEventListener('click', () => { guideIdx += 1; renderGuideStep() })

// Phase 4：手勢 → 語意事件走 gestureMapFor 純函式（模式作用域的單一
// 事實來源），main.ts 只剩一個 dispatcher。模式切換只在手機 radio。
function handleGesture(gesture: 'tap' | 'double-tap', src: InputSource): void {
  if (!agreedToPrivacy) {
    if (gesture === 'double-tap' && even) void even.exitApp()
    return
  }
  const ev = gestureMapFor({
    mode: currentMode,
    micOn,
    hasAnswer: hasAnswerOnScreen(),
    source: src === 'ring' ? 'ring' : 'glasses',
    gesture,
    silentIdle: autoListen && micOn && Date.now() - lastTranscriptAt >= PROACTIVE_SILENT_MS,
  })
  if (ev === 'exit') {
    if (even) void even.exitApp()
    return
  }
  if (ev) void dispatchTrigger(ev)
}

async function dispatchTrigger(ev: TriggerEvent): Promise<void> {
  switch (ev) {
    case 'gate-start':
      if (!micOn) await toggleMic()
      break
    case 'gate-stop':
      if (micOn) await toggleMic()
      break
    case 'cancel':
      await cancelGate()
      break
    case 'extend':
      await runExtend()
      break
    case 'proactive':
      await showProactiveTopics()
      break
  }
}

function onTap(src: InputSource): void {
  handleGesture('tap', src)
}

function onDoubleTap(source: InputSource): void {
  handleGesture('double-tap', source)
}

function onSwipe(_dir: SwipeDir): void {
  // Reserved for v0.2+ — could let the user scroll back through the
  // transcript buffer or page through more suggestions.
}

// --- privacy modal handlers ---

privacyAccept.addEventListener('click', async () => {
  agreedToPrivacy = true
  await setPrivacyAgreed()
  privacyModal.style.display = 'none'
  await paint()
})
privacyDecline.addEventListener('click', () => {
  privacyModal.style.display = 'none'
  status.textContent = 'Privacy notice declined. You can re-open Cue anytime to accept.'
})

// --- form handlers ---

saveCustomBtn.addEventListener('click', async () => {
  await setCustomPrompt(customPromptInput.value)
  saveCustomBtn.textContent = 'Saved ✓'
  window.setTimeout(() => { saveCustomBtn.textContent = 'Save custom prompt' }, 2000)
})

// Wire fetch log accessors + handlers (must come BEFORE bootstrap so
// renderFetchLog has a target element when the first chunk fires).
const fetchLogEl = document.querySelector<HTMLDivElement>('#fetch-log')!
const fetchLogClearBtn = document.querySelector<HTMLButtonElement>('#fetch-log-clear')!
const fetchLogRefreshBtn = document.querySelector<HTMLButtonElement>('#fetch-log-refresh')!
fetchLogClearBtn.addEventListener('click', () => { fetchLog.length = 0; renderFetchLog() })
fetchLogRefreshBtn.addEventListener('click', () => renderFetchLog())
setTransportLogger(pushFetchLog)
renderFetchLog()

// v0.4.3 — Session history panel (past mic sessions)
const sessionHistoryEl = document.querySelector<HTMLDivElement>('#session-history')!
const sessionHistoryClearBtn = document.querySelector<HTMLButtonElement>('#session-history-clear')!
const sessionHistoryRefreshBtn = document.querySelector<HTMLButtonElement>('#session-history-refresh')!
sessionHistoryClearBtn.addEventListener('click', async () => {
  if (!confirm('Delete all past session records? This cannot be undone.')) return
  await clearSessionHistory()
  await renderSessionHistory()
})
sessionHistoryRefreshBtn.addEventListener('click', () => { void renderSessionHistory() })

function fmtSessionDuration(start: number, end: number): string {
  const s = Math.round((end - start) / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  const rs = s % 60
  return rs === 0 ? `${m}m` : `${m}m ${rs}s`
}

function fmtSessionDate(ts: number): string {
  const d = new Date(ts)
  const today = new Date()
  const sameDay = d.toDateString() === today.toDateString()
  if (sameDay) return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

async function renderSessionHistory(): Promise<void> {
  if (!sessionHistoryEl) return
  const records = await loadSessionHistory()
  if (records.length === 0) {
    sessionHistoryEl.innerHTML = '<div style="color: #7b7b7b; padding: .5rem;">No past sessions yet. Sessions are saved when you toggle mic off after capturing some transcript.</div>'
    return
  }
  sessionHistoryEl.innerHTML = records
    .map(r => {
      const preview = r.transcript.length > 200 ? `${r.transcript.slice(0, 200)}…` : r.transcript
      return `<div style="padding: .5rem; border-bottom: 1px solid #f0f0f0;">
        <div style="display: flex; gap: .5rem; align-items: center; color: #555;">
          <strong>${escapeHtml(r.mode)}</strong>
          <span>${fmtSessionDate(r.startedAt)}</span>
          <span>· ${fmtSessionDuration(r.startedAt, r.endedAt)}</span>
          <span>· ${r.suggestionCount} suggestion${r.suggestionCount === 1 ? '' : 's'}</span>
        </div>
        <div style="margin-top: .25rem; color: #232323; line-height: 1.4;">${escapeHtml(preview)}</div>
      </div>`
    })
    .join('')
}

// Initial render + re-render after each mic session ends.
void renderSessionHistory()

saveIdleBtn.addEventListener('click', async () => {
  const raw = Number.parseInt(idleAutoPauseInput.value, 10)
  const min = Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_IDLE_AUTO_PAUSE_MIN
  await setIdleAutoPauseMin(min)
  idleAutoPauseMs = min * 60_000
  idleAutoPauseInput.value = String(min)
  idleStatus.style.color = '#2a2'
  idleStatus.textContent = min === 0
    ? 'Saved. Auto-pause disabled.'
    : `Saved. Mic will auto-pause after ${min} min idle.`
  window.setTimeout(() => { idleStatus.textContent = '' }, 4000)
})

saveWorkerBtn.addEventListener('click', async () => {
  await setWorkerUrl(workerUrlInput.value)
  await setWorkerToken(workerTokenInput.value)
  // Re-initialize transport so the next mic session uses the new config.
  transport = createTransport(workerUrlInput.value.trim(), workerTokenInput.value.trim(), { lang: langMode, gated: effectiveGated() })
  isRealMode = transport.ready
  workerStatus.style.color = '#2a2'
  workerStatus.textContent = isRealMode
    ? 'Saved. Real STT + LLM active on next mic session.'
    : 'Saved (URL + token incomplete — mock mode will run).'
  window.setTimeout(() => { workerStatus.textContent = '' }, 4000)
  // Force an immediate glasses repaint so the ◉ live / ◌ mock indicator
  // reflects the new state without waiting for the next user gesture.
  void paint()
})

// --- bootstrap ---

async function bootstrap(): Promise<void> {
  // eslint-disable-next-line no-console
  console.log('[cue] bootstrap start')
  status.textContent = 'Connecting to glasses…'
  even = await connectEvenRuntime(`Cue v${__APP_VERSION__}\n\nLoading…`)

  if (even) {
    setStorageBridge({ getStorage: even.getStorage, setStorage: even.setStorage })
  }

  // Hydrate state.
  agreedToPrivacy = await hasAgreedToPrivacy()
  // In dev mode (Vite dev server), auto-accept the privacy gate so the
  // simulator regression test and developer workflow aren't blocked by
  // the phone-side modal. Production .ehpk installs run with
  // import.meta.env.DEV === false and require explicit user opt-in.
  if (!agreedToPrivacy && import.meta.env.DEV) {
    agreedToPrivacy = true
    await setPrivacyAgreed()
    // eslint-disable-next-line no-console
    console.log('[cue:state] dev-mode auto-accepted privacy (production requires real opt-in)')
  }
  // 舊版本存的模式 id（date/sting/…）已不存在 — 驗證後才採用，
  // 否則 modeById 會在首次渲染就拋錯。
  const persistedMode = await getMode()
  if (persistedMode && MODES.some(m => m.id === persistedMode)) currentMode = persistedMode
  customPromptInput.value = await getCustomPrompt()
  const wUrl = await getWorkerUrl()
  const wTok = await getWorkerToken()
  workerUrlInput.value = wUrl
  workerTokenInput.value = wTok
  const idleMin = await getIdleAutoPauseMin()
  idleAutoPauseInput.value = String(idleMin)
  idleAutoPauseMs = idleMin * 60_000
  // Hydrate v0.4.0 toggles.
  showDebugOverlay = await getShowDebugOverlay()
  showDebugOverlayInput.checked = showDebugOverlay
  wearerSpeakerId = await getWearerSpeakerId()
  wearerSpeakerSelect.value = String(wearerSpeakerId)
  calibratingNow = await getCalibrating()
  // Phase 4：閘門模式補水（預設開）
  gatedMode = await getGatedMode()
  gatedModeInput.checked = gatedMode
  autoListen = await getAutoListen()
  autoListenInput.checked = autoListen
  audioSource = await getAudioSource()
  audioSourceSelect.value = audioSource
  // Phase 4：媒體鍵 flag（預設關）— 開了才啟動 MediaSession 路線
  const mediaKeyOn = await getMediaKeyFlag()
  mediaKeyInput.checked = mediaKeyOn
  if (mediaKeyOn) setupMediaKeyTrigger()
  // Phase 1 設定補水
  sceneNote = await getSceneNote()
  modelChoice = await getModelChoice()
  answerLength = await getAnswerLength()
  langMode = await getLang()
  sceneNoteInput.value = sceneNote
  modelSelect.value = modelChoice
  answerLengthSelect.value = answerLength
  langSelect.value = langMode
  // Phase 2 KB 補水
  kbPersonal = await getKbPersonal()
  kbExtra = await getKbExtra()
  kbAttach = await getKbAttach()
  kbPersonalInput.value = kbPersonal
  kbExtraInput.value = kbExtra
  renderKbCounts()
  renderKbAttach()
  // Set up transport if both Worker URL + token are configured. If they're
  // unset or change later, mock mode runs.
  transport = createTransport(wUrl, wTok, { lang: langMode, gated: effectiveGated() })
  isRealMode = transport.ready
  renderModeList()

  if (!agreedToPrivacy) {
    privacyModal.style.display = 'flex'
  }

  if (!even) {
    status.textContent = 'Running outside the Even runtime — browser preview only.'
    return
  }
  status.textContent = agreedToPrivacy
    ? 'Glasses connected. Use them to start a session.'
    : 'Glasses connected. Accept the privacy notice to enable mic.'

  even.onTap(onTap)
  even.onSwipe(onSwipe)
  even.onDoubleTap(onDoubleTap)
  even.onForeground(() => { void paint() })

  // One-shot battery read so the idle screen shows the glyph before the
  // first mic-tick. The tick keeps it fresh while mic is on; without this
  // call the battery glyph is invisible on every cold-start idle render.
  try { cachedBatteryLevel = await even.getBatteryLevel() } catch { /* ignore */ }

  await paint()
}

void bootstrap().catch(err => {
  // eslint-disable-next-line no-console
  console.error('[cue] bootstrap threw:', err?.message ?? err, err?.stack)
})
