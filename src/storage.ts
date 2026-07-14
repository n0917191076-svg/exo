// Storage layer. Wraps the SDK's native bridge.setLocalStorage with
// browser-localStorage fallback for the dev preview. Same pattern as Glance.

import type { ModeId } from './modes'

interface BridgeStorageLike {
  getStorage: (key: string) => Promise<string>
  setStorage: (key: string, value: string) => Promise<boolean>
}

let bridge: BridgeStorageLike | null = null

export function setStorageBridge(b: BridgeStorageLike | null): void {
  bridge = b
}

async function readRaw(key: string): Promise<string | null> {
  try {
    if (bridge) {
      const v = await bridge.getStorage(key)
      return v || null
    }
    return window.localStorage.getItem(key)
  } catch {
    return null
  }
}

async function writeRaw(key: string, value: string): Promise<void> {
  try {
    if (bridge) {
      await bridge.setStorage(key, value)
      return
    }
    window.localStorage.setItem(key, value)
  } catch {
    /* swallow — settings will degrade to in-memory for the session */
  }
}

const KEY_AGREED = 'cue:privacy-agreed:v1'
const KEY_MODE = 'cue:mode:v1'
const KEY_CUSTOM_PROMPT = 'cue:custom-prompt:v1'
const KEY_WORKER_URL = 'cue:worker-url:v1'
const KEY_WORKER_TOKEN = 'cue:worker-token:v1'
const KEY_IDLE_AUTO_PAUSE_MIN = 'cue:idle-auto-pause-min:v1'
// v0.4.0: show the diagnostic stats line on glasses (audio frames /
// chunks / errors). Default OFF — only meant for active debugging.
const KEY_SHOW_DEBUG_OVERLAY = 'cue:show-debug-overlay:v1'
// v0.4.0: which Deepgram-assigned speaker is the wearer. -1 = none /
// auto-detect (don't filter from suggestion context). 0/1/... = anchor
// that speaker as wearer; suggestions exclude their lines.
const KEY_WEARER_SPEAKER_ID = 'cue:wearer-speaker-id:v1'

export const DEFAULT_IDLE_AUTO_PAUSE_MIN = 5
export const DEFAULT_WEARER_SPEAKER_ID = -1

export async function hasAgreedToPrivacy(): Promise<boolean> {
  const raw = await readRaw(KEY_AGREED)
  return raw === '1'
}

export async function setPrivacyAgreed(): Promise<void> {
  await writeRaw(KEY_AGREED, '1')
}

export async function getMode(): Promise<ModeId | null> {
  const raw = await readRaw(KEY_MODE)
  return (raw as ModeId) || null
}

export async function setMode(mode: ModeId): Promise<void> {
  await writeRaw(KEY_MODE, mode)
}

export async function getCustomPrompt(): Promise<string> {
  return (await readRaw(KEY_CUSTOM_PROMPT)) ?? ''
}

export async function setCustomPrompt(prompt: string): Promise<void> {
  await writeRaw(KEY_CUSTOM_PROMPT, prompt)
}

export async function getWorkerUrl(): Promise<string> {
  return (await readRaw(KEY_WORKER_URL)) ?? ''
}

export async function setWorkerUrl(url: string): Promise<void> {
  await writeRaw(KEY_WORKER_URL, url.trim())
}

export async function getWorkerToken(): Promise<string> {
  return (await readRaw(KEY_WORKER_TOKEN)) ?? ''
}

export async function setWorkerToken(token: string): Promise<void> {
  await writeRaw(KEY_WORKER_TOKEN, token.trim())
}

// Idle auto-pause threshold in minutes. Stored as a small int string. 0 = disable.
// Negative or non-numeric input falls back to the default — defensive because the
// phone-side textbox can't be locked down from accepting garbage input.
export async function getIdleAutoPauseMin(): Promise<number> {
  const raw = await readRaw(KEY_IDLE_AUTO_PAUSE_MIN)
  if (raw === null) return DEFAULT_IDLE_AUTO_PAUSE_MIN
  const n = Number.parseInt(raw, 10)
  if (!Number.isFinite(n) || n < 0) return DEFAULT_IDLE_AUTO_PAUSE_MIN
  return n
}

