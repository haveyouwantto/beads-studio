/**
 * 一次性对照：同一张图，hueWeight 0 / 2 出两份 PNG，肉眼看色相有没有被换掉。
 * 运行：node --experimental-strip-types huecompare.ts
 */
import { deflateSync } from 'node:zlib'
import { writeFileSync } from 'node:fs'
import { buildLibraryPalette } from './src/core/palette.ts'
import { quantizeToPalette } from './src/core/quantize.ts'
import { PaletteOptimizer, targetsFromPixmap, DEFAULT_OPTIMIZE_CONFIG, type OptimizeConfig } from './src/core/optimize.ts'
import type { Pixmap, RGB } from './src/core/types.ts'

const W = 240
const H = 180

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

/** 场景：天空渐变 + 远山（灰蓝）+ 草地（橄榄绿）+ 一棵树（深绿）+ 一条小溪（青）+ 屋顶（砖红） */
function scene(): Pixmap {
  const data = new Uint8ClampedArray(W * H * 4)
  const put = (x: number, y: number, c: RGB) => {
    const i = (y * W + x) * 4
    data[i] = c[0]
    data[i + 1] = c[1]
    data[i + 2] = c[2]
    data[i + 3] = 255
  }
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let c: RGB
      const horizon = 96
      if (y < horizon) {
        // 天空：顶部偏紫蓝，靠近地平线偏暖
        const t = y / horizon
        c = lchToRgb(72 - 6 * t, 26 + 10 * t, 258 - 18 * t)
      } else if (y < horizon + 26) {
        const t = (y - horizon) / 26
        c = lchToRgb(50 + 8 * t, 14, 265 - 4 * t) // 灰蓝山体
      } else {
        const t = (y - horizon - 26) / (H - horizon - 26)
        c = lchToRgb(56 - 14 * t, 24 + 6 * t, 108) // 橄榄草地
      }
      // 小溪：斜向带，低彩度青
      const d = Math.abs(y - (130 + 0.12 * (x - 120)))
      if (d < 7 && y > 110) c = lchToRgb(64 - d, 16, 172)
      // 树
      const dx = x - 62
      const dy = y - 108
      if (dx * dx + dy * dy < 26 * 26) c = lchToRgb(40 + (dx + dy) / 12, 30, 140)
      // 屋顶
      if (x > 160 && x < 214 && y > 84 && y < 100) c = lchToRgb(46, 38, 32)
      if (x > 164 && x < 210 && y >= 100 && y < 132) c = lchToRgb(78, 12, 70)
      put(x, y, c)
    }
  }
  return { width: W, height: H, data }
}

function crc32(buf: Uint8Array): number {
  let c = ~0
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i]
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1))
  }
  return ~c >>> 0
}

function png(img: Pixmap): Buffer {
  const raw = Buffer.alloc((img.width * 3 + 1) * img.height)
  let o = 0
  for (let y = 0; y < img.height; y++) {
    raw[o++] = 0
    for (let x = 0; x < img.width; x++) {
      const i = (y * img.width + x) * 4
      raw[o++] = img.data[i]
      raw[o++] = img.data[i + 1]
      raw[o++] = img.data[i + 2]
    }
  }
  const chunk = (type: string, body: Buffer) => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(body.length)
    const tb = Buffer.concat([Buffer.from(type, 'ascii'), body])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(tb))
    return Buffer.concat([len, tb, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(img.width, 0)
  ihdr.writeUInt32BE(img.height, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

const palette = buildLibraryPalette({ includeExtended: true })
const base = scene()
writeFileSync('hue_original.png', png(base))

const scale = (img: Pixmap, k: number): Pixmap => {
  const d = new Uint8ClampedArray(img.width * k * img.height * k * 4)
  for (let y = 0; y < img.height * k; y++) {
    for (let x = 0; x < img.width * k; x++) {
      const si = (Math.floor(y / k) * img.width + Math.floor(x / k)) * 4
      const di = (y * img.width * k + x) * 4
      d[di] = img.data[si]
      d[di + 1] = img.data[si + 1]
      d[di + 2] = img.data[si + 2]
      d[di + 3] = 255
    }
  }
  return { width: img.width * k, height: img.height * k, data: d }
}
const stack = (imgs: Pixmap[]): Pixmap => {
  const w = Math.max(...imgs.map((i) => i.width))
  const h = imgs.reduce((a, i) => a + i.height + 4, 0)
  const d = new Uint8ClampedArray(w * h * 4).fill(255)
  let y0 = 0
  for (const im of imgs) {
    for (let y = 0; y < im.height; y++) {
      for (let x = 0; x < im.width; x++) {
        const si = (y * im.width + x) * 4
        const di = ((y0 + y) * w + x) * 4
        d[di] = im.data[si]
        d[di + 1] = im.data[si + 1]
        d[di + 2] = im.data[si + 2]
        d[di + 3] = 255
      }
    }
    y0 += im.height + 4
  }
  return { width: w, height: h, data: d }
}

const targetInfo = targetsFromPixmap(base)

async function fullRun(w: number, fams: boolean) {
  const cfg: OptimizeConfig = {
    ...DEFAULT_OPTIMIZE_CONFIG,
    k: 12,
    hueWeight: w,
    hueFamilies: fams,
    steps: 15000,
    patience: 3000,
  }
  const opt = new PaletteOptimizer(palette, cfg, 'grid')
  opt.setTargets(targetInfo.samples)
  let mapping: { key: number; hex: string }[] = []
  for await (const ev of opt.run()) if (ev.type === 'completed') mapping = ev.mapping
  return mapping
}

const outs: Pixmap[] = [scale(base, 2)]
for (const [w, fams] of [[0, false], [2, true]] as const) {
  const mapping = await fullRun(w, fams)
  const out = quantizeToPalette(
    base,
    palette,
    { metric: 'lab', quantize: true, dither: 'none', hueWeight: w },
    mapping,
  )
  writeFileSync(`hue_w${w}.png`, png(out))
  outs.push(scale(out, 2))
  const hexes = new Set<string>()
  for (let i = 0; i < out.data.length; i += 4) {
    hexes.add(`${out.data[i]},${out.data[i + 1]},${out.data[i + 2]}`)
  }
  console.log(`wHue=${w} 保底${fams ? '开' : '关'}: ${hexes.size} 种颜色 → hue_w${w}.png`)
}
writeFileSync('hue_stack.png', png(stack(outs)))
