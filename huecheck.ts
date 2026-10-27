/**
 * 一次性对照脚本：同一张图、同一个预算，改 hueWeight / 色相族保底，看出图后的色相误差
 * 与「每个色相族是否还有自己的豆」。
 * 运行：node --experimental-strip-types huecheck.ts
 */
import { buildKitPalette, buildLibraryPalette } from './src/core/palette.ts'
import {
  PaletteOptimizer,
  targetsFromPixmap,
  DEFAULT_OPTIMIZE_CONFIG,
  type OptimizeConfig,
} from './src/core/optimize.ts'
import { hexToRgb, rgbToLab } from './src/core/color.ts'
import type { Pixmap, RGB } from './src/core/types.ts'

const W = 64
const H = 48

/** 6 个色相族，面积差别很大：青绿只有一小块，看它会不会被吞掉 */
const FAMILIES = [
  { name: '红', hue: 25, chroma: 42, area: 0.22 },
  { name: '橙黄', hue: 62, chroma: 48, area: 0.18 },
  { name: '草绿', hue: 118, chroma: 38, area: 0.2 },
  { name: '青绿', hue: 168, chroma: 30, area: 0.04 },
  { name: '蓝', hue: 245, chroma: 40, area: 0.21 },
  { name: '紫', hue: 305, chroma: 34, area: 0.15 },
]

function lchToRgb(L: number, C: number, hDeg: number): RGB {
  const a = C * Math.cos((hDeg * Math.PI) / 180)
  const b = C * Math.sin((hDeg * Math.PI) / 180)
  const fy = (L + 16) / 116
  const fx = fy + a / 500
  const fz = fy - b / 200
  const inv = (t: number) => (t ** 3 > 0.008856 ? t ** 3 : (t - 16 / 116) / 7.787)
  const X = inv(fx) * 0.95047
  const Y = inv(fy)
  const Z = inv(fz) * 1.08883
  const enc = (v: number) => {
    const s = v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055
    return Math.min(255, Math.max(0, Math.round(s * 255)))
  }
  return [
    enc(3.2406 * X - 1.5372 * Y - 0.4986 * Z),
    enc(-0.9689 * X + 1.8758 * Y + 0.0415 * Z),
    enc(0.0557 * X - 0.204 * Y + 1.057 * Z),
  ]
}

const data = new Uint8ClampedArray(W * H * 4)
const areaSum = FAMILIES.reduce((a, f) => a + f.area, 0)
const familyOf = new Map<number, string>()
let x0 = 0
const bands: { name: string; from: number; to: number }[] = []
for (const f of FAMILIES) {
  const w = Math.max(1, Math.round((f.area / areaSum) * W))
  bands.push({ name: f.name, from: x0, to: Math.min(W, x0 + w) })
  for (let y = 0; y < H; y++) {
    const band = y < H / 3 ? 0 : y < (2 * H) / 3 ? 1 : 2
    const L = band === 0 ? 72 : band === 1 ? 55 : 38
    const C = band === 1 ? f.chroma : f.chroma * 0.8
    const rgb = lchToRgb(L, C, f.hue)
    familyOf.set((rgb[0] << 16) | (rgb[1] << 8) | rgb[2], f.name)
    for (let x = x0; x < Math.min(W, x0 + w); x++) {
      const i = (y * W + x) * 4
      data[i] = rgb[0]
      data[i + 1] = rgb[1]
      data[i + 2] = rgb[2]
      data[i + 3] = 255
    }
  }
  x0 += w
}
const pixmap: Pixmap = { width: W, height: H, data }
const targetInfo = targetsFromPixmap(pixmap)
const PALETTES: Record<string, ReturnType<typeof buildLibraryPalette>> = {
  '291 色': buildLibraryPalette({ includeExtended: true }),
  '72 色套装': buildKitPalette(72),
  '24 色套装': buildKitPalette(24),
}
let candidates = PALETTES['291 色']

