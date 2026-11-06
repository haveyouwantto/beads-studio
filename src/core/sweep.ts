import type { OptimizeConfig } from './optimize.ts'

/**
 * 多方案参数对比变体生成。
 */
export type SweepAxis = 'algo' | 'budget' | 'mixed'

export const SWEEP_AXES: { value: SweepAxis; label: string; hint: string }[] = [
  { value: 'algo', label: '算法', hint: '换几种配色思路各出一张，挑顺眼的' },
  { value: 'budget', label: '色数', hint: '只动豆色数量，配法不变' },
  { value: 'mixed', label: '综合', hint: '推荐 / 省豆 / 忠实 / 自动，各来一张' },
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
    // 排第一的是实验室终审冠军（默认配置）
    return [
      { id: 'lab-euclid', label: '推荐 · 颜色最准', hint: '实验室 12 张图测出来的最优配法（也是默认设置）', patch: { colorSpace: 'lab', distance: 'euclidean' } },
      { id: 'yuv-manhattan', label: '最不容易花', hint: '同色区域整片用一颗豆，最不容易碎成花斑', patch: { colorSpace: 'yuv', distance: 'manhattan' } },
      { id: 'yuv-euclid', label: '均衡', hint: '「准」和「不花」之间的折中', patch: { colorSpace: 'yuv', distance: 'euclidean' } },
      { id: 'lab-manhattan', label: '准而不碎', hint: '和推荐接近，但整片感更好一点', patch: { colorSpace: 'lab', distance: 'manhattan' } },
      { id: 'wrgb-euclid', label: '原版对照', hint: '原版拼豆工具的配法，放这对比用', patch: { colorSpace: 'weightedRgb', distance: 'euclidean' } },
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

  // 综合方案：推荐（当前设置）排第一
  const k = cfg.k
  const lean = scaleK(k, 0.7)
  return [
    {
      id: 'm-balanced',
      label: '推荐 · 当前设置',
      hint: '就用现在面板上的设置跑一张',
      patch: {},
    },
    {
      id: 'm-sparse',
      label: '省豆',
      hint: `${lean} 色：买豆便宜，观感略粗`,
      patch: { kMode: 'fixed', k: lean },
    },
    {
      id: 'm-faithful',
      label: '忠实原色',
      hint: '不做整片归并，逐色找最近的豆：最像原图，但同色区域容易碎成花斑',
      patch: { clusterRadius: 0, kMode: 'fixed' },
    },
    {
      id: 'm-auto',
      label: '自动挑最少',
      hint: `上限 ${k} 色，豆色加到不再明显变好就自动停`,
      patch: { kMode: 'auto' },
    },
  ]
}
