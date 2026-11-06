import { medianValue } from './color.ts'
import { autocorrelation } from './fft.ts'
import type { Pixmap, SampleMode } from './types.ts'
import { clamp } from './color.ts'
import { arithmeticMean, geometricMean, modeColor } from './color.ts'

export interface EdgeMap {
  gray: Float32Array
  edge: Float32Array
  width: number
  height: number
}

export interface Projections {
  px: Float64Array
  py: Float64Array
}

export interface Peak {
  pos: number
  value: number
}

export interface PeriodScore {
  period: number
  score: number
  coverage: number
  occupancy: number
  medianError: number
  matched: number
  bins: number[]
}

export interface PeriodResult {
  period: number | null
  peaks: Peak[]
  scored: PeriodScore[]
  winner?: PeriodScore
}

function median(arr: number[]): number {
  if (!arr.length) return 0
  const a = [...arr].sort((x, y) => x - y)
  const m = Math.floor(a.length / 2)
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2
}

/** 灰度与一阶边缘梯度图计算 */
export function makeEdgeMap(img: Pixmap): EdgeMap {
  const { width, height, data } = img
  const gray = new Float32Array(width * height)

  for (let i = 0; i < width * height; i++) {
    const p = i * 4
    gray[i] = data[p] * 0.2126 + data[p + 1] * 0.7152 + data[p + 2] * 0.0722
  }

  const edge = new Float32Array(width * height)
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x
      const gx = Math.abs(gray[i + 1] - gray[i - 1])
      const gy = Math.abs(gray[i + width] - gray[i - width])
      edge[i] = gx + gy
    }
  }

  return { gray, edge, width, height }
}

/**
 * 方向投影。
 * X 方向周期：把垂直边缘强度沿 Y 汇总；Y 方向周期：沿 X 汇总。
 */
export function buildProjections(gray: Float32Array, width: number, height: number): Projections {
  const px = new Float64Array(width)
  const py = new Float64Array(height)

  for (let y = 0; y < height; y++) {
    for (let x = 1; x < width; x++) {
      px[x] += Math.abs(gray[y * width + x] - gray[y * width + x - 1])
    }
  }
  for (let y = 1; y < height; y++) {
    for (let x = 0; x < width; x++) {
      py[y] += Math.abs(gray[y * width + x] - gray[(y - 1) * width + x])
    }
  }

  return { px, py }
}

/** 盒式平滑 */
export function smooth(arr: Float64Array, radius = 2): Float64Array {
  const out = new Float64Array(arr.length)
  for (let i = 0; i < arr.length; i++) {
    let sum = 0
    let count = 0
    for (let j = Math.max(0, i - radius); j <= Math.min(arr.length - 1, i + radius); j++) {
      sum += arr[j]
      count++
    }
    out[i] = sum / count
  }
  return out
}

/**
 * 自相关峰值检测。
 */
export function findPeaks(ac: Float64Array): Peak[] {
  const peaks: Peak[] = []
  const maxLag = Math.floor(ac.length * 0.55)
  if (maxLag < 6) return peaks

  const region = Array.from(ac.slice(1, maxLag))
  const base = median(region)
  const mad = median(region.map((x) => Math.abs(x - base))) + 1e-9
  const threshold = base + mad * 0.8

  for (let i = 2; i < maxLag - 2; i++) {
    if (ac[i] > threshold && ac[i] >= ac[i - 1] && ac[i] > ac[i + 1]) {
      // 非极大值抑制
      if (!peaks.length || i - peaks[peaks.length - 1].pos > 2) {
        peaks.push({ pos: i, value: ac[i] })
      } else if (ac[i] > peaks[peaks.length - 1].value) {
        peaks[peaks.length - 1] = { pos: i, value: ac[i] }
      }
    }
  }
  return peaks
}

/**
 * 由相邻峰距生成候选基频（包含 1..4 次分频以应对峰列缺项）。
 */
export function generatePeriodCandidates(peaks: Peak[]): number[] {
  const candidates: number[] = []
  const maxPeriod = 256
  const minPeriod = 2

  for (let i = 1; i < peaks.length; i++) {
    const d = peaks[i].pos - peaks[i - 1].pos
    for (let k = 1; k <= 4; k++) {
      const p = d / k
      if (p >= minPeriod && p <= maxPeriod) candidates.push(p)
    }
  }

  candidates.sort((a, b) => a - b)

  const groups: { mean: number; values: number[] }[] = []
  for (const c of candidates) {
    let found = false
    for (const g of groups) {
      if (Math.abs(c - g.mean) < 1.5) {
        g.values.push(c)
        g.mean = g.values.reduce((a, b) => a + b, 0) / g.values.length
        found = true
        break
      }
    }
    if (!found) groups.push({ mean: c, values: [c] })
  }

  return groups.filter((g) => g.values.length >= 2).map((g) => g.mean)
}

