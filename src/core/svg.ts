import { luminance } from './color.ts'
import { IGNORED_ALPHA } from './edit.ts'
import { blendOver, codeOf, type CodeSystem, type PaletteEntry } from './palette.ts'
import type { Pixmap, RGB } from './types.ts'

export interface RenderOptions {
  /** 'flat' 方格图纸；'beads' 圆形珠子预览 */
  style: 'flat' | 'beads'
  /** 每个格子在 SVG 里占多少像素（决定默认显示与导出尺寸，缩放时不受影响） */
  cellSize: number
  /** 珠子之间的间隙 */
  gap: number
  /** 是否画网格线 */
  grid: boolean
  /** 每隔多少格画一条粗线（图纸的主网格） */
  majorEvery: number
  background: string
  /** 是否在格子上写色号 */
  codes: boolean
  codeSystem: CodeSystem
  /** 是否画行列标尺 */
  rulers: boolean
  rulerStep: number
  /** 四边的留白（以「格」为单位）：标尺数字就写在留白里 */
  margin: number
}

export const DEFAULT_RENDER_OPTIONS: RenderOptions = {
  style: 'flat',
  cellSize: 22,
  gap: 1,
  grid: true,
  majorEvery: 10,
  background: '#ffffff',
  codes: true,
  codeSystem: 'MARD',
  rulers: true,
  rulerStep: 10,
  // 2.6 是标尺数字需要的地方：比这更窄，左上的数字就贴着图纸了
  margin: 2.6,
}

/** 线宽以「格」为单位，保证跟着图一起缩放，永远是矢量 */
const THIN_WIDTH = 0.05
const THICK_WIDTH = 0.18

/**
 * 图纸四边的留白（格）。
 * 标尺数字写在留白里，不再自己额外撑开一条边 —— 四边永远一样宽。
 * 老存档里没有这个字段，缺省按默认值走。
 */
function marginOf(options: RenderOptions): number {
  return Number.isFinite(options.margin) ? Math.max(0, options.margin) : DEFAULT_RENDER_OPTIONS.margin
}

/** 和界面一致的 Roboto 无衬线字体栈 */
export const SVG_FONT =
  "Roboto, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', system-ui, sans-serif"

/** 格子太多时不再逐格写色号，否则 SVG 会大到浏览器吃不消 */
const CODE_CELL_LIMIT = 12000
/** 珠子样式逐颗绘制，元素数量大，超过这个规模建议用方格 */
const BEAD_CELL_LIMIT = 60000

export interface PatternSvg {
  /** 完整的 SVG 源码，可直接插入 DOM，也可以直接存成 .svg 文件 */
  svg: string
  /** 未缩放的固有尺寸 */
  width: number
  height: number
  /** 色号是否因为格子太多被省略 */
  codesSuppressed: boolean
  /** 珠子是否因为格子太多退回方格 */
  beadSuppressed: boolean
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/** 把数字裁到 3 位小数，避免 SVG 里出现又长又没用的浮点串 */
function n(v: number): string {
  return Number.isInteger(v) ? String(v) : v.toFixed(3).replace(/0+$/, '').replace(/\.$/, '')
}

function hexOf(data: Uint8ClampedArray, i: number): string {
  return (
    '#' +
    data[i].toString(16).padStart(2, '0').toUpperCase() +
    data[i + 1].toString(16).padStart(2, '0').toUpperCase() +
    data[i + 2].toString(16).padStart(2, '0').toUpperCase()
  )
}

/**
 * 把拼豆图案生成为 SVG。
 *
 * 为什么用 SVG：图纸本质是矢量图，放大多少倍都应该清晰；
 * 用 canvas 渲染再靠 CSS 放大一定会糊。
 *
 * 性能上做了两件事：
 * - 同色格子合并成一条 `<path>`（几十个元素，而不是几万个 `<rect>`）
 * - 网格线合并成两条 `<path>`（细线一条、粗线一条）
 */
export function buildPatternSvg(
  img: Pixmap,
  palette: PaletteEntry[],
  options: RenderOptions = DEFAULT_RENDER_OPTIONS,
): PatternSvg {
  const { width: W, height: H, data } = img
  const {
    style,
    cellSize,
    gap,
    grid,
    majorEvery,
    background,
    codes,
    codeSystem,
    rulers,
    rulerStep,
  } = options

  const lookup = new Map<string, PaletteEntry>()
  for (const e of palette) lookup.set(e.hex, e)

  /** 半透明豆画的是它的颜料色（H01 = 纯白），透明度由 fill-opacity 表达 */
  const pigmentOf = (entry: PaletteEntry) => entry.pigmentHex ?? entry.hex

  // 半透明豆（H01 这种透明塑料）：出图按真·半透明画，
  // 也就是那颗豆的实色 + fill-opacity，背景会从底下透出来。
  // 按「颜色 + 透明度」分组，避免给每个格子单独写属性。
  const groupKey = (hex: string) => {
    const entry = lookup.get(hex)
    if (!entry?.alpha || entry.alpha >= 1) return hex
    return `${pigmentOf(entry)}|${entry.alpha}`
  }
  const groupFill = (key: string) => {
    const sep = key.indexOf('|')
    const hex = sep < 0 ? key : key.slice(0, sep)
    const alpha = sep < 0 ? 1 : Number(key.slice(sep + 1))
    return `fill="${escapeAttr(hex)}"${alpha < 1 ? ` fill-opacity="${n(alpha)}"` : ''}`
  }

  const totalCells = W * H
  const beads = style === 'beads' && totalCells <= BEAD_CELL_LIMIT
  const beadSuppressed = style === 'beads' && !beads
  const codesSuppressed = codes && totalCells > CODE_CELL_LIMIT
  const drawCodes = codes && !codesSuppressed && cellSize >= 8

  // 四边留同样的白（以「格」为单位），标尺数字写在留白里。
  // 以前只有左上的标尺占位、右下贴边，看起来是歪的。
  const pad = marginOf(options)
  const vbW = W + pad * 2
  const vbH = H + pad * 2
  const outW = Math.max(1, Math.round(vbW * cellSize))
  const outH = Math.max(1, Math.round(vbH * cellSize))

  const bgIsLight = luminance(hexToRgbSafe(background)) > 0.5
  const thinColor = bgIsLight ? 'rgba(15,23,42,0.30)' : 'rgba(226,232,240,0.28)'
  const thickColor = bgIsLight ? 'rgba(15,23,42,0.85)' : 'rgba(226,232,240,0.85)'
  const rulerColor = bgIsLight ? '#0f172a' : '#e2e8f0'

  const parts: string[] = []
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${outW}" height="${outH}" viewBox="0 0 ${n(vbW)} ${n(vbH)}" font-family="${SVG_FONT}">`,
  )
  parts.push(`<rect x="0" y="0" width="${n(vbW)}" height="${n(vbH)}" fill="${escapeAttr(background)}"/>`)

