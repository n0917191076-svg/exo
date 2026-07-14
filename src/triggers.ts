// Phase 4：觸發來源統一抽象。所有收音觸發（眼鏡觸控／手機大按鈕／R1／
// 媒體鍵／自動收音）都化約成語意事件，main.ts 只有一個 dispatcher。
// 手勢 → 語意的對應是純函式 gestureMapFor —— 模式作用域的單一事實來源，
// Phase 8 的 guide/talk 模式加自己的分支即可，不影響其他模式。

import type { ModeId } from './modes'

// 語意事件 — 所有觸發來源最終都化約成這五種
export type TriggerEvent =
  | 'gate-start'   // 開始收音（閘門開）
  | 'gate-stop'    // 結束收音並送出（觸發 /suggest）
  | 'cancel'       // 丟棄本段收音（不送出）
  | 'proactive'    // 主動救場：要可聊話題（daily/custom）
  | 'extend'       // 延伸：回答顯示中雙擊，帶前輪問答 context 接續深入

export type TriggerSourceId = 'glasses' | 'phone-button' | 'r1' | 'media-key' | 'auto'

export interface TriggerSource {
  id: TriggerSourceId
  /** 註冊底層事件，把手勢翻成語意事件丟給 dispatch；回傳解除函式。 */
  attach(dispatch: (ev: TriggerEvent) => void): () => void
}

/** 自動收音模式的 proactive 救場靜默窗（距上次 transcript 的毫秒數）。 */
export const PROACTIVE_SILENT_MS = 8_000

/** 支援 proactive 救場的模式（custom 比照 daily）。 */
function supportsProactive(mode: ModeId): boolean {
  return mode === 'daily' || mode === 'custom'
}

/**
 * 手勢 → 語意事件。狀態優先序：收音中（micOn）> 回答顯示中（hasAnswer）
 * > 純待命。'exit' 不算收音語意，由 glasses 配接器直接呼叫 exitApp()。
 * 誤觸保護：退出只在「純待命且無回答」的雙擊 — 回答顯示中雙擊一律延伸。
 */
export function gestureMapFor(input: {
  mode: ModeId
  micOn: boolean
  hasAnswer: boolean
  source: 'glasses' | 'ring'
  gesture: 'tap' | 'double-tap' | 'long-press'
  /** 自動收音模式下且距上次 transcript ≥ PROACTIVE_SILENT_MS */
  silentIdle: boolean
}): TriggerEvent | 'exit' | null {
  const { mode, micOn, hasAnswer, source, gesture, silentIdle } = input

  // 長按＝退出，所有狀態一致（含收音中——隱私逃生）。這是終態退出手勢；
  // 官方 Device APIs 文件有 LONG_PRESS_EVENT，但 JS SDK（至 0.0.12）尚未
  // 暴露 — 配接器待 SDK 落地後接上（見 KNOWN_QUIRKS），屆時移除「純待命
  // 雙擊=exit」的過渡語意。
  if (gesture === 'long-press') return 'exit'

  if (gesture === 'tap') {
    // 自動收音的靜默窗優先 — 此時 mic 常開，單擊語意是「救場」不是關閘門
    if (silentIdle && supportsProactive(mode)) return 'proactive'
    if (micOn) return 'gate-stop'
    return 'gate-start' // 純待命與回答顯示中皆開始（新一輪）收音；清屏由 dispatcher 處理
  }

  // double-tap
  if (micOn) {
    if (source === 'ring' && supportsProactive(mode)) return 'proactive' // 沿用 Cue ring-tap
    return 'cancel'
  }
  if (hasAnswer) return 'extend'
  return source === 'glasses' ? 'exit' : null
}