/**
 * 晶格周期拟合评估（peak ≈ k × P），评估覆盖度、对齐误差与谐波连续性。
 */
export function scorePeriod(peaks: Peak[], period: number): PeriodScore | null {
  if (peaks.length < 3) return null

  const tolerance = Math.max(1.5, period * 0.12)
  let matched = 0
  const errors: number[] = []
  const bins = new Set<number>()
  let minK = Infinity
  let maxK = -Infinity

  for (const peak of peaks) {
    const k = Math.round(peak.pos / period)
    if (k < 1) continue
    const target = k * period
    const error = Math.abs(peak.pos - target)
    if (error <= tolerance) {
      matched++
      errors.push(error / tolerance)
      bins.add(k)
      minK = Math.min(minK, k)
      maxK = Math.max(maxK, k)
    }
  }

  if (matched < 3) return null

  const coverage = matched / peaks.length
  const medianError = median(errors)

  const span = maxK - minK + 1
  const occupancy = bins.size / span

  let gaps = 0
  for (let k = minK; k <= maxK; k++) if (!bins.has(k)) gaps++
  const gapPenalty = gaps / Math.max(1, span)

  const score = coverage * 4 + occupancy * 4 + (1 - medianError) * 2 - gapPenalty * 2

  return {
    period,
    score,
    coverage,
    occupancy,
    medianError,
    matched,
    bins: [...bins].sort((a, b) => a - b),
  }
}

/** 候选基频局部细化后取最优 */
export function detectPeriod(ac: Float64Array): PeriodResult {
  const peaks = findPeaks(ac)
  const candidates = generatePeriodCandidates(peaks)
  const scored: PeriodScore[] = []

  for (const p of candidates) {
    let best: PeriodScore | null = null
    for (let q = p - 1.5; q <= p + 1.5; q += 0.25) {
      if (q < 2) continue
      const result = scorePeriod(peaks, q)
      if (result && (!best || result.score > best.score)) best = result
    }
    if (best) scored.push(best)
  }

  if (!scored.length) return { period: null, peaks, scored }

  scored.sort((a, b) => b.score - a.score)
  let winner = scored[0]

  // 谐波去重：若大周期为小周期的整数倍且指标相当，优先选用较小周期
  for (const candidate of scored) {
    if (candidate.period >= winner.period) continue
    const ratio = winner.period / candidate.period
    const integerRatio = Math.round(ratio)
    if (integerRatio >= 2 && Math.abs(ratio - integerRatio) < 0.12) {
      if (
        candidate.coverage >= winner.coverage - 0.08 &&
        candidate.occupancy >= winner.occupancy - 0.1
      ) {
        winner = candidate
      }
    }
  }

  return { period: winner.period, peaks, scored, winner }
}

/**
 * 在 phase ∈ [0, P) 搜索与边缘投影对齐的最优网格相位。
 */
export function findPhase(projection: Float64Array, period: number): number {
  let bestPhase = 0
  let bestScore = -Infinity
  const steps = Math.max(8, Math.round(period * 8))

  for (let s = 0; s < steps; s++) {
    const phase = (s / steps) * period
    let score = 0
    let count = 0

    for (let x = phase; x < projection.length; x += period) {
      const center = Math.round(x)
      let local = 0
      for (let dx = -1; dx <= 1; dx++) {
        const p = center + dx
        if (p >= 0 && p < projection.length) local = Math.max(local, projection[p])
      }
      score += local
      count++
    }

    if (count) score /= count
    if (score > bestScore) {
      bestScore = score
      bestPhase = phase
    }
  }

  return bestPhase
}

/**
 * 将像素样本集合按指定采样模式聚合为 RGBA 颜色。
 * 透明样本（alpha < 8）不参与 RGB 统计（RGB=0 混进来会拉暗）；
 * 全透明样本输出全透明。
 */
