import { deltaE, rgbToLab } from './color.ts'
import type { PaletteEntry } from './palette.ts'
import type { RGB, Pixmap } from './types.ts'

export interface TargetSample {
  rgb: RGB
  lab: RGB
  /** 该颜色在图案中出现的次数，用作权重 */
  count: number
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
 * 优先按精确 RGB 分组（像素画通常是有限色集）；
 * 若颜色过多（例如照片对齐），逐步加大分桶以把目标数压到 maxTargets 以内。
 * 每个目标带出现次数权重，保证「优化目标」偏向图案里真正占面积的颜色。
 */
export function targetsFromPixmap(
  img: Pixmap,
  options: { maxTargets?: number; ignoreTransparent?: boolean } = {},
): TargetSourceInfo {
  const maxTargets = options.maxTargets ?? 1200
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
  if (uniqueColors <= maxTargets) {
    return {
      samples: [...allAcc.values()].map((a) => ({
        rgb: [a.r, a.g, a.b] as RGB,
        lab: rgbToLab([a.r, a.g, a.b]),
        count: a.count,
      })),
      uniqueColors,
      pixels: countedPixels,
      bucket: 0,
    }
  }

  let bucket = 2
  while (bucket <= 128) {
    const merged = new Map<number, { r: number; g: number; b: number; count: number }>()
    for (const a of allAcc.values()) {
      const qr = Math.floor(a.r / bucket)
      const qg = Math.floor(a.g / bucket)
      const qb = Math.floor(a.b / bucket)
      const key = (qr << 16) | (qg << 8) | qb
      const m = merged.get(key)
      if (m) {
        m.r += a.r * a.count
        m.g += a.g * a.count
        m.b += a.b * a.count
        m.count += a.count
      } else {
        merged.set(key, { r: a.r * a.count, g: a.g * a.count, b: a.b * a.count, count: a.count })
      }
    }
    if (merged.size <= maxTargets) {
      const samples = [...merged.values()].map((m) => {
        const rgb: RGB = [m.r / m.count, m.g / m.count, m.b / m.count]
        return { rgb, lab: rgbToLab(rgb), count: m.count }
      })
      return { samples, uniqueColors, pixels: countedPixels, bucket }
    }
    bucket *= 2
  }

  // 极端情况：按出现次数取前 maxTargets 个
  const sorted = [...allAcc.values()].sort((a, b) => b.count - a.count).slice(0, maxTargets)
  return {
    samples: sorted.map((a) => ({
      rgb: [a.r, a.g, a.b] as RGB,
      lab: rgbToLab([a.r, a.g, a.b]),
      count: a.count,
    })),
    uniqueColors,
    pixels: countedPixels,
    bucket: -1,
  }
}

export interface OptimizeConfig {
  /** 颜料预算：最终要选多少种拼豆颜色 */
  k: number
  steps: number
  patience: number
  seed: number
  t0: number
  alpha: number
  /** avg = 平均 ΔE 最优；max = 最坏情况（最大 ΔE）最优 */
  objective: 'avg' | 'max'
  /** 是否按颜色出现次数加权 */
  weighted: boolean
  /**
   * 对比惩罚权重（0 = 关闭，和旧版只看 ΔE 一样）。
   * 同一颗豆被用来表示原本差得很远的颜色时要罚分 ——
   * 否则候选色很少时，把颜色「压平」到一颗豆反而是平均 ΔE 最低的解。
   */
  contrast: number
  /** 对比惩罚的死区（ΔE）：组内差别在这个范围内，合并了也不算丢对比 */
  contrastTolerance: number
  /** 固定包含 MARD 黑白（H02 / H07），与旧工具一致 */
  mandatory: boolean
  /** 用贪心最远点做初始解（比随机初始解明显更好） */
  greedyInit: boolean
  /** 退火后做一轮贪心替换精修 */
  polish: boolean
}

export const DEFAULT_OPTIMIZE_CONFIG: OptimizeConfig = {
  k: 30,
  steps: 60000,
  patience: 5000,
  seed: 42,
  t0: 20,
  alpha: 0.9995,
  objective: 'avg',
  weighted: true,
  contrast: 1,
  contrastTolerance: 5,
  mandatory: true,
  greedyInit: true,
  polish: true,
}

export const MANDATORY_MARD = ['H02', 'H07']

export interface OptimizeStats {
  min: number
  max: number
  avg: number
  weightedAvg: number
}

export type OptimizeEvent =
  | { type: 'initialized'; stats: OptimizeStats; selected: number[]; candidates: number }
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
      steps: number
      reason: 'finished' | 'early-exit' | 'stopped'
    }

