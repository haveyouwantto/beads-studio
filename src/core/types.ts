/** 二维点（图像像素坐标） */
export interface Pt {
  x: number
  y: number
}

/** RGB / RGBA 三元组、四元组 */
export type RGB = [number, number, number]
export type RGBA = [number, number, number, number]

/** 与 DOM 无关的像素缓冲，便于在浏览器与 Node 中复用同一套算法 */
export interface Pixmap {
  width: number
  height: number
  /** RGBA，长度 = width * height * 4 */
  data: Uint8ClampedArray
}

/** 矩形（像素坐标，原点在左上角） */
export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/** 格内取样方式（对应 pixelart-regualizer 的 sampleMode） */
export type SampleMode = 'center' | 'mean' | 'median' | 'geometric' | 'mode'

export const SAMPLE_MODE_LABELS: Record<SampleMode, string> = {
  center: '中心点',
  mean: '算术平均',
  median: '中位数',
  geometric: '几何平均',
  mode: '众数（按频率）',
}

/** 四角顺序：左上 → 右上 → 右下 → 左下 */
export type Quad = [Pt, Pt, Pt, Pt]

export function clonePixmap(p: Pixmap): Pixmap {
  return { width: p.width, height: p.height, data: new Uint8ClampedArray(p.data) }
}

export function emptyPixmap(width: number, height: number): Pixmap {
  return { width, height, data: new Uint8ClampedArray(width * height * 4) }
}
