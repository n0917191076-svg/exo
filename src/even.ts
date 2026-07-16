// Glasses bridge wrapper for Cue. Single full-screen text container —
// transcript area on top, suggestions below, mode + mic indicator at the
// header. Mirrors the Glance pattern (BLE-write serialization, structured
// state logs for the regression harness).

import {
  AudioInputSource,
  CreateStartUpPageContainer,
  EventSourceType,
  OsEventTypeList,
  TextContainerProperty,
  TextContainerUpgrade,
  waitForEvenAppBridge,
} from '@evenrealities/even_hub_sdk'

// Audio frame from the SDK's mic capture. Per the SDK README, audio comes
// as PCM bytes — assumed 16kHz mono 16-bit little-endian (industry-standard
// BLE voice format). Verify on real glasses; if it differs, adjust the
// Deepgram URL in worker-template/index.ts.
export type AudioFrame = Uint8Array

const MAIN_ID = 1
const MAIN_NAME = 'main'
const BRIDGE_TIMEOUT_MS = 4000
const WIDTH = 576
const HEIGHT = 288

export type InputSource = 'glasses' | 'ring' | 'unknown'
export type SwipeDir = 'up' | 'down'

export interface EvenRuntime {
  render: (text: string) => Promise<void>
  onTap: (handler: (source: InputSource) => void) => void
  onSwipe: (handler: (dir: SwipeDir, source: InputSource) => void) => void
  onDoubleTap: (handler: (source: InputSource) => void) => void
  onForeground: (handler: () => void) => void
  // Mic capture. Calling startMic emits PCM frames to the registered handler
  // until stopMic. Caller is responsible for routing frames to STT.
  startMic: (handler: (frame: AudioFrame) => void, source?: 'glasses' | 'phone') => Promise<boolean>
  stopMic: () => Promise<void>
  exitApp: () => Promise<void>
  getStorage: (key: string) => Promise<string>
  setStorage: (key: string, value: string) => Promise<boolean>
  // Battery level 0-100, or undefined if the device hasn't reported it yet.
  // Cheap to call repeatedly — uses the latest cached push value when
  // available, falls back to a synchronous getDeviceInfo poll otherwise.
  getBatteryLevel: () => Promise<number | undefined>
  // Phase 7：原生相簿/相機（SDK ≥0.0.12）。回精簡的 {base64,mimeType}，
  // 與 SDK 型別解耦。失敗或取消回 null。實機權限彈窗行為待驗證。
  pickImageFromAlbum: () => Promise<EvenImageAsset | null>
  captureImageFromCamera: () => Promise<EvenImageAsset | null>
}

export interface EvenImageAsset {
  base64: string
  mimeType: string
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(
      () => reject(new Error('Timed out waiting for the Even bridge')),
      timeoutMs,
    )
    promise.then(
      v => { window.clearTimeout(timer); resolve(v) },
      e => { window.clearTimeout(timer); reject(e) },
    )
  })
}

