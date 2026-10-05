/**
 * 拼豆图纸的 PDF 导出：**纯矢量**，一页一块板。
 *
 * 图纸本来就是「一堆方块 + 网格线 + 色号文字」，PDF 里正好一一对应：
 *   方块 → `re f`（或一条 path 里多个 re，一次填充）
 *   网格线 → `m/l S`
 *   文字 → 标准 Helvetica（色号都是 ASCII，不用嵌字体）
 * 所以不引第三方 PDF 库，也不光栅化 —— 放到多大都是清楚的。
 *
 * 页面用 A4，每块板按自身长宽比缩放到页内居中；多页时页脚写「3 / 9」。
 */
import { hexToRgb, luminance } from './color.ts'
import { IGNORED_ALPHA } from './edit.ts'
import { codeOf, type PaletteEntry } from './palette.ts'
import { boardLayout, patternMargin, rulerOffset, sliceBoard, type RenderOptions } from './svg.ts'
import type { Pixmap } from './types.ts'

/** A4（pt） */
const A4_W = 595.28
const A4_H = 841.89
/** 页边距（pt） */
const PAGE_MARGIN = 26
/** 色号字高（格） */
const CODE_SIZE = 0.42
/** 标尺数字字高（格） */
const RULER_SIZE = 0.9
/** 字号小于这个值就不画色号（印出来看不清） */
const MIN_CODE_PT = 3.2

/** 字符串按单字节写（内容全是 ASCII） */
function enc(text: string): Uint8Array {
  const out = new Uint8Array(text.length)
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0xff
  return out
}

function f(v: number): string {
  return Number.isInteger(v) ? String(v) : v.toFixed(3).replace(/0+$/, '').replace(/\.$/, '')
}

function fillColor(hex: string): string {
  const [r, g, b] = hexToRgb(hex)
  return `${f(r / 255)} ${f(g / 255)} ${f(b / 255)} rg`
}

function strokeColor(hex: string): string {
  const [r, g, b] = hexToRgb(hex)
  return `${f(r / 255)} ${f(g / 255)} ${f(b / 255)} RG`
}

/** PDF 文本里的 () \ 要转义 */
function pdfText(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)')
}

/** Helvetica 里这几个字符的宽度（1/1000 em），用来把文字摆到格子中间 */
function charWidth(ch: string): number {
  if (ch >= '0' && ch <= '9') return 556
  if (/[A-Z]/.test(ch)) return 667
  if (ch === ' ') return 278
  return 500
}

function textWidth(text: string, size: number): number {
  let w = 0
  for (const ch of text) w += charWidth(ch)
  return (w / 1000) * size
}