/** 线性同余随机数生成器：与旧工具同参数，保证相同种子得到相同结果 */
class RandomGenerator {
  private seed: number
  constructor(seed: number) {
    this.seed = seed
  }
  random(): number {
    this.seed = (this.seed * 9301 + 49297) % 233280
    return this.seed / 233280
  }
  int(min: number, max: number): number {
    return Math.floor(min + this.random() * (max - min))
  }
}

export type TargetMode = 'grid' | 'library'

/**
 * 调色板优化器。
 *
 * 与旧实现的关键差别：最近色距离做了增量维护 ——
 * 交换一个颜色时，只有「最近色正好是被移除的那个」的目标需要重算，
 * 其余目标只需检查新颜色是否更近。语义完全等价，但每步从 O(T·K) 降到接近 O(T)。
 */
export class PaletteOptimizer {
  entries: PaletteEntry[]
  config: OptimizeConfig
  targetMode: TargetMode

  private random: RandomGenerator
  private t = 0
  private c = 0
  private dist = new Float64Array(0)
  private weights = new Float64Array(0)
  private weightSum = 0
  /** √出现次数：对比惩罚用的权重（不做面积折扣，见 contrastPenaltyOf） */
  private sqrtWeights = new Float64Array(0)
  private sqrtWeightSum = 0
  /** 目标色的 Lab（对比惩罚要按组心算偏差） */
  private labs = new Float64Array(0)
  private groupW = new Float64Array(0)
  private groupMean = new Float64Array(0)
  private groupDev = new Float64Array(0)
  private contrastWeight = 0
  private contrastTolerance = 0

  private selected: number[] = []
  private inState = new Uint8Array(0)
  private nearestD = new Float64Array(0)
  private nearestI = new Int32Array(0)
  private scratchD = new Float64Array(0)
  private scratchI = new Int32Array(0)

  private fixed = new Set<number>()
  private running = false
  private bestSelected: number[] = []

  constructor(entries: PaletteEntry[], config: OptimizeConfig, targetMode: TargetMode = 'grid') {
    this.entries = entries
    this.config = config
    this.targetMode = targetMode
    this.random = new RandomGenerator(config.seed)
    this.c = entries.length

    if (config.mandatory) {
      for (let i = 0; i < entries.length; i++) {
        const mard = entries[i].codes.MARD
        if (mard && MANDATORY_MARD.includes(mard)) this.fixed.add(i)
      }
    }
  }

  setTargets(samples: TargetSample[]): void {
    this.t = samples.length
    this.weights = new Float64Array(this.t)
    this.labs = new Float64Array(this.t * 3)
    this.sqrtWeights = new Float64Array(this.t)
    this.weightSum = 0
    this.sqrtWeightSum = 0
    for (let i = 0; i < this.t; i++) {
      const w = Math.max(1, samples[i].count)
      this.weights[i] = w
      this.weightSum += w
      const sw = Math.sqrt(w)
      this.sqrtWeights[i] = sw
      this.sqrtWeightSum += sw
      this.labs[i * 3] = samples[i].lab[0]
      this.labs[i * 3 + 1] = samples[i].lab[1]
      this.labs[i * 3 + 2] = samples[i].lab[2]
    }

    this.dist = new Float64Array(this.t * this.c)
    for (let i = 0; i < this.t; i++) {
      const lab = samples[i].lab
      const base = i * this.c
      for (let j = 0; j < this.c; j++) {
        this.dist[base + j] = deltaE(lab, this.entries[j].lab)
      }
    }

    this.nearestD = new Float64Array(this.t)
    this.nearestI = new Int32Array(this.t)
    this.scratchD = new Float64Array(this.t)
    this.scratchI = new Int32Array(this.t)
    this.inState = new Uint8Array(this.c)
    this.groupW = new Float64Array(this.c)
    this.groupMean = new Float64Array(this.c * 3)
    this.groupDev = new Float64Array(this.c)
    // 老存档里的配置没有这两个字段，缺省按默认走
    this.contrastWeight = Number.isFinite(this.config.contrast) ? Math.max(0, this.config.contrast) : DEFAULT_OPTIMIZE_CONFIG.contrast
    this.contrastTolerance = Number.isFinite(this.config.contrastTolerance)
      ? Math.max(0, this.config.contrastTolerance)
      : DEFAULT_OPTIMIZE_CONFIG.contrastTolerance
  }

