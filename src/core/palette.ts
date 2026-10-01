import { BEAD_COLOR_DATA } from '../data/beadColors.ts'
import { deltaE, hexToRgb, rgbToLab, rgbToHex, weightedRgbDistance } from './color.ts'
import type { Pixmap, RGB } from './types.ts'

export interface PaletteEntry {
  /** 归一化大写 HEX */
  hex: string
  rgb: RGB
  lab: RGB
  /** 各品牌色号，例如 MARD: "A01" */
  codes: Record<string, string>
  /** 不透明度（0–1）。只有半透明豆才有，缺省表示实心 */
  alpha?: number
  /** 半透明豆的颜料色（H01 = 纯白）：画图与匹配用它，hex 仍是色号对应的实色 */
  pigmentHex?: string
}

/**
 * 半透明豆。
 *
 * 这些色号现实中是透明塑料做的，色卡上的颜色只是它盖在白底上扫描出来的近似值，
 * 不能当实心色用 —— 否则「匹配」会把大片白色区域都算到它头上，出图也会画成纯白。
 * 物理上它是「纯白颜料 + 25% 不透明度」：H01 = `#FFFFFF40`（0x40/255）。
 *
 * 单一来源：用户实测（手上的 H01 是透明塑料）。
 */
export const TRANSLUCENT_MARD: Record<string, { hex: string; alpha: number }> = {
  H01: { hex: '#FFFFFF', alpha: 0x40 / 255 },
}

/** 按 alpha 把前景色叠到背景色上，得到「看起来是什么颜色」 */
export function blendOver(fore: RGB, alpha: number, back: RGB): RGB {
  const a = Math.min(1, Math.max(0, alpha))
  return [
    Math.round(fore[0] * a + back[0] * (1 - a)),
    Math.round(fore[1] * a + back[1] * (1 - a)),
    Math.round(fore[2] * a + back[2] * (1 - a)),
  ]
}

/** 某个色号叠在给定背景上的实际观感色（实心色就是它自己） */
export function appearanceRgb(entry: PaletteEntry, backgroundHex: string): RGB {
  if (!entry.alpha || entry.alpha >= 1) return entry.rgb
  return blendOver(hexToRgb(entry.pigmentHex ?? entry.hex), entry.alpha, hexToRgb(backgroundHex))
}

/**
 * 界面上画色块用的颜色：半透明豆按叠在面板底色上的观感画，
 * 否则它看起来和 H02 纯白一模一样，没人知道那是颗透明豆。
 */
export function swatchHex(entry: PaletteEntry, panelHex = '#232323'): string {
  if (!entry.alpha || entry.alpha >= 1) return entry.hex
  return rgbToHex(appearanceRgb(entry, panelHex))
}

/**
 * 把半透明豆的透明度写进像素（导出 1:1 像素图用）：
 * H01 的格子会变成 #FFFFFF40，而不是它盖在背景上的观感色，换工具再用时透明度还在。
 */
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

/**
 * 供「颜色匹配」用的调色板。
 *
 * 1. 半透明豆换成它叠在图纸背景上的观感色（hex / codes 不动，它仍是那颗豆）；
 * 2. 如果它的观感和某个实心豆几乎一样，就直接不参与匹配 ——
 *    比如白底上的 H01（25% 白）看起来和 H02 纯白没区别，但现实里透明豆是专门买的，
 *    不该悄悄顶替白色格子。差异要超过 `redundantWithin` 个 ΔE 才留着。
 */
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
  const translucent = TRANSLUCENT_MARD[(codes.MARD ?? '').toUpperCase()]
  const entry: PaletteEntry = { hex: rgbToHex(rgb), rgb, lab: rgbToLab(rgb), codes }
  if (translucent) {
    entry.alpha = translucent.alpha
    entry.pigmentHex = rgbToHex(hexToRgb(translucent.hex))
  }
  return entry
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
 * MARD 零售套装：24 / 48 / 72 / 96 / 120，每档比上一档多 24 色，且严格包含上一档。
 *
 * 色号取自公开色卡（拼豆Pic 与 FuseBeadsHub 两家逐色一致），全部落在 MARD 标准 221 色内。
 * 电商上还有「144 色」套装和 144 张色号贴纸，但那是商家自己配的，没有公开统一的色号表，
 * 而且卖家之间不一样，所以这里不收录 —— 需要的话按 120 色再加自己手里多出来的 24 色即可。
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

/** 按套装规模取色板；套装色号全部在标准 221 色内，所以用标准色号库解析 */
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

/** 界面上可见的色板来源（wplace 色板不是拼豆颜色，已隐藏） */
export const VISIBLE_PALETTE_SOURCES: PaletteSource[] = ['optimized', 'library', 'kit', 'custom']

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
