import { STAGE_ORDER, type StageId } from '../store/studio.ts'

/**
 * 阶段标签与图标元数据。
 */
export const STAGE_META: Record<StageId, { label: string; icon: string }> = {
  regularize: { label: '规范化', icon: 'center_focus_strong' },
  edit: { label: '编辑', icon: 'brush' },
  optimize: { label: '优化颜色', icon: 'palette' },
  pattern: { label: '转拼豆图纸', icon: 'grid_on' },
}

/** 阶段顺序（快捷键 1/2/3/4、上一步/下一步都按这个来） */
export { STAGE_ORDER }
