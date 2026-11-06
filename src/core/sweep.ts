import type { OptimizeConfig } from './optimize.ts'

/**
 * 多方案参数对比变体生成。
 */
export type SweepAxis = 'algo' | 'budget' | 'mixed'

export const SWEEP_AXES: { value: SweepAxis; label: string; hint: string }[] = [
  { value: 'algo', label: '算法', hint: '不同「色彩空间 × 距离」组合各出一张' },
  { value: 'budget', label: '色数', hint: '只动颜料预算，算法设置不变' },
  { value: 'mixed', label: '综合', hint: '省豆 / 均衡 / 忠实 / 自动，各来一张' },
]

export interface SweepVariant {
  id: string
  label: string
  hint: string
  patch: Partial<OptimizeConfig>
}

/** 预算按比例取整，至少 2 色 */
function scaleK(k: number, factor: number): number {
  return Math.max(2, Math.round(k * factor))
}

/**
 * 根据指定对比轴生成候选参数变体。
 */
export function sweepVariants(axis: SweepAxis, cfg: OptimizeConfig): SweepVariant[] {
  if (axis === 'algo') {
    // quant-lab 实验矩阵里有区分度的五个组合：YUV 曼哈顿（拆色最低）、
    // Lab 欧氏（精度最高）、YUV 欧氏（均衡）、Lab 曼哈顿、加权RGB 欧氏（原版度量）
    return [
      { id: 'yuv-manhattan', label: 'YUV·曼哈顿', hint: '实验综合冠军：最不容易花', patch: { colorSpace: 'yuv', distance: 'manhattan' } },
      { id: 'lab-euclid', label: 'Lab·欧氏', hint: '精度冠军：ΔE 最低', patch: { colorSpace: 'lab', distance: 'euclidean' } },
      { id: 'yuv-euclid', label: 'YUV·欧氏', hint: '两项之间的均衡选择', patch: { colorSpace: 'yuv', distance: 'euclidean' } },
      { id: 'lab-manhattan', label: 'Lab·曼哈顿', hint: '感知空间 + 抗花距离', patch: { colorSpace: 'lab', distance: 'manhattan' } },
      { id: 'wrgb-euclid', label: '加权RGB·欧氏', hint: '原版工具的度量，作对照', patch: { colorSpace: 'weightedRgb', distance: 'euclidean' } },
    ]
  }

  if (axis === 'budget') {
    const k = cfg.k
    const spots = [scaleK(k, 0.7), scaleK(k, 0.85), k, scaleK(k, 1.3)]
    const seen = new Set<number>()
    const out: SweepVariant[] = []
    for (const n of spots) {
      if (seen.has(n)) continue
      seen.add(n)
      out.push({
        id: `k${n}`,
        label: `${n} 色`,
        hint: n === k ? '当前预算' : n < k ? `预算比现在少 ${k - n} 色` : `预算比现在多 ${n - k} 色`,
        patch: { kMode: 'fixed', k: n },
      })
    }
    return out
  }

  // 综合方案
  const k = cfg.k
  const lean = scaleK(k, 0.7)
  return [
    {
      id: 'm-sparse',
      label: '省豆',
      hint: `${lean} 色：颜色少、买豆便宜，观感略粗`,
      patch: { kMode: 'fixed', k: lean },
    },
    { id: 'm-balanced', label: '均衡', hint: `当前设置原样跑一张`, patch: {} },
    {
      id: 'm-faithful',
      label: '忠实原色',
      hint: '不聚类逐色最近匹配：最像原图，但同色片段容易花',
      patch: { clusterRadius: 0, kMode: 'fixed' },
    },
    {
      id: 'm-auto',
      label: '自动挑最少',
      hint: `上限 ${k} 色，按 ΔE 收益拐点自动停`,
      patch: { kMode: 'auto' },
    },
  ]
}