export async function setIdleAutoPauseMin(min: number): Promise<void> {
  const n = Math.max(0, Math.floor(min))
  await writeRaw(KEY_IDLE_AUTO_PAUSE_MIN, String(n))
}

export async function getShowDebugOverlay(): Promise<boolean> {
  return (await readRaw(KEY_SHOW_DEBUG_OVERLAY)) === '1'
}

export async function setShowDebugOverlay(on: boolean): Promise<void> {
  await writeRaw(KEY_SHOW_DEBUG_OVERLAY, on ? '1' : '0')
}

// Wearer speaker id: -1 = none / auto-detect (no filter), 0+ = anchor.
export async function getWearerSpeakerId(): Promise<number> {
  const raw = await readRaw(KEY_WEARER_SPEAKER_ID)
  if (raw === null) return DEFAULT_WEARER_SPEAKER_ID
  const n = Number.parseInt(raw, 10)
  if (!Number.isFinite(n)) return DEFAULT_WEARER_SPEAKER_ID
  return n
}

export async function setWearerSpeakerId(id: number): Promise<void> {
  await writeRaw(KEY_WEARER_SPEAKER_ID, String(Math.floor(id)))
}

// v0.4.2: one-shot flag set by phone-side "Calibrate me" button. Plugin
// reads + clears on the next non-empty utterance, anchoring that
// speaker as the wearer. Replaces the manual "Speaker A is me" dropdown
// for users who'd rather just press a button + say their name.
const KEY_CALIBRATING = 'cue:calibrating:v1'
export async function getCalibrating(): Promise<boolean> {
  return (await readRaw(KEY_CALIBRATING)) === '1'
}
export async function setCalibrating(on: boolean): Promise<void> {
  await writeRaw(KEY_CALIBRATING, on ? '1' : '0')
}

// v0.4.3: per-session transcript persistence. Cue saves each mic session
// as a record so the user can review past conversations on phone-side
// settings. Capped at SESSION_HISTORY_CAP entries (newest first); older
// roll off. NOT a transcript of every chunk — just one record per
// mic-on / mic-off pair with the assembled transcript + suggestions.
const KEY_SESSION_HISTORY = 'cue:session-history:v1'
export const SESSION_HISTORY_CAP = 50

export interface SessionRecord {
  startedAt: number      // Date.now() at mic-on
  endedAt: number        // Date.now() at mic-off
  mode: string           // ModeId at session start
  transcript: string     // accumulated other-speakers' transcript (no wearer)
  suggestionCount: number  // total /suggest calls made
}

export async function loadSessionHistory(): Promise<SessionRecord[]> {
  const raw = await readRaw(KEY_SESSION_HISTORY)
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw) as SessionRecord[]
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

export async function appendSessionRecord(rec: SessionRecord): Promise<void> {
  const list = await loadSessionHistory()
  list.unshift(rec)
  while (list.length > SESSION_HISTORY_CAP) list.pop()
  await writeRaw(KEY_SESSION_HISTORY, JSON.stringify(list))
}

export async function clearSessionHistory(): Promise<void> {
  await writeRaw(KEY_SESSION_HISTORY, JSON.stringify([]))
}

// ── Phase 1（Exo）：場景說明 / 模型 / 回答長度 / 語言 ──────────────
// 皆為手機端設定，key 沿用 cue: 前綴避免舊資料失聯。

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

// 非法儲存值一律回退預設 — 下拉選單理論上擋得住，但儲存層可能被
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

// ── Phase 2（Exo）：知識庫 ────────────────────────────────────────
// 兩個 KB 文字框（個人資訊／補充資料）＋每模式掛載表。Evan 的工作流
// 是 Obsidian 寫好貼上，v1 不做雲端同步。

const KEY_KB_PERSONAL = 'cue:kb-personal:v1'
const KEY_KB_EXTRA = 'cue:kb-extra:v1'
const KEY_KB_ATTACH = 'cue:kb-attach:v1'

// 單一 KB 上限。超過時從頭截斷保留尾端 — 新資訊通常貼在後面。
export const KB_MAX_CHARS = 6000

function tailTruncate(s: string, max: number): string {
  return s.length > max ? s.slice(s.length - max) : s
}

