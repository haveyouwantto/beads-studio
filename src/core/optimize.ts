import { rgbToLab } from './color.ts'
import type { PaletteEntry } from './palette.ts'
import type { RGB, Pixmap } from './types.ts'

// ================================================================ 空间与距离

/** 候选色彩空间。实验结论（quant-lab）：YUV ≈ Lab > 加权RGB > RGB；HSV/CMYK 出局 */
export type ColorSpaceId = 'lab' | 'yuv' | 'weightedRgb' | 'rgb'

export const COLOR_SPACES: { value: ColorSpaceId; label: string; hint: string }[] = [
  { value: 'yuv', label: 'YUV', hint: '明度单独成通道，色团最紧凑（实验综合冠军）' },
  { value: 'lab', label: 'Lab', hint: '感知均匀，精度最高的空间' },
  { value: 'weightedRgb', label: '加权RGB', hint: '0.3/0.59/0.11 加权，原版工具的度量空间' },
  { value: 'rgb', label: 'RGB', hint: '不加权，仅作对照' },
]

/** 距离算法。实验结论：曼哈顿拆色最低，欧氏精度最高；切比雪夫/余弦出局但保留作对照 */
export type DistanceId = 'euclidean' | 'manhattan' | 'minkowski3' | 'chebyshev' | 'cosine'

export const DISTANCES: { value: DistanceId; label: string; hint: string }[] = [
  { value: 'manhattan', label: '曼哈顿', hint: 'L1，抗「花」能力最强' },
  { value: 'euclidean', label: '欧氏', hint: 'L2，精度最高的距离' },
  { value: 'minkowski3', label: '闵氏3', hint: 'p=3，介于 L1 与 L2 之间' },
  { value: 'chebyshev', label: '切比雪夫', hint: 'L∞，仅看最大通道差' },
  { value: 'cosine', label: '余弦', hint: '只看方向不看明暗，容易丢暗部' },
]

/** RGB(0-255) → 目标空间坐标 */
export function toSpace(rgb: RGB, space: ColorSpaceId): [number, number, number] {
  const [r, g, b] = rgb
  switch (space) {
    case 'lab':
      return rgbToLab(rgb)
    case 'yuv': {
      const y = 0.299 * r + 0.587 * g + 0.114 * b
      return [y, 0.492 * (b - y), 0.877 * (r - y)]
    }
    case 'weightedRgb':
      // 权重开方后乘进通道：之后任何 p-范数的「欧氏」格都精确等于原版 0.3/0.59/0.11 加权公式
      return [0.547723 * r, 0.768115 * g, 0.331662 * b]
    case 'rgb':
      return [r, g, b]
  }
}

function distanceOf(
  a: readonly [number, number, number],
  b: readonly [number, number, number],
  kind: DistanceId,
): number {
  const dx = a[0] - b[0]
  const dy = a[1] - b[1]
  const dz = a[2] - b[2]
  switch (kind) {
    case 'euclidean':
      return Math.sqrt(dx * dx + dy * dy + dz * dz)
    case 'manhattan':
      return Math.abs(dx) + Math.abs(dy) + Math.abs(dz)
    case 'chebyshev':
      return Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz))
    case 'minkowski3':
      return Math.cbrt(dx * dx * dx + dy * dy * dy + dz * dz * dz)
    case 'cosine': {
      const na = Math.hypot(a[0], a[1], a[2])
      const nb = Math.hypot(b[0], b[1], b[2])
      if (na < 1e-9 && nb < 1e-9) return 0
      if (na < 1e-9 || nb < 1e-9) return 1
      return 1 - (a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) / (na * nb)
    }
  }
}

// ================================================================ 目标色提取

export interface TargetSample {
  rgb: RGB
  lab: RGB
  /** 该颜色在图案中出现的次数，用作权重 */
  count: number
  /**
   * 分桶合并时，桶内原始颜色的精确 key（r<<16|g<<8|b）。
   * 出图纸的强制分配按精确 key 查表，分桶后不能只留桶均值。
   */
  keys?: number[]
}

export interface TargetSourceInfo {
  samples: TargetSample[]
  uniqueColors: number
  pixels: number
  /** 为控制规模而启用的合并桶大小，0 表示未合并 */
  bucket: number
}

