import { BEAD_COLOR_DATA } from '../data/beadColors.ts'
import {
  DEFAULT_HUE_WEIGHT,
  deltaE,
  deltaEHuePolar,
  hexToRgb,
  labPolar,
  rgbToLab,
  rgbToHex,
  weightedRgbDistance,
} from './color.ts'
import type { Pixmap, RGB } from './types.ts'

export interface PaletteEntry {
  /** 归一化大写 HEX */
  hex: string
  rgb: RGB
  lab: RGB
  /** 各品牌色号 */
  codes: Record<string, string>
  /** 不透明度（0–1） */
  alpha?: number
  /** 半透明豆的颜料基础色 */
  pigmentHex?: string
}

/** 半透明豆配置 */
export const TRANSLUCENT_MARD: Record<string, { hex: string; alpha: number }> = {
  H01: { hex: '#FFFFFF', alpha: 0x40 / 255 },
}

/** 按 alpha 把前景色叠到背景色上，得到实际观感色 */
export function blendOver(fore: RGB, alpha: number, back: RGB): RGB {
  const a = Math.min(1, Math.max(0, alpha))
  return [
    Math.round(fore[0] * a + back[0] * (1 - a)),
    Math.round(fore[1] * a + back[1] * (1 - a)),
    Math.round(fore[2] * a + back[2] * (1 - a)),
  ]
}

/** 获取色号叠在背景色上的实际观感色 */
export function appearanceRgb(entry: PaletteEntry, backgroundHex: string): RGB {
  if (!entry.alpha || entry.alpha >= 1) return entry.rgb
  return blendOver(hexToRgb(entry.pigmentHex ?? entry.hex), entry.alpha, hexToRgb(backgroundHex))
}

/** 获取界面色块展示颜色 */
export function swatchHex(entry: PaletteEntry, panelHex = '#232323'): string {
  if (!entry.alpha || entry.alpha >= 1) return entry.hex
  return rgbToHex(appearanceRgb(entry, panelHex))
}

/** 将半透明豆的透明度写回像素数据 */
export function applyBeadAlpha(img: Pixmap, palette: PaletteEntry[]): Pixmap {
  const alphaOf = new Map(palette.filter((e) => e.alpha && e.alpha < 1).map((e) => [e.hex, e]))
  if (!alphaOf.size) return img
  const data = new Uint8ClampedArray(img.data)
  for (let i = 0; i < data.length; i += 4) {
    const entry = alphaOf.get(rgbToHex([data[i], data[i + 1], data[i + 2]]))
    if (!entry || !entry.alpha) continue
    const pigment = hexToRgb(entry.pigmentHex ?? entry.hex)
    data[i] = pigment[0]
    data[i + 1] = pigment[1]
    data[i + 2] = pigment[2]
    data[i + 3] = Math.round(entry.alpha * 255)
  }
  return { width: img.width, height: img.height, data }
}

/** 颜色匹配专用调色板，过滤色差较小的冗余半透明候选 */
export function matchPalette(palette: PaletteEntry[], backgroundHex: string, redundantWithin = 3): PaletteEntry[] {
  const translucent = palette.filter((e) => e.alpha && e.alpha < 1)
  if (!translucent.length) return palette

  const solids = palette.filter((e) => !e.alpha || e.alpha >= 1)
  const out: PaletteEntry[] = []
  for (const entry of palette) {
    if (!entry.alpha || entry.alpha >= 1) {
      out.push(entry)
      continue
    }
    const rgb = appearanceRgb(entry, backgroundHex)
    const lab = rgbToLab(rgb)
    const redundant = solids.some((solid) => deltaE(lab, solid.lab) <= redundantWithin)
    if (!redundant) out.push({ ...entry, rgb, lab })
  }
  return out
}

/**
 * wplace 31 色板。
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
  const translucent = TRANSLUCENT_MARD[(codes.MARD ?? '').toUpperCase()]
  const entry: PaletteEntry = { hex: rgbToHex(rgb), rgb, lab: rgbToLab(rgb), codes }
  if (translucent) {
    entry.alpha = translucent.alpha
    entry.pigmentHex = rgbToHex(hexToRgb(translucent.hex))
  }
  return entry
}

/** 提取 MARD 色号系列 */
export function mardSeries(code: string): string {
  const m = /^([A-Za-z]+)/.exec(code || '')
  return m ? m[1].toUpperCase() : ''
}

const STANDARD_SERIES = new Set(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'M'])