  /**
   * 对比惩罚：每颗豆下面挂着的原始颜色如果彼此差得远，就要罚。
   *
   * 算法：按「豆」把目标色分组，算每组的加权标准差（Lab 空间的 RMS 偏差），
   * 减掉死区（同色系细微差别不算丢对比）后按组权重加权平均。
   * 只看分组、不看具体选了哪颗豆 —— 匹配得好不好由 ΔE 那一项负责。
   *
   * 这里用 √出现次数 当权重，而不是出现次数本身：
   * 对比是「看得见 / 看不见」的问题，几颗豆的红点被压成棕色，
   * 平均 ΔE 几乎不动，但成品上就是少了一处颜色，所以小面积不能按面积打折。
   */
  contrastPenaltyOf(assignment: Int32Array = this.nearestI): number {
    if (this.contrastWeight <= 0 || this.t === 0) return 0
    const gw = this.groupW
    const gm = this.groupMean
    const gd = this.groupDev
    const sw = this.sqrtWeights
    gw.fill(0)
    gm.fill(0)
    gd.fill(0)

    for (let i = 0; i < this.t; i++) {
      const j = assignment[i]
      if (j < 0) continue
      const w = sw[i]
      const b = i * 3
      const g = j * 3
      const x = this.labs[b]
      const y = this.labs[b + 1]
      const z = this.labs[b + 2]
      gw[j] += w
      gm[g] += x * w
      gm[g + 1] += y * w
      gm[g + 2] += z * w
      gd[j] += (x * x + y * y + z * z) * w
    }

    let penalty = 0
    for (let j = 0; j < this.c; j++) {
      const w = gw[j]
      if (w <= 0) continue
      const g = j * 3
      const mx = gm[g] / w
      const my = gm[g + 1] / w
      const mz = gm[g + 2] / w
      const variance = Math.max(0, gd[j] / w - (mx * mx + my * my + mz * mz))
      // 死区：组内差别小于 contrastTolerance 的合并不算「丢失对比」
      const excess = Math.max(0, Math.sqrt(variance) - this.contrastTolerance)
      if (excess > 0) penalty += w * excess
    }

    return this.sqrtWeightSum > 0 ? penalty / this.sqrtWeightSum : 0
  }

  stop(): void {
    this.running = false
  }

  get isRunning(): boolean {
    return this.running
  }

  /**
   * 目标函数 = 匹配误差（平均或最坏 ΔE）+ 对比惩罚 × 权重。
   * 对比那一项让「把深浅不同的颜色压成同一颗豆」变贵，候选色少时也能保住层次。
   */
  private objectiveOf(stats: OptimizeStats, assignment: Int32Array = this.nearestI): number {
    const base = this.config.objective === 'max' ? stats.max : this.config.weighted ? stats.weightedAvg : stats.avg
    return base + this.contrastWeight * this.contrastPenaltyOf(assignment)
  }

  private statsFrom(dArr: Float64Array, iArr: Int32Array): OptimizeStats {
    let min = Infinity
    let max = 0
    let sum = 0
    let wsum = 0
    for (let i = 0; i < this.t; i++) {
      const d = iArr[i] < 0 ? 0 : dArr[i]
      if (d < min) min = d
      if (d > max) max = d
      sum += d
      wsum += d * this.weights[i]
    }
    const n = Math.max(1, this.t)
    return {
      min: min === Infinity ? 0 : min,
      max,
      avg: sum / n,
      weightedAvg: this.weightSum > 0 ? wsum / this.weightSum : sum / n,
    }
  }

  /** 用当前 selected 全量重算最近色 */
  private rebuildNearest(): void {
    this.nearestD.fill(0)
    this.nearestI.fill(-1)
    for (let i = 0; i < this.t; i++) {
      const base = i * this.c
      let best = Infinity
      let bestIdx = -1
      for (const j of this.selected) {
        const d = this.dist[base + j]
        if (d < best) {
          best = d
          bestIdx = j
        }
      }
      this.nearestD[i] = bestIdx < 0 ? 0 : best
      this.nearestI[i] = bestIdx
    }
  }

  /**
   * 增量评估「移除 out、加入 inn」。
   * 结果写入 scratch，返回对应统计量；由调用方决定是否提交。
   */
  private evaluateSwap(out: number, inn: number): OptimizeStats {
    const sd = this.scratchD
    const si = this.scratchI
    sd.set(this.nearestD)
    si.set(this.nearestI)

    for (let i = 0; i < this.t; i++) {
      const base = i * this.c
      if (si[i] === out) {
        // 最近色被移除，必须重算（含 inn）
        let best = this.dist[base + inn]
        let bestIdx = inn
        for (const j of this.selected) {
          if (j === out) continue
          const d = this.dist[base + j]
          if (d < best) {
            best = d
            bestIdx = j
          }
        }
        sd[i] = best
        si[i] = bestIdx
      } else {
        const d = this.dist[base + inn]
        if (d < sd[i] || si[i] < 0) {
          sd[i] = d
          si[i] = inn
        }
      }
    }

    return this.statsFrom(sd, si)
  }

