/**
 * 像素编辑（规范化之后、优化颜色之前的那一步）。
 *
 * 约定：**alpha = 0 的格子表示「忽略」** —— 它不是一颗豆，既不参与配色优化，
 * 也不会出现在图纸和用料清单里（画布上会画成棋盘格让它一眼可辨）。
 * 用 alpha 而不是另一个 mask 字段，好处是它天然跟着网格一起存档、一起传下去。
 */
import { deltaE, hexToRgb, rgbToLab, rgbToHex } from './color.ts'
import { buildLibraryPalette, KIT_MARD } from './palette.ts'
import type { Pixmap } from './types.ts'

/** alpha 低于这个值就算「忽略」 */
export const IGNORED_ALPHA = 8

export interface EditPreset {
  /** MARD 色号 */
  code: string
  /** 色块显示的颜色 */
  hex: string
  /** true = 这一格涂下去是「忽略」（完全透明），不是上色 */
  transparent?: boolean
}

/**
 * 编辑器预设色板 = **MARD 24 色套装**（`KIT_MARD[24]`），色值取色号库里的真值。
 *
 * 例外是 `H01`：现实中它是透明塑料，所以这里不当作白色，而是「透明（忽略）」那一档 ——
 * 涂下去等于把格子标成不要（不参与配色、不出图）。
 */
const MARD_HEX = new Map(buildLibraryPalette({ includeExtended: true }).map((e) => [e.codes.MARD, e.hex]))

export const EDIT_PRESETS: EditPreset[] = KIT_MARD[24].map((code) =>
  code === 'H01'
    ? { code, hex: '#FFFFFF', transparent: true }
    : { code, hex: MARD_HEX.get(code) ?? '#000000' },
)

/** 「新增色」最多留多少个 */
export const MAX_ADDED_SWATCHES = 24

/**
 * 往「新增色」里加一个颜色：已经有了就不动（不重排），没有就追加到末尾，
 * 超过上限时挤掉最早加进来的那个。返回新数组，不改传进来的。
 */
export function appendSwatch(list: string[], hex: string, max = MAX_ADDED_SWATCHES): string[] {
  if (list.includes(hex)) return list
  return [...list, hex].slice(-max)
}

export function clonePixmap(img: Pixmap): Pixmap {
  return { width: img.width, height: img.height, data: new Uint8ClampedArray(img.data) }
}

/** 这一格是不是被忽略了 */
export function isIgnoredAt(img: Pixmap, x: number, y: number): boolean {
  if (x < 0 || y < 0 || x >= img.width || y >= img.height) return true
  return img.data[(y * img.width + x) * 4 + 3] < IGNORED_ALPHA
}

/** 取这一格的颜色；被忽略时返回 null */
export function readCell(img: Pixmap, x: number, y: number): string | null {
  if (isIgnoredAt(img, x, y)) return null
  const i = (y * img.width + x) * 4
  return rgbToHex([img.data[i], img.data[i + 1], img.data[i + 2]])
}

/**
 * 写一格。`hex = null` 表示涂成透明（忽略）。
 * 直接改传入的 data，编辑时每拖一下都要写，不能每次复制整块缓冲。
 */
export function writeCell(data: Uint8ClampedArray, width: number, x: number, y: number, hex: string | null): void {
  const i = (y * width + x) * 4
  if (hex === null) {
    data[i] = 0
    data[i + 1] = 0
    data[i + 2] = 0
    data[i + 3] = 0
    return
  }
  const rgb = hexToRgb(hex)
  data[i] = rgb[0]
  data[i + 1] = rgb[1]
  data[i + 2] = rgb[2]
  data[i + 3] = 255
}

/** 被忽略（透明）的格子数 */
export function countIgnored(img: Pixmap): number {
  let n = 0
  for (let i = 3; i < img.data.length; i += 4) if (img.data[i] < IGNORED_ALPHA) n++
  return n
}

/** 图中实际用到的颜色及数量（忽略的格子不计），按数量从多到少 */
export function colorUsage(img: Pixmap): { hex: string; count: number }[] {
  const map = new Map<string, number>()
  for (let i = 0; i < img.data.length; i += 4) {
    if (img.data[i + 3] < IGNORED_ALPHA) continue
    const hex = rgbToHex([img.data[i], img.data[i + 1], img.data[i + 2]])
    map.set(hex, (map.get(hex) ?? 0) + 1)
  }
  return [...map.entries()].map(([hex, count]) => ({ hex, count })).sort((a, b) => b.count - a.count)
}

export interface ColorCluster {
  /** 这一类里出现最多的那个颜色（用它可以照原色继续画） */
  hex: string
  /** 这一类总共多少格 */
  count: number
  /** 这一类合并了几个不同的颜色 */
  merged: number
}

/**
 * 把图里的颜色聚成若干类。
 *
 * 一张照片转出来的网格可能有几百上千种颜色，全列出来没法看。
 * 做法：按出现次数从多到少扫一遍，颜色和已有的类差距在 `maxDeltaE` 以内就并进去，
 * 否则开一个新类；类数到上限后，剩下的都并进最接近的那一类。
 * 阈值取得小（默认 4 个 ΔE）：只并掉肉眼几乎一样的颜色，
 * 刻意用的两种相邻色不会被合掉；颜色上百种时靠「最多 24 类」这个上限来分堆。
 * 代表色取该类里出现最多的那个颜色 —— 是图里真实存在的颜色，不是平均出来的中间色。
 */
