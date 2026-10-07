import type { Pixmap, Rect } from './types.ts'

/** 裁剪框最小边长（像素），防止拖成一条线 */
export const MIN_CROP = 8

/**
 * 把裁剪框夹进图片范围内。
 * 注意这里不设最小边长：能不能裁 1px 是调用方的事
 * （拖拽时用 MIN_CROP 兜底，程序给定的框照原样裁）。
 */
export function clampRect(rect: Rect, width: number, height: number): Rect {
  const w = Math.max(1, Math.min(Math.round(rect.width), width))
  const h = Math.max(1, Math.min(Math.round(rect.height), height))
  const x = Math.max(0, Math.min(Math.round(rect.x), width - w))
  const y = Math.max(0, Math.min(Math.round(rect.y), height - h))
  return { x, y, width: w, height: h }
}

/**
 * 矩形裁剪。上传图片时的预处理用 —— 只切矩形，不缩放、不旋转。
 * 返回新的像素缓冲，原图不动。
 */
export function cropPixmap(img: Pixmap, rect: Rect): Pixmap {
  const r = clampRect(rect, img.width, img.height)
  const out = new Uint8ClampedArray(r.width * r.height * 4)
  for (let y = 0; y < r.height; y++) {
    const from = ((r.y + y) * img.width + r.x) * 4
    out.set(img.data.subarray(from, from + r.width * 4), y * r.width * 4)
  }
  return { width: r.width, height: r.height, data: out }
}