  private commitScratch(): void {
    this.nearestD.set(this.scratchD)
    this.nearestI.set(this.scratchI)
  }

  /** 贪心最远点（k-center）初始解 */
  private greedyInit(k: number): number[] {
    const chosen: number[] = [...this.fixed]
    if (!chosen.length) {
      // 第一个点：使加权平均距离最小的候选
      let bestC = 0
      let bestScore = Infinity
      for (let j = 0; j < this.c; j++) {
        let s = 0
        for (let i = 0; i < this.t; i++) s += this.dist[i * this.c + j] * this.weights[i]
        if (s < bestScore) {
          bestScore = s
          bestC = j
        }
      }
      chosen.push(bestC)
    }

    while (chosen.length < k) {
      // 当前最近距离
      const cur = new Float64Array(this.t).fill(Infinity)
      for (let i = 0; i < this.t; i++) {
        const base = i * this.c
        let best = Infinity
        for (const j of chosen) best = Math.min(best, this.dist[base + j])
        cur[i] = best
      }

      let bestC = -1
      let bestGain = -Infinity
      for (let j = 0; j < this.c; j++) {
        if (chosen.includes(j)) continue
        let gain = 0
        for (let i = 0; i < this.t; i++) {
          const d = this.dist[i * this.c + j]
          if (d < cur[i]) gain += (cur[i] - d) * this.weights[i]
        }
        if (gain > bestGain) {
          bestGain = gain
          bestC = j
        }
      }
      if (bestC < 0 || bestGain <= 0) break
      chosen.push(bestC)
    }

    return chosen
  }

  private randomInit(k: number): number[] {
    const chosen = new Set<number>(this.fixed)
    let guard = 0
    while (chosen.size < k && guard++ < k * 200) {
      chosen.add(this.random.int(0, this.c))
    }
    return [...chosen]
  }

  private setState(list: number[]): void {
    this.selected = [...list]
    this.inState.fill(0)
    for (const j of this.selected) this.inState[j] = 1
  }

  /** 退火后的贪心替换精修：逐个尝试把每个配色换成更好的候选色 */
  private polish(passes: number): number {
    let improved: boolean
    let pass = 0
    let objective = this.objectiveOf(this.statsFrom(this.nearestD, this.nearestI))

    do {
      improved = false
      for (let p = 0; p < this.selected.length; p++) {
        const out = this.selected[p]
        if (this.fixed.has(out)) continue
        let bestCandidate = out
        let bestObjective = objective
        for (let inn = 0; inn < this.c; inn++) {
          if (this.inState[inn]) continue
          const stats = this.evaluateSwap(out, inn)
          // 对比惩罚要按「换过去之后」的分组算，所以用 scratch 里的分配
          const obj = this.objectiveOf(stats, this.scratchI)
          if (obj < bestObjective - 1e-9) {
            bestObjective = obj
            bestCandidate = inn
          }
        }
        if (bestCandidate !== out) {
          this.evaluateSwap(out, bestCandidate)
          this.commitScratch()
          this.inState[out] = 0
          this.selected[p] = bestCandidate
          this.inState[bestCandidate] = 1
          objective = bestObjective
          improved = true
        }
      }
      pass++
    } while (improved && pass < passes)

    return objective
  }

