import type { Pixmap } from './types.ts'

/**
 * 探测「设计稿被整数倍放大」的倍数。
 *
 * 思路：先算两条边界差异表 ——
 *   colDiff[x] = 是否存在某行在 x-1 / x 之间颜色不同
 *   rowDiff[y] = 是否存在某列在 y-1 / y 之间颜色不同
 * 那么 N×N 块内颜色一致 ⟺ 所有不是 N 的整数倍的列/行都没有差异。
 * 一次 O(w·h) 扫描 + 每个候选 N 的 O(w+h) 检查，比逐块比较快得多。
 *
 * 返回可以被整除的最大倍数；没有明显放大时返回 1。
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

/** 把 N×N 像素块取左上角像素，压成一张 1 格 = 1 豆的图 */
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