/**
 * 从规范化结果里提取优化目标色。
 * 按精确 RGB 分组，每个目标带出现次数权重。
 *
 * 颜色数超过 maxTargets 时按 RGB 桶合并（照片类素材的性能闸）：
 * 桶均值作为目标色，桶内成员的精确 key 一并带下去，最终分配仍按精确色查表。
 */
export function targetsFromPixmap(
  img: Pixmap,
  options: { maxTargets?: number; ignoreTransparent?: boolean } = {},
): TargetSourceInfo {
  const maxTargets = options.maxTargets ?? 2500
  const ignoreTransparent = options.ignoreTransparent ?? true
  const d = img.data

  const allAcc = new Map<number, { r: number; g: number; b: number; count: number }>()
  let countedPixels = 0

  for (let i = 0; i < d.length; i += 4) {
    if (ignoreTransparent && d[i + 3] < 8) continue
    countedPixels++
    const key = (d[i] << 16) | (d[i + 1] << 8) | d[i + 2]
    const acc = allAcc.get(key)
    if (acc) acc.count++
    else allAcc.set(key, { r: d[i], g: d[i + 1], b: d[i + 2], count: 1 })
  }

  const uniqueColors = allAcc.size
  const exact = (a: { r: number; g: number; b: number; count: number }): TargetSample => ({
    rgb: [a.r, a.g, a.b],
    lab: rgbToLab([a.r, a.g, a.b]),
    count: a.count,
  })

  if (uniqueColors <= maxTargets) {
    return {
      samples: [...allAcc.values()].map(exact),
      uniqueColors,
      pixels: countedPixels,
      bucket: 0,
    }
  }

  // 照片类：按 RGB 均匀桶合并。桶均值是代表色，成员精确 key 全部记录，
  // 最终分配时每个成员都按「桶的豆」落子 —— 同桶强制同豆。
  let bucket = 2
  while (bucket <= 128) {
    const merged = new Map<number, { r: number; g: number; b: number; count: number; keys: number[] }>()
    for (const [key, a] of allAcc) {
      const qr = Math.floor(a.r / bucket)
      const qg = Math.floor(a.g / bucket)
      const qb = Math.floor(a.b / bucket)
      const bkey = (qr << 16) | (qg << 8) | qb
      const m = merged.get(bkey)
      if (m) {
        m.r += a.r * a.count
        m.g += a.g * a.count
        m.b += a.b * a.count
        m.count += a.count
        m.keys.push(key)
      } else {
        merged.set(bkey, { r: a.r * a.count, g: a.g * a.count, b: a.b * a.count, count: a.count, keys: [key] })
      }
    }
    if (merged.size <= maxTargets) {
      const samples = [...merged.values()].map((m) => ({
        rgb: [m.r / m.count, m.g / m.count, m.b / m.count] as RGB,
        lab: rgbToLab([m.r / m.count, m.g / m.count, m.b / m.count]),
        count: m.count,
        keys: m.keys,
      }))
      return { samples, uniqueColors, pixels: countedPixels, bucket }
    }
    bucket *= 2
  }

  // 极端情况：按出现次数取前 maxTargets 个
  const sorted = [...allAcc.entries()].sort((a, b) => b[1].count - a[1].count).slice(0, maxTargets)
  return {
    samples: sorted.map(([, a]) => ({ ...exact(a), keys: [sortedKey(a)] })),
    uniqueColors,
    pixels: countedPixels,
    bucket: -1,
  }

  function sortedKey(a: { r: number; g: number; b: number }): number {
    return (a.r << 16) | (a.g << 8) | a.b
  }
}

// ================================================================ 配置

/** 聚类空间。与匹配空间解耦：实验室终审 = YUV 聚类 + Lab 匹配 */
export type ClusterSpaceId = ColorSpaceId

export interface OptimizeConfig {
  /** 颜料预算：最终要选多少种拼豆颜色（kMode = auto 时是上限） */
  k: number
  /**
   * 预算模式。
   * - `fixed`：就用 `k` 色（没用的位置不硬凑）。
   * - `auto`：贪心扫描「多一颗豆还能降多少 ΔE」的曲线，收益低于 minGain 即停 —— 拐点。
   */
  kMode: 'fixed' | 'auto'
  /** 匹配用的色彩空间（簇均色 → 豆的距离在这算） */
  colorSpace: ColorSpaceId
  /** 匹配用的距离算法 */
  distance: DistanceId
  /** 球覆盖聚类用的色彩空间（源色分团在这算） */
  clusterSpace: ClusterSpaceId
  /**
   * 球覆盖聚类半径（聚类空间的单位）。
   * 半径内的源色归一个球，整球强制同豆 —— 这是「不花」的来源。
   * 0 = 不聚类，每个源色独立找最近豆（最忠实但会花）。
   */
  clusterRadius: number
  /** 固定包含 MARD 黑白（H02 / H07），不占 K 预算 */
  mandatory: boolean
  /** 自动色数：每多一颗豆至少要降这么多（每格加权 ΔE），否则视为拐点 */
  minGain: number
}