  if (beads) {
    // 珠子样式：按颜色分组，减少重复属性
    const byColor = new Map<string, string[]>()
    const radius = Math.max(0.05, (1 - Math.max(0, gap) / Math.max(1, cellSize)) / 2)
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        // 透明格 = 忽略：不出豆子，背景直接透出来
        if (data[(y * W + x) * 4 + 3] < IGNORED_ALPHA) continue
        const hex = hexOf(data, (y * W + x) * 4)
        const cx = n(pad + x + 0.5)
        const cy = n(pad + y + 0.5)
        const key = groupKey(hex)
        let list = byColor.get(key)
        if (!list) {
          list = []
          byColor.set(key, list)
        }
        list.push(`<circle cx="${cx}" cy="${cy}" r="${n(radius)}"/>`)
      }
    }
    for (const [key, circles] of byColor) {
      parts.push(`<g ${groupFill(key)}>${circles.join('')}</g>`)
    }
    // 高光：统一一层，透明度固定，不再逐颗写属性
    parts.push(`<g fill="#ffffff" fill-opacity="0.26">`)
    const hl: string[] = []
    const hr = n(Math.max(0.03, radius * 0.34))
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        if (data[(y * W + x) * 4 + 3] < IGNORED_ALPHA) continue
        hl.push(`<circle cx="${n(pad + x + 0.34)}" cy="${n(pad + y + 0.34)}" r="${hr}"/>`)
      }
    }
    parts.push(hl.join(''))
    parts.push('</g>')
  } else {
    // 方格样式：同色格子合并成一条 path
    const byColor = new Map<string, string[]>()
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        if (data[(y * W + x) * 4 + 3] < IGNORED_ALPHA) continue
        const hex = hexOf(data, (y * W + x) * 4)
        const key = groupKey(hex)
        let list = byColor.get(key)
        if (!list) {
          list = []
          byColor.set(key, list)
        }
        list.push(`M${x} ${y}h1v1h-1z`)
      }
    }
    for (const [key, rects] of byColor) {
      parts.push(
        `<path transform="translate(${n(pad)} ${n(pad)})" d="${rects.join('')}" ${groupFill(key)} shape-rendering="crispEdges"/>`,
      )
    }
  }

  // 网格：细线一条 path + 粗线一条 path，整张图只有两个元素
  if (grid) {
    const step = Math.max(1, Math.round(majorEvery))
    const thin: string[] = []
    const thick: string[] = []
    for (let x = 0; x <= W; x++) {
      const target = x % step === 0 ? thick : thin
      target.push(`M${n(pad + x)} ${n(pad)}V${n(pad + H)}`)
    }
    for (let y = 0; y <= H; y++) {
      const target = y % step === 0 ? thick : thin
      target.push(`M${n(pad)} ${n(pad + y)}H${n(pad + W)}`)
    }
    if (thin.length) {
      parts.push(
        `<path d="${thin.join('')}" stroke="${thinColor}" stroke-width="${n(THIN_WIDTH)}" fill="none" shape-rendering="crispEdges"/>`,
      )
    }
    if (thick.length) {
      parts.push(
        `<path d="${thick.join('')}" stroke="${thickColor}" stroke-width="${n(THICK_WIDTH)}" fill="none" shape-rendering="crispEdges"/>`,
      )
    }
  }

  // 色号
  if (drawCodes) {
    const fontSize = 0.4
    const groups = new Map<string, string[]>()
    const needLookup = new Map<string, PaletteEntry | undefined>()
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 4
        // 忽略的格子没有豆子，自然也没有色号
        if (data[i + 3] < IGNORED_ALPHA) continue
        const hex = hexOf(data, i)
        if (!needLookup.has(hex)) needLookup.set(hex, lookup.get(hex))
        const entry = needLookup.get(hex)
        const label = entry ? codeOf(entry, codeSystem) : ''
        if (!label) continue
        // 按文字颜色分组，避免每格都写一遍 fill
        // 半透明豆的色号写在「叠在背景上的观感」上，所以对比度要按观感算
        const shown =
          entry && entry.alpha && entry.alpha < 1
            ? blendOver(hexToRgbSafe(pigmentOf(entry)), entry.alpha, hexToRgbSafe(background))
            : ([data[i], data[i + 1], data[i + 2]] as RGB)
        const dark = luminance(shown) < 0.55
        let list = groups.get(dark ? 'light' : 'dark')
        if (!list) {
          list = []
          groups.set(dark ? 'light' : 'dark', list)
        }
        list.push(`<text x="${n(pad + x + 0.5)}" y="${n(pad + y + 0.5)}">${escapeAttr(label)}</text>`)
      }
    }
    for (const [kind, texts] of groups) {
      const fill = kind === 'light' ? '#ffffff' : '#0b1220'
      parts.push(
        `<g fill="${fill}" fill-opacity="0.92" font-size="${fontSize}" font-weight="600" text-anchor="middle" dominant-baseline="central">${texts.join('')}</g>`,
      )
    }
  }

  // 行列标尺
  if (rulers) {
    const step = Math.max(1, Math.round(rulerStep))
    const texts: string[] = []
    for (let x = 0; x < W; x++) {
      if ((x + 1) % step !== 0 && x !== 0) continue
      texts.push(
        `<text x="${n(pad + x + 0.5)}" y="${n(pad - 1.1)}" text-anchor="middle" dominant-baseline="central">${x + 1}</text>`,
      )
    }
    for (let y = 0; y < H; y++) {
      if ((y + 1) % step !== 0 && y !== 0) continue
      texts.push(
        `<text x="${n(pad - 1.1)}" y="${n(pad + y + 0.5)}" text-anchor="middle" dominant-baseline="central">${y + 1}</text>`,
      )
    }
    parts.push(
      `<g fill="${rulerColor}" font-size="0.9" font-weight="600" fill-opacity="0.9">${texts.join('')}</g>`,
    )
  }

  parts.push('</svg>')

  return {
    svg: parts.join(''),
    width: outW,
    height: outH,
    codesSuppressed,
    beadSuppressed,
  }
}

