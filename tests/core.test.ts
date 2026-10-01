/**
 * 核心算法自检：不依赖浏览器，用 Node 直接跑。
 *   npm test
 */
import { analyzePeriods, sampleImage } from '../src/core/regularize.ts'
import { detectUniformBlock, collapseBlocks } from '../src/core/direct.ts'
import { defaultCorners, sampleQuad } from '../src/core/warp.ts'
import { quantizeToPalette, countUniqueColors, usageCounts } from '../src/core/quantize.ts'
import {
  buildLibraryPalette,
  codeOf,
  parsePaletteText,
  type PaletteEntry,
} from '../src/core/palette.ts'
import {
  BASIC_24_MARD,
  BASIC_48_EXTRA_MARD,
  BASIC_48_MARD,
  buildBasic24Palette,
  buildBasic48Palette,
  buildWplacePalette,
  PALETTE_SOURCE_LABELS,
  VISIBLE_PALETTE_SOURCES,
} from '../src/core/palette.ts'
import { PaletteOptimizer, targetsFromPixmap, DEFAULT_OPTIMIZE_CONFIG } from '../src/core/optimize.ts'
import { deltaE, hexToRgb, rgbToLab } from '../src/core/color.ts'
import {
  buildPatternSvg,
  clampPreviewCellSize,
  estimateSvgSize,
  SVG_FONT,
  DEFAULT_RENDER_OPTIONS,
  type RenderOptions,
} from '../src/core/svg.ts'
import type { Pixmap, RGB } from '../src/core/types.ts'

let passed = 0
let failed = 0