/** 默认配置 = quant-lab 12 张存档批量终审冠军：YUV 聚类 r9 → Lab 欧氏，拐点 0.02，不强制黑白 */
export const DEFAULT_OPTIMIZE_CONFIG: OptimizeConfig = {
  k: 30,
  kMode: 'auto',
  colorSpace: 'lab',
  distance: 'euclidean',
  clusterSpace: 'yuv',
  clusterRadius: 9,
  mandatory: false,
  minGain: 0.02,
}

export const MANDATORY_MARD = ['H02', 'H07']

// ================================================================ 球覆盖聚类

/**
 * 贪心密度球覆盖。
 * 每轮取「罩住加权点数最多」的球（球心候选 = 剩余点），球心向罩内加权质心爬坡
 * （罩住的权重不降才接受），罩住的点归同簇后删除，直到覆盖完。
 *
 * 一个球罩住的就是一个团 —— 不会把连续色带拆成两半，也不会把小团吞进大团。
 */
function ballCover(
  pts: Float64Array, // n*3
  w: Float64Array,
  r: number,
): Int32Array {
  const n = w.length
  const labels = new Int32Array(n).fill(-1)
  const active = new Uint8Array(n).fill(1)
  let nActive = n
  let next = 0

  while (nActive > 0) {
    // 最优球心必在某个点上：逐点算「以我为心能罩多少权重」
    let bestScore = -1
    let bestInside: Uint8Array | null = null
    for (let c = 0; c < n; c++) {
      if (!active[c]) continue
      const cx = pts[c * 3]
      const cy = pts[c * 3 + 1]
      const cz = pts[c * 3 + 2]
      let score = 0
      const inside = new Uint8Array(n)
      for (let i = 0; i < n; i++) {
        if (!active[i]) continue
        const dx = pts[i * 3] - cx
        const dy = pts[i * 3 + 1] - cy
        const dz = pts[i * 3 + 2] - cz
        if (dx * dx + dy * dy + dz * dz <= r * r) {
          inside[i] = 1
          score += w[i]
        }
      }
      if (score > bestScore) {
        bestScore = score
        bestInside = inside
      }
    }

    // 爬坡：球心移向罩内点的加权质心，罩住的权重不降才接受（保证单调）
    let inside = bestInside!
    let cur = bestScore
    for (let climb = 0; climb < 20; climb++) {
      let ws = 0
      let mx = 0
      let my = 0
      let mz = 0
      for (let i = 0; i < n; i++) {
        if (!inside[i]) continue
        ws += w[i]
        mx += pts[i * 3] * w[i]
        my += pts[i * 3 + 1] * w[i]
        mz += pts[i * 3 + 2] * w[i]
      }
      if (ws <= 0) break
      const nx = mx / ws
      const ny = my / ws
      const nz = mz / ws
      let score = 0
      const moved = new Uint8Array(n)
      for (let i = 0; i < n; i++) {
        if (!active[i]) continue
        const dx = pts[i * 3] - nx
        const dy = pts[i * 3 + 1] - ny
        const dz = pts[i * 3 + 2] - nz
        if (dx * dx + dy * dy + dz * dz <= r * r) {
          moved[i] = 1
          score += w[i]
        }
      }
      if (score <= cur + 1e-9) break
      inside = moved
      cur = score
    }

    for (let i = 0; i < n; i++) {
      if (inside[i]) {
        labels[i] = next
        active[i] = 0
        nActive--
      }
    }
    next++
  }
  return labels
}

// ================================================================ 统计

export interface OptimizeStats {
  min: number
  max: number
  avg: number
  weightedAvg: number
  /** 按像素数加权的 95 分位 ΔE */
  p95?: number
  /** ΔE 超过 HOT_DE 的像素占比（0~1） */
  hotRatio?: number
}

