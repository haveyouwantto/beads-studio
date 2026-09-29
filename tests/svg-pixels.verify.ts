/**
 * 用真实光栅化核对图纸渲染结果（可选工具，需要先装 sharp）：
 *
 *   npm i -D sharp   # sharp 不写进项目依赖，只在需要做像素级核对时临时安装
 *   npx tsx --tsconfig tsconfig.app.json tests/svg-pixels.verify.ts
 *
 * 分三组独立验证，避免互相干扰：
 *   A 线条 —— 单色格子，量细线/粗线的暗度与像素宽度
 *   B 填色 —— 避开格子中心（那里写着色号）与边界
 *   C 色号 —— 深色格子上用浅色字，浅色格子上用深色字
 */
import { buildPatternSvg, DEFAULT_RENDER_OPTIONS, type RenderOptions } from '../src/core/svg.ts'
import { makeEntry } from '../src/core/palette.ts'
import type { Pixmap } from '../src/core/types.ts'

const CELL = 40
const W = 12
const H = 12

function solid(w: number, h: number, rgb: [number, number, number]): Pixmap {
  const img: Pixmap = { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }
  for (let i = 0; i < img.data.length; i += 4) {
    img.data[i] = rgb[0]
    img.data[i + 1] = rgb[1]
    img.data[i + 2] = rgb[2]
    img.data[i + 3] = 255
  }
  return img
}

function checker(w: number, h: number, a: [number, number, number], b: [number, number, number]): Pixmap {
  const img = solid(w, h, a)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if ((x + y) % 2 === 0) continue
      const i = (y * w + x) * 4
      img.data[i] = b[0]
      img.data[i + 1] = b[1]
      img.data[i + 2] = b[2]
    }
  }
  return img
}

const base: RenderOptions = { ...DEFAULT_RENDER_OPTIONS, cellSize: CELL, rulers: false, background: '#ffffff' }

// 用变量形式动态 import：这样没装 sharp 时也不会影响 tsc 类型检查
const sharpSpecifier = 'sharp'
let sharpModule: unknown
try {
  sharpModule = await import(sharpSpecifier)
} catch {
  console.error('需要先安装 sharp 才能做像素级核对：npm i -D sharp')
  process.exit(1)
}
const sharpFactory = sharpModule as { default?: unknown }
const sharp = (sharpFactory.default ?? sharpModule) as unknown as (input: Buffer) => {
  raw: () => {
    toBuffer: (o: {
      resolveWithObject: boolean
    }) => Promise<{ data: Buffer; info: { width: number; height: number; channels: number } }>
  }
}

async function raster(svg: string) {
  const { data, info } = await sharp(Buffer.from(svg)).raw().toBuffer({ resolveWithObject: true })
  const ch = info.channels
  return {
    width: info.width,
    lum: (x: number, y: number): number => {
      const i = (y * info.width + x) * ch
      return 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]
    },
    rgb: (x: number, y: number): [number, number, number] => {
      const i = (y * info.width + x) * ch
      return [data[i], data[i + 1], data[i + 2]]
    },
  }
}

