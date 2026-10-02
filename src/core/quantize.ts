import type { DistanceMetric, PaletteEntry } from './palette.ts'
import { nearestIndex } from './palette.ts'
import { hexToRgb } from './color.ts'
import type { Pixmap } from './types.ts'

export interface QuantizeOptions {
  metric: DistanceMetric
  /** 是否把颜色吸附到色板（关闭则保留规范化后的原始像素） */
  quantize: boolean
  /** 抖动方式 */
  dither: 'none' | 'floyd-steinberg'
}

export const DEFAULT_QUANTIZE_OPTIONS: QuantizeOptions = {
  metric: 'lab',
  quantize: true,
  dither: 'none',
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
  data[i] = Math.min(255, Math.max(0, data[i] + er * factor))
  data[i + 1] = Math.min(255, Math.max(0, data[i + 1] + eg * factor))
  data[i + 2] = Math.min(255, Math.max(0, data[i + 2] + eb * factor))
}

/**
 * 把规范化后的像素图映射到拼豆色板。
 * 抖动使用 Floyd–Steinberg 误差扩散（与旧「拼豆工具箱」一致）。
 */
export function quantizeToPalette(
  img: Pixmap,
  palette: PaletteEntry[],
  options: QuantizeOptions = DEFAULT_QUANTIZE_OPTIONS,
): Pixmap {
  const w = img.width
  const h = img.height
  const data = new Uint8ClampedArray(img.data)

  if (!options.quantize || !palette.length) {
    return { width: w, height: h, data }
  }

  // 结果里写「豆子本身的颜色」——调色板可能是「半透明豆已换成叠在背景上的观感色」的版本
  // （H01 匹配时是浅灰），但图纸上要记的是那颗豆，所以输出一律按 hex 取色，
  // 否则后面按 hex 查色号会全部落空。
  const outRgb = palette.map((entry) => hexToRgb(entry.hex))

  if (options.dither === 'floyd-steinberg') {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4
        const oldR = data[i]
        const oldG = data[i + 1]
        const oldB = data[i + 2]

        const idx = nearestIndex(oldR, oldG, oldB, palette, options.metric)
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
    const idx = nearestIndex(data[i], data[i + 1], data[i + 2], palette, options.metric)
    const target = outRgb[idx]
    data[i] = target[0]
    data[i + 1] = target[1]
    data[i + 2] = target[2]
  }

  return { width: w, height: h, data }
}

/** 每种色板颜色的用量统计（用于用料清单 / BOM） */
export function usageCounts(img: Pixmap, palette: PaletteEntry[]): Uint32Array {
  const counts = new Uint32Array(palette.length)
  const index = new Map<string, number>()
  for (let i = 0; i < palette.length; i++) index.set(palette[i].hex, i)

  const data = img.data
  for (let i = 0; i < data.length; i += 4) {
    // 透明格 = 忽略：不算一颗豆，别进用料清单
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
