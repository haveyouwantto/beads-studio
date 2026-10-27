import type { RGB, RGBA } from './types.ts'

export function clamp(x: number, a: number, b: number): number {
  return Math.max(a, Math.min(b, x))
}

export function rgbToHex(rgb: RGB): string {
  return (
    '#' +
    rgb
      .map((v) => clamp(Math.round(v), 0, 255).toString(16).padStart(2, '0'))
      .join('')
      .toUpperCase()
  )
}

export function hexToRgb(hex: string): RGB {
  const h = hex.replace('#', '')
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ]
}

export function isHexColor(s: string): boolean {
  return /^#[0-9a-fA-F]{6}$/.test(s)
}

/**
 * sRGB → CIE Lab（D65）。与原 beads-color-sampler 使用同一套系数，
 * 保证 ΔE 数值与旧工具一致。
 */
export function rgbToLab(rgb: RGB): RGB {
  const [r, g, b] = rgb.map((x) => {
    const v = x / 255
    return v > 0.04045 ? Math.pow((v + 0.055) / 1.055, 2.4) : v / 12.92
  }) as RGB

  let x = (r * 0.4124 + g * 0.3576 + b * 0.1805) / 0.95047
  let y = (r * 0.2126 + g * 0.7152 + b * 0.0722) / 1.0
  let z = (r * 0.0193 + g * 0.1192 + b * 0.9505) / 1.08883

  x = x > 0.008856 ? Math.pow(x, 1 / 3) : 7.787 * x + 16 / 116
  y = y > 0.008856 ? Math.pow(y, 1 / 3) : 7.787 * y + 16 / 116
  z = z > 0.008856 ? Math.pow(z, 1 / 3) : 7.787 * z + 16 / 116

  return [116 * y - 16, 500 * (x - y), 200 * (y - z)]
}

/** Lab 空间的欧氏距离，即 CIE76 色差 ΔE */
export function deltaE(a: RGB, b: RGB): number {
  const d0 = a[0] - b[0]
  const d1 = a[1] - b[1]
  const d2 = a[2] - b[2]
  return Math.sqrt(d0 * d0 + d1 * d1 + d2 * d2)
}

/**
 * 色相权重随彩度渐入的起点/终点。
 *
 * 彩度太低时人眼读不出色相：两个 C≈5 的淡色哪怕差 60°，看着都是同一块米白。
 * 这时如果按「色相很重要」去罚，度量就会把淡色推到纯白/纯灰上去 ——
 * 实测就是浅色头发变成白发（饱和度没了）。所以色相权重从 C=6 开始线性上升，
 * 到 C=20 才用满 `wHue`；低彩度区等价于原 CIE76。
 */
const HUE_RAMP_FROM = 6
const HUE_RAMP_TO = 20

/** 默认色相权重：选色与出图共用同一个值，避免「选色同族、出图跨族」的错位 */
export const DEFAULT_HUE_WEIGHT = 2

/**
 * Lab → (彩度, 色相角) 的记忆化。
 *
 * 色板条目的 lab 数组是稳定的，同一颗豆会被同一张图的每个像素问一遍；
 * 把 atan2/hypot 的结果挂在数组上复用，最近色匹配就不会因为换了度量慢一个数量级。
 */
const POLAR = new WeakMap<RGB, readonly [number, number]>()

export function labPolar(lab: RGB): readonly [number, number] {
  let p = POLAR.get(lab)
  if (!p) {
    p = [Math.hypot(lab[1], lab[2]), Math.atan2(lab[2], lab[1])]
    POLAR.set(lab, p)
  }
  return p
}

/**
 * 彩度「掉下去」时的额外惩罚倍数。
 *
 * 色相项写成 `2√(C1·C2)·sin(Δh/2)` 之后，无彩色候选的色相项恒等于 0 ——
 * 它成了躲开色相惩罚的免费出口。预算紧、色板缺某个色相时，优化器就会去挑灰豆：
 * 报表里的色相误差好看了，但整张图掉饱和度（浅色头发变白就是这条路走出来的）。
 * 所以彩度下降按 1.5 倍计，灰不再免费；彩度上升照旧，不影响「配到更艳的豆」。
 */
const SAT_LOSS_GAIN = 1.5

/** 彩度 → 色相权重的放大比例（1 = 原 CIE76 的色相项） */
export function hueWeightAt(chroma: number, wHue: number): number {
  const ramp = Math.min(1, Math.max(0, (chroma - HUE_RAMP_FROM) / (HUE_RAMP_TO - HUE_RAMP_FROM)))
  return 1 + (wHue - 1) * ramp
}

