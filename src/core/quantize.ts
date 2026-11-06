import type { DistanceMetric, PaletteEntry } from './palette.ts'
import { prepareNearest } from './palette.ts'
import { DEFAULT_HUE_WEIGHT, hexToRgb } from './color.ts'
import { IGNORED_ALPHA } from './edit.ts'
import type { Pixmap } from './types.ts'

export interface QuantizeOptions {
  metric: DistanceMetric
  /** 是否把颜色吸附到色板 */
  quantize: boolean
  /** 抖动方式 */
  dither: 'none' | 'floyd-steinberg'
  /** 色相权重 */
  hueWeight?: number
}

export const DEFAULT_QUANTIZE_OPTIONS: QuantizeOptions = {
  metric: 'lab',
  quantize: true,
  dither: 'none',
  hueWeight: DEFAULT_HUE_WEIGHT,
}

function distributeErr(
  data: Uint8ClampedArray,
  x: number,
  y: number,
  w: number,
  h: number,
  er: number,
  eg: number,
  eb: number,
  factor: number,
): void {
  if (x < 0 || x >= w || y < 0 || y >= h) return
  const i = (y * w + x) * 4
  if (data[i + 3] < IGNORED_ALPHA) return // 透明格不收误差：RGB 被污染后 alpha 一丢就是黑豆
  data[i] = Math.min(255, Math.max(0, data[i] + er * factor))
  data[i + 1] = Math.min(255, Math.max(0, data[i + 1] + eg * factor))
  data[i + 2] = Math.min(255, Math.max(0, data[i + 2] + eb * factor))
}

/** 将像素图量化吸附至目标色板 */
export function quantizeToPalette(
  img: Pixmap,
  palette: PaletteEntry[],
  options: QuantizeOptions = DEFAULT_QUANTIZE_OPTIONS,
  overrides?: { key: number; hex: string }[] | null,
): Pixmap {
  const w = img.width
  const h = img.height
  const data = new Uint8ClampedArray(img.data)

  if (!options.quantize || !palette.length) {
    return { width: w, height: h, data }
  }

  const match = prepareNearest(palette, options.metric, options.hueWeight ?? DEFAULT_HUE_WEIGHT)
  const outRgb = palette.map((entry) => hexToRgb(entry.hex))

  let forced: Map<number, number> | null = null
  if (overrides?.length) {
    const byHex = new Map<string, number>()
    for (let i = 0; i < palette.length; i++) byHex.set(palette[i].hex.toUpperCase(), i)
    forced = new Map<number, number>()
    for (const o of overrides) {
      const idx = byHex.get(o.hex.toUpperCase())
      if (idx !== undefined) forced.set(o.key, idx)
    }
    if (!forced.size) forced = null
  }

  if (options.dither === 'floyd-steinberg') {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4
        if (data[i + 3] < IGNORED_ALPHA) continue // 全透明 = 忽略
        const oldR = data[i]
        const oldG = data[i + 1]
        const oldB = data[i + 2]

        const idx = forced?.get((oldR << 16) | (oldG << 8) | oldB) ?? match(oldR, oldG, oldB)
        const target = outRgb[idx]

        data[i] = target[0]
        data[i + 1] = target[1]
        data[i + 2] = target[2]

        const errR = oldR - target[0]
        const errG = oldG - target[1]
        const errB = oldB - target[2]

        distributeErr(data, x + 1, y, w, h, errR, errG, errB, 7 / 16)
        distributeErr(data, x - 1, y + 1, w, h, errR, errG, errB, 3 / 16)
        distributeErr(data, x, y + 1, w, h, errR, errG, errB, 5 / 16)
        distributeErr(data, x + 1, y + 1, w, h, errR, errG, errB, 1 / 16)
      }
    }
    return { width: w, height: h, data }
  }

  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < IGNORED_ALPHA) continue // 全透明 = 忽略
    const idx =
      forced?.get((data[i] << 16) | (data[i + 1] << 8) | data[i + 2]) ??
      match(data[i], data[i + 1], data[i + 2])
    const target = outRgb[idx]
    data[i] = target[0]
    data[i + 1] = target[1]
    data[i + 2] = target[2]
  }

  return { width: w, height: h, data }
}

/** 每种色板颜色的用量统计 */
export function usageCounts(img: Pixmap, palette: PaletteEntry[]): Uint32Array {
  const counts = new Uint32Array(palette.length)
  const index = new Map<string, number>()
  for (let i = 0; i < palette.length; i++) index.set(palette[i].hex, i)

  const data = img.data
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 8) continue
    const hex =
      '#' +
      data[i].toString(16).padStart(2, '0').toUpperCase() +
      data[i + 1].toString(16).padStart(2, '0').toUpperCase() +
      data[i + 2].toString(16).padStart(2, '0').toUpperCase()
    const idx = index.get(hex)
    if (idx !== undefined) counts[idx]++
  }
  return counts
}

/** 统计图像中出现的不同颜色数量 */
export function countUniqueColors(img: Pixmap): number {
  const seen = new Set<number>()
  const d = img.data
  for (let i = 0; i < d.length; i += 4) {
    seen.add((d[i] << 16) | (d[i + 1] << 8) | d[i + 2])
  }
  return seen.size
}
