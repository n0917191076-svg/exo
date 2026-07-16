// Phase 7：圖片前處理。大圖 base64 很肥（官方文件明示），送出前一律縮圖：
// 長邊 ≤1568px、JPEG 0.8。回 base64（不含 data: 前綴）與 media type。
// 在瀏覽器與 Even WKWebView 皆可用（createImageBitmap + canvas）。

export interface DownscaledImage {
  base64: string
  mediaType: string
  dataUrl: string // 給 UI 預覽用
  width: number
  height: number
}

export async function downscaleImage(
  file: Blob,
  maxEdge = 1568,
  quality = 0.8,
): Promise<DownscaledImage> {
  const bitmap = await createImageBitmap(file)
  const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height))
  const width = Math.max(1, Math.round(bitmap.width * scale))
  const height = Math.max(1, Math.round(bitmap.height * scale))
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('canvas 2d context unavailable')
  ctx.drawImage(bitmap, 0, 0, width, height)
  bitmap.close?.()
  const dataUrl = canvas.toDataURL('image/jpeg', quality)
  const base64 = dataUrl.split(',')[1] ?? ''
  return { base64, mediaType: 'image/jpeg', dataUrl, width, height }
}

// 原生相簿/相機回的是 base64（AppImageAsset），轉 Blob 後走同一條縮圖路徑。
export async function downscaleFromBase64(
  base64: string,
  mimeType: string,
  maxEdge = 1568,
  quality = 0.8,
): Promise<DownscaledImage> {
  const resp = await fetch(`data:${mimeType || 'image/jpeg'};base64,${base64}`)
  const blob = await resp.blob()
  return downscaleImage(blob, maxEdge, quality)
}
