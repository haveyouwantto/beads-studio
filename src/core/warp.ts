import { aggregateSamples } from './regularize.ts'
import type { Pixmap, Pt, Quad, SampleMode } from './types.ts'

/**
 * 手动四角对齐采样。
 *
 * 格的四个角先用双线性插值映射到源图，得到一个四边形；
 * 再按 `mode` 决定怎么取色（和「自动识别」共用同一套取样方式）：
 * - center：只取格中心那一个像素（默认，最不容易被格子缝里的杂色带偏）
 * - mean / median / geometric / mode：把四边形覆盖到的像素合起来
 *
 * 对应旧「拼豆工具箱」的角点拖拽流程，适合拍照有透视 / 旋转、
 * 自动周期检测不可靠的场景。
 */
export function sampleQuad(
  img: Pixmap,
  corners: Quad,
  cols: number,
  rows: number,
  mode: SampleMode = 'center',
): Pixmap {
  const w = Math.max(1, Math.round(cols))
  const h = Math.max(1, Math.round(rows))
  const out = new Uint8ClampedArray(w * h * 4)
  const src = img.data
  const sw = img.width
  const sh = img.height

  const [tl, tr, br, bl] = corners

  /** 四边形内部按 (u,v) 双线性插值出源图坐标 */
  const at = (u: number, v: number): Pt => {
    const tx = tl.x + (tr.x - tl.x) * u
    const ty = tl.y + (tr.y - tl.y) * u
    const bx = bl.x + (br.x - bl.x) * u
    const by = bl.y + (br.y - bl.y) * u
    return { x: tx + (bx - tx) * v, y: ty + (by - ty) * v }
  }

  const pixelAt = (px: number, py: number): [number, number, number, number] | null => {
    if (px < 0 || px >= sw || py < 0 || py >= sh) return null
    const idx = (py * sw + px) * 4
    return [src[idx], src[idx + 1], src[idx + 2], src[idx + 3]]
  }

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const target = (y * w + x) * 4

      // 格中心：所有模式都用它兜底（格子太小时平均取不到任何像素）
      const center = at((x + 0.5) / w, (y + 0.5) / h)
      const fallback = pixelAt(Math.floor(center.x), Math.floor(center.y))

      let color: [number, number, number, number]
      if (mode === 'center') {
        color = fallback ?? [0, 0, 0, 255]
      } else {
        const quad = [at(x / w, y / h), at((x + 1) / w, y / h), at((x + 1) / w, (y + 1) / h), at(x / w, (y + 1) / h)]
        const samples = pixelsInQuad(quad, sw, sh, src)
        color = samples.length ? aggregateSamples(samples, mode) : (fallback ?? [0, 0, 0, 255])
      }

      out[target] = Math.round(Math.max(0, Math.min(255, color[0])))
      out[target + 1] = Math.round(Math.max(0, Math.min(255, color[1])))
      out[target + 2] = Math.round(Math.max(0, Math.min(255, color[2])))
      out[target + 3] = Math.round(Math.max(0, Math.min(255, color[3])))
    }
  }

  return { width: w, height: h, data: out }
}

/** 四边形（凸的，四个角按顺序）覆盖到的像素：按像素中心点判断在不在里面 */
function pixelsInQuad(quad: Pt[], width: number, height: number, src: Uint8ClampedArray): number[][] {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const p of quad) {
    if (p.x < minX) minX = p.x
    if (p.y < minY) minY = p.y
    if (p.x > maxX) maxX = p.x
    if (p.y > maxY) maxY = p.y
  }

  const x0 = Math.max(0, Math.floor(minX))
  const x1 = Math.min(width - 1, Math.ceil(maxX))
  const y0 = Math.max(0, Math.floor(minY))
  const y1 = Math.min(height - 1, Math.ceil(maxY))

  const samples: number[][] = []
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      if (!inQuad(quad, x + 0.5, y + 0.5)) continue
      const idx = (y * width + x) * 4
      samples.push([src[idx], src[idx + 1], src[idx + 2], src[idx + 3]])
    }
  }
  return samples
}

/** 射线法：点是否在多边形内 */
function inQuad(quad: Pt[], px: number, py: number): boolean {
  let inside = false
  for (let i = 0, j = quad.length - 1; i < quad.length; j = i++) {
    const a = quad[i]
    const b = quad[j]
    if (a.y > py !== b.y > py && px < ((b.x - a.x) * (py - a.y)) / (b.y - a.y) + a.x) inside = !inside
  }
  return inside
}

/** 默认四角：向内收缩 20%，与原工具一致 */
export function defaultCorners(width: number, height: number, inset = 0.2): Quad {
  const padX = width * inset
  const padY = height * inset
  return [
    { x: padX, y: padY },
    { x: width - padX, y: padY },
    { x: width - padX, y: height - padY },
    { x: padX, y: height - padY },
  ]
}

/** 按四角构成的四边形估算每个格子的平均边长，用于给出手动模式的默认行列数 */
export function estimateCellSize(corners: Quad, cols: number, rows: number): { w: number; h: number } {
  const [tl, tr, br, bl] = corners
  const topW = Math.hypot(tr.x - tl.x, tr.y - tl.y)
  const botW = Math.hypot(br.x - bl.x, br.y - bl.y)
  const leftH = Math.hypot(bl.x - tl.x, bl.y - tl.y)
  const rightH = Math.hypot(br.x - tr.x, br.y - tr.y)
  return { w: (topW + botW) / 2 / Math.max(1, cols), h: (leftH + rightH) / 2 / Math.max(1, rows) }
}

/** 把点限制在图像范围内 */
export function clampPoint(p: Pt, width: number, height: number): Pt {
  return { x: Math.max(0, Math.min(width, p.x)), y: Math.max(0, Math.min(height, p.y)) }
}
