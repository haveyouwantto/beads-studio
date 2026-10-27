import { deltaEHue, rgbToLab } from './color.ts'
import { labPolar } from './color.ts'
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
  /** 颜料预算：最终要选多少种拼豆颜色（kMode = auto 时是上限） */
  k: number
  /**
   * 预算模式。
   * - `fixed`：就用 `k` 色。
   * - `auto`：先扫一遍「多一颗豆还能降多少 ΔE」的曲线，取拐点 —— 再往上加颜色
   *   画面几乎不变，只是多备几种豆。`k` 变成上限。
   */
  kMode: 'fixed' | 'auto'
  /**
   * 预算没用满时，是否强行把颜色补到预算。
   * 补出来的颜色是「第 2 顺位的豆」，代价大的时候会让图纸上冒出几颗不该有的豆，
   * 所以有代价上限（见 FILL_MAX_COST），也可以整个关掉。
   */
  fillBudget: boolean
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
  /**
   * 色相权重：距离用 `deltaEHue(lab, lab, hueWeight)` 算。
   * 0 = 旧 CIE76（会对低彩度区的色相视而不见）；默认 2。
   */
  hueWeight: number
  /** 是否给面积够得着的色相族各保底留一颗豆 */
  hueFamilies: boolean
  /** 看起来一样的豆只留一颗（否则一片同色里会深浅不一，看着花） */
  mergeLookalikes: boolean
  /**
   * 对比强度（0 = 关闭）。
   *
   * 目标函数 = 匹配误差 + contrast × 层次损失。层次损失只算「原图本来是分开的、
   * 成品里被压平了」的部分：原图头发有三级明暗，成品只剩两级，就是很典型的例子。
   * 平均 ΔE 对这种事几乎无感 —— 压平两级只多几个 ΔE，却要花掉一颗豆。
   */
  contrast: number
  /** 层次损失的死区（ΔE）：本来只差这么点的两个颜色，合并了不算丢层次 */
  contrastSlack: number
}

export const DEFAULT_OPTIMIZE_CONFIG: OptimizeConfig = {
  k: 30,
  kMode: 'fixed',
  fillBudget: true,
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
  hueWeight: 2,
  hueFamilies: true,
  mergeLookalikes: true,
  contrast: 1,
  contrastSlack: 5,
}

export const MANDATORY_MARD = ['H02', 'H07']

/**
 * 色相族保底。
 *
 * 只压平均 ΔE 的时候，面积小的色相族（一点青、一点紫）会被整体压进邻近族 ——
 * 代价只有「面积 × 很小的 ΔE」，但图纸上那一块的颜色就彻底变味了。所以按色相对
 * 目标色分族，每个「面积够得着」的族至少留一颗豆在自己的色相里。
 *
 * 族不按硬分箱判定（358° 和 2° 明明只差 4°），而是按与族中心的角度距离。
 */
const FAMILY_BIN_DEG = 30
/** 目标色彩度低于它算无彩色，不参与分族 */
const FAMILY_MIN_CHROMA = 8
/** 族在整张图里的面积占比低于它就不强求（否则零碎小色会被强塞一颗豆） */
const FAMILY_MIN_SHARE = 0.02
/** 与族中心的角度距离在这个范围内算「同族」 */
const FAMILY_TOLERANCE_DEG = 30
/** 为了保住一个族，最多允许平均 ΔE 上涨多少 */
const FAMILY_MAX_COST = 1.5

/**
 * 补色（把颜色补到预算）时的两道闸。
 *
 * 补色本质是「让某个目标色改用第 2 顺位的豆」，代价一定 ≥ 0。没有闸门时，
 * 优化器会为了凑满预算，把颜色差几个 ΔE 的格子挪到另一颗豆上 —— 图纸上就是
 * 一大块同色里冒出几颗不一样的豆，也就是「花」。
 *
 * 另外「看起来一样」的源色已经在上游并成了同一个目标色（TARGET_MERGE_DE），
 * 所以这里不用再担心拆开近色的问题，只要守住代价。
 */
const FILL_MAX_COST = 4

/** 自动色数：每多加一颗豆至少该买回这么多 ΔE，否则就是白备颜色 */
const AUTO_MIN_GAIN = 0.35

/**
 * 层次损失只关心「本来分得开」的颜色对：差得比这更远的两个颜色，
 * 成品里几乎不可能被压到同一颗豆上，算进来只是浪费。
 */
const PAIR_MAX_ORIG = 32
/** 目标色很多时，每个颜色只跟最近的这么多个比（照片类图会有几百个合并后目标色） */
const PAIR_PER_TARGET = 8
/** 目标色不超过这个数就全量两两比较（拼豆图纸基本都在这个量级） */
const PAIRWISE_ALL_LIMIT = 64
/**
 * 自动选色数时，目标色超过这个数就不把层次损失算进「该买几颗豆」的评分里：
 * 每个候选色都要重算一遍层次损失，照片类图的目标色上千，扫一遍会很慢。
 */
const AUTO_CONTRAST_MAX_T = 600

/**
 * 拆层修补：退火每次只换一颗豆，而「把一层明暗分出来」往往要同时动两颗
 * （先撤掉那两颗共用的豆，再把两边的替代豆加进来），单步换色永远走不到。
 * 这里专门盯被压平的颜色对，做一次有限的两次换两颗搜索。
 */