/** 「这一格已经明显不对了」的门槛：ΔE76 ≥ 8 大致是一眼能看出来的量级 */
export const HOT_DE = 8

export type TargetMode = 'grid' | 'library'

export type OptimizeEvent =
  | {
      type: 'initialized'
      stats: OptimizeStats
      selected: number[]
      candidates: number
      /** 本次实际用的色数（kMode = auto 时是自动选出来的，不是配置里的 k） */
      budget: number
      /** 自动模式的「色数 → 加权 ΔE」曲线，供 UI 画拐点 */
      curve?: { k: number; deltaE: number }[]
    }
  | {
      type: 'progress'
      step: number
      totalSteps: number
      stats: OptimizeStats
      temperature: number
      progress: number
      selected: number[]
    }
  | {
      type: 'completed'
      stats: OptimizeStats
      selected: number[]
      /**
       * 每个源色最终落到哪颗豆（key = 源色精确 RGB 数值）。
       * 簇内强制同豆：同一片颜色的所有源色都指向同一颗豆。
       */
      mapping: { key: number; hex: string }[]
      steps: number
      reason: 'finished' | 'knee' | 'stopped'
      /** 真正用上的色数（含固定色号） */
      budget: number
      /** 兼容字段，新算法没有层次损失，恒为 0 */
      contrast: number
    }

// ================================================================ 优化器

/**
 * 调色板优化器（新管线）：
 *
 *   源色 → 目标空间 → 球覆盖聚类（整球同豆）→ 簇加权均色
 *        → 贪心 k-median 选豆（+ 交换精修）→ 每簇一颗豆
 *
 * 确定性算法：没有随机初始化、没有退火，同样输入永远得到同样结果。
 * 统计一律用 Lab ΔE76 报告 —— 与匹配用的度量无关，两套方案可直接比较。
 */
export class PaletteOptimizer {
  entries: PaletteEntry[]
  config: OptimizeConfig
  targetMode: TargetMode

  private samples: TargetSample[] = []
  /** 聚类空间坐标（只喂球覆盖） */
  private pts: Float64Array = new Float64Array(0)
  /** 匹配空间坐标（簇均色与选豆距离在这算） */
  private matchPts: Float64Array = new Float64Array(0)
  private weights = new Float64Array(0)
  private weightSum = 0
  /** 源色的精确 key（r<<16|g<<8|b），出图纸的强制分配按它查表 */
  private sourceKeys: number[] = []
  /** 簇标签（clusterRadius = 0 时每源色一簇） */
  private labels: Int32Array<ArrayBufferLike> = new Int32Array(0)
  private nClusters = 0
  /** 簇加权均色（目标空间） */
  private clusterMean: Float64Array = new Float64Array(0)
  /** 簇 × 候选豆 距离 */
  private dist = new Float64Array(0)
  /** 固定豆（黑白） */
  private fixed: number[] = []

  constructor(entries: PaletteEntry[], config: OptimizeConfig, targetMode: TargetMode = 'grid') {
    this.entries = entries
    this.config = config
    this.targetMode = targetMode
    if (config.mandatory) {
      for (let i = 0; i < entries.length; i++) {
        const mard = entries[i].codes.MARD
        if (mard && MANDATORY_MARD.includes(mard)) this.fixed.push(i)
      }
    }
  }