function hueOf(hex: string): { c: number; h: number } {
  const lab = rgbToLab(hexToRgb(hex))
  return {
    c: Math.hypot(lab[1], lab[2]),
    h: ((Math.atan2(lab[2], lab[1]) * 180) / Math.PI + 360) % 360,
  }
}

function gap(a: number, b: number): number {
  const d = Math.abs(a - b) % 360
  return d > 180 ? 360 - d : d
}

async function run(w: number, fams: boolean, k: number) {
  const cfg: OptimizeConfig = {
    ...DEFAULT_OPTIMIZE_CONFIG,
    k,
    hueWeight: w,
    hueFamilies: fams,
    steps: 20000,
    patience: 3000,
  }
  const opt = new PaletteOptimizer(candidates, cfg, 'grid')
  opt.setTargets(targetInfo.samples)
  let stats = { avg: 0, weightedAvg: 0, min: 0, max: 0 }
  let mapping: { key: number; hex: string }[] = []
  let selected: number[] = []
  for await (const ev of opt.run()) {
    if (ev.type === 'completed') {
      stats = ev.stats
      mapping = ev.mapping
      selected = ev.selected
    }
  }
  const byKey = new Map(mapping.map((m) => [m.key, m.hex]))
  let hueErr = 0
  let hueW = 0
  let big = 0
  let chromaLoss = 0
  let lightLoss = 0
  let allW = 0
  let grayOut = 0
  const held = new Map<string, number>() // 族 → 族内最好的那颗豆的色相差（只算有色输出）
  for (const s of targetInfo.samples) {
    const key = (Math.round(s.rgb[0]) << 16) | (Math.round(s.rgb[1]) << 8) | Math.round(s.rgb[2])
    const hex = byKey.get(key)
    const fam = familyOf.get(key)
    if (!hex || !fam) continue
    const bead = hueOf(hex)
    const tl = rgbToLab([s.rgb[0], s.rgb[1], s.rgb[2]])
    const tc = Math.hypot(tl[1], tl[2])
    const th = ((Math.atan2(tl[2], tl[1]) * 180) / Math.PI + 360) % 360
    allW += s.count
    chromaLoss += Math.max(0, tc - bead.c) * s.count
    lightLoss += Math.abs(tl[0] - rgbToLab(hexToRgb(hex))[0]) * s.count
    // 输出接近无彩色时，它的「色相」是数值噪声：算成掉彩度，不算色相错
    if (bead.c < 6) {
      grayOut += s.count
      continue
    }
    const dh = gap(th, bead.h)
    hueErr += dh * s.count
    hueW += s.count
    if (dh > 20) big += s.count
    const cur = held.get(fam)
    if (cur === undefined || dh < cur) held.set(fam, dh)
  }
  const famLine = bands
    .map((b) => {
      const d = held.get(b.name)
      return d === undefined ? `${b.name} ✗灰` : `${b.name} ${d.toFixed(0)}°`
    })
    .join('  ')
  console.log(
    `w${w} 保底${fams ? '开' : '关'} k=${k}  ΔE ${stats.avg.toFixed(2)}  ` +
      `色相 ${(hueErr / Math.max(hueW, 1)).toFixed(1)}°（>20° 占 ${((big / Math.max(hueW, 1)) * 100).toFixed(0)}%）  ` +
      `掉彩度 ${(chromaLoss / Math.max(allW, 1)).toFixed(1)}  ΔL ${(lightLoss / Math.max(allW, 1)).toFixed(1)}  ` +
      `变灰 ${((grayOut / Math.max(allW, 1)) * 100).toFixed(0)}%  ` +
      `用色 ${selected.length}`,
  )
  console.log(`   各族最近豆：${famLine}`)
}

for (const [name, pal] of Object.entries(PALETTES)) {
  candidates = pal
  for (const k of [18, 10, 6]) {
    console.log(`\n===== ${name} / 预算 k=${k}（候选 ${pal.length} 色）=====`)
    for (const w of [0, 1, 1.5, 2]) await run(w, true, k)
  }
}
