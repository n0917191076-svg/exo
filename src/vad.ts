// 語音活動偵測（VAD）— PCM16 mono 16kHz frame 的 RMS 閾值狀態機。
// 改寫自 tntpsu/even-voice-shim 的 src/vad.ts（MIT，作者即 Cue 上游）。
//
// **只給自動收音模式用**：在音訊層提早知道「說完了」→ 立即 flush 當前
// pending 音訊送轉寫，不必等 2.5s 切塊滿；閘門模式完全不經 VAD（閘門
// 的開/關就是人手，測試鎖定此邊界）。
//
// 狀態機：
//   PRE_VOICE  — 剛開始聽；等第一個有聲 frame（逾時 → 'no-speech'）
//   VOICE      — 偵測到人聲；錄音中
//   POST_VOICE — 有聲→靜音轉換；計靜音長度（超過 hold → 'voice-end'；
//                人聲恢復 → 回 VOICE）
//   總時長超過 maxRecordMs → 'hard-cap'（防持續噪音永不觸發）

const BYTES_PER_SAMPLE = 2

// 預設值沿用 even-voice-shim 的實測調校：threshold 是正規化 RMS（0..1），
// 0.04 ≈ -28 dBFS——抓得到對話音量、擋得住一般環境噪音。
export const DEFAULT_VAD_THRESHOLD = 0.04
export const PRE_VOICE_TIMEOUT_MS = 2_500
export const SILENCE_HOLD_MS = 700
export const MAX_RECORD_MS = 8_000

export type VadState = 'PRE_VOICE' | 'VOICE' | 'POST_VOICE' | 'CLOSED'
export type VadCloseReason = 'voice-end' | 'hard-cap' | 'no-speech'

export interface VadConfig {
  threshold?: number
  preVoiceTimeoutMs?: number
  silenceHoldMs?: number
  maxRecordMs?: number
}

/** PCM16 mono little-endian frame 的正規化 RMS（0..1）。 */
export function rmsPcm16(frame: Uint8Array): number {
  const samples = Math.floor(frame.byteLength / BYTES_PER_SAMPLE)
  if (samples === 0) return 0
  let sumSq = 0
  for (let i = 0; i < samples; i += 1) {
    const lo = frame[i * 2]!
    const hi = frame[i * 2 + 1]!
    let s = (hi << 8) | lo
    if (s >= 0x8000) s -= 0x10000
    const norm = s / 32768
    sumSq += norm * norm
  }
  return Math.sqrt(sumSq / samples)
}

export class Vad {
  private state: VadState = 'PRE_VOICE'
  private startedAt = 0
  private silentSinceMs = 0
  private readonly threshold: number
  private readonly preVoiceTimeoutMs: number
  private readonly silenceHoldMs: number
  private readonly maxRecordMs: number

  constructor(cfg: VadConfig = {}) {
    this.threshold = cfg.threshold ?? DEFAULT_VAD_THRESHOLD
    this.preVoiceTimeoutMs = cfg.preVoiceTimeoutMs ?? PRE_VOICE_TIMEOUT_MS
    this.silenceHoldMs = cfg.silenceHoldMs ?? SILENCE_HOLD_MS
    this.maxRecordMs = cfg.maxRecordMs ?? MAX_RECORD_MS
  }

  /** 開始（或重新開始）一輪偵測。自動收音是連續的 — 每次 close 後重啟。 */
  start(now: number = Date.now()): void {
    this.state = 'PRE_VOICE'
    this.startedAt = now
    this.silentSinceMs = 0
  }

  /** 餵一個 frame。要收束時回傳原因，否則 null。now 可注入供測試。 */
  push(frame: Uint8Array, now: number = Date.now()): VadCloseReason | null {
    if (this.state === 'CLOSED') return null
    const elapsed = now - this.startedAt
    if (elapsed >= this.maxRecordMs) {
      this.state = 'CLOSED'
      return 'hard-cap'
    }
    const voiced = rmsPcm16(frame) >= this.threshold
    switch (this.state) {
      case 'PRE_VOICE': {
        if (voiced) {
          this.state = 'VOICE'
          return null
        }
        if (elapsed >= this.preVoiceTimeoutMs) {
          this.state = 'CLOSED'
          return 'no-speech'
        }
        return null
      }
      case 'VOICE': {
        if (!voiced) {
          this.state = 'POST_VOICE'
          this.silentSinceMs = now
        }
        return null
      }
      case 'POST_VOICE': {
        if (voiced) {
          this.state = 'VOICE'
          this.silentSinceMs = 0
          return null
        }
        if (now - this.silentSinceMs >= this.silenceHoldMs) {
          this.state = 'CLOSED'
          return 'voice-end'
        }
        return null
      }
      default:
        return null
    }
  }

  current(): VadState {
    return this.state
  }
}

/** 測試用：產生 RMS ≈ level 的合成 PCM16 frame。 */
export function synthFrame(samples: number, level: number): Uint8Array {
  const buf = new Uint8Array(samples * 2)
  const view = new DataView(buf.buffer)
  for (let i = 0; i < samples; i += 1) {
    const v = Math.round((i % 2 === 0 ? 1 : -1) * level * 32767)
    view.setInt16(i * 2, v, true)
  }
  return buf
}