export async function connectEvenRuntime(initial: string): Promise<EvenRuntime | null> {
  let bridge: Awaited<ReturnType<typeof waitForEvenAppBridge>>
  try {
    bridge = await withTimeout(waitForEvenAppBridge(), BRIDGE_TIMEOUT_MS)
  } catch {
    return null
  }

  const main = new TextContainerProperty({
    xPosition: 0,
    yPosition: 0,
    width: WIDTH,
    height: HEIGHT,
    borderWidth: 0,
    borderColor: 5,
    paddingLength: 6,
    containerID: MAIN_ID,
    containerName: MAIN_NAME,
    content: initial,
    isEventCapture: 1,
  })

  const created = await bridge.createStartUpPageContainer(
    new CreateStartUpPageContainer({ containerTotalNum: 1, textObject: [main] }),
  )
  if (created !== 0) return null

  let lastSent = initial
  let lastLen = initial.length

  let busy: Promise<unknown> = Promise.resolve()
  function enqueue<T>(work: () => Promise<T>): Promise<T> {
    const next = busy.then(work, work) as Promise<T>
    busy = next.then(() => undefined, () => undefined)
    return next
  }

  let tapHandler: ((source: InputSource) => void) | null = null
  let swipeHandler: ((dir: SwipeDir, source: InputSource) => void) | null = null
  let doubleTapHandler: ((source: InputSource) => void) | null = null
  let foregroundHandler: (() => void) | null = null
  let audioHandler: ((frame: AudioFrame) => void) | null = null
  // Latest battery push from onDeviceStatusChanged. Push beats poll for
  // freshness and avoids hitting BLE on every tick.
  let cachedBattery: number | undefined
  try {
    const maybeOn = (bridge as unknown as {
      onDeviceStatusChanged?: (cb: (s: { batteryLevel?: number }) => void) => () => void
    }).onDeviceStatusChanged
    if (typeof maybeOn === 'function') {
      maybeOn(s => {
        if (typeof s.batteryLevel === 'number') cachedBattery = s.batteryLevel
      })
    }
  } catch { /* push not supported on this SDK build — fall back to poll */ }

  function classifySource(src: number | undefined): InputSource {
    if (src === EventSourceType.TOUCH_EVENT_FROM_RING) return 'ring'
    if (
      src === EventSourceType.TOUCH_EVENT_FROM_GLASSES_L ||
      src === EventSourceType.TOUCH_EVENT_FROM_GLASSES_R
    ) {
      return 'glasses'
    }
    return 'unknown'
  }

  bridge.onEvenHubEvent(event => {
    // Audio frames are pushed via the same onEvenHubEvent channel —
    // SDK 0.0.10 wraps them as `audioEvent.audioPcm: Uint8Array`. We
    // hand the raw bytes to the registered handler; transport layer
    // is responsible for shaping into Deepgram's expected encoding.
    const audioEvent = (event as { audioEvent?: { audioPcm?: Uint8Array } }).audioEvent
    if (audioEvent?.audioPcm && audioHandler) {
      audioHandler(audioEvent.audioPcm)
      return
    }
    if (event.textEvent) {
      const t = event.textEvent.eventType ?? 0
      if (t === OsEventTypeList.SCROLL_TOP_EVENT) swipeHandler?.('up', 'unknown')
      else if (t === OsEventTypeList.SCROLL_BOTTOM_EVENT) swipeHandler?.('down', 'unknown')
      return
    }
    if (event.sysEvent) {
      const t = event.sysEvent.eventType ?? 0
      const src = classifySource(event.sysEvent.eventSource)
      if (t === 0) { tapHandler?.(src); return }
      if (t === OsEventTypeList.DOUBLE_CLICK_EVENT) { doubleTapHandler?.(src); return }
      if (t === OsEventTypeList.FOREGROUND_ENTER_EVENT) { foregroundHandler?.(); return }
    }
  })

  return {
    async render(text: string): Promise<void> {
      if (text === lastSent) return
      await enqueue(async () => {
        await bridge.textContainerUpgrade(
          new TextContainerUpgrade({
            containerID: MAIN_ID,
            containerName: MAIN_NAME,
            contentOffset: 0,
            contentLength: Math.max(lastLen, text.length),
            content: text,
          }),
        )
        lastSent = text
        lastLen = text.length
      })
    },
    onTap(h) { tapHandler = h },
    onSwipe(h) { swipeHandler = h },
    onDoubleTap(h) { doubleTapHandler = h },
    onForeground(h) { foregroundHandler = h },
    async startMic(handler, source) {
      audioHandler = handler
      try {
        // SDK 0.0.12：audioControl 第二參數選收音來源（眼鏡/手機麥克風）。
        // 未指定時維持 SDK 預設（眼鏡）。
        const ok = await bridge.audioControl(
          true,
          source === 'phone' ? AudioInputSource.Phone : source === 'glasses' ? AudioInputSource.Glasses : undefined,
        )
        return !!ok
      } catch {
        audioHandler = null
        return false
      }
    },
    async stopMic() {
      audioHandler = null
      try { await bridge.audioControl(false) } catch { /* ignore */ }
    },
    async exitApp(): Promise<void> { await bridge.shutDownPageContainer(1) },
    async getStorage(key) {
      try { return await bridge.getLocalStorage(key) } catch { return '' }
    },
    async setStorage(key, value) {
      try { return await bridge.setLocalStorage(key, value) } catch { return false }
    },
    async getBatteryLevel() {
      if (typeof cachedBattery === 'number') return cachedBattery
      try {
        const info = (await bridge.getDeviceInfo()) as { batteryLevel?: number } | null
        const lvl = info?.batteryLevel
        if (typeof lvl === 'number') cachedBattery = lvl
        return lvl
      } catch {
        return undefined
      }
    },
    async pickImageFromAlbum() {
      try {
        const a = await bridge.pickImageFromAlbum()
        return a && a.base64 ? { base64: a.base64, mimeType: a.mimeType || 'image/jpeg' } : null
      } catch { return null }
    },
    async captureImageFromCamera() {
      try {
        const a = await bridge.captureImageFromCamera()
        return a && a.base64 ? { base64: a.base64, mimeType: a.mimeType || 'image/jpeg' } : null
      } catch { return null }
    },
  }
}