  setTargets(samples: TargetSample[]): void {
    this.samples = samples
    const n = samples.length
    const clusterSpace = this.config.clusterSpace
    const matchSpace = this.config.colorSpace
    this.pts = new Float64Array(n * 3)
    this.matchPts = new Float64Array(n * 3)
    this.weights = new Float64Array(n)
    this.weightSum = 0
    this.sourceKeys = new Array(n)
    for (let i = 0; i < n; i++) {
      const cp = toSpace(samples[i].rgb, clusterSpace)
      this.pts[i * 3] = cp[0]
      this.pts[i * 3 + 1] = cp[1]
      this.pts[i * 3 + 2] = cp[2]
      const mp = toSpace(samples[i].rgb, matchSpace)
      this.matchPts[i * 3] = mp[0]
      this.matchPts[i * 3 + 1] = mp[1]
      this.matchPts[i * 3 + 2] = mp[2]
      this.weights[i] = Math.max(1, samples[i].count)
      this.weightSum += this.weights[i]
      const [r, g, b] = samples[i].rgb
      this.sourceKeys[i] =
        (Math.min(255, Math.max(0, Math.round(r))) << 16) |
        (Math.min(255, Math.max(0, Math.round(g))) << 8) |
        Math.min(255, Math.max(0, Math.round(b)))
    }

    // 球覆盖聚类；半径 0 = 不聚类
    const r = this.config.clusterRadius
    if (r > 0 && n > 1) {
      this.labels = ballCover(this.pts, this.weights, r)
    } else {
      this.labels = new Int32Array(n)
      for (let i = 0; i < n; i++) this.labels[i] = i
    }
    this.nClusters = n ? Math.max(...this.labels) + 1 : 0

    // 簇加权均色（匹配空间坐标）
    this.clusterMean = new Float64Array(this.nClusters * 3)
    const cw = new Float64Array(this.nClusters)
    for (let i = 0; i < n; i++) {
      const c = this.labels[i]
      cw[c] += this.weights[i]
      for (let d = 0; d < 3; d++) this.clusterMean[c * 3 + d] += this.matchPts[i * 3 + d] * this.weights[i]
    }
    for (let c = 0; c < this.nClusters; c++) {
      for (let d = 0; d < 3; d++) this.clusterMean[c * 3 + d] /= cw[c] || 1
    }

    // 簇 × 候选豆 距离矩阵（匹配空间 + 匹配距离算法）
    const C = this.entries.length
    this.dist = new Float64Array(this.nClusters * C)
    const meanBuf: [number, number, number] = [0, 0, 0]
    for (let c = 0; c < this.nClusters; c++) {
      meanBuf[0] = this.clusterMean[c * 3]
      meanBuf[1] = this.clusterMean[c * 3 + 1]
      meanBuf[2] = this.clusterMean[c * 3 + 2]
      for (let j = 0; j < C; j++) {
        const jp = toSpace(this.entries[j].rgb, matchSpace)
        this.dist[c * C + j] = distanceOf(meanBuf, jp, this.config.distance)
      }
    }
  }

  stop(): void {
    this.stopped = true
  }

  get isRunning(): boolean {
    return this.running
  }

  private running = false
  private stopped = false

  /** 每簇到当前选豆的最近距离 */
  private nearestOf(selected: number[]): { d: Float64Array; idx: Int32Array } {
    const T = this.nClusters
    const d = new Float64Array(T).fill(Infinity)
    const idx = new Int32Array(T).fill(-1)
    for (let c = 0; c < T; c++) {
      for (const j of selected) {
        const v = this.dist[c * this.entries.length + j]
        if (v < d[c]) {
          d[c] = v
          idx[c] = j
        }
      }
      if (idx[c] < 0) d[c] = 0
    }
    return { d, idx }
  }

  /**
   * 贪心 k-median：每轮加「能把加权 ΔE 拉低最多」的那颗豆。
   * fixed 模式：加到 k 颗或收益耗尽为止；auto 模式：收益低于 minGain 即拐点，提前停。
   */
  private greedy(k: number): { selected: number[]; curve: { k: number; deltaE: number }[]; reason: 'finished' | 'knee' } {
    const C = this.entries.length
    const T = this.nClusters
    const selected = [...this.fixed]
    const cur = new Float64Array(T).fill(Infinity)
    const inState = new Uint8Array(C)
    for (const j of selected) {
      inState[j] = 1
      for (let c = 0; c < T; c++) cur[c] = Math.min(cur[c], this.dist[c * C + j])
    }

    const curve: { k: number; deltaE: number }[] = []
    const pushCurve = () => {
      let sum = 0
      for (let c = 0; c < T; c++) {
        if (!Number.isFinite(cur[c])) return false // 还有簇没豆：曲线从第一颗豆后才开始记
        sum += cur[c] * this.weights[c]
      }
      curve.push({ k: selected.length, deltaE: sum / (this.weightSum || 1) })
      return true
    }

    // 没有固定豆时先挑「加权距离和最小」的那颗，否则增益全是 Infinity 比不出大小
    if (!selected.length && T > 0) {
      let bestJ = 0
      let bestScore = Infinity
      for (let j = 0; j < C; j++) {
        let sum = 0
        for (let c = 0; c < T; c++) sum += this.dist[c * C + j] * this.weights[c]
        if (sum < bestScore) {
          bestScore = sum
          bestJ = j
        }
      }
      selected.push(bestJ)
      inState[bestJ] = 1
      for (let c = 0; c < T; c++) cur[c] = this.dist[c * C + bestJ]
    }
    pushCurve()

    let reason: 'finished' | 'knee' = 'finished'
    while (selected.length < k + this.fixed.length) {
      let bestJ = -1
      let bestGain = 0
      for (let j = 0; j < C; j++) {
        if (inState[j]) continue
        let gain = 0
        for (let c = 0; c < T; c++) {
          const v = this.dist[c * C + j]
          if (v < cur[c]) gain += (cur[c] - v) * this.weights[c]
        }
        if (gain > bestGain) {
          bestGain = gain
          bestJ = j
        }
      }
      if (bestJ < 0) break // 没有任何豆能改进：剩下的名额都是空位，不硬凑
      // auto 模式下收益低于 minGain（每格加权 ΔE）就是「白备一颗豆」—— 拐点
      if (this.config.kMode === 'auto' && bestGain / (this.weightSum || 1) < this.config.minGain) {
        reason = 'knee'
        break
      }
      for (let c = 0; c < T; c++) {
        const v = this.dist[c * C + bestJ]
        if (v < cur[c]) cur[c] = v
      }
      selected.push(bestJ)
      inState[bestJ] = 1
      pushCurve()
    }
    return { selected, curve, reason }
  }