/** 构建色板库，includeExtended 为 true 时包含全部扩展色号 */
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
 * MARD 常用零售套装色号（24 / 48 / 72 / 96 / 120 色）。
 */
export const KIT_SIZES = [24, 48, 72, 96, 120] as const
export type KitSize = (typeof KIT_SIZES)[number]

export const KIT_MARD: Record<KitSize, readonly string[]> = {
  24: [
    'A04', 'A06', 'A07', 'B03', 'B05', 'B08', 'C03', 'C05', 'C08', 'D06', 'D07', 'D09', 'E02',
    'E04', 'F05', 'G01', 'G05', 'G07', 'H01', 'H02', 'H03', 'H04', 'H05', 'H07',
  ],
  48: [
    'A04', 'A06', 'A07', 'A10', 'A11', 'A13', 'B03', 'B05', 'B08', 'B12', 'C02', 'C03', 'C05',
    'C06', 'C07', 'C08', 'C10', 'C11', 'C13', 'D03', 'D06', 'D07', 'D09', 'D13', 'D15', 'D18',
    'D19', 'D21', 'E02', 'E03', 'E04', 'E07', 'E08', 'F05', 'F08', 'F13', 'G01', 'G05', 'G07',
    'G08', 'G09', 'G13', 'H01', 'H02', 'H03', 'H04', 'H05', 'H07',
  ],
  72: [
    'A03', 'A04', 'A06', 'A07', 'A10', 'A11', 'A13', 'B03', 'B05', 'B07', 'B08', 'B10', 'B12',
    'B14', 'B17', 'B18', 'B19', 'B20', 'C02', 'C03', 'C05', 'C06', 'C07', 'C08', 'C10', 'C11',
    'C13', 'C16', 'D02', 'D03', 'D06', 'D07', 'D08', 'D09', 'D11', 'D12', 'D13', 'D14', 'D15',
    'D16', 'D18', 'D19', 'D20', 'D21', 'E01', 'E02', 'E03', 'E04', 'E05', 'E07', 'E08', 'E12',
    'E13', 'F05', 'F07', 'F08', 'F10', 'F13', 'G01', 'G02', 'G03', 'G05', 'G07', 'G08', 'G09',
    'G13', 'H01', 'H02', 'H03', 'H04', 'H05', 'H07',
  ],
  96: [
    'A03', 'A04', 'A06', 'A07', 'A10', 'A11', 'A13', 'A14', 'B03', 'B05', 'B07', 'B08', 'B10',
    'B12', 'B14', 'B17', 'B18', 'B19', 'B20', 'C02', 'C03', 'C05', 'C06', 'C07', 'C08', 'C10',
    'C11', 'C13', 'C16', 'D02', 'D03', 'D05', 'D06', 'D07', 'D08', 'D09', 'D11', 'D12', 'D13',
    'D14', 'D15', 'D16', 'D18', 'D19', 'D20', 'D21', 'E01', 'E02', 'E03', 'E04', 'E05', 'E06',
    'E07', 'E08', 'E09', 'E10', 'E11', 'E12', 'E13', 'E14', 'E15', 'F01', 'F02', 'F03', 'F04',
    'F05', 'F06', 'F07', 'F08', 'F09', 'F10', 'F11', 'F12', 'F13', 'F14', 'G01', 'G02', 'G03',
    'G05', 'G07', 'G08', 'G09', 'G13', 'G14', 'G17', 'H01', 'H02', 'H03', 'H04', 'H05', 'H06',
    'H07', 'M05', 'M06', 'M09', 'M12',
  ],
  120: [
    'A01', 'A03', 'A04', 'A05', 'A06', 'A07', 'A08', 'A09', 'A10', 'A11', 'A12', 'A13', 'A14',
    'A15', 'B01', 'B02', 'B03', 'B04', 'B05', 'B06', 'B07', 'B08', 'B10', 'B11', 'B12', 'B13',
    'B14', 'B15', 'B16', 'B17', 'B18', 'B19', 'B20', 'C01', 'C02', 'C03', 'C04', 'C05', 'C06',
    'C07', 'C08', 'C09', 'C10', 'C11', 'C13', 'C14', 'C15', 'C16', 'C17', 'D01', 'D02', 'D03',
    'D05', 'D06', 'D07', 'D08', 'D09', 'D11', 'D12', 'D13', 'D14', 'D15', 'D16', 'D17', 'D18',
    'D19', 'D20', 'D21', 'E01', 'E02', 'E03', 'E04', 'E05', 'E06', 'E07', 'E08', 'E09', 'E10',
    'E11', 'E12', 'E13', 'E14', 'E15', 'F01', 'F02', 'F03', 'F04', 'F05', 'F06', 'F07', 'F08',
    'F09', 'F10', 'F11', 'F12', 'F13', 'F14', 'G01', 'G02', 'G03', 'G05', 'G06', 'G07', 'G08',
    'G09', 'G13', 'G14', 'G17', 'H01', 'H02', 'H03', 'H04', 'H05', 'H06', 'H07', 'H12', 'M05',
    'M06', 'M09', 'M12',
  ],
}

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