export async function getKbPersonal(): Promise<string> {
  return (await readRaw(KEY_KB_PERSONAL)) ?? ''
}
export async function setKbPersonal(s: string): Promise<void> {
  await writeRaw(KEY_KB_PERSONAL, tailTruncate(s, KB_MAX_CHARS))
}

export async function getKbExtra(): Promise<string> {
  return (await readRaw(KEY_KB_EXTRA)) ?? ''
}
export async function setKbExtra(s: string): Promise<void> {
  await writeRaw(KEY_KB_EXTRA, tailTruncate(s, KB_MAX_CHARS))
}

export interface KbAttach {
  personal: boolean
  extra: boolean
}

// 預設掛載：work 全掛；daily 只掛個人資訊；custom 不掛（使用者自控 prompt）。
const DEFAULT_KB_ATTACH: Record<ModeId, KbAttach> = {
  work: { personal: true, extra: true },
  daily: { personal: true, extra: false },
  custom: { personal: false, extra: false },
}

export async function getKbAttach(): Promise<Record<ModeId, KbAttach>> {
  const raw = await readRaw(KEY_KB_ATTACH)
  const out: Record<ModeId, KbAttach> = {
    work: { ...DEFAULT_KB_ATTACH.work },
    daily: { ...DEFAULT_KB_ATTACH.daily },
    custom: { ...DEFAULT_KB_ATTACH.custom },
  }
  if (!raw) return out
  try {
    const parsed = JSON.parse(raw) as Partial<Record<ModeId, Partial<KbAttach>>>
    // 逐模式逐欄位驗證合併 — 壞 JSON、缺欄、非布林一律回退該欄預設
    for (const id of ['work', 'daily', 'custom'] as ModeId[]) {
      const p = parsed?.[id]
      if (p && typeof p === 'object') {
        if (typeof p.personal === 'boolean') out[id].personal = p.personal
        if (typeof p.extra === 'boolean') out[id].extra = p.extra
      }
    }
  } catch {
    /* 壞 JSON → 全預設 */
  }
  return out
}

export async function setKbAttach(map: Record<ModeId, KbAttach>): Promise<void> {
  await writeRaw(KEY_KB_ATTACH, JSON.stringify(map))
}

// ── Phase 4（Exo）：閘門模式 / 自動收音 / 媒體鍵 flag ────────────────

const KEY_GATED_MODE = 'cue:gated-mode:v1'
const KEY_AUTO_LISTEN = 'cue:auto-listen:v1'
const KEY_MEDIA_KEY = 'cue:media-key:v1'

// 閘門收音是產品核心設計 — 預設開；未設定（null）視為開。
export async function getGatedMode(): Promise<boolean> {
  return (await readRaw(KEY_GATED_MODE)) !== '0'
}
export async function setGatedMode(on: boolean): Promise<void> {
  await writeRaw(KEY_GATED_MODE, on ? '1' : '0')
}

// 自動收音預設關 — 隱私鐵律：麥克風預設 OFF。
export async function getAutoListen(): Promise<boolean> {
  return (await readRaw(KEY_AUTO_LISTEN)) === '1'
}
export async function setAutoListen(on: boolean): Promise<void> {
  await writeRaw(KEY_AUTO_LISTEN, on ? '1' : '0')
}

// 媒體鍵 MediaSession 駭法是實驗路線 — 預設關。
export async function getMediaKeyFlag(): Promise<boolean> {
  return (await readRaw(KEY_MEDIA_KEY)) === '1'
}
export async function setMediaKeyFlag(on: boolean): Promise<void> {
  await writeRaw(KEY_MEDIA_KEY, on ? '1' : '0')
}

// 收音來源 — audioControl 第二參數（SDK 0.0.12 的 AudioInputSource）。
// 預設眼鏡；手機麥克風供眼鏡收音不穩或想省眼鏡電時用。
const KEY_AUDIO_SOURCE = 'cue:audio-source:v1'
export type AudioSource = 'glasses' | 'phone'
export async function getAudioSource(): Promise<AudioSource> {
  const raw = await readRaw(KEY_AUDIO_SOURCE)
  return raw === 'phone' ? 'phone' : 'glasses'
}
export async function setAudioSource(src: AudioSource): Promise<void> {
  await writeRaw(KEY_AUDIO_SOURCE, src)
}
