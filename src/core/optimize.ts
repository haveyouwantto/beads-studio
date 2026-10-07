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
      /**
       * 每个目标色最终落到哪颗豆（key = 目标色的 RGB 数值）。
       * 补色阶段会把一部分目标色放到「不是最近、但能保住颜色数」的豆上，
       * 出图纸要照这份分配走，否则会按最近色重新映射、把补出来的色又压回去。
       */
      mapping: { key: number; hex: string }[]
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
  /** 目标色的 RGB 数值（r<<16|g<<8|b），出图纸时要按它查最终分配 */
  private targetKeys = new Int32Array(0)

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
    this.targetKeys = new Int32Array(this.t)
    this.weightSum = 0
    for (let i = 0; i < this.t; i++) {
      const w = Math.max(1, samples[i].count)
      this.weights[i] = w
      this.weightSum += w
      const [r, g, b] = samples[i].rgb
      this.targetKeys[i] =
        (Math.min(255, Math.max(0, Math.round(r))) << 16) |
        (Math.min(255, Math.max(0, Math.round(g))) << 8) |
        Math.min(255, Math.max(0, Math.round(b)))
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
  }

  stop(): void {
    this.running = false
  }

  get isRunning(): boolean {
    return this.running
  }

  private objectiveOf(stats: OptimizeStats): number {
    if (this.config.objective === 'max') return stats.max
    return this.config.weighted ? stats.weightedAvg : stats.avg
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

  /**
   * 补色：只盯 ΔE 的时候，优化会为了压低误差把颜色数一起压掉 ——
   * 原图 8 种颜色，预算 8 颗豆，它只肯用 6 颗（另外几种各自挤在同一颗豆上）。
   *
   * 结果色号数应该是「预算」和「原图颜色数」里小的那个，不够就补：
   * 每一轮挑一个「正跟别的颜色挤在同一颗豆上」的目标色，把它挪到它自己最好的
   * 空位豆上，挑 ΔE 增加最少的那个先挪（比的是这个颜色自己的 ΔE 涨了多少）。
   * 代价也记在图纸上（ΔE 统计按补完之后的分配重算）。
   */
  private fillToBudget(budget: number): void {
    for (let guard = 0; guard <= this.t; guard++) {
      const used = new Set<number>()
      for (let i = 0; i < this.t; i++) if (this.nearestI[i] >= 0) used.add(this.nearestI[i])
      if (used.size >= budget) return

      // 每颗豆上挂了哪些目标色
      const buckets = new Map<number, number[]>()
      for (let i = 0; i < this.t; i++) {
        const b = this.nearestI[i]
        if (b < 0) continue
        const arr = buckets.get(b)
        if (arr) arr.push(i)
        else buckets.set(b, [i])
      }

      let pickI = -1
      let pickBead = -1
      let pickCost = Infinity
      for (const [b, members] of buckets) {
        if (members.length < 2) continue
        for (const i of members) {
          const base = i * this.c
          const cur = this.dist[base + b]
          // 这颗目标色自己的「空位」：最近的、还没被别的豆占用的候选色
          let bead = -1
          let best = Infinity
          for (let j = 0; j < this.c; j++) {
            if (used.has(j)) continue
            const d = this.dist[base + j]
            if (d < best) {
              best = d
              bead = j
            }
          }
          if (bead < 0) continue
          // 代价 = 这个颜色换到新豆上多出来的 ΔE
          const cost = best - cur
          if (cost < pickCost) {
            pickCost = cost
            pickI = i
            pickBead = bead
          }
        }
      }

      if (pickI < 0) return
      this.nearestI[pickI] = pickBead
      this.nearestD[pickI] = this.dist[pickI * this.c + pickBead]
    }
  }

  /**
   * 最终交出去的结果：真正落在这张图纸上的豆（最近色或补色落到它上面的目标色
   * 至少有一个），加上固定色号。预算里的空位不交出去 —— 结果面板只该列成品上
   * 会出现的色号。
   */
  private resultSelection(): number[] {
    const used = new Set<number>()
    for (let i = 0; i < this.t; i++) if (this.nearestI[i] >= 0) used.add(this.nearestI[i])
    for (const j of this.selected) if (this.fixed.has(j)) used.add(j)
    return [...used].sort((a, b) => {
      const ca = this.entries[a].codes.MARD ?? ''
      const cb = this.entries[b].codes.MARD ?? ''
      return ca.localeCompare(cb, undefined, { numeric: true })
    })
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
          const obj = this.objectiveOf(stats)
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
        mapping: [],
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
      const nextObjective = this.objectiveOf(stats)

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

    // 结果色号数 = min(预算, 原图颜色数)。优化出来的解没用到这么多就把颜色补回来。
    const resultBudget = Math.max(this.fixed.size, Math.min(cfg.k, this.t))
    this.fillToBudget(resultBudget)

    const mapping: { key: number; hex: string }[] = []
    for (let i = 0; i < this.t; i++) {
      const j = this.nearestI[i]
      if (j < 0) continue
      mapping.push({ key: this.targetKeys[i], hex: this.entries[j].hex })
    }

    yield {
      type: 'completed',
      stats: this.statsFrom(this.nearestD, this.nearestI),
      selected: this.resultSelection(),
      mapping,
      steps: step,
      reason,
    }
  }
}
