import type { StageId } from '../store/studio.ts'

/**
 * 三个阶段的标签与图标。
 * 侧边导航和页面标题共用同一份定义，避免两处各写一遍图标名。
 */
export const STAGE_META: Record<StageId, { label: string; icon: string }> = {
  regularize: { label: '规范化', icon: 'center_focus_strong' },
  optimize: { label: '优化颜色', icon: 'palette' },
  pattern: { label: '转拼豆图纸', icon: 'grid_on' },
}

/** 阶段顺序（快捷键 1/2/3、上一步/下一步都按这个来） */
export const STAGE_ORDER: StageId[] = ['regularize', 'optimize', 'pattern']
