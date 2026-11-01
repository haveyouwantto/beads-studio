import type { OptimizeConfig } from './optimize.ts'

/**
 * 多方案参数对比变体生成。
 */
export type SweepAxis = 'layers' | 'budget' | 'mixed'

export const SWEEP_AXES: { value: SweepAxis; label: string; hint: string }[] = [
  { value: 'mixed', label: '综合', hint: '省豆 / 均衡 / 忠实 / 保层次，各来一张' },
  { value: 'layers', label: '明暗层次', hint: '只动「明暗层次保留」0～4' },
  { value: 'budget', label: '色数', hint: '只动颜料预算，层次设置不变' },
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

  if (axis === 'layers') {
    return [
      { id: 'c0', label: '只求像', hint: '层次 0：ΔE 最低', patch: { contrast: 0 } },
      { id: 'c1', label: '略保层次', hint: '层次 1：救损失最大的处所', patch: { contrast: 1 } },
      { id: 'c2', label: '均衡', hint: '层次 2：默认设置', patch: { contrast: 2 } },
      { id: 'c4', label: '强保层次', hint: '层次 4：宁可增加预算也要保住明暗', patch: { contrast: 4 } },
    ]
  }

  // 综合方案
  const k = cfg.k
  const lean = scaleK(k, 0.75)
  return [
    {
      id: 'm-sparse',
      label: '省豆',
      hint: `预算 ${lean} 色 · 层次 1：颜色少但明暗不至于模糊`,
      patch: { kMode: 'fixed', k: lean, contrast: 1 },
    },
    { id: 'm-balanced', label: '均衡', hint: `预算 ${k} 色 · 层次 2：默认设置`, patch: { kMode: 'fixed', k, contrast: 2 } },
    {
      id: 'm-faithful',
      label: '忠实原色',
      hint: `预算 ${k} 色 · 层次 0：追求颜色匹配最精准`,
      patch: { kMode: 'fixed', k, contrast: 0 },
    },
    {
      id: 'm-layers',
      label: '保层次',
      hint: `预算 ${k} 色 · 层次 4：最大限度保留明暗细节`,
      patch: { kMode: 'fixed', k, contrast: 4 },
    },
  ]
}