/** 一块板画成 PDF 内容（坐标单位是「格」，外面用 cm 缩放） */
function boardContent(
  img: Pixmap,
  palette: PaletteEntry[],
  options: RenderOptions,
  pad: number,
  rulerFrom: number,
  scalePt: number,
): string {
  const { width: W, height: H } = img
  const boxW = W + pad * 2
  const boxH = H + pad * 2
  const out: string[] = []
  /** 格子坐标（左上原点）→ PDF 坐标（左下原点） */
  const py = (y: number) => boxH - pad - y

  out.push(fillColor(options.background))
  out.push(`0 0 ${f(boxW)} ${f(boxH)} re f`)

  // 按颜色分组：一条 path 里多个 re，一次填充
  const byColor = new Map<string, string[]>()
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4
      if (img.data[i + 3] < IGNORED_ALPHA) continue
      const hex =
        '#' +
        [img.data[i], img.data[i + 1], img.data[i + 2]]
          .map((v) => v.toString(16).padStart(2, '0').toUpperCase())
          .join('')
      const list = byColor.get(hex)
      const rect = `${f(pad + x)} ${f(py(y + 1))} 1 1 re`
      if (list) list.push(rect)
      else byColor.set(hex, [rect])
    }
  }
  for (const [hex, rects] of byColor) {
    out.push(fillColor(hex))
    out.push(`${rects.join(' ')} f`)
  }

  // 网格线
  if (options.grid) {
    const step = Math.max(1, Math.round(options.majorEvery))
    const bgIsLight = luminance(hexToRgb(options.background)) > 0.5
    const thinColor = bgIsLight ? '#8a94a6' : '#6b7280'
    const thickColor = bgIsLight ? '#1a2233' : '#e2e8f0'
    const thin: string[] = []
    const thick: string[] = []
    for (let x = 0; x <= W; x++) {
      const line = `${f(pad + x)} ${f(pad)} m ${f(pad + x)} ${f(pad + H)} l`
      ;((x - rulerFrom) % step === 0 ? thick : thin).push(line)
    }
    for (let y = 0; y <= H; y++) {
      const line = `${f(pad)} ${f(pad + y)} m ${f(pad + W)} ${f(pad + y)} l`
      ;((y - rulerFrom) % step === 0 ? thick : thin).push(line)
    }
    const w = (pt: number) => f(pt / Math.max(0.001, scalePt))
    if (thin.length) out.push(`${strokeColor(thinColor)} ${w(0.4)} w ${thin.join(' ')} S`)
    if (thick.length) out.push(`${strokeColor(thickColor)} ${w(1.1)} w ${thick.join(' ')} S`)
  }

  // 色号 + 标尺数字：一个 BT 块里用绝对定位挨个写
  const texts: string[] = []
  const lookup = new Map<string, PaletteEntry>()
  for (const e of palette) lookup.set(e.hex, e)

  if (options.codes && CODE_SIZE * scalePt >= MIN_CODE_PT) {
    const size = CODE_SIZE
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 4
        if (img.data[i + 3] < IGNORED_ALPHA) continue
        const hex =
          '#' +
          [img.data[i], img.data[i + 1], img.data[i + 2]]
            .map((v) => v.toString(16).padStart(2, '0').toUpperCase())
            .join('')
        const entry = lookup.get(hex)
        const label = entry ? codeOf(entry, options.codeSystem) : ''
        if (!label) continue
        const dark = luminance(hexToRgb(hex)) > 0.55
        texts.push(
          `${dark ? '0.04 0.07 0.13 rg' : '0.97 0.98 0.99 rg'} ${f(size)} 0 0 ${f(size)} ` +
            `${f(pad + x + 0.5 - textWidth(label, size) / 2)} ${f(py(y + 1) + 0.5 - size * 0.36)} Tm (${pdfText(label)}) Tj`,
        )
      }
    }
  }

  if (options.rulers) {
    const size = RULER_SIZE
    const step = Math.max(1, Math.round(options.rulerStep))
    const rulerColor = luminance(hexToRgb(options.background)) > 0.5 ? '0.06 0.09 0.16 rg' : '0.89 0.91 0.94 rg'
    const draw = (label: string, x: number, y: number) => {
      texts.push(
        `${rulerColor} ${f(size)} 0 0 ${f(size)} ${f(x - textWidth(label, size) / 2)} ${f(y - size * 0.36)} Tm (${label}) Tj`,
      )
    }
    for (let x = rulerFrom; x < W; x++) {
      const v = x - rulerFrom + 1
      if (v !== 1 && v % step !== 0) continue
      draw(String(v), pad + x + 0.5, boxH - pad + 1.1)
    }
    for (let y = rulerFrom; y < H; y++) {
      const v = y - rulerFrom + 1
      if (v !== 1 && v % step !== 0) continue
      draw(String(v), pad - 1.1, py(y + 1) + 0.5)
    }
  }

  if (texts.length) out.push(`BT\n/F1 1 Tf\n${texts.join('\n')}\nET`)

  return out.join('\n')
}

interface PdfPageContent {
  content: string
}

