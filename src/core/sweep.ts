import type { OptimizeConfig } from './optimize.ts'

/**
 * 多方案对比：一次跑几套参数，各出一张成品，肉眼看哪张顺眼。
 *
 * 为什么不做「网格搜索最优解」：目标函数只是代理指标 —— 平均 ΔE 最低的那张
 * 常常不是最好看的那张（层次被压平、色相跑偏都能把 ΔE 做得很好看）。
 * 所以这里只给出少量「性格不同」的方案，挑哪张交给人。
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

/** 预算按比例取整，至少 2 色（1 色没有比较的意义） */
function scaleK(k: number, factor: number): number {
  return Math.max(2, Math.round(k * factor))
}

/**
 * 生成一套方案。四套为宜：再多就挑花眼，也白等时间。
 *
 * 种子固定不变 —— 同一套参数跑两次结果应当一样，换种子属于「碰运气」，
 * 需要的话用户自己改随机种子再单独跑。
 */
export function sweepVariants(axis: SweepAxis, cfg: OptimizeConfig): SweepVariant[] {
  if (axis === 'budget') {
    // 自动色数模式下 K 只是上限，比色数没意义，一律按固定数量跑
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
        // 说「预算」而不是「色数」：固定包含的黑白是额外的，最终颗数可能多两颗
        hint: n === k ? '当前预算' : n < k ? `预算比现在少 ${k - n} 色` : `预算比现在多 ${n - k} 色`,
        patch: { kMode: 'fixed', k: n },
      })
    }
    return out
  }

  if (axis === 'layers') {
    return [
      { id: 'c0', label: '只求像', hint: '层次 0：明暗被压平也不罚，ΔE 最低', patch: { contrast: 0 } },
      { id: 'c1', label: '略保层次', hint: '层次 1：只救损失最大的那几处', patch: { contrast: 1 } },
      { id: 'c2', label: '均衡', hint: '层次 2：默认档', patch: { contrast: 2 } },
      { id: 'c4', label: '强保层次', hint: '层次 4：宁可多花一颗豆也要保住明暗', patch: { contrast: 4 } },
    ]
  }

  // 综合：预算和层次各让一步，四种「性格」
  const k = cfg.k
  const lean = scaleK(k, 0.75)
  return [
    {
      id: 'm-sparse',
      label: '省豆',
      hint: `预算 ${lean} 色 · 层次 1：颜色少，但明暗不至于糊成一片`,
      patch: { kMode: 'fixed', k: lean, contrast: 1 },
    },
    { id: 'm-balanced', label: '均衡', hint: `预算 ${k} 色 · 层次 2：默认档`, patch: { kMode: 'fixed', k, contrast: 2 } },
    {
      id: 'm-faithful',
      label: '忠实原色',
      hint: `预算 ${k} 色 · 层次 0：只追求每颗豆都最接近原色`,
      patch: { kMode: 'fixed', k, contrast: 0 },
    },
    {
      id: 'm-layers',
      label: '保层次',
      hint: `预算 ${k} 色 · 层次 4：头发、嘴唇的明暗层尽量一层不丢`,
      patch: { kMode: 'fixed', k, contrast: 4 },
    },
  ]
}