export function clusterColors(img: Pixmap, maxClusters = 24, maxDeltaE = 4): ColorCluster[] {
  const usage = colorUsage(img)
  if (!usage.length) return []

  interface Bucket {
    lab: [number, number, number]
    memberHex: string
    memberCount: number
    count: number
    merged: number
  }

  const buckets: Bucket[] = []
  for (const { hex, count } of usage) {
    const rgb = hexToRgb(hex)
    const lab = rgbToLab(rgb)
    let best = -1
    let bestDist = Infinity
    for (let i = 0; i < buckets.length; i++) {
      const d = deltaE(lab, buckets[i].lab)
      if (d < bestDist) {
        bestDist = d
        best = i
      }
    }

    if (best >= 0 && (bestDist <= maxDeltaE || buckets.length >= maxClusters)) {
      const bucket = buckets[best]
      // 代表色按出现次数取最多的那个，不做平均（平均出来的颜色图里没有）
      if (count > bucket.memberCount) {
        bucket.memberHex = hex
        bucket.memberCount = count
      }
      bucket.count += count
      bucket.merged += 1
      continue
    }
    buckets.push({ lab, memberHex: hex, memberCount: count, count, merged: 1 })
  }

  return buckets
    .map((b) => ({ hex: b.memberHex, count: b.count, merged: b.merged }))
    .sort((a, b) => b.count - a.count)
}

/** 油漆桶的两种口径 */
export interface FloodFillOptions {
  /**
   * 'color'：只填和起点颜色一模一样的连通块。
   * 'cluster'：先把每个颜色归到「图中颜色」里最近的那一类，再按类填 ——
   * 抗锯齿边、轻微渐变这些本属同色系的格子会被当成一块。
   */
  mode?: 'color' | 'cluster'
  /** mode === 'cluster' 时用的类，直接用「图中颜色」那一组 */
  clusters?: ColorCluster[]
}

/**
 * 油漆桶：把和起点同色（含同为「忽略」）的连通区域整片换成 `hex`（null = 涂成忽略）。
 * 用显式栈而不是递归，几万格也不会爆栈。
 */
export function floodFill(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  x: number,
  y: number,
  hex: string | null,
  options: FloodFillOptions = {},
): number {
  if (x < 0 || y < 0 || x >= width || y >= height) return 0
  const at = (px: number, py: number) => (py * width + px) * 4

  const start = at(x, y)
  const startIgnored = data[start + 3] < IGNORED_ALPHA
  const target = [data[start], data[start + 1], data[start + 2], data[start + 3]]

  // 按类填：把「这个颜色属于哪一类」算一次就缓存住，一张图来回问很多次
  const clusterLabs =
    options.mode === 'cluster' ? (options.clusters ?? []).map((c) => rgbToLab(hexToRgb(c.hex))) : []
  const clusterCache = new Map<number, number>()
  const clusterOf = (i: number): number => {
    const key = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2]
    const cached = clusterCache.get(key)
    if (cached !== undefined) return cached
    const lab = rgbToLab([data[i], data[i + 1], data[i + 2]])
    let best = 0
    let bestDist = Infinity
    for (let k = 0; k < clusterLabs.length; k++) {
      const d = deltaE(lab, clusterLabs[k])
      if (d < bestDist) {
        bestDist = d
        best = k
      }
    }
    clusterCache.set(key, best)
    return best
  }
  const byCluster = clusterLabs.length > 0
  const startCluster = byCluster ? clusterOf(start) : -1

  const sameColor = (i: number) => {
    const ignored = data[i + 3] < IGNORED_ALPHA
    if (ignored || startIgnored) return ignored === startIgnored
    if (byCluster) return clusterOf(i) === startCluster
    return data[i] === target[0] && data[i + 1] === target[1] && data[i + 2] === target[2] && data[i + 3] === target[3]
  }

  // 已经是目标色就不用填
  const probe = new Uint8ClampedArray(4)
  writeCell(probe, 1, 0, 0, hex)
  if (!startIgnored && probe[3] >= IGNORED_ALPHA && data[start] === probe[0] && data[start + 1] === probe[1] && data[start + 2] === probe[2]) return 0

  const stack: number[] = [x, y]
  const seen = new Uint8Array(width * height)
  let filled = 0
  while (stack.length) {
    const py = stack.pop() as number
    const px = stack.pop() as number
    if (px < 0 || py < 0 || px >= width || py >= height) continue
    const cell = py * width + px
    if (seen[cell]) continue
    const i = cell * 4
    if (!sameColor(i)) continue
    seen[cell] = 1
    writeCell(data, width, px, py, hex)
    filled++
    stack.push(px + 1, py, px - 1, py, px, py + 1, px, py - 1)
  }
  return filled
}

/** 撤销栈的容量：按网格大小限制内存（最多留 8MB 历史） */
export function historyLimit(img: Pixmap): number {
  const bytesPerSnapshot = Math.max(1, img.width * img.height * 4)
  return Math.min(40, Math.max(1, Math.floor(8_000_000 / bytesPerSnapshot)))
}