/** 按套装规模取色板 */
export function buildKitPalette(size: KitSize = 24): PaletteEntry[] {
  const codes = KIT_MARD[size] ?? KIT_MARD[24]
  return paletteFromMard(codes, buildLibraryPalette({ includeExtended: false }))
}

export type PaletteSource = 'library' | 'optimized' | 'kit' | 'custom' | 'wplace'

export const PALETTE_SOURCE_LABELS: Record<PaletteSource, string> = {
  optimized: '优化结果',
  library: '全色',
  kit: '套装',
  custom: '自定义',
  wplace: 'wplace 色板',
}

/** 界面上可见的色板来源 */
export const VISIBLE_PALETTE_SOURCES: PaletteSource[] = ['optimized', 'library', 'kit', 'custom']

/** 色号体系 */
export const CODE_SYSTEMS = ['MARD', 'COCO', '漫漫', '盼盼', '咪小窝'] as const
export type CodeSystem = (typeof CODE_SYSTEMS)[number]

export function codeOf(entry: PaletteEntry, system: CodeSystem): string {
  return entry.codes[system] || entry.codes.MARD || ''
}

/** 按目标色号自然排序 */
export function compareByCode(a: PaletteEntry, b: PaletteEntry, system: CodeSystem): number {
  const ca = codeOf(a, system)
  const cb = codeOf(b, system)
  return ca.localeCompare(cb, undefined, { numeric: true, sensitivity: 'base' })
}

export type DistanceMetric = 'lab' | 'weighted-rgb'

export const METRIC_LABELS: Record<DistanceMetric, string> = {
  lab: 'Lab ΔE · 色相加权（推荐）',
  'weighted-rgb': '加权 RGB',
}

/** 在调色板中检索最接近颜色的索引 */
export function nearestIndex(
  r: number,
  g: number,
  b: number,
  palette: PaletteEntry[],
  metric: DistanceMetric = 'lab',
  hueWeight = DEFAULT_HUE_WEIGHT,
): number {
  if (!palette.length) return -1
  return prepareNearest(palette, metric, hueWeight)(r, g, b)
}

/** 预编译高性能匹配函数 */
export function prepareNearest(
  palette: PaletteEntry[],
  metric: DistanceMetric = 'lab',
  hueWeight = DEFAULT_HUE_WEIGHT,
): (r: number, g: number, b: number) => number {
  const n = palette.length
  if (!n) return () => -1

  if (metric === 'weighted-rgb') {
    return (r, g, b) => {
      let best = Infinity
      let bestIdx = 0
      for (let i = 0; i < n; i++) {
        const d = weightedRgbDistance(r, g, b, palette[i].rgb)
        if (d < best) {
          best = d
          bestIdx = i
        }
      }
      return bestIdx
    }
  }

  const labs = palette.map((e) => e.lab)

  if (hueWeight <= 0) {
    return (r, g, b) => {
      const lab = rgbToLab([r, g, b])
      let best = Infinity
      let bestIdx = 0
      for (let i = 0; i < n; i++) {
        const d = deltaE(lab, labs[i])
        if (d < best) {
          best = d
          bestIdx = i
        }
      }
      return bestIdx
    }
  }

  const cs = new Float64Array(n)
  const hs = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    const [c, h] = labPolar(labs[i])
    cs[i] = c
    hs[i] = h
  }

  return (r, g, b) => {
    const lab = rgbToLab([r, g, b])
    const cIn = Math.hypot(lab[1], lab[2])
    const hIn = Math.atan2(lab[2], lab[1])
    let best = Infinity
    let bestIdx = 0
    for (let i = 0; i < n; i++) {
      const d = deltaEHuePolar(lab[0] - labs[i][0], cIn, hIn, cs[i], hs[i], hueWeight)
      if (d < best) {
        best = d
        bestIdx = i
      }
    }
    return bestIdx
  }
}

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

/** 解析色号或 HEX 文本 */
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