function hexToRgbSafe(hex: string): [number, number, number] {
  const h = hex.replace('#', '')
  if (h.length !== 6) return [255, 255, 255]
  return [
    parseInt(h.slice(0, 2), 16) || 0,
    parseInt(h.slice(2, 4), 16) || 0,
    parseInt(h.slice(4, 6), 16) || 0,
  ]
}

/** 给定渲染设置后 SVG 的固有尺寸（用来提前判断导出会不会过大） */
export function estimateSvgSize(img: Pixmap, options: RenderOptions): { width: number; height: number } {
  const pad = marginOf(options)
  return {
    width: Math.round((img.width + pad * 2) * options.cellSize),
    height: Math.round((img.height + pad * 2) * options.cellSize),
  }
}

/** 预览用：把固有尺寸限制在 maxSide 以内，超大图纸自动缩小显示 */
export function clampPreviewCellSize(img: Pixmap, options: RenderOptions, maxSide = 2048): number {
  const pad = marginOf(options)
  const longest = Math.max(img.width, img.height) + pad * 2
  if (longest <= 0) return options.cellSize
  return Math.max(1, Math.min(options.cellSize, Math.floor(maxSide / longest)))
}

export const MAX_EXPORT_SIDE = 12000

/**
 * 把 SVG 光栅化成 PNG。
 * scale 是导出倍数：SVG 是矢量的，放大几倍都是重新绘制，不会变糊。
 */
export async function svgToPngBlob(svg: string, width: number, height: number, scale = 1): Promise<Blob> {
  const blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image()
      el.onload = () => resolve(el)
      el.onerror = () => reject(new Error('SVG 光栅化失败'))
      el.src = url
    })

    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(width * scale))
    canvas.height = Math.max(1, Math.round(height * scale))
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('无法创建画布上下文')
    ctx.imageSmoothingEnabled = true
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height)

    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((out) => {
        if (out) resolve(out)
        else reject(new Error('PNG 生成失败'))
      }, 'image/png')
    })
  } finally {
    URL.revokeObjectURL(url)
  }
}
