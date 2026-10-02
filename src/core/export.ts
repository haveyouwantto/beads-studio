import type { PaletteEntry } from './palette.ts'
import { codeOf, type CodeSystem } from './palette.ts'

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 2000)
}

/**
 * 下载文件名：以项目名开头，这样一堆导出能看出是哪个项目的。
 * 文件系统不允许的字符（`\ / : * ? " < > |`、控制符）换成空格，
 * 去掉首尾的点和空格（开头的点会让文件变成隐藏文件），太长的截断。
 */
export function safeFileName(name: string, fallback = 'beads-studio'): string {
  const cleaned = (name ?? '')
    .replace(/[\\/:*?"<>|]/g, ' ')
    .replace(/[\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+/, '')
    .replace(/[.\s]+$/, '')
    .slice(0, 60)
    .trim()
  return cleaned || fallback
}

export function downloadText(text: string, filename: string, mime = 'text/plain'): void {
  downloadBlob(new Blob([text], { type: `${mime};charset=utf-8` }), filename)
}

export function downloadCanvasPng(canvas: HTMLCanvasElement, filename: string): Promise<void> {
  return new Promise((resolve) => {
    canvas.toBlob((blob) => {
      if (blob) downloadBlob(blob, filename)
      resolve()
    }, 'image/png')
  })
}

export interface BomRow {
  code: string
  hex: string
  count: number
}

/** 用料清单：按用量从多到少 */
export function buildBom(
  palette: PaletteEntry[],
  counts: Uint32Array,
  system: CodeSystem,
): BomRow[] {
  const rows: BomRow[] = []
  for (let i = 0; i < palette.length; i++) {
    if (!counts[i]) continue
    rows.push({ code: codeOf(palette[i], system), hex: palette[i].hex, count: counts[i] })
  }
  rows.sort((a, b) => b.count - a.count || a.code.localeCompare(b.code, undefined, { numeric: true }))
  return rows
}

export function bomToCsv(rows: BomRow[], title = 'beads-studio'): string {
  const header = '色号,HEX,数量'
  const body = rows.map((r) => `${r.code},${r.hex},${r.count}`).join('\n')
  return `${title}\n${header}\n${body}\n`
}

/** 导出调色板：json / hex 列表 / 色号列表 */
export function buildPaletteExport(
  entries: PaletteEntry[],
  system: CodeSystem,
  format: 'json' | 'hex' | 'code',
): string {
  const sorted = [...entries].sort((a, b) =>
    codeOf(a, system).localeCompare(codeOf(b, system), undefined, { numeric: true, sensitivity: 'base' }),
  )
  if (format === 'json') {
    return JSON.stringify(
      {
        // 本工具自己的格式版本，和项目存档一样从 1 起
        // （旧的 '3.0' 是从原「配色采样器」搬过来的字面量，跟这里没关系）
        app: 'beads-studio',
        version: 1,
        codeSystem: system,
        exportDate: new Date().toISOString(),
        totalColors: sorted.length,
        selectedHexValues: sorted.map((e) => e.hex),
        codes: sorted.map((e) => ({ code: codeOf(e, system), hex: e.hex })),
      },
      null,
      2,
    )
  }
  if (format === 'hex') return sorted.map((e) => e.hex).join('\n')
  return sorted.map((e) => codeOf(e, system)).join('\n')
}

/** 项目存档 */
export interface ProjectFile {
  app: 'beads-studio'
  version: 1
  savedAt: string
  /** 项目名（标签页标题）；导入后照着改名 */
  name?: string
  /** 导出时停在哪一步；导入后直接跳过去 */
  activeStage?: string
  /** 网格是否被像素编辑改过 */
  edited?: boolean
  grid?: { width: number; height: number; data: string }
  paletteHex?: string[]
  settings?: Record<string, unknown>
}

export function packPixels(img: { width: number; height: number; data: Uint8ClampedArray }): string {
  const bytes = new Uint8Array(img.data.buffer.slice(0))
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(binary)
}

export function unpackPixels(
  width: number,
  height: number,
  base64: string,
): Uint8ClampedArray {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  const expected = width * height * 4
  if (bytes.length !== expected) {
    throw new Error(`项目像素数据尺寸不匹配：期望 ${expected} 字节，实际 ${bytes.length} 字节`)
  }
  return new Uint8ClampedArray(bytes.buffer)
}