const REPAIR_PAIRS = 8
/** 每层最多试几颗替代豆 */
const LAYER_SPLIT_TRIES = 3
/** 最多拆几层（每轮拆一层，避免为了层次把整张图都拖差） */
const LAYER_SPLIT_ROUNDS = 6
/**
 * 拆层时，替代豆最多比原来那颗豆差多少 ΔE（基准值）。
 * 层次要保住，但不能靠「换一颗色系不对的豆」来保 —— 那样头发会被染成粉灰，
 * 所以真正的限制是下面的同色相检查，这里只是不让它跑到很远的地方去。
 * 对比强度越高，允许的代价也越大（用户明确说了「宁可失真也要有层次」）。
 */
const REPAIR_MAX_DEMOTE = 2
/** 彩度低于它就算无彩色，拆层时不看色相（色相角本身没有意义） */
const REPAIR_NEUTRAL_CHROMA = 4

/**
 * 两颗豆的色差小于它，就当它们「看起来一样」，不同时用。
 *
 * 色号库里本来就有一堆近重复色（#C8B9B2 / #C9BAB3 这种差 0.5 的），预算够的时候
 * 优化器会把它们都选上：两个源色明明同色，却各落一颗，图纸上就是一片同色里深浅
 * 不一的格子 —— 加了色号，画面反而更花。
 */
const LOOKALIKE_DE = 2.5

/**
 * 目标色的合并门槛：差不到这么多的两个源色算「同一个颜色」。
 *
 * 像素画经缩放/抗锯齿之后，同一块底色会散成几十个只差零点几的源色。分开处理时，
 * 它们完全可能各自落在相邻的两颗豆上（都算「最近」），于是同一片颜色被切成深浅
 * 不一的格子 —— 这就是「颜色给多了反而花」。所以先把它们并成一个目标色，强制同豆。
 */
const TARGET_MERGE_DE = 2.5

export interface HueFamily {
  /** 族中心的色相角（度） */
  center: number
  /** 属于这个族的目标色下标 */
  members: number[]
  /** 面积占比（按出现次数加权） */
  share: number
}

/** 两个色相角之间的最小夹角（度） */
function hueGap(a: number, b: number): number {
  const d = Math.abs(a - b) % 360
  return d > 180 ? 360 - d : d
}

export interface OptimizeStats {
  min: number
  max: number
  avg: number
  weightedAvg: number
}

