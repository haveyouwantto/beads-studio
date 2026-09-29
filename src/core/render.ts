import type { PaletteEntry } from './palette.ts'
import type { Pixmap } from './types.ts'

/**
 * 像素数据的画布绘制工具。
 *
 * 只负责「真实像素」的显示（源图、规范化后的 1:1 网格、1:1 像素图导出）：
 * 这类内容本来就该用最近邻放大，格子与屏幕像素一一对应，不会糊。
 *
 * 拼豆图纸是矢量内容，走 core/svg.ts，不要用这里的 canvas 绘制。
 */

/** 把像素图按最近邻放大画到 canvas 上 */
export function drawPixmap(
  canvas: HTMLCanvasElement,
  img: Pixmap,
  scale = 1,
  smoothing = false,
): void {
  canvas.width = Math.max(1, Math.round(img.width * scale))
  canvas.height = Math.max(1, Math.round(img.height * scale))
  const ctx = canvas.getContext('2d')
  if (!ctx) return

  const tmp = document.createElement('canvas')
  tmp.width = img.width
  tmp.height = img.height
  const tctx = tmp.getContext('2d')
  if (!tctx) return
  tctx.putImageData(new ImageData(new Uint8ClampedArray(img.data), img.width, img.height), 0, 0)

  ctx.imageSmoothingEnabled = smoothing
  ctx.clearRect(0, 0, canvas.width, canvas.height)
  ctx.drawImage(tmp, 0, 0, canvas.width, canvas.height)
}

export function pixmapToCanvas(img: Pixmap, scale: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  drawPixmap(canvas, img, scale, false)
  return canvas
}

/** 计算图案在给定容器尺寸下的合适显示倍率 */
export function fitScale(img: Pixmap, maxWidth: number, maxHeight: number): number {
  const sx = maxWidth / Math.max(1, img.width)
  const sy = maxHeight / Math.max(1, img.height)
  return Math.max(1, Math.min(sx, sy))
}

/** HEX → 色板下标索引，供用量统计 / 高亮使用 */
export function buildHexLookup(palette: PaletteEntry[]): Map<string, number> {
  const map = new Map<string, number>()
  for (let i = 0; i < palette.length; i++) map.set(palette[i].hex, i)
  return map
}
