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
 * 无彩色门槛：两边彩度里较小的那个低于它，色相就没有意义（灰没有色相），
 * 此时不参与色相惩罚，避免把纯灰硬按到某个色相上。
 */
export const HUE_MIN_CHROMA = 5

/**
 * 色相项的彩度参考下限。
 *
 * CIE76 的色相项等价于 `2√(C1·C2)·sin(Δh/2)`，当彩度趋近 0 时这一项会自动消失，
 * 于是「灰蓝」和「灰褐」算出来的距离几乎相等 —— 但低彩度恰恰是人对色相最敏感、
 * 也最容易看出「整块颜色变味」的地方。这里给彩度加个下限，让色相项不会因为
 * 颜色淡就失效。
 */
export const HUE_REF_MIN = 10

/** 软阈值：色相差超过这个角度之后，惩罚开始额外加速 */
export const HUE_SOFT_LIMIT_DEG = 24

/** 超过软阈值后每超 1° 追加的倍率（1° 按 1+GAIN 度算） */
export const HUE_EXCESS_GAIN = 3

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
 * 色相敏感色差：把 Lab 的色相项从「弦长」改成「弧长」，并对大角度差加权。
 *
 * - `wHue = 0` 时退回纯 CIE76（`deltaE`）。
 * - `wHue = 1` 相当于只修掉「低彩度时色相项消失」这个 bug。
 * - 默认 `wHue = 2`：实测能把 sRGB 网格上色相偏差 >15° 的比例从 8.2% 压到 2.2%。
 *
 * 超过 `HUE_SOFT_LIMIT_DEG` 的部分按 `HUE_EXCESS_GAIN` 放大，是连续且单调的
 * （不会出现 Infinity），所以可以用在退火目标函数里，也不需要「找不到同色相时的兜底」。
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
  const dC = c1 - c2
  if (wHue <= 0) return Math.sqrt(dL * dL + dC * dC)

  let dH = 0
  const chroma = c1 < c2 ? c1 : c2
  if (chroma >= HUE_MIN_CHROMA) {
    let d = h1 > h2 ? h1 - h2 : h2 - h1
    if (d > Math.PI) d = 2 * Math.PI - d
    const soft = (HUE_SOFT_LIMIT_DEG * Math.PI) / 180
    const arc = d > soft ? d + HUE_EXCESS_GAIN * (d - soft) : d
    dH = wHue * (chroma > HUE_REF_MIN ? chroma : HUE_REF_MIN) * arc
  }

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