function check(name: string, condition: boolean, detail = ''): void {
  if (condition) {
    passed++
    console.log(`  ✓ ${name}`)
  } else {
    failed++
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

function section(title: string): void {
  console.log(`\n${title}`)
}

function makePixmap(width: number, height: number, fill: RGB): Pixmap {
  const data = new Uint8ClampedArray(width * height * 4)
  for (let i = 0; i < data.length; i += 4) {
    data[i] = fill[0]
    data[i + 1] = fill[1]
    data[i + 2] = fill[2]
    data[i + 3] = 255
  }
  return { width, height, data }
}

function setPixel(img: Pixmap, x: number, y: number, rgb: RGB): void {
  const i = (y * img.width + x) * 4
  img.data[i] = rgb[0]
  img.data[i + 1] = rgb[1]
  img.data[i + 2] = rgb[2]
  img.data[i + 3] = 255
}

function getPixel(img: Pixmap, x: number, y: number): RGB {
  const i = (y * img.width + x) * 4
  return [img.data[i], img.data[i + 1], img.data[i + 2]]
}

/**
 * 造一张「像素画被整数倍放大」的测试图。
 * 相邻格子保证颜色不同，避免误判成更大的均匀块。
 */
const CELLS_W = 12
const CELLS_H = 10
const BLOCK = 8

function buildTestArt(): { art: Pixmap; upscaled: Pixmap } {
  const cellColor = (cx: number, cy: number): RGB => [(cx * 21) % 256, (cy * 27) % 256, (cx * 13 + cy * 41) % 256]

  const art = makePixmap(CELLS_W, CELLS_H, [0, 0, 0])
  for (let y = 0; y < CELLS_H; y++) {
    for (let x = 0; x < CELLS_W; x++) setPixel(art, x, y, cellColor(x, y))
  }

  const upscaled = makePixmap(CELLS_W * BLOCK, CELLS_H * BLOCK, [0, 0, 0])
  for (let y = 0; y < CELLS_H; y++) {
    for (let x = 0; x < CELLS_W; x++) {
      const c = cellColor(x, y)
      for (let dy = 0; dy < BLOCK; dy++) {
        for (let dx = 0; dx < BLOCK; dx++) {
          setPixel(upscaled, x * BLOCK + dx, y * BLOCK + dy, c)
        }
      }
    }
  }

  return { art, upscaled }
}

const { art, upscaled } = buildTestArt()

// ---------------------------------------------------------------- 规范化
section('① 规范化 · 像素自动识别')
{
  const report = analyzePeriods(upscaled)
  check('检测到周期', report !== null)

  if (report) {
    check(
      `X 周期 ≈ ${BLOCK}`,
      Math.abs(report.periodX - BLOCK) < 0.75,
      `实际 ${report.periodX.toFixed(2)}`,
    )
    check(
      `Y 周期 ≈ ${BLOCK}`,
      Math.abs(report.periodY - BLOCK) < 0.75,
      `实际 ${report.periodY.toFixed(2)}`,
    )
    check('X 覆盖率满分', (report.resultX.winner?.coverage ?? 0) > 0.95)
    check('X 谐波占用满分', (report.resultX.winner?.occupancy ?? 0) > 0.95)
    check(
      'X 相位对齐到 0',
      Math.min(report.phaseX, report.periodX - report.phaseX) < 1,
      `phase=${report.phaseX.toFixed(2)}`,
    )

    const out = sampleImage(
      upscaled.data,
      upscaled.width,
      upscaled.height,
      report.periodX,
      report.periodY,
      report.phaseX,
      report.phaseY,
      'mean',
    )
    check(`重采样得到 ${CELLS_W}×${CELLS_H}`, out.cols === CELLS_W && out.rows === CELLS_H, `实际 ${out.cols}×${out.rows}`)

    let exact = 0
    for (let y = 0; y < Math.min(out.rows, CELLS_H); y++) {
      for (let x = 0; x < Math.min(out.cols, CELLS_W); x++) {
        const got = getPixel(out.pixmap, x, y)
        const want = getPixel(art, x, y)
        if (got[0] === want[0] && got[1] === want[1] && got[2] === want[2]) exact++
      }
    }
    check('逐格颜色与原像素画完全一致', exact === CELLS_W * CELLS_H, `${exact}/${CELLS_W * CELLS_H} 匹配`)
  }
}

section('① 规范化 · 直接 1:1 输入')
{
  check('探测到 8× 放大', detectUniformBlock(upscaled) === BLOCK, `实际 ${detectUniformBlock(upscaled)}`)
  check('1:1 原图不再压缩', detectUniformBlock(art) === 1)

  const collapsed = collapseBlocks(upscaled, BLOCK)
  check(
    `压缩后 ${CELLS_W}×${CELLS_H}`,
    collapsed.width === CELLS_W && collapsed.height === CELLS_H,
    `实际 ${collapsed.width}×${collapsed.height}`,
  )
  let same = true
  for (let y = 0; y < CELLS_H && same; y++) {
    for (let x = 0; x < CELLS_W; x++) {
      const a = getPixel(collapsed, x, y)
      const b = getPixel(art, x, y)
      if (a[0] !== b[0] || a[1] !== b[1] || a[2] !== b[2]) {
        same = false
        break
      }
    }
  }
  check('压缩结果与原像素画一致', same)
}

section('① 规范化 · 四角变换')
{
  // 把 96×80 的图放进 200×200 的画布里，位置已知，检验四角采样能不能对回去
  const canvas = makePixmap(200, 200, [10, 10, 10])
  for (let y = 0; y < upscaled.height; y++) {
    for (let x = 0; x < upscaled.width; x++) {
      setPixel(canvas, x + 30, y + 40, getPixel(upscaled, x, y))
    }
  }

  const corners = [
    { x: 30, y: 40 },
    { x: 30 + 96, y: 40 },
    { x: 30 + 96, y: 40 + 80 },
    { x: 30, y: 40 + 80 },
  ] as const

  const quadded = sampleQuad(canvas, [...corners], CELLS_W, CELLS_H)
  check(`四角采样得到 ${CELLS_W}×${CELLS_H}`, quadded.width === CELLS_W && quadded.height === CELLS_H)

  let exact = 0
  for (let y = 0; y < CELLS_H; y++) {
    for (let x = 0; x < CELLS_W; x++) {
      const a = getPixel(quadded, x, y)
      const b = getPixel(art, x, y)
      if (a[0] === b[0] && a[1] === b[1] && a[2] === b[2]) exact++
    }
  }
  check('四角采样逐格还原', exact === CELLS_W * CELLS_H, `${exact}/${CELLS_W * CELLS_H}`)

  const dc = defaultCorners(200, 200)
  check('默认四角向内收缩 20%', Math.abs(dc[0].x - 40) < 1e-6 && Math.abs(dc[2].y - 160) < 1e-6)
}

// ---------------------------------------------------------------- 色板
section('色板与色号库')
const palette = buildLibraryPalette({ includeExtended: false })
const fullpalette = buildLibraryPalette({ includeExtended: true })
{
  // MARD 官方口径：标准 221 色 = A–H + M 九个系列；完整 291 色 = 再加 P/Q/R/T/Y/ZG
  check('标准色号库 221 色（A–H + M）', palette.length === 221, `实际 ${palette.length}`)
  check('标准库包含 M 系列', palette.some((e) => e.codes.MARD.startsWith('M')), '')
  check('标准库不含 P/Q/R/T/Y/ZG', !palette.some((e) => /^(P|Q|R|T|Y|ZG)/.test(e.codes.MARD)))
  check('含扩展色号 291 色', fullpalette.length === 291, `实际 ${fullpalette.length}`)
  check('包含固定黑白 H02/H07', palette.some((e) => e.codes.MARD === 'H02') && palette.some((e) => e.codes.MARD === 'H07'))
  check('每个色号都有 HEX 与 Lab', palette.every((e) => e.hex.startsWith('#') && e.lab.length === 3))

  const parsed = parsePaletteText('A01, #FEFFFF\nB02', palette, 'MARD')
  check('文本解析命中 A01 / #FEFFFF / B02', parsed.length === 3, `实际 ${parsed.length}`)
  check(
    '解析按选定色号体系优先（MARD B02 ≠ COCO B02）',
    parsePaletteText('B02', palette, 'MARD')[0] === '#63F347' &&
      parsePaletteText('B02', palette, 'COCO')[0] !== '#63F347',
  )
  check('解析结果随色号体系可取回色号', codeOf({ hex: '#FAF4C8', rgb: hexToRgb('#FAF4C8'), lab: rgbToLab(hexToRgb('#FAF4C8')), codes: { MARD: 'A01' } }, 'MARD') === 'A01')
}

section('基础 24 / 48 色与 wplace 色板')
{
  const full = buildLibraryPalette({ includeExtended: true })
  const codes = new Set(full.map((e) => e.codes.MARD))

  check('24 色定义恰好 24 个', BASIC_24_MARD.length === 24, `${BASIC_24_MARD.length}`)
  check('48 追加列表恰好 24 个', BASIC_48_EXTRA_MARD.length === 24, `${BASIC_48_EXTRA_MARD.length}`)
  check('48 = 24 + 追加，且无重复', BASIC_48_MARD.length === 48 && new Set(BASIC_48_MARD).size === 48)
  check(
    '24 色与追加列表不重叠',
    BASIC_24_MARD.every((c) => !(BASIC_48_EXTRA_MARD as readonly string[]).includes(c)),
  )
  check('所有色号都在色号库里存在', BASIC_48_MARD.every((c) => codes.has(c)))

  const p24 = buildBasic24Palette()
  const p48 = buildBasic48Palette()
  check('基础24色解析出 24 个颜色', p24.length === 24, `${p24.length}`)
  check('基础48色解析出 48 个颜色', p48.length === 48, `${p48.length}`)
  check('24 色全部包含在 48 色里', p24.every((e) => p48.some((x) => x.hex === e.hex)))
  check('两个色板都带 MARD 色号', p48.every((e) => Boolean(e.codes.MARD)))
  check(
    '基础色板按色号排序',
    p48.map((e) => e.codes.MARD).join() ===
      [...p48.map((e) => e.codes.MARD)].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).join(),
  )

  // wplace 色板：不是拼豆颜色，保留在代码里但从界面隐藏
  const wplace = buildWplacePalette()
  check('wplace 色板仍然存在（31 色）', wplace.length === 31, `${wplace.length}`)
  check('wplace 色板没有拼豆色号', wplace.every((e) => !e.codes.MARD))
  check('界面上看不到 wplace', !VISIBLE_PALETTE_SOURCES.includes('wplace'))
  check('色板来源里有「优化结果」且排第一', VISIBLE_PALETTE_SOURCES[0] === 'optimized')
  check('「优化结果」的标签正确', PALETTE_SOURCE_LABELS.optimized === '优化结果')
  check(
    '界面色板来源不含旧的基础31色',
    VISIBLE_PALETTE_SOURCES.every((s) => s !== ('basic' as never)),
  )
}

// ---------------------------------------------------------------- 量化
section('② 量化')
{
  const counts = new Uint32Array(0)
  void counts

  const quantized = quantizeToPalette(art, palette, { metric: 'lab', quantize: true, dither: 'none' })
  check('输出尺寸不变', quantized.width === CELLS_W && quantized.height === CELLS_H)

  const allowed = new Map(palette.map((e) => [e.hex, true]))
  let allInPalette = true
  for (let y = 0; y < quantized.height; y++) {
    for (let x = 0; x < quantized.width; x++) {
      const c = getPixel(quantized, x, y)
      const hex = '#' + c.map((v) => v.toString(16).padStart(2, '0')).join('').toUpperCase()
      if (!allowed.has(hex)) {
        allInPalette = false
        break
      }
    }
  }
  check('每个格子都吸附到色板内', allInPalette)
  check('量化后颜色数不超过色板', countUniqueColors(quantized) <= palette.length)

  const dith = quantizeToPalette(art, palette, { metric: 'lab', quantize: true, dither: 'floyd-steinberg' })
  let dithInPalette = true
  for (let i = 0; i < dith.data.length; i += 4) {
    const hex =
      '#' +
      [dith.data[i], dith.data[i + 1], dith.data[i + 2]].map((v) => v.toString(16).padStart(2, '0')).join('').toUpperCase()
    if (!allowed.has(hex)) {
      dithInPalette = false
      break
    }
  }
  check('抖动后仍然只使用色板颜色', dithInPalette)

  const usage = usageCounts(quantized, palette)
  const sum = usage.reduce((a, b) => a + b, 0)
  check('用量统计覆盖全部格子', sum === CELLS_W * CELLS_H, `${sum} vs ${CELLS_W * CELLS_H}`)
}

// ---------------------------------------------------------------- 优化
section('③ 优化颜色（以规范化结果为优化目标）')
{
  const targetInfo = targetsFromPixmap(art, { maxTargets: 1200 })
  check('从网格提取出目标色', targetInfo.samples.length > 0, `${targetInfo.samples.length} 个`)
  check('目标权重之和 = 像素数', targetInfo.samples.reduce((a, s) => a + s.count, 0) === CELLS_W * CELLS_H)

  const config = {
    ...DEFAULT_OPTIMIZE_CONFIG,
    k: 6,
    steps: 4000,
    patience: 800,
    seed: 7,
  }

  const runOnce = async (seed: number) => {
    const optimizer = new PaletteOptimizer(palette, { ...config, seed }, 'grid')
    optimizer.setTargets(targetInfo.samples)
    let initial = 0
    let final = 0
    let selected: PaletteEntry[] = []
    let stats = { min: 0, max: 0, avg: 0, weightedAvg: 0 }
    let sawProgress = false
    for await (const event of optimizer.run()) {
      if (event.type === 'initialized') initial = event.stats.weightedAvg
      if (event.type === 'progress') sawProgress = true
      if (event.type === 'completed') {
        final = event.stats.weightedAvg
        selected = event.selected.map((i) => palette[i])
        stats = event.stats
      }
    }
    return { initial, final, selected, stats, sawProgress }
  }

  const a = await runOnce(7)
  check('返回结果色数 = K + 固定黑白', a.selected.length === config.k + 2, `实际 ${a.selected.length}`)
  check('结果全部来自色号库', a.selected.every((e) => palette.includes(e)))
  check('固定色号一定被选中', a.selected.some((e) => e.codes.MARD === 'H07') && a.selected.some((e) => e.codes.MARD === 'H02'))
  check('优化后不差于初始解', a.final <= a.initial + 1e-9, `初始 ${a.initial.toFixed(3)} → 最终 ${a.final.toFixed(3)}`)
  check('比随机乱选 6 色更好', a.final < naiveBaseline(targetInfo.samples, palette, config.k + 2))
  check('运行过程有进度回调', a.sawProgress)
  check('最终最大 ΔE 有限', Number.isFinite(a.stats.max) && a.stats.max >= 0)

  const b = await runOnce(7)
  const sameSelection =
    a.selected.length === b.selected.length &&
    a.selected.every((e, i) => e.hex === b.selected[i].hex)
  check('相同种子结果可复现', sameSelection)
}

/** 参照物：随机抽 k 个颜色的加权平均 ΔE，用来确认优化确实有用 */
function naiveBaseline(
  samples: { rgb: RGB; lab: RGB; count: number }[],
  pool: PaletteEntry[],
  k: number,
): number {
  let sum = 0
  let weight = 0
  for (const s of samples) {
    let best = Infinity
    for (let i = 0; i < pool.length; i += 37) {
      best = Math.min(best, deltaE(s.lab, pool[i].lab))
    }
    sum += best * s.count
    weight += s.count
  }
  void k
  return sum / weight
}

// ---------------------------------------------------------------- 图纸（SVG）
const THIN_ATTR = 'stroke-width="0.05"'
const THICK_ATTR = 'stroke-width="0.18"'

function strokePathD(svg: string, attr: string): string {
  const m = new RegExp(`<path d="([^"]*)" stroke="[^"]*" ${attr}`).exec(svg)
  return m ? m[1] : ''
}

function countSubpaths(svg: string, attr: string): number {
  const d = strokePathD(svg, attr)
  if (!d) return 0
  return (d.match(/M/g) ?? []).length
}

/** 竖向粗线：d 里用 V 指令的都是竖线 */
function countVerticalThick(svg: string): number {
  const d = strokePathD(svg, THICK_ATTR)
  if (!d) return 0
  return (d.match(/M[\d.]+ [\d.]+V/g) ?? []).length
}

/** 非网格 path 都是按颜色分组的格子 */
function countColorPaths(svg: string): number {
  return (svg.match(/<path transform="translate\([^)]*\)" d="[^"]*" fill="#/g) ?? []).length
}

section('③ 转拼豆图纸 · 矢量 SVG')
{
  // 默认就是「带色号的方格图纸 + 每格细线 + 每 10 格粗线」
  check('默认样式是方格图纸', DEFAULT_RENDER_OPTIONS.style === 'flat')
  check('默认标注色号', DEFAULT_RENDER_OPTIONS.codes === true)
  check('默认绘制网格线', DEFAULT_RENDER_OPTIONS.grid === true)
  check('默认每 10 格一条粗线', DEFAULT_RENDER_OPTIONS.majorEvery === 10)

  // 造一张 21×12 的图案：x=0/10/20、y=0/10 应该落在粗线上
  const W = 21
  const H = 12
  const png = makePixmap(W, H, [0, 0, 0])
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4
      const c = palette[(x + y * 3) % palette.length]
      png.data[i] = c.rgb[0]
      png.data[i + 1] = c.rgb[1]
      png.data[i + 2] = c.rgb[2]
      png.data[i + 3] = 255
    }
  }

  const opts: RenderOptions = { ...DEFAULT_RENDER_OPTIONS, rulers: false }
  const out = buildPatternSvg(png, palette, opts)

  check('输出是 SVG', out.svg.startsWith('<svg') && out.svg.endsWith('</svg>'))
  check('带 viewBox（可任意缩放）', out.svg.includes('viewBox="0 0 21 12"'), out.svg.slice(0, 80))
  check('固有尺寸 = 格数 × 格子大小', out.width === W * opts.cellSize && out.height === H * opts.cellSize)
  check('没有把文字转成像素', !out.svg.includes('<image'))

  const horizontalThick = countVerticalThick(out.svg)
  check(
    '粗线只落在 0 / 10 / 20 这几列上',
    horizontalThick === 3,
    `实际 ${horizontalThick} 条竖向粗线`,
  )

  const thickTotal = countSubpaths(out.svg, THICK_ATTR)
  const thinTotal = countSubpaths(out.svg, THIN_ATTR)
  check('竖向粗线 3 + 横向粗线 2', thickTotal === 5, `实际 ${thickTotal}`)
  check(
    '细线补满其余所有格线',
    thinTotal === (W + 1 - 3) + (H + 1 - 2),
    `实际 ${thinTotal}`,
  )

  const thick5 = buildPatternSvg(png, palette, { ...opts, majorEvery: 5 })
  check(
    '把粗线间隔改成 5 之后粗线变多',
    countSubpaths(thick5.svg, THICK_ATTR) > countSubpaths(out.svg, THICK_ATTR),
    `${countSubpaths(thick5.svg, THICK_ATTR)} vs ${countSubpaths(out.svg, THICK_ATTR)}`,
  )

  check('每个用到的颜色合并成一条 path', countColorPaths(out.svg) === new Set(
    Array.from({ length: W * H }, (_, i) => {
      const p = i * 4
      return '#' + [png.data[p], png.data[p + 1], png.data[p + 2]]
        .map((v) => v.toString(16).padStart(2, '0'))
        .join('')
        .toUpperCase()
    }),
  ).size)

  check('格子用 crispEdges 避免抗锯齿缝隙', out.svg.includes('shape-rendering="crispEdges"'))
  check('色号以 <text> 输出', /<text[^>]*>[A-Z]{1,2}\d{1,2}<\/text>/.test(out.svg))
  check('图纸用无衬线字体（与界面一致）', SVG_FONT.includes('Roboto') && SVG_FONT.includes('sans-serif'))
  check('图纸字体不是等宽', !SVG_FONT.includes('monospace'))
  check('SVG 根节点带上了这个字体', out.svg.includes(`font-family="${SVG_FONT}"`))

  const noCodes = buildPatternSvg(png, palette, { ...opts, codes: false })
  check('关掉色号后没有 <text>', !noCodes.svg.includes('<text'))

  const noGrid = buildPatternSvg(png, palette, { ...opts, grid: false })
  check('关掉网格后没有网格 path', countSubpaths(noGrid.svg, THICK_ATTR) === 0)

  const small = buildPatternSvg(makePixmap(4, 4, [10, 10, 10]), palette, opts)
  check('4×4 小图也能生成', small.svg.startsWith('<svg'))

  check('标尺会让固有尺寸变大', estimateSvgSize(png, { ...opts, rulers: true }).width > out.width)
  check(
    '超大图纸预览会自动降格子尺寸',
    clampPreviewCellSize(makePixmap(600, 400, [0, 0, 0]), DEFAULT_RENDER_OPTIONS, 1600) <
      DEFAULT_RENDER_OPTIONS.cellSize,
  )
}

// ---------------------------------------------------------------- 汇总
console.log(`\n${'─'.repeat(52)}`)
console.log(`通过 ${passed} 项，失败 ${failed} 项`)
if (failed > 0) process.exit(1)
