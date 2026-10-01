import { BEAD_COLOR_DATA } from '../data/beadColors.ts'
import { deltaE, hexToRgb, rgbToLab, rgbToHex, weightedRgbDistance } from './color.ts'
import type { RGB } from './types.ts'

export interface PaletteEntry {
  /** 归一化大写 HEX */
  hex: string
  rgb: RGB
  lab: RGB
  /** 各品牌色号，例如 MARD: "A01" */
  codes: Record<string, string>
}

/**
 * 旧「拼豆工具箱」内置的 31 色板。
 *
 * 注意：这 31 个颜色是 wplace 的调色板，**不是拼豆的颜色**，
 * 所以不再出现在界面上，只在代码里保留（名字也按来源叫 wplace_colors）。
 * 想要拼豆用的精简色板请用「基础 24 色 / 基础 48 色」。
 */
export const WPLACE_COLORS: RGB[] = [
  [0, 0, 0], [60, 60, 60], [120, 120, 120], [210, 210, 210], [255, 255, 255],
  [96, 0, 24], [237, 28, 36], [255, 127, 39], [246, 170, 9], [249, 221, 59],
  [255, 250, 188], [14, 185, 104], [19, 230, 123], [135, 255, 94], [12, 129, 110],
  [16, 174, 166], [19, 225, 190], [96, 247, 242], [40, 80, 158], [64, 147, 228],
  [107, 80, 246], [153, 177, 251], [120, 12, 153], [170, 56, 185], [224, 159, 249],
  [203, 0, 122], [236, 31, 128], [243, 141, 169], [104, 70, 52], [149, 104, 42],
  [248, 178, 119],
]

export function makeEntry(hex: string, codes: Record<string, string> = {}): PaletteEntry {
  const rgb = hexToRgb(hex)
  return { hex: rgbToHex(rgb), rgb, lab: rgbToLab(rgb), codes }
}

/** MARD 色号的系列字母（A–H / M / P / Q / R / T / Y / ZG…） */
export function mardSeries(code: string): string {
  const m = /^([A-Za-z]+)/.exec(code || '')
  return m ? m[1].toUpperCase() : ''
}

/**
 * MARD 官方把色号分成两档（多来源一致）：
 * - 标准 221 色：A B C D E F G H M 九个系列
 * - 完整 291 色：再加 P Q R T Y ZG 六个系列
 * 所以 M 属于标准色，只有 P/Q/R/T/Y/ZG 才是「扩展色号」，
 * 界面上不勾扩展时给的就是 221 色。
 */
const STANDARD_SERIES = new Set(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'M'])

/** 从内嵌色号库构建调色板；includeExtended 打开时给完整的 291 色 */
export function buildLibraryPalette(options: { includeExtended?: boolean } = {}): PaletteEntry[] {
  const entries: PaletteEntry[] = []
  for (const [hex, info] of Object.entries(BEAD_COLOR_DATA)) {
    const mard = info.MARD ?? ''
    if (!mard) continue
    if (!options.includeExtended && !STANDARD_SERIES.has(mardSeries(mard))) continue
    entries.push(makeEntry(hex, info))
  }
  return entries
}

export function buildWplacePalette(): PaletteEntry[] {
  return WPLACE_COLORS.map((rgb) => ({
    hex: rgbToHex(rgb),
    rgb,
    lab: rgbToLab(rgb),
    codes: {},
  }))
}

/**
 * 基础 24 色 / 48 色：都用 MARD 色号定义。
 * 24 色是精简起步色；48 色 = 24 色 + 另外 24 个（补齐各系列过渡色）。
 */
export const BASIC_24_MARD = [
  'B03', 'B05', 'B08',
  'C03', 'C05', 'C08',
  'D09', 'D06', 'D07',
  'E02', 'E04',
  'F05',
  'G01', 'G05', 'G07',
  'A04', 'A06', 'A07',
  'H01', 'H02', 'H03', 'H04', 'H05', 'H07',
] as const

/** 在 24 色基础上追加的 24 个色号 */
export const BASIC_48_EXTRA_MARD = [
  'C02', 'C10', 'C11',
  'B12',
  'C13', 'C06', 'C07',
  'D03', 'D19', 'D18', 'D21', 'D15',
  'E08', 'E03',
  'D13', 'E07',
  'A13', 'A10',
  'F13', 'F08',
  'A11',
  'G09', 'G13', 'G08',
] as const

export const BASIC_48_MARD = [...BASIC_24_MARD, ...BASIC_48_EXTRA_MARD] as const

/** 按 MARD 色号取颜色，返回按色号排序的色板 */
export function paletteFromMard(codes: readonly string[], library: PaletteEntry[]): PaletteEntry[] {
  const byCode = new Map<string, PaletteEntry>()
  for (const e of library) {
    const code = e.codes.MARD
    if (code && !byCode.has(code)) byCode.set(code, e)
  }
  const out: PaletteEntry[] = []
  for (const code of codes) {
    const hit = byCode.get(code)
    if (hit) out.push(hit)
  }
  return out.sort(compareByCodeMard)
}

function compareByCodeMard(a: PaletteEntry, b: PaletteEntry): number {
  return (a.codes.MARD ?? '').localeCompare(b.codes.MARD ?? '', undefined, {
    numeric: true,
    sensitivity: 'base',
  })
}

