import type { Pixmap } from './types.ts'

/**
 * 探测图像是否为整数倍放大的像素块网格。
 *
 * 通过扫描行与列边界，检测最大无损压缩块尺寸。
 */
export function detectUniformBlock(img: Pixmap, maxBlock = 64): number {
  const { width: w, height: h, data } = img
  if (w < 2 || h < 2) return 1

  const colDiff = new Uint8Array(w)
  const rowDiff = new Uint8Array(h)

  for (let y = 0; y < h; y++) {
    const row = y * w * 4
    for (let x = 1; x < w; x++) {
      if (colDiff[x]) continue
      const a = row + x * 4
      const b = a - 4
      if (data[a] !== data[b] || data[a + 1] !== data[b + 1] || data[a + 2] !== data[b + 2]) {
        colDiff[x] = 1
      }
    }
  }

  for (let y = 1; y < h; y++) {
    const row = y * w * 4
    const prev = row - w * 4
    for (let x = 0; x < w; x++) {
      const a = row + x * 4
      const b = prev + x * 4
      if (data[a] !== data[b] || data[a + 1] !== data[b + 1] || data[a + 2] !== data[b + 2]) {
        rowDiff[y] = 1
        break
      }
    }
  }

  const limit = Math.min(maxBlock, w, h)
  for (let n = limit; n >= 2; n--) {
    if (w % n !== 0 || h % n !== 0) continue

    let ok = true
    for (let x = 1; x < w && ok; x++) {
      if (x % n !== 0 && colDiff[x]) ok = false
    }
    for (let y = 1; y < h && ok; y++) {
      if (y % n !== 0 && rowDiff[y]) ok = false
    }
    if (ok) return n
  }

  return 1
}

/** 像素块坍缩：按块大小取样左上角像素 */
export function collapseBlocks(img: Pixmap, block: number): Pixmap {
  const n = Math.max(1, Math.round(block))
  if (n === 1) {
    return { width: img.width, height: img.height, data: new Uint8ClampedArray(img.data) }
  }

  const w = Math.floor(img.width / n)
  const h = Math.floor(img.height / n)
  const out = new Uint8ClampedArray(w * h * 4)
  const src = img.data
  const sw = img.width

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const s = (y * n * sw + x * n) * 4
      const t = (y * w + x) * 4
      out[t] = src[s]
      out[t + 1] = src[s + 1]
      out[t + 2] = src[s + 2]
      out[t + 3] = src[s + 3]
    }
  }

  return { width: w, height: h, data: out }
}