  async *run(): AsyncGenerator<OptimizeEvent> {
    const cfg = this.config
    this.random = new RandomGenerator(cfg.seed)
    this.running = true

    const targetCount = this.t
    if (!targetCount || !this.c) {
      this.running = false
      yield {
        type: 'completed',
        stats: { min: 0, max: 0, avg: 0, weightedAvg: 0 },
        selected: [],
        steps: 0,
        reason: 'finished',
      }
      return
    }

    const budget = Math.max(this.fixed.size, Math.min(cfg.k + this.fixed.size, this.c))
    const init = cfg.greedyInit ? this.greedyInit(budget) : this.randomInit(budget)
    this.setState(init)
    this.rebuildNearest()

    let currentObjective = this.objectiveOf(this.statsFrom(this.nearestD, this.nearestI))
    let bestObjective = currentObjective
    this.bestSelected = [...this.selected]

    yield {
      type: 'initialized',
      stats: this.statsFrom(this.nearestD, this.nearestI),
      selected: [...this.selected],
      candidates: this.c,
    }

    // 候选之间的对称距离（仅 library 模式用于局部邻域搜索）
    let candidateDist: Float64Array | null = null
    if (this.targetMode === 'library') {
      candidateDist = new Float64Array(this.c * this.c)
      for (let i = 0; i < this.c; i++) {
        for (let j = 0; j < this.c; j++) {
          candidateDist[i * this.c + j] = deltaE(this.entries[i].lab, this.entries[j].lab)
        }
      }
    }

    let maxDist = 0
    for (let i = 0; i < this.dist.length; i++) if (this.dist[i] > maxDist) maxDist = this.dist[i]
    const radiusDecay = Math.pow(1 / (maxDist + 1e-6), 1 / Math.max(1, cfg.steps))

    let noImprovement = 0
    let reason: 'finished' | 'early-exit' | 'stopped' = 'finished'
    const variableSlots: number[] = []
    let step = 0
    let lastYield = performance.now()
    const UPDATE_INTERVAL = 100

    for (; step < cfg.steps; step++) {
      if (!this.running) {
        reason = 'stopped'
        break
      }
      if (noImprovement > cfg.patience) {
        reason = 'early-exit'
        break
      }

      variableSlots.length = 0
      for (const j of this.selected) if (!this.fixed.has(j)) variableSlots.push(j)
      if (!variableSlots.length) {
        reason = 'finished'
        break
      }

      const out = variableSlots[this.random.int(0, variableSlots.length)]
      const temperature = cfg.t0 * Math.pow(cfg.alpha, step)
      const currentRadius = maxDist * Math.pow(radiusDecay, step)

      let inn = -1
      if (candidateDist) {
        // 邻域搜索：只考虑与被移除色接近的候选
        for (let attempts = 0; attempts < 32; attempts++) {
          const cand = this.random.int(0, this.c)
          if (this.inState[cand]) continue
          if (candidateDist[out * this.c + cand] < currentRadius) {
            inn = cand
            break
          }
        }
      }
      if (inn < 0) {
        for (let attempts = 0; attempts < 64; attempts++) {
          const cand = this.random.int(0, this.c)
          if (!this.inState[cand]) {
            inn = cand
            break
          }
        }
      }
      if (inn < 0) continue

      const stats = this.evaluateSwap(out, inn)
      const nextObjective = this.objectiveOf(stats, this.scratchI)

      const accept =
        nextObjective < currentObjective ||
        this.random.random() < Math.exp((currentObjective - nextObjective) / Math.max(1e-9, temperature))

      if (accept) {
        this.commitScratch()
        this.inState[out] = 0
        this.inState[inn] = 1
        this.selected[this.selected.indexOf(out)] = inn
        currentObjective = nextObjective

        if (currentObjective < bestObjective - 1e-9) {
          bestObjective = currentObjective
          this.bestSelected = [...this.selected]
          noImprovement = 0
        } else {
          noImprovement++
        }
      } else {
        noImprovement++
      }

      const now = performance.now()
      // 即使跑得很快也每 500 步汇报一次，保证 UI 一定有中间态
      if (now - lastYield >= UPDATE_INTERVAL || step % 500 === 499) {
        yield {
          type: 'progress',
          step: step + 1,
          totalSteps: cfg.steps,
          stats: this.statsFrom(this.nearestD, this.nearestI),
          temperature,
          progress: ((step + 1) / cfg.steps) * 100,
          selected: [...this.selected],
        }
        lastYield = now
        // 让出主线程，保证 UI 不卡死
        await new Promise((resolve) => setTimeout(resolve, 0))
      }
    }

    // 精修：以历史最优解为起点做贪心替换
    this.setState(this.bestSelected)
    this.rebuildNearest()
    if (cfg.polish) {
      this.polish(3)
      const polishedObjective = this.objectiveOf(this.statsFrom(this.nearestD, this.nearestI))
      if (polishedObjective <= bestObjective + 1e-9) {
        bestObjective = polishedObjective
        this.bestSelected = [...this.selected]
      }
    }

    this.setState(this.bestSelected)
    this.rebuildNearest()
    this.running = false

    yield {
      type: 'completed',
      stats: this.statsFrom(this.nearestD, this.nearestI),
      selected: [...this.selected].sort((a, b) => {
        const ca = this.entries[a].codes.MARD ?? ''
        const cb = this.entries[b].codes.MARD ?? ''
        return ca.localeCompare(cb, undefined, { numeric: true })
      }),
      steps: step,
      reason,
    }
  }
}