export function buildBasic24Palette(): PaletteEntry[] {
  return paletteFromMard(BASIC_24_MARD, buildLibraryPalette({ includeExtended: true }))
}

export function buildBasic48Palette(): PaletteEntry[] {
  return paletteFromMard(BASIC_48_MARD, buildLibraryPalette({ includeExtended: true }))
}

export type PaletteSource = 'library' | 'optimized' | 'basic24' | 'basic48' | 'custom' | 'wplace'

export const PALETTE_SOURCE_LABELS: Record<PaletteSource, string> = {
  optimized: '优化结果',
  library: '全色',
  basic24: '基础24色',
  basic48: '基础48色',
  custom: '自定义',
  wplace: 'wplace 色板',
}

/** 界面上可见的色板来源（wplace 色板不是拼豆颜色，已隐藏） */
export const VISIBLE_PALETTE_SOURCES: PaletteSource[] = ['optimized', 'library', 'basic24', 'basic48', 'custom']

/** 色号体系（对应旧工具的 code-type） */
export const CODE_SYSTEMS = ['MARD', 'COCO', '漫漫', '盼盼', '咪小窝'] as const
export type CodeSystem = (typeof CODE_SYSTEMS)[number]

export function codeOf(entry: PaletteEntry, system: CodeSystem): string {
  return entry.codes[system] || entry.codes.MARD || ''
}

/** 按目标色号自然排序（A01 < A02 < A10） */
export function compareByCode(a: PaletteEntry, b: PaletteEntry, system: CodeSystem): number {
  const ca = codeOf(a, system)
  const cb = codeOf(b, system)
  return ca.localeCompare(cb, undefined, { numeric: true, sensitivity: 'base' })
}

export type DistanceMetric = 'lab' | 'weighted-rgb'

export const METRIC_LABELS: Record<DistanceMetric, string> = {
  lab: 'Lab ΔE（感知色差，推荐）',
  'weighted-rgb': '加权 RGB（旧工具算法）',
}

/**
 * 在调色板中找最接近的颜色，返回索引。
 * lab 模式走 CIE76 ΔE；weighted-rgb 模式复刻旧「拼豆工具箱」的 0.3/0.59/0.11 距离。
 */
export function nearestIndex(
  r: number,
  g: number,
  b: number,
  palette: PaletteEntry[],
  metric: DistanceMetric = 'lab',
): number {
  if (!palette.length) return -1
  if (metric === 'weighted-rgb') {
    let best = Infinity
    let bestIdx = 0
    for (let i = 0; i < palette.length; i++) {
      const d = weightedRgbDistance(r, g, b, palette[i].rgb)
      if (d < best) {
        best = d
        bestIdx = i
      }
    }
    return bestIdx
  }

  const lab = rgbToLab([r, g, b])
  let best = Infinity
  let bestIdx = 0
  for (let i = 0; i < palette.length; i++) {
    const d = deltaE(lab, palette[i].lab)
    if (d < best) {
      best = d
      bestIdx = i
    }
  }
  return bestIdx
}

/** 去重并保留顺序 */
export function uniqueEntries(entries: PaletteEntry[]): PaletteEntry[] {
  const seen = new Set<string>()
  const out: PaletteEntry[] = []
  for (const e of entries) {
    if (seen.has(e.hex)) continue
    seen.add(e.hex)
    out.push(e)
  }
  return out
}

export function entryByHex(entries: PaletteEntry[], hex: string): PaletteEntry | undefined {
  const target = hex.toUpperCase()
  return entries.find((e) => e.hex === target)
}

/**
 * 解析用户粘贴的文本（色号或 HEX，空格/逗号/换行分隔），
 * 返回匹配到的调色板 HEX 列表（去重、保持输入顺序）。
 *
 * 注意：不同品牌的色号会重号（例如 COCO 的 B02 与 MARD 的 B02 是两个颜色），
 * 所以优先按当前选定的色号体系匹配，其余体系只在没有歧义时兜底。
 */
export function parsePaletteText(text: string, palette: PaletteEntry[], system: CodeSystem = 'MARD'): string[] {
  const tokens = text
    .split(/[\s,;、]+/)
    .map((t) => t.trim())
    .filter(Boolean)
  if (!tokens.length) return []

  const byHex = new Map<string, string>()
  const primary = new Map<string, string>()
  const fallback = new Map<string, string>()
  const ambiguous = new Set<string>()

  for (const e of palette) {
    byHex.set(e.hex.toUpperCase(), e.hex)
    byHex.set(e.hex.slice(1).toUpperCase(), e.hex)

    const chosen = e.codes[system]
    if (chosen) primary.set(chosen.toUpperCase(), e.hex)

    for (const [sys, code] of Object.entries(e.codes)) {
      if (!code || sys === system) continue
      const key = code.toUpperCase()
      const existing = fallback.get(key)
      if (existing && existing !== e.hex) ambiguous.add(key)
      else fallback.set(key, e.hex)
    }
  }

  const out: string[] = []
  for (const token of tokens) {
    const upper = token.toUpperCase()
    const hexHit = byHex.get(upper.startsWith('#') ? upper : `#${upper}`)
    if (hexHit) {
      out.push(hexHit)
      continue
    }
    const hit = primary.get(upper) ?? (ambiguous.has(upper) ? undefined : fallback.get(upper))
    if (hit) out.push(hit)
  }
  return [...new Set(out)]
}