let ok = 0
let bad = 0
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    ok++
    console.log(`  ✓ ${name}`)
  } else {
    bad++
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

// ---------------------------------------------------------------- A 线条
console.log('\nA 网格线（单色格子，关掉色号）')
{
  const pattern = buildPatternSvg(solid(W, H, [128, 128, 128]), [], { ...base, codes: false })
  const img = await raster(pattern.svg)
  const midY = 5 * CELL + CELL / 2
  const cellFill = img.lum(5 * CELL + 20, midY)
  const thinLine = img.lum(3 * CELL, midY)
  const thickLine = img.lum(10 * CELL, midY)

  check('格子填色是灰色', Math.abs(cellFill - 128) < 6, cellFill.toFixed(0))
  check('每格之间有细线', thinLine < cellFill - 20, `线 ${thinLine.toFixed(0)} vs 格内 ${cellFill.toFixed(0)}`)
  check('每 10 格有更明显的粗线', thickLine < thinLine - 10, `粗 ${thickLine.toFixed(0)} vs 细 ${thinLine.toFixed(0)}`)

  const darkRun = (fromX: number): number => {
    let count = 0
    for (let x = fromX - 8; x <= fromX + 8; x++) if (img.lum(x, midY) < cellFill - 20) count++
    return count
  }
  const thinRun = darkRun(3 * CELL)
  const thickRun = darkRun(10 * CELL)
  check('粗线的像素宽度大于细线', thickRun > thinRun, `粗 ${thickRun}px vs 细 ${thinRun}px`)

  const noGrid = await raster(buildPatternSvg(solid(W, H, [128, 128, 128]), [], { ...base, codes: false, grid: false }).svg)
  check('关掉网格后格子之间没有暗线', Math.abs(noGrid.lum(3 * CELL, midY) - cellFill) < 6)

  const every5 = await raster(
    buildPatternSvg(solid(W, H, [128, 128, 128]), [], { ...base, codes: false, majorEvery: 5 }).svg,
  )
  check(
    '粗线间隔改成 5 之后 x=5 这格也变成粗线',
    every5.lum(5 * CELL, midY) < thinLine - 10,
    `x=5 处 ${every5.lum(5 * CELL, midY).toFixed(0)}`,
  )
}

// ---------------------------------------------------------------- B 填色
console.log('\nB 格子填色')
{
  const dark: [number, number, number] = [30, 30, 30]
  const light: [number, number, number] = [240, 240, 240]
  const pattern = buildPatternSvg(checker(W, H, dark, light), [], { ...base, codes: false })
  const img = await raster(pattern.svg)

  const corner = img.rgb(CELL * 1 + 7, CELL * 0 + 7)
  check('浅色格保持原色', Math.abs(corner[0] - 240) < 8, JSON.stringify(corner))
  const cornerDark = img.rgb(CELL * 0 + 7, CELL * 0 + 7)
  check('深色格保持原色', Math.abs(cornerDark[0] - 30) < 8, JSON.stringify(cornerDark))
  check('相邻格子交界处是干净的（crispEdges 无缝隙）', img.lum(CELL * 2, CELL * 0 + 20) < 40)
}

// ---------------------------------------------------------------- C 色号
console.log('\nC 色号文字')
{
  const darkHex = '#1E1E1E'
  const lightHex = '#F0F0F0'
  const palette = [makeEntry(darkHex, { MARD: 'H06' }), makeEntry(lightHex, { MARD: 'H12' })]
  const img = await raster(buildPatternSvg(checker(W, H, [30, 30, 30], [240, 240, 240]), palette, base).svg)

  const countText = (cx: number, cy: number, mode: 'bright' | 'dark'): number => {
    let count = 0
    for (let y = cy * CELL + 8; y < cy * CELL + CELL - 8; y++) {
      for (let x = cx * CELL + 8; x < cx * CELL + CELL - 8; x++) {
        const l = img.lum(x, y)
        if (mode === 'bright' ? l > 190 : l < 70) count++
      }
    }
    return count
  }

  check('深色格上的色号是浅色字', countText(0, 0, 'bright') > 8, `${countText(0, 0, 'bright')} px`)
  check('浅色格上的色号是深色字', countText(1, 0, 'dark') > 8, `${countText(1, 0, 'dark')} px`)

  const noCodes = await raster(buildPatternSvg(checker(W, H, [30, 30, 30], [240, 240, 240]), palette, { ...base, codes: false }).svg)
  let bright = 0
  for (let y = 8; y < CELL - 8; y++) {
    for (let x = 8; x < CELL - 8; x++) if (noCodes.lum(x, y) > 190) bright++
  }
  check('关掉色号后格子里没有文字', bright === 0, `${bright} px`)
}

console.log(`\n结果：${ok} 项通过，${bad} 项失败`)
if (bad > 0) process.exit(1)