/** 把每页内容流打成 PDF（A4、多页、含 xref） */
function assemblePdf(pages: PdfPageContent[]): Blob {
  if (!pages.length) throw new Error('没有可导出的页面')
  const chunks: (Uint8Array | string)[] = []
  let size = 0
  const push = (part: Uint8Array | string) => {
    chunks.push(part)
    size += part.length
  }

  const pageObjects = pages.map((_, i) => 4 + i * 2)
  const objCount = 3 + pages.length * 2
  const offsets = new Array<number>(objCount + 1).fill(0)
  const beginObj = (n: number) => {
    offsets[n] = size
    push(`${n} 0 obj\n`)
  }

  push('%PDF-1.4\n')
  push(new Uint8Array([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]))

  beginObj(1)
  push('<< /Type /Catalog /Pages 2 0 R >>\nendobj\n')
  beginObj(2)
  push(`<< /Type /Pages /Kids [${pageObjects.map((n) => `${n} 0 R`).join(' ')}] /Count ${pages.length} >>\nendobj\n`)
  beginObj(3)
  push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>\nendobj\n')

  pages.forEach((page, i) => {
    const pageNum = pageObjects[i]
    const contentNum = pageNum + 1
    const bytes = enc(page.content)
    beginObj(pageNum)
    push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${f(A4_W)} ${f(A4_H)}] ` +
        `/Resources << /Font << /F1 3 0 R >> >> /Contents ${contentNum} 0 R >>\nendobj\n`,
    )
    beginObj(contentNum)
    push(`<< /Length ${bytes.length} >>\nstream\n`)
    push(bytes)
    push('\nendstream\nendobj\n')
  })

  const xrefOffset = size
  push(`xref\n0 ${objCount + 1}\n`)
  push('0000000000 65535 f \n')
  for (let n = 1; n <= objCount; n++) push(`${String(offsets[n]).padStart(10, '0')} 00000 n \n`)
  push(`trailer\n<< /Size ${objCount + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`)

  const out = new Uint8Array(size)
  let at = 0
  for (const part of chunks) {
    if (typeof part === 'string') {
      out.set(enc(part), at)
      at += part.length
    } else {
      out.set(part, at)
      at += part.length
    }
  }
  return new Blob([out], { type: 'application/pdf' })
}

export interface PatternPdfOptions {
  /** 页脚：一页一块板时写「3 / 9」，单页不写 */
  pageLabels?: boolean
}

/**
 * 拼豆图纸 → 矢量 PDF（一页一块板，不拆分就是整张一页）。
 * 页面 A4，每块板按长宽比缩放居中，四周留边距。
 */
export function buildPatternPdf(
  img: Pixmap,
  palette: PaletteEntry[],
  options: RenderOptions,
  cfg: PatternPdfOptions = {},
): Blob {
  const layout = boardLayout(img, options)
  const pad = patternMargin(options)
  const rulerFrom = rulerOffset(options)
  const multi = layout.boards.length > 1

  const contents = layout.boards.map((board) => {
    const tile = sliceBoard(img, board.x0, board.y0, board.cols, board.rows)
    const boxW = tile.width + pad * 2
    const boxH = tile.height + pad * 2
    // 每块板都按自己的长宽比缩放到页内（pt/格）
    const footRoom = multi && cfg.pageLabels !== false ? 16 : 0
    const scale = Math.min((A4_W - PAGE_MARGIN * 2) / boxW, (A4_H - PAGE_MARGIN * 2 - footRoom) / boxH)
    const drawW = boxW * scale
    const drawH = boxH * scale
    const tx = (A4_W - drawW) / 2
    const ty = A4_H - PAGE_MARGIN - drawH

    const body = boardContent(tile, palette, options, pad, rulerFrom, scale)
    let content = `q\n${f(scale)} 0 0 ${f(scale)} ${f(tx)} ${f(ty)} cm\n${body}\nQ`
    if (multi && cfg.pageLabels !== false) {
      const label = `${board.index} / ${layout.boards.length}`
      const size = 9
      content +=
        `\nBT\n0.35 0.35 0.35 rg\n/F1 ${size} Tf\n` +
        `1 0 0 1 ${f(A4_W / 2 - textWidth(label, size) / 2)} ${f(PAGE_MARGIN - 8)} Tm (${pdfText(label)}) Tj\nET`
    }
    return { content }
  })

  return assemblePdf(contents)
}