/**
 * 色相敏感色差。
 *
 * 色相项沿用 CIE76 的形式 `2√(C1·C2)·sin(Δh/2)`，再乘一个随彩度渐入的权重：
 *
 * - `wHue = 0` 退回纯 CIE76（`deltaE`）。
 * - 权重按**源色**（要被还原的那个颜色）的彩度取值：≤6 时是 1，淡色不会被推向纯白；
 *   ≥20 时用满 `wHue`（默认 2），「整块变味」的问题才真正被治住。
 * - 另外，彩度下降按 `SAT_LOSS_GAIN` 倍计，无彩色不再能靠「没有色相」躲开惩罚。
 *
 * 为什么权重挂在源色而不是两端的较小值：灰豆的彩度只有 4，取 min 就把权重压回 1，
 * 于是深棕会被配成一颗冷灰 —— 报表上「色相误差」不难看，图上那块颜色却废了。
 *
 * 为什么不用「彩度下限 + 色相角弧长」：那样在淡色区会给出和 dL/dC 同量级甚至更大的
 * 惩罚，把浅色头发直接换成白豆 —— 色相是保住了，饱和度没了。
 */
export function deltaEHue(a: RGB, b: RGB, wHue = DEFAULT_HUE_WEIGHT): number {
  if (wHue <= 0) return deltaE(a, b)
  const [c1, h1] = labPolar(a)
  const [c2, h2] = labPolar(b)
  return deltaEHuePolar(a[0] - b[0], c1, h1, c2, h2, wHue)
}

/**
 * 上一行公式的裸参数版本：ΔL 与两端的 (彩度, 色相角) 由调用方给。
 * 最近色匹配要对每个像素遍历整张色板，彩度/色相预先算好再走这里，省掉重复的 atan2。
 */
export function deltaEHuePolar(
  dL: number,
  c1: number,
  h1: number,
  c2: number,
  h2: number,
  wHue = DEFAULT_HUE_WEIGHT,
): number {
  const dCraw = c1 - c2
  if (wHue <= 0) return Math.sqrt(dL * dL + dCraw * dCraw)
  const dC = dCraw > 0 ? dCraw * SAT_LOSS_GAIN : dCraw

  let d = h1 > h2 ? h1 - h2 : h2 - h1
  if (d > Math.PI) d = 2 * Math.PI - d
  const chord = 2 * Math.sqrt(c1 * c2) * Math.sin(d / 2)
  // 权重只看「被还原的那个颜色有多彩」：用两端的较小值会被无彩色候选钻空子 ——
  // 一颗灰豆的彩度是 4，min 就变 4，色相权重直接掉回 1，于是深棕被配成冷灰。
  const w = hueWeightAt(c1, wHue)
  const dH = w * chord

  return Math.sqrt(dL * dL + dC * dC + dH * dH)
}

/** 感知亮度 0..1，用于决定叠在色块上的文字用黑还是白 */
export function luminance(rgb: RGB): number {
  return (0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2]) / 255
}

export function idealTextColor(rgb: RGB): string {
  return luminance(rgb) > 0.55 ? '#0b1220' : '#f8fafc'
}

/** 0.3 / 0.59 / 0.11 加权 RGB 距离 —— 旧「拼豆工具箱」的配色距离 */
export function weightedRgbDistance(r: number, g: number, b: number, c: RGB): number {
  const dr = r - c[0]
  const dg = g - c[1]
  const db = b - c[2]
  return dr * dr * 0.3 + dg * dg * 0.59 + db * db * 0.11
}

export function rgbaToCss(c: RGBA | RGB): string {
  return `rgb(${Math.round(c[0])},${Math.round(c[1])},${Math.round(c[2])})`
}

export function arithmeticMean(values: number[]): number {
  if (!values.length) return 0
  let sum = 0
  for (const v of values) sum += v
  return sum / values.length
}

export function medianValue(values: number[]): number {
  if (!values.length) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

/** 几何平均：值为 0 时用 log((v+1)/256) 规避 log(0)，不丢弃任何样本 */
export function geometricMean(values: number[]): number {
  if (!values.length) return 0
  let logSum = 0
  for (const v of values) logSum += Math.log((v + 1) / 256)
  return clamp(Math.exp(logSum / values.length) * 256 - 1, 0, 255)
}

/** 众数：按 quantization 分桶后取出现次数最多的桶，桶内取原始均值 */
export function modeColor(samples: number[][], quantization = 16): RGBA {
  if (!samples.length) return [0, 0, 0, 255]
  const buckets = new Map<string, { count: number; sums: [number, number, number, number] }>()
  for (const c of samples) {
    const key = `${Math.floor(c[0] / quantization)},${Math.floor(c[1] / quantization)},${Math.floor(
      c[2] / quantization,
    )}`
    let bucket = buckets.get(key)
    if (!bucket) {
      bucket = { count: 0, sums: [0, 0, 0, 0] }
      buckets.set(key, bucket)
    }
    bucket.count++
    bucket.sums[0] += c[0]
    bucket.sums[1] += c[1]
    bucket.sums[2] += c[2]
    bucket.sums[3] += c[3] ?? 255
  }
  let winner: { count: number; sums: [number, number, number, number] } | null = null
  for (const bucket of buckets.values()) {
    if (!winner || bucket.count > winner.count) winner = bucket
  }
  const w = winner as { count: number; sums: [number, number, number, number] }
  return [
    w.sums[0] / w.count,
    w.sums[1] / w.count,
    w.sums[2] / w.count,
    w.sums[3] / w.count,
  ]
}
