import type { Pixmap, Pt, Quad } from './types.ts'

/**
 * 手动四角对齐采样。
 * 对目标格的每个中心点 (u,v) 做双线性插值求源图坐标，
 * 再取该像素颜色 —— 对应旧「拼豆工具箱」的角点拖拽流程。
 * 适合拍照有透视 / 旋转、自动周期检测不可靠的场景。
 */
export function sampleQuad(img: Pixmap, corners: Quad, cols: number, rows: number): Pixmap {
  const w = Math.max(1, Math.round(cols))
  const h = Math.max(1, Math.round(rows))
  const out = new Uint8ClampedArray(w * h * 4)
  const src = img.data
  const sw = img.width
  const sh = img.height

  const [tl, tr, br, bl] = corners

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const u = (x + 0.5) / w
      const v = (y + 0.5) / h

      // 上边 / 下边在当前 u 处的插值点，再沿 v 插值
      const tx = tl.x + (tr.x - tl.x) * u
      const ty = tl.y + (tr.y - tl.y) * u
      const bx = bl.x + (br.x - bl.x) * u
      const by = bl.y + (br.y - bl.y) * u

      const sx = Math.floor(tx + (bx - tx) * v)
      const sy = Math.floor(ty + (by - ty) * v)

      const target = (y * w + x) * 4
      if (sx >= 0 && sx < sw && sy >= 0 && sy < sh) {
        const idx = (sy * sw + sx) * 4
        out[target] = src[idx]
        out[target + 1] = src[idx + 1]
        out[target + 2] = src[idx + 2]
        out[target + 3] = src[idx + 3]
      } else {
        out[target] = 0
        out[target + 1] = 0
        out[target + 2] = 0
        out[target + 3] = 255
      }
    }
  }

  return { width: w, height: h, data: out }
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