  /**
   * 交换精修：逐颗尝试把选中的豆换成没选的，接受加权 ΔE 下降最多的交换。
   * 确定性的局部搜索，贪心解通常还能再压一点。
   */
  private polish(selected: number[], passes: number): number[] {
    const cur = [...selected]
    for (let pass = 0; pass < passes; pass++) {
      let improved = false
      for (let p = this.fixed.length; p < cur.length; p++) {
        const without = cur.filter((_, i) => i !== p)
        let bestJ = -1
        let bestDe = this.weightedDeltaE(without, null)
        for (let j = 0; j < this.entries.length; j++) {
          if (cur.includes(j)) continue
          const de = this.weightedDeltaE(without, j)
          if (de < bestDe - 1e-9) {
            bestDe = de
            bestJ = j
          }
        }
        if (bestJ >= 0) {
          cur[p] = bestJ
          improved = true
        }
      }
      if (!improved) break
    }
    return cur
  }

  /** 给定豆集合（可选带一颗试用豆）的加权 ΔE（簇均色层面）。没豆的簇 = Infinity，拆豆绝不免费 */
  private weightedDeltaE(beads: number[], trial: number | null): number {
    const C = this.entries.length
    let sum = 0
    for (let c = 0; c < this.nClusters; c++) {
      let best = Infinity
      for (const j of beads) best = Math.min(best, this.dist[c * C + j])
      if (trial !== null) best = Math.min(best, this.dist[c * C + trial])
      sum += best * this.weights[c]
    }
    return sum / (this.weightSum || 1)
  }

  /** 按「图上真实的每一格」统计误差 —— Lab ΔE76，与匹配用的度量无关 */
  private statsOf(rows: { d: number; count: number }[]): OptimizeStats {
    if (!rows.length) return { min: 0, max: 0, avg: 0, weightedAvg: 0, p95: 0, hotRatio: 0 }
    let min = Infinity
    let max = 0
    let sum = 0
    let wsum = 0
    let wtot = 0
    for (const r of rows) {
      const w = Math.max(1, r.count)
      if (r.d < min) min = r.d
      if (r.d > max) max = r.d
      sum += r.d
      wsum += r.d * w
      wtot += w
    }
    const sorted = rows.slice().sort((a, b) => a.d - b.d)
    const target = wtot * 0.95
    let acc = 0
    let picked = false
    let p95 = max
    let hot = 0
    for (const r of sorted) {
      const w = Math.max(1, r.count)
      acc += w
      if (!picked && acc >= target) {
        p95 = r.d
        picked = true
      }
      if (r.d > HOT_DE) hot += w
    }
    return { min, max, avg: sum / rows.length, weightedAvg: wsum / wtot, p95, hotRatio: hot / wtot }
  }