export type OptimizeEvent =
  | {
      type: 'initialized'
      stats: OptimizeStats
      selected: number[]
      candidates: number
      /** 本次实际用的色数（kMode = auto 时是自动选出来的，不是配置里的 k） */
      budget: number
      /** 自动模式的「色数 → 加权 ΔE」曲线，前几个点就够了，供 UI 画个小图 */
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
       * 每个目标色最终落到哪颗豆（key = 目标色的 RGB 数值）。
       * 补色阶段会把一部分目标色放到「不是最近、但能保住颜色数」的豆上，
       * 出图纸要照这份分配走，否则会按最近色重新映射、把补出来的色又压回去。
       */
      mapping: { key: number; hex: string }[]
      steps: number
      reason: 'finished' | 'early-exit' | 'stopped'
      /** 真正用上的色数（含固定色号） */
      budget: number
      /** 最终解的层次损失（0 = 原图的明暗层次一点没丢） */
      contrast: number
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
  /** 每个（合并后的）目标色对应哪些原始源色的 key，出图纸时要全部映射过去 */
  private targetGroupKeys: number[][] = []

  private selected: number[] = []
  private inState = new Uint8Array(0)
  private nearestD = new Float64Array(0)
  private nearestI = new Int32Array(0)
  private scratchD = new Float64Array(0)
  private scratchI = new Int32Array(0)

  /** 每个目标色 / 候选色的彩度与色相角，分族与覆盖检查都靠它 */
  private targetC = new Float64Array(0)
  private targetH = new Float64Array(0)
  private candC = new Float64Array(0)
  private candH = new Float64Array(0)

  /** 候选色两两之间的距离（算层次损失要用；library 模式的邻域搜索也复用） */
  private candDist = new Float64Array(0)
  private candDistReady = false
  /** 颜色对的 CSR：第 i 个目标色相关的对从 pairStart[i] 到 pairStart[i+1] */
  private pairStart = new Int32Array(0)
  private pairOther = new Int32Array(0)
  private pairOrig = new Float64Array(0)
  private pairW = new Float64Array(0)
  private pairWSum = 0
  /** 当前分配下的层次损失 / 试探分配下的层次损失 */
  private currentContrast = 0
  private scratchContrast = 0
  private changed: number[] = []

  private fixed = new Set<number>()
  /** 本次要保底的色相族（ensureFamilies 里算一次，isSoleHolder 复用） */
  private families: HueFamily[] = []
  private running = false
  private bestSelected: number[] = []

  constructor(entries: PaletteEntry[], config: OptimizeConfig, targetMode: TargetMode = 'grid') {
    this.entries = entries
    this.config = config
    this.targetMode = targetMode
    this.random = new RandomGenerator(config.seed)
    this.c = entries.length

    this.candC = new Float64Array(this.c)
    this.candH = new Float64Array(this.c)
    for (let i = 0; i < this.c; i++) {
      const [c, h] = labPolar(entries[i].lab)
      this.candC[i] = c
      this.candH[i] = (h * 180) / Math.PI
    }

    if (config.mandatory) {
      for (let i = 0; i < entries.length; i++) {
        const mard = entries[i].codes.MARD
        if (mard && MANDATORY_MARD.includes(mard)) this.fixed.add(i)
      }
    }
  }

  setTargets(samples: TargetSample[]): void {
    const wHue = this.config.hueWeight ?? 2
    // 先把「看起来一样」的源色并成一个目标色：分开处理时它们会各自落在相邻的
    // 两颗豆上，同一片颜色被切成深浅不一的格子（颜色越多越明显）
    const keyOf = (s: TargetSample) => {
      const [r, g, b] = s.rgb
      return (
        (Math.min(255, Math.max(0, Math.round(r))) << 16) |
        (Math.min(255, Math.max(0, Math.round(g))) << 8) |
        Math.min(255, Math.max(0, Math.round(b)))
      )
    }
    const order = samples.map((_, i) => i).sort((a, b) => samples[b].count - samples[a].count)
    const groupOf = new Int32Array(samples.length).fill(-1)
    const merged: TargetSample[] = []
    this.targetGroupKeys = []
    for (const seed of order) {
      if (groupOf[seed] >= 0) continue
      const g = merged.length
      const members: number[] = []
      let weight = 0
      let r = 0
      let gr = 0
      let b = 0
      let L = 0
      let aa = 0
      let bb = 0
      for (const j of order) {
        if (groupOf[j] >= 0) continue
        if (
          deltaEHue(samples[seed].lab, samples[j].lab, wHue) >= TARGET_MERGE_DE &&
          j !== seed
        ) {
          continue
        }
        groupOf[j] = g
        members.push(j)
        const c = samples[j].count
        weight += c
        r += samples[j].rgb[0] * c
        gr += samples[j].rgb[1] * c
        b += samples[j].rgb[2] * c
        L += samples[j].lab[0] * c
        aa += samples[j].lab[1] * c
        bb += samples[j].lab[2] * c
      }
      const n = Math.max(1, weight)
      merged.push({
        rgb: [r / n, gr / n, b / n],
        lab: [L / n, aa / n, bb / n],
        count: weight,
      })
      this.targetGroupKeys.push(members.map((j) => keyOf(samples[j])))
    }

    this.t = merged.length
    this.weights = new Float64Array(this.t)
    this.targetKeys = new Int32Array(this.t)
    this.weightSum = 0
    for (let i = 0; i < this.t; i++) {
      const w = Math.max(1, merged[i].count)
      this.weights[i] = w
      this.weightSum += w
      const [r, g, b] = merged[i].rgb
      this.targetKeys[i] =
        (Math.min(255, Math.max(0, Math.round(r))) << 16) |
        (Math.min(255, Math.max(0, Math.round(g))) << 8) |
        Math.min(255, Math.max(0, Math.round(b)))
    }

    this.targetC = new Float64Array(this.t)
    this.targetH = new Float64Array(this.t)
    for (let i = 0; i < this.t; i++) {
      const [c, h] = labPolar(merged[i].lab)
      this.targetC[i] = c
      this.targetH[i] = (h * 180) / Math.PI
    }

    this.dist = new Float64Array(this.t * this.c)
    for (let i = 0; i < this.t; i++) {
      const lab = merged[i].lab
      const base = i * this.c
      for (let j = 0; j < this.c; j++) {
        this.dist[base + j] = deltaEHue(lab, this.entries[j].lab, this.config.hueWeight ?? 2)
      }
    }

    this.nearestD = new Float64Array(this.t)
    this.nearestI = new Int32Array(this.t)
    this.scratchD = new Float64Array(this.t)
    this.scratchI = new Int32Array(this.t)
    this.inState = new Uint8Array(this.c)

    this.candDistReady = false
    this.currentContrast = 0
    this.buildPairs(merged)
  }

  /** 层次损失有没有开（关掉时整条链路都不跑，行为与旧版完全一致） */
  private get contrastActive(): boolean {
    return (this.config.contrast ?? 0) > 0
  }

  /** 候选色两两距离（只在第一次要用时算） */
  private ensureCandDist(): void {
    if (this.candDistReady) return
    const w = this.config.hueWeight ?? 2
    const n = this.c * this.c
    if (this.candDist.length !== n) this.candDist = new Float64Array(n)
    for (let i = 0; i < this.c; i++) {
      const li = this.entries[i].lab
      const base = i * this.c
      for (let j = i + 1; j < this.c; j++) {
        const d = deltaEHue(li, this.entries[j].lab, w)
        this.candDist[base + j] = d
        this.candDist[j * this.c + i] = d
      }
    }
    this.candDistReady = true
  }

  /**
   * 建「颜色对」表：只收原图里本来分得开的近邻对（ΔE ≤ PAIR_MAX_ORIG）。
   *
   * 层次损失 = Σ w·max(0, 原距离 − 成品距离 − 死区) / Σ w。
   * 只看这个方向：成品里分得比原图还开不算加分，否则优化器又会拿「乱摊」来刷分。
   */
  private buildPairs(merged: TargetSample[]): void {
    this.pairStart = new Int32Array(this.t + 1)
    this.pairOther = new Int32Array(0)
    this.pairOrig = new Float64Array(0)
    this.pairW = new Float64Array(0)
    this.pairWSum = 0
    if (!this.contrastActive || this.t < 2) return
    this.ensureCandDist()

    const wHue = this.config.hueWeight ?? 2
    const edges: { i: number; j: number; orig: number; w: number }[] = []
    for (let i = 0; i < this.t; i++) {
      for (let j = i + 1; j < this.t; j++) {
        const orig = deltaEHue(merged[i].lab, merged[j].lab, wHue)
        if (orig <= 1e-6 || orig > PAIR_MAX_ORIG) continue
        edges.push({ i, j, orig, w: Math.sqrt(this.weights[i] * this.weights[j]) })
      }
    }
    if (!edges.length) return

    // 目标色太多时每个颜色只跟最近的几个比，否则是平方级
    let kept = edges
    if (this.t > PAIRWISE_ALL_LIMIT) {
      const perTarget: number[][] = Array.from({ length: this.t }, () => [])
      edges.forEach((e, idx) => {
        perTarget[e.i].push(idx)
        perTarget[e.j].push(idx)
      })
      const keep = new Uint8Array(edges.length)
      for (let i = 0; i < this.t; i++) {
        perTarget[i].sort((a, b) => edges[a].orig - edges[b].orig)
        for (const idx of perTarget[i].slice(0, PAIR_PER_TARGET)) keep[idx] = 1
      }
      kept = edges.filter((_, idx) => keep[idx])
    }

    // CSR
    const start = new Int32Array(this.t + 1)
    for (const e of kept) {
      start[e.i + 1]++
      start[e.j + 1]++
    }
    for (let i = 0; i < this.t; i++) start[i + 1] += start[i]
    const other = new Int32Array(start[this.t])
    const orig = new Float64Array(start[this.t])
    const pw = new Float64Array(start[this.t])
    const cursor = start.slice(0, this.t)
    for (const e of kept) {
      let p = cursor[e.i]++
      other[p] = e.j
      orig[p] = e.orig
      pw[p] = e.w
      p = cursor[e.j]++
      other[p] = e.i
      orig[p] = e.orig
      pw[p] = e.w
    }
    this.pairStart = start
    this.pairOther = other
    this.pairOrig = orig
    this.pairW = pw
    this.pairWSum = kept.reduce((a, e) => a + e.w, 0)
  }

  /** 给定分配下的层次损失（0 = 一点层次都没丢） */
  private contrastOf(assign: Int32Array): number {
    if (!this.pairWSum) return 0
    const slack = this.config.contrastSlack ?? 5
    let loss = 0
    for (let i = 0; i < this.t; i++) {
      const ai = assign[i]
      for (let p = this.pairStart[i]; p < this.pairStart[i + 1]; p++) {
        const j = this.pairOther[p]
        if (j < i) continue // 每对只算一次
        const aj = assign[j]
        // 没有豆（或者同一颗豆）时成品距离就是 0
        const out = ai < 0 || aj < 0 || ai === aj ? 0 : this.candDist[ai * this.c + aj]
        const drop = this.pairOrig[p] - out - slack
        if (drop > 0) loss += this.pairW[p] * drop
      }
    }
    return loss / this.pairWSum
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

  /**
   * 真正被优化的目标 = 匹配误差 + contrast × 层次损失。
   *
   * 层次损失单独放在平均 ΔE 里没有用：把三级明暗压成两级，平均 ΔE 只涨几个点，
   * 却省下一颗豆 —— 优化器当然会省。所以必须显式给它挂权重。
   */
  private costOf(stats: OptimizeStats, contrast: number): number {
    const base = this.objectiveOf(stats)
    if (!this.contrastActive) return base
    return base + this.config.contrast * contrast
  }

  /** 当前解的完整目标值 */
  private currentCost(): number {
    return this.costOf(this.statsFrom(this.nearestD, this.nearestI), this.currentContrast)
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
    // 层次损失只在分配变了的时候才变，全量重算一次即可（O(对数)，很便宜）
    if (this.contrastActive) this.currentContrast = this.contrastOf(this.nearestI)
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

    this.scratchContrast = this.contrastActive
      ? this.currentContrast + this.contrastDelta(this.scratchI)
      : this.currentContrast
    return this.statsFrom(sd, si)
  }

  /**
   * 相对 currentContrast 的增量（只算分配真的变了的颜色附近的颜色对）。
   *
   * 一对颜色在 CSR 里存了两次（两个端点各一条），所以只在下标较大的那一端算，
   * 避免同一对算两遍。若较大那端没变，就退回到变小那端来算。
   */
  private contrastDelta(next: Int32Array): number {
    if (!this.pairWSum) return 0
    this.changed.length = 0
    for (let i = 0; i < this.t; i++) {
      if (next[i] !== this.nearestI[i]) this.changed.push(i)
    }
    if (!this.changed.length) return 0

    const slack = this.config.contrastSlack ?? 5
    const c = this.c
    const cur = this.nearestI
    let delta = 0
    for (const i of this.changed) {
      const ai0 = cur[i]
      const ai1 = next[i]
      for (let p = this.pairStart[i]; p < this.pairStart[i + 1]; p++) {
        const j = this.pairOther[p]
        // j 比 i 大时这一对归 j 算；除非 j 自己也变了（否则会漏）
        if (j > i && next[j] !== cur[j]) continue
        const aj0 = cur[j]
        const aj1 = next[j]
        const orig = this.pairOrig[p]
        const out0 = ai0 < 0 || aj0 < 0 || ai0 === aj0 ? 0 : this.candDist[ai0 * c + aj0]
        const out1 = ai1 < 0 || aj1 < 0 || ai1 === aj1 ? 0 : this.candDist[ai1 * c + aj1]
        const drop1 = orig - out1 - slack
        const drop0 = orig - out0 - slack
        if (drop1 > 0) delta += this.pairW[p] * drop1
        if (drop0 > 0) delta -= this.pairW[p] * drop0
      }
    }
    return delta / this.pairWSum
  }

  private commitScratch(): void {
    this.nearestD.set(this.scratchD)
    this.nearestI.set(this.scratchI)
    this.currentContrast = this.scratchContrast
  }

  /**
   * 按色相把目标色分族。只有面积占比够得着的族才会进名单，
   * 族数超过预算时按面积取前面几个 —— 预算本来就不够，保底也保不过来。
   */
  private hueFamiliesOf(budget: number): HueFamily[] {
    const bins = new Map<number, { w: number; cos: number; sin: number; members: number[] }>()
    const binCount = Math.max(1, Math.round(360 / FAMILY_BIN_DEG))
    for (let i = 0; i < this.t; i++) {
      if (this.targetC[i] < FAMILY_MIN_CHROMA) continue
      const bin = Math.floor(this.targetH[i] / FAMILY_BIN_DEG) % binCount
      const rad = (this.targetH[i] * Math.PI) / 180
      const w = this.weights[i]
      let acc = bins.get(bin)
      if (!acc) {
        acc = { w: 0, cos: 0, sin: 0, members: [] }
        bins.set(bin, acc)
      }
      acc.w += w
      acc.cos += Math.cos(rad) * w
      acc.sin += Math.sin(rad) * w
      acc.members.push(i)
    }

    const total = this.weightSum || 1
    const out: HueFamily[] = []
    // 相邻桶先合并：30° 分箱会把同一个族切在两只桶里（蓝 239° 和蓝 246° 就是两只桶），
    // 分开算等于让一个色相占两个保底名额，预算小的时候把别的族直接挤掉。
    const centerOf = (a: { cos: number; sin: number }) =>
      ((Math.atan2(a.sin, a.cos) * 180) / Math.PI + 360) % 360
    const ordered = [...bins.values()].sort((a, b) => centerOf(a) - centerOf(b))
    const merged: typeof ordered = []
    for (const acc of ordered) {
      const prev = merged[merged.length - 1]
      if (prev && hueGap(centerOf(prev), centerOf(acc)) < FAMILY_BIN_DEG) {
        prev.w += acc.w
        prev.cos += acc.cos
        prev.sin += acc.sin
        prev.members.push(...acc.members)
      } else {
        merged.push({ w: acc.w, cos: acc.cos, sin: acc.sin, members: [...acc.members] })
      }
    }
    // 首尾是环形相邻的，跨 0° 的两只桶也要合
    if (merged.length > 1) {
      const first = merged[0]
      const last = merged[merged.length - 1]
      if (hueGap(centerOf(first), centerOf(last)) < FAMILY_BIN_DEG) {
        first.w += last.w
        first.cos += last.cos
        first.sin += last.sin
        first.members.push(...last.members)
        merged.pop()
      }
    }

    for (const acc of merged) {
      const share = acc.w / total
      if (share < FAMILY_MIN_SHARE) continue
      // 族中心用加权圆周平均：直接按分箱中点会被边界上的颜色带偏
      out.push({ center: centerOf(acc), members: acc.members, share })
    }
    out.sort((a, b) => b.share - a.share)
    return out.slice(0, Math.max(1, budget))
  }

  /** 两颗豆是不是同一个色系（几乎无彩色时色相角没有意义，直接算同族） */
  private sameHueFamily(a: number, b: number): boolean {
    if (this.candC[a] < REPAIR_NEUTRAL_CHROMA || this.candC[b] < REPAIR_NEUTRAL_CHROMA) return true
    return hueGap(this.candH[a], this.candH[b]) <= FAMILY_TOLERANCE_DEG
  }

  /** 当前选色里，这个族有没有一颗「自己色相」的豆 */
  private familyHeld(f: HueFamily, skip?: number): boolean {
    for (const j of this.selected) {
      if (j === skip) continue
      if (this.candC[j] < FAMILY_MIN_CHROMA) continue
      if (hueGap(this.candH[j], f.center) <= FAMILY_TOLERANCE_DEG) return true
    }
    return false
  }

  /**
   * 色相族保底：退火只认平均 ΔE，面积小的族整族消失也不会被惩罚，
   * 这里对缺族的补一颗，换掉「走了损失最小」的那颗豆，且涨幅超过 FAMILY_MAX_COST 就不动。
   */
  private ensureFamilies(budget: number): void {
    if (!this.config.hueFamilies) return
    this.families = this.hueFamiliesOf(budget)
    if (this.families.length < 2) return

    for (const f of this.families) {
      if (this.familyHeld(f)) continue

      // 这个族最该有的那颗豆：族内目标色的加权距离之和最小
      let bestBead = -1
      let bestScore = Infinity
      for (let j = 0; j < this.c; j++) {
        if (this.inState[j]) continue
        if (this.candC[j] < FAMILY_MIN_CHROMA) continue
        if (hueGap(this.candH[j], f.center) > FAMILY_TOLERANCE_DEG) continue
        let score = 0
        for (const i of f.members) score += this.dist[i * this.c + j] * this.weights[i]
        if (score < bestScore) {
          bestScore = score
          bestBead = j
        }
      }
      if (bestBead < 0) continue

      // 这里只比 ΔE：保底是「色相覆盖」的硬约束，代价闸门也该只按 ΔE 算，
      // 掺进层次损失等于用另一把尺子量这个闸门，族会被无缘无故挡掉。
      const before = this.objectiveOf(this.statsFrom(this.nearestD, this.nearestI))
      let bestOut = -1
      let bestObj = Infinity
      for (const out of this.selected) {
        if (this.fixed.has(out)) continue
        // 别为了补一个族，把别的族的唯一一颗豆换掉
        let sole = false
        for (const g of this.families) {
          if (hueGap(this.candH[out], g.center) > FAMILY_TOLERANCE_DEG) continue
          if (!this.familyHeld(g, out)) {
            sole = true
            break
          }
        }
        if (sole) continue
        const obj = this.objectiveOf(this.evaluateSwap(out, bestBead))
        if (obj < bestObj) {
          bestObj = obj
          bestOut = out
        }
      }
      if (bestOut < 0) continue
      if (bestObj - before > FAMILY_MAX_COST) continue

      this.evaluateSwap(bestOut, bestBead)
      this.commitScratch()
      this.inState[bestOut] = 0
      this.inState[bestBead] = 1
      this.selected[this.selected.indexOf(bestOut)] = bestBead
    }
  }

  /**
   * 看起来一样的豆只留一颗。
   *
   * 预算够、候选色又多的图上，优化器会把色号库里的近重复色一起选上（它们对 ΔE
   * 的贡献是正的，退火没有理由拒绝）。结果是两个本来同色的源色各落一颗豆：整片
   * 颜色里就开始出现深浅不一的格子。这里按使用面积从大到小过一遍，和已经留下的
   * 豆差不到 LOOKALIKE_DE 的全部并过去，然后重新找最近色。
   */
  private mergeLookalikes(): void {
    if (!this.config.mergeLookalikes) return
    const used = new Map<number, number>()
    for (let i = 0; i < this.t; i++) {
      const j = this.nearestI[i]
      if (j < 0) continue
      used.set(j, (used.get(j) ?? 0) + this.weights[i])
    }
    if (used.size < 2) return

    const order = [...used.entries()].sort((a, b) => b[1] - a[1]).map((e) => e[0])
    const kept: number[] = []
    let dropped = false
    for (const j of order) {
      let merge = false
      for (const k of kept) {
        if (deltaEHue(this.entries[j].lab, this.entries[k].lab, this.config.hueWeight ?? 2) < LOOKALIKE_DE) {
          merge = true
          break
        }
      }
      if (merge) dropped = true
      else kept.push(j)
    }
    if (!dropped) return

    // 固定色号（黑白）不能被并掉
    for (const f of this.fixed) if (!kept.includes(f)) kept.push(f)
    this.setState(kept)
    this.rebuildNearest()
    this.bestSelected = [...this.selected]
  }

  /**
   * 给定豆集合和「强制分配」，算出这个方案有多好（不碰内部状态）。
   *
   * 强制分配是拆层的关键：为了保住一层明暗，这一块就该**故意**用深一档的豆，
   * 哪怕它不是最近的 —— 只要那不是「换了个色系」。
   */
  private scoreOf(
    beads: number[],
    forced: { t: number; bead: number }[],
  ): { deltaE: number; loss: number; cost: number } {
    const si = this.scratchI
    const sd = this.scratchD
    for (let i = 0; i < this.t; i++) {
      const base = i * this.c
      let best = Infinity
      let bestIdx = -1
      for (const j of beads) {
        const d = this.dist[base + j]
        if (d < best) {
          best = d
          bestIdx = j
        }
      }
      si[i] = bestIdx
      sd[i] = bestIdx < 0 ? 0 : best
    }
    for (const f of forced) {
      si[f.t] = f.bead
      sd[f.t] = this.dist[f.t * this.c + f.bead]
    }
    const deltaE = this.statsFrom(sd, si).weightedAvg
    const loss = this.contrastOf(si)
    return { deltaE, loss, cost: deltaE + (this.config.contrast ?? 0) * loss }
  }

  /**
   * 拆层：把「明明分得开、却压在同一颗豆上」的两个颜色拆到各自的豆上。
   *
   * 为什么不能交给退火：这一步要让某个颜色用一颗「不是最近」的豆。最近色是硬约束，
   * 加豆也没用（新豆离它更远，永远不会被选中）；只有直接钉住分配才能做到。
   * 所以放在收尾：先让 ΔE 把颜色放到最近处，再挑层次损失最大的几对，
   * 一次挪一层、撤掉一颗最不顶用的豆腾位置，按「ΔE + contrast × 层次损失」决定收不收。
   *
   * 两道闸：替代豆必须同色系（否则头发会被染成粉灰）、ΔE 涨幅有上限。
   */
  private splitLayers(budget: number): void {
    if (!this.contrastActive || !this.pairWSum || this.t > AUTO_CONTRAST_MAX_T) return
    const slack = this.config.contrastSlack ?? 5
    // 对比强度越高，越舍得为这一层付颜色代价
    const maxDemote = REPAIR_MAX_DEMOTE + 2 * (this.config.contrast ?? 0)

    const usedBeads = (): Set<number> => {
      const s = new Set<number>()
      for (let i = 0; i < this.t; i++) if (this.nearestI[i] >= 0) s.add(this.nearestI[i])
      return s
    }
    /** 这颗豆是不是某个色相族唯一的一颗（不能撤，撤了整族就没了） */
    const soleHolder = (bead: number): boolean => {
      for (const g of this.families) {
        if (hueGap(this.candH[bead], g.center) > FAMILY_TOLERANCE_DEG) continue
        if (!this.familyHeld(g, bead)) return true
      }
      return false
    }

    for (let round = 0; round < LAYER_SPLIT_ROUNDS; round++) {
      const used = usedBeads()
      // 被压平的对：两端落在同一颗豆上，成品距离恒为 0
      const flat: { i: number; j: number; score: number }[] = []
      for (let i = 0; i < this.t; i++) {
        const a = this.nearestI[i]
        if (a < 0) continue
        for (let p = this.pairStart[i]; p < this.pairStart[i + 1]; p++) {
          const j = this.pairOther[p]
          if (j < i || this.nearestI[j] !== a) continue
          const drop = this.pairOrig[p] - slack
          if (drop > 0) flat.push({ i, j, score: this.pairW[p] * drop })
        }
      }
      if (!flat.length) return
      flat.sort((x, y) => y.score - x.score)

      const beadSet = [...this.selected]
      let bestPlan: { set: number[]; t: number; bead: number } | null = null
      let bestCost = this.currentCost()

      for (const f of flat.slice(0, REPAIR_PAIRS)) {
        for (const t of [f.i, f.j]) {
          const b = this.nearestI[t]
          if (b < 0) continue
          const base = t * this.c
          const cands: number[] = []
          for (let cc = 0; cc < this.c; cc++) {
            if (cc === b || this.fixed.has(cc) || beadSet.includes(cc)) continue
            if (!this.sameHueFamily(cc, b)) continue
            if (this.dist[base + cc] - this.dist[base + b] > maxDemote) continue
            cands.push(cc)
          }
          cands.sort((x, y) => this.dist[base + x] - this.dist[base + y])
          for (const cc of cands.slice(0, LAYER_SPLIT_TRIES)) {
            // 腾一颗豆的位置：预算没用满就直接加，否则撤掉一颗（撤谁最后比分数决定）
            const sets: number[][] = []
            if (used.size < budget) sets.push([...beadSet, cc])
            else
              for (const donor of beadSet) {
                if (this.fixed.has(donor) || donor === b) continue
                if (soleHolder(donor)) continue
                sets.push(beadSet.filter((x) => x !== donor).concat([cc]))
              }
            for (const set of sets) {
              const sc = this.scoreOf(set, [{ t, bead: cc }])
              if (sc.cost < bestCost - 1e-9) {
                bestCost = sc.cost
                bestPlan = { set, t, bead: cc }
              }
            }
          }
        }
      }

      if (!bestPlan) return
      this.setState(bestPlan.set)
      this.rebuildNearest()
      // 钉住这一块：它不是最近的豆，这正是「为了保住这一层」付的代价
      this.nearestI[bestPlan.t] = bestPlan.bead
      this.nearestD[bestPlan.t] = this.dist[bestPlan.t * this.c + bestPlan.bead]
      this.currentContrast = this.contrastOf(this.nearestI)
      this.bestSelected = [...this.selected]
    }
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
    if (!this.config.fillBudget) return

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
          // 这颗目标色自己的「空位」：最近的、还没被别的豆占用的候选色。
          // 先只找同色相的空位，实在没有才放开 —— 补色时把颜色挪到隔壁色相，
          // 正是图纸上「这一格颜色不对」最常见的来源。
          let bead = -1
          let best = Infinity
          const wantHue = this.targetC[i] >= FAMILY_MIN_CHROMA
          for (let pass = 0; pass < 2; pass++) {
            if (pass === 1 && !wantHue) break
            for (let j = 0; j < this.c; j++) {
              if (used.has(j)) continue
              if (
                pass === 0 &&
                (this.candC[j] < FAMILY_MIN_CHROMA ||
                  hueGap(this.candH[j], this.targetH[i]) > FAMILY_TOLERANCE_DEG)
              ) {
                continue
              }
              const d = this.dist[base + j]
              if (d < best) {
                best = d
                bead = j
              }
            }
            if (bead >= 0) break
          }
          if (bead < 0) continue
          // 代价 = 这个颜色换到新豆上多出来的 ΔE。超上限就不补：
          // 少用一个色号，比在图上撒几颗不该有的豆要好。
          const cost = best - cur
          if (cost > FILL_MAX_COST) continue
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

  /**
   * 自动色数：前向贪心扫一遍「每多一颗豆，分数降到多少」，再取曲线拐点。
   *
   * 分数 = 加权 ΔE + contrast × 层次损失 —— 和退火用的目标函数是同一条。
   * 只按 ΔE 扫的话，图省事会得出「头发三层压成两层也差不多」的结论，于是少买一颗豆。
   *
   * 为什么不按「ΔE 低于某个阈值就停」：不同图的 ΔE 量级差太多（8 色像素画和照片
   * 不是一个尺度），阈值没法通用；拐点是尺度无关的 —— 拐点之后再买颜色，画面几乎
   * 不变，只是多备几种豆。
   *
   * 另外再兜一道底线：每一步至少得买回 AUTO_MIN_GAIN 的分数，曲线还在陡降就说明
   * 拐点取早了。
   */
  private autoBudget(maxK: number): { k: number; curve: { k: number; deltaE: number }[] } {
    const chosen: number[] = []
    const nearest = new Float64Array(this.t).fill(Infinity)
    /** 每个目标色当前落在第几颗豆上（-1 = 还没有豆） */
    const assign = new Int32Array(this.t).fill(-1)
    const curve: { k: number; deltaE: number; score: number }[] = []
    const wContrast = this.config.contrast ?? 0
    // 目标色特别多时（照片类）两两比较太贵，退回只看 ΔE
    const useContrast = wContrast > 0 && this.pairWSum > 0 && this.t <= AUTO_CONTRAST_MAX_T
    const trial = useContrast ? new Int32Array(this.t) : assign

    const add = (j: number) => {
      chosen.push(j)
      for (let i = 0; i < this.t; i++) {
        const d = this.dist[i * this.c + j]
        if (d < nearest[i]) {
          nearest[i] = d
          assign[i] = j
        }
      }
    }
    let weighted = 0
    const refreshWeighted = () => {
      let sum = 0
      for (let i = 0; i < this.t; i++) sum += nearest[i] * this.weights[i]
      weighted = this.weightSum > 0 ? sum / this.weightSum : 0
      return weighted
    }
    const scoreOf = (deltaE: number, asg: Int32Array) =>
      deltaE + (useContrast ? wContrast * this.contrastOf(asg) : 0)
    const push = () => {
      const de = refreshWeighted()
      curve.push({ k: chosen.length, deltaE: de, score: scoreOf(de, assign) })
    }

    for (const j of this.fixed) add(j)

    // 一颗都没有时先挑「加权距离之和最小」的那颗，否则增益全是 Infinity，比不出大小
    if (!chosen.length) {
      let bestC = 0
      let bestScore = Infinity
      for (let j = 0; j < this.c; j++) {
        let sum = 0
        for (let i = 0; i < this.t; i++) sum += this.dist[i * this.c + j] * this.weights[i]
        if (sum < bestScore) {
          bestScore = sum
          bestC = j
        }
      }
      add(bestC)
    }
    push()

    // 扫到曲线平了就不用再往下算了：拐点一定在陡降段结束之前，
    // 继续扫只是白花时间（上限 120 色 × 291 候选 × 1200 目标色就是几千万次）
    let flat = 0
    while (chosen.length < maxK) {
      let bestJ = -1
      let bestScore = Infinity
      const deNow = refreshWeighted()
      for (let j = 0; j < this.c; j++) {
        if (chosen.includes(j)) continue
        // 这颗豆会把哪些目标色从原来的豆上抢过来，加权 ΔE 因此降多少
        let gainW = 0
        let moved = false
        if (useContrast) trial.set(assign)
        for (let i = 0; i < this.t; i++) {
          const d = this.dist[i * this.c + j]
          if (d < nearest[i]) {
            gainW += (nearest[i] - d) * this.weights[i]
            moved = true
            if (useContrast) trial[i] = j
          }
        }
        if (!moved) continue
        const deAfter = deNow - gainW / (this.weightSum || 1)
        const score = scoreOf(deAfter, useContrast ? trial : assign)
        if (score < bestScore) {
          bestScore = score
          bestJ = j
        }
      }
      if (bestJ < 0) break
      const prevScore = curve[curve.length - 1].score
      add(bestJ)
      push()
      // 分数涨幅太小就是「白备一颗豆」
      flat = prevScore - curve[curve.length - 1].score < AUTO_MIN_GAIN ? flat + 1 : 0
      if (flat >= 3) break
    }

    if (curve.length < 3) return { k: chosen.length, curve }

    // 拐点：离「首尾连线」最远的点（Kneedle）。比的是分数（ΔE + 层次损失）
    const first = curve[0]
    const last = curve[curve.length - 1]
    let knee = last.k
    let bestGap = -Infinity
    for (const p of curve) {
      const line =
        last.k > first.k
          ? ((first.score - last.score) * (p.k - first.k)) / (last.k - first.k) + first.score
          : first.score
      const gap = line - p.score
      if (gap > bestGap) {
        bestGap = gap
        knee = p.k
      }
    }

    let floorK = curve[0].k
    for (let i = 1; i < curve.length; i++) {
      if (curve[i - 1].score - curve[i].score < AUTO_MIN_GAIN) break
      floorK = curve[i].k
    }

    return { k: Math.max(knee, floorK), curve }
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
    let objective = this.currentCost()

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
          const obj = this.costOf(stats, this.scratchContrast)
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
        budget: 0,
        contrast: 0,
      }
      return
    }

    const cap = Math.max(this.fixed.size + 1, Math.min(cfg.k + this.fixed.size, this.c))
    let budget = Math.max(this.fixed.size, Math.min(cfg.k + this.fixed.size, this.c))
    let curve: { k: number; deltaE: number }[] | undefined
    if (cfg.kMode === 'auto') {
      // 自动模式：先扫曲线定色数，之后的退火还是照常跑一遍（贪心解只是起点）
      const plan = this.autoBudget(cap)
      budget = Math.max(this.fixed.size + 1, Math.min(plan.k, cap))
      curve = plan.curve
    }
    const init = cfg.greedyInit ? this.greedyInit(budget) : this.randomInit(budget)
    this.setState(init)
    this.rebuildNearest()

    let currentObjective = this.currentCost()
    let bestObjective = currentObjective
    this.bestSelected = [...this.selected]

    yield {
      type: 'initialized',
      stats: this.statsFrom(this.nearestD, this.nearestI),
      selected: [...this.selected],
      candidates: this.c,
      budget,
      curve,
    }

    // 候选之间的对称距离（library 模式用于局部邻域搜索；层次损失也用它）
    let candidateDist: Float64Array | null = null
    if (this.targetMode === 'library') {
      this.ensureCandDist()
      candidateDist = this.candDist
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
      const nextObjective = this.costOf(stats, this.scratchContrast)

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
      const polishedObjective = this.currentCost()
      if (polishedObjective <= bestObjective + 1e-9) {
        bestObjective = polishedObjective
        this.bestSelected = [...this.selected]
      }
    }

    this.setState(this.bestSelected)
    this.rebuildNearest()
    this.running = false

    // 结果色号数是「预算」和「原图颜色数」里小的那个；优化出来的解没用到这么多时，
    // 只有在代价可控的情况下才补（fillToBudget 里的两道闸）。
    const resultBudget = Math.max(this.fixed.size, Math.min(budget, this.t))
    this.ensureFamilies(resultBudget)
    this.fillToBudget(resultBudget)
    // 最后才合并近似豆：补色可能又塞进一颗「看起来一样」的豆，顺序反了就白合并
    this.mergeLookalikes()
    // 最后拆层：这一步会故意把某些颜色钉到「不是最近」的豆上，所以必须排在所有
    // 「按最近色重算」的收尾之后；拆完的分配就是最终图，别再 rebuildNearest
    this.splitLayers(resultBudget)
    if (this.contrastActive) this.currentContrast = this.contrastOf(this.nearestI)

    const mapping: { key: number; hex: string }[] = []
    for (let i = 0; i < this.t; i++) {
      const j = this.nearestI[i]
      if (j < 0) continue
      const hex = this.entries[j].hex
      const keys = this.targetGroupKeys[i]
      if (keys && keys.length) for (const key of keys) mapping.push({ key, hex })
      else mapping.push({ key: this.targetKeys[i], hex })
    }

    yield {
      type: 'completed',
      stats: this.statsFrom(this.nearestD, this.nearestI),
      selected: this.resultSelection(),
      mapping,
      steps: step,
      reason,
      budget: this.resultSelection().length,
      contrast: this.currentContrast,
    }
  }
}