export function aggregateSamples(samples: number[][], mode: SampleMode): [number, number, number, number] {
  if (!samples.length) return [0, 0, 0, 0]

  const opaque = samples.filter((c) => c[3] >= 8)
  if (!opaque.length) return [0, 0, 0, 0]

  const rs: number[] = []
  const gs: number[] = []
  const bs: number[] = []
  const as: number[] = []
  for (const c of opaque) {
    rs.push(c[0])
    gs.push(c[1])
    bs.push(c[2])
    as.push(c[3])
  }
  // alpha 用全部样本平均：混了透明的格子观感更接近半透明
  const alphaAll = samples.map((c) => c[3])

  switch (mode) {
    case 'mean':
      return [arithmeticMean(rs), arithmeticMean(gs), arithmeticMean(bs), arithmeticMean(alphaAll)]
    case 'median':
      return [medianValue(rs), medianValue(gs), medianValue(bs), medianValue(alphaAll)]
    case 'geometric':
      return [geometricMean(rs), geometricMean(gs), geometricMean(bs), arithmeticMean(alphaAll)]
    case 'mode':
      return modeColor(opaque)
    default:
      return [arithmeticMean(rs), arithmeticMean(gs), arithmeticMean(bs), arithmeticMean(alphaAll)]
  }
}

/** 单元格内取样：center 直接取格中心像素，其余模式聚合网格覆盖范围内的样本 */
function sampleCell(
  source: Uint8ClampedArray,
  width: number,
  height: number,
  left: number,
  right: number,
  top: number,
  bottom: number,
  mode: SampleMode,
): [number, number, number, number] {
  if (mode === 'center') {
    const x = clamp(Math.floor((left + right) / 2), 0, width - 1)
    const y = clamp(Math.floor((top + bottom) / 2), 0, height - 1)
    const p = (y * width + x) * 4
    return [source[p], source[p + 1], source[p + 2], source[p + 3]]
  }

  const x0 = Math.max(0, Math.ceil(left))
  const x1 = Math.min(width, Math.ceil(right))
  const y0 = Math.max(0, Math.ceil(top))
  const y1 = Math.min(height, Math.ceil(bottom))

  const samples: number[][] = []
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const p = (y * width + x) * 4
      samples.push([source[p], source[p + 1], source[p + 2], source[p + 3]])
    }
  }
  return aggregateSamples(samples, mode)
}

export interface SampleResult {
  pixmap: Pixmap
  cols: number
  rows: number
}

/**
 * 按检测到的周期与相位重采样为 1:1 像素图。
 */
export function sampleImage(
  source: Uint8ClampedArray,
  width: number,
  height: number,
  periodX: number,
  periodY: number,
  phaseX: number,
  phaseY: number,
  mode: SampleMode,
): SampleResult {
  const minCellX = Math.floor(-phaseX / periodX)
  const maxCellX = Math.ceil((width - phaseX) / periodX)
  const minCellY = Math.floor(-phaseY / periodY)
  const maxCellY = Math.ceil((height - phaseY) / periodY)

  const cols = maxCellX - minCellX
  const rows = maxCellY - minCellY
  const out = new Uint8ClampedArray(Math.max(0, cols) * Math.max(0, rows) * 4)

  for (let gy = 0; gy < rows; gy++) {
    for (let gx = 0; gx < cols; gx++) {
      const cellX = gx + minCellX
      const cellY = gy + minCellY

      const color = sampleCell(
        source,
        width,
        height,
        phaseX + cellX * periodX,
        phaseX + (cellX + 1) * periodX,
        phaseY + cellY * periodY,
        phaseY + (cellY + 1) * periodY,
        mode,
      )

      const outP = (gy * cols + gx) * 4
      out[outP] = clamp(Math.round(color[0]), 0, 255)
      out[outP + 1] = clamp(Math.round(color[1]), 0, 255)
      out[outP + 2] = clamp(Math.round(color[2]), 0, 255)
      out[outP + 3] = clamp(Math.round(color[3]), 0, 255)
    }
  }

  return { pixmap: { width: cols, height: rows, data: out }, cols, rows }
}

export interface DetectReport {
  periodX: number
  periodY: number
  phaseX: number
  phaseY: number
  acX: Float64Array
  acY: Float64Array
  resultX: PeriodResult
  resultY: PeriodResult
  projectionX: Float64Array
  projectionY: Float64Array
}

/** 周期与相位完整分析流程：灰度 → 投影 → 自相关 → 基频检测 → 相位估算 */
export function analyzePeriods(img: Pixmap): DetectReport | null {
  const { width, height } = img
  if (width < 8 || height < 8) return null

  const { gray } = makeEdgeMap(img)
  const { px, py } = buildProjections(gray, width, height)

  const sx = smooth(px, 1)
  const sy = smooth(py, 1)

  const acX = autocorrelation(sx)
  const acY = autocorrelation(sy)

  const resultX = detectPeriod(acX)
  const resultY = detectPeriod(acY)

  if (!resultX.period || !resultY.period) return null

  return {
    periodX: resultX.period,
    periodY: resultY.period,
    phaseX: findPhase(px, resultX.period),
    phaseY: findPhase(py, resultY.period),
    acX,
    acY,
    resultX,
    resultY,
    projectionX: px,
    projectionY: py,
  }
}