  /** 最终图纸分配：每个源色 → 它所在簇的豆（整簇同豆），ΔE 用 Lab ΔE76 报告 */
  private finalAssignment(selected: number[]): {
    rows: { d: number; count: number }[]
    mapping: { key: number; hex: string }[]
  } {
    const { idx } = this.nearestOf(selected)
    const rows: { d: number; count: number }[] = []
    const mapping: { key: number; hex: string }[] = []
    for (let i = 0; i < this.samples.length; i++) {
      const c = this.labels[i]
      const bead = idx[c]
      if (bead < 0) continue
      const hex = this.entries[bead].hex
      const dLab = Math.hypot(
        this.samples[i].lab[0] - this.entries[bead].lab[0],
        this.samples[i].lab[1] - this.entries[bead].lab[1],
        this.samples[i].lab[2] - this.entries[bead].lab[2],
      )
      const keys = this.samples[i].keys ?? [this.sourceKeys[i]]
      for (const key of keys) {
        rows.push({ d: dLab, count: this.samples[i].count / keys.length })
        mapping.push({ key, hex })
      }
    }
    return { rows, mapping }
  }

  private resultSelection(selected: number[]): number[] {
    const used = new Set<number>()
    for (const j of selected) if (this.fixed.includes(j)) used.add(j)
    const { idx } = this.nearestOf(selected)
    for (let c = 0; c < this.nClusters; c++) if (idx[c] >= 0) used.add(idx[c])
    return [...used].sort((a, b) => {
      const ca = this.entries[a].codes.MARD ?? ''
      const cb = this.entries[b].codes.MARD ?? ''
      return ca.localeCompare(cb, undefined, { numeric: true })
    })
  }

  async *run(): AsyncGenerator<OptimizeEvent> {
    this.running = true
    this.stopped = false

    const progressEvent = (progress: number, selected: number[]): OptimizeEvent => {
      const { d } = this.nearestOf(selected)
      let sum = 0
      for (let c = 0; c < this.nClusters; c++) sum += d[c] * this.weights[c]
      return {
        type: 'progress',
        step: Math.round(progress),
        totalSteps: 100,
        stats: { min: 0, max: 0, avg: 0, weightedAvg: this.weightSum ? sum / this.weightSum : 0 },
        temperature: 0,
        progress,
        selected: [...selected],
      }
    }

    if (!this.nClusters || !this.entries.length) {
      this.running = false
      yield {
        type: 'completed',
        stats: { min: 0, max: 0, avg: 0, weightedAvg: 0 },
        selected: [],
        mapping: [],
        steps: 0,
        reason: 'finished',
        budget: 0,
        contrast: 0,
      }
      return
    }

    // 自动模式：k 只是上限，拐点处提前停
    const cap = Math.min(this.config.k, this.nClusters)
    const { selected: greedySel, curve, reason } = this.greedy(cap)

    yield {
      type: 'initialized',
      stats: { min: 0, max: 0, avg: 0, weightedAvg: curve[0]?.deltaE ?? 0 },
      selected: [...greedySel],
      candidates: this.entries.length,
      budget: greedySel.length,
      curve,
    }
    yield progressEvent(30, greedySel)
    await new Promise((resolve) => setTimeout(resolve, 0))

    // 交换精修：实验室用 ILP 精确解，贪心解不做局部搜索够不着它的质量
    let selected = greedySel
    if (!this.stopped) {
      const passes = this.nClusters > 800 ? 1 : 3
      const polished = this.polish(greedySel, passes)
      if (this.weightedDeltaE(polished, null) < this.weightedDeltaE(greedySel, null) - 1e-9) {
        selected = polished
      }
    }
    yield progressEvent(80, selected)
    await new Promise((resolve) => setTimeout(resolve, 0))

    if (this.stopped) {
      this.running = false
      const { rows, mapping } = this.finalAssignment(selected)
      yield {
        type: 'completed',
        stats: this.statsOf(rows),
        selected: this.resultSelection(selected),
        mapping,
        steps: 100,
        reason: 'stopped',
        budget: this.resultSelection(selected).length,
        contrast: 0,
      }
      return
    }

    const { rows, mapping } = this.finalAssignment(selected)
    const finalSelected = this.resultSelection(selected)
    this.running = false
    yield {
      type: 'completed',
      stats: this.statsOf(rows),
      selected: finalSelected,
      mapping,
      steps: 100,
      reason,
      budget: finalSelected.length,
      contrast: 0,
    }
  }
}
