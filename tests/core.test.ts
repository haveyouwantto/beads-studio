/**
 * 核心算法自检：不依赖浏览器，用 Node 直接跑。
 *   npm test
 */
import { analyzePeriods, sampleImage } from '../src/core/regularize.ts'
import {
  appendSwatch,
  clusterColors,
  colorUsage,
  countIgnored,
  EDIT_PRESETS,
  floodFill,
  historyLimit,
  IGNORED_ALPHA,
  isIgnoredAt,
  MAX_ADDED_SWATCHES,
  readCell,
  writeCell,
} from '../src/core/edit.ts'
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
  applyBeadAlpha,
  appearanceRgb,
  buildKitPalette,
  buildWplacePalette,
  KIT_MARD,
  KIT_SIZES,
  matchPalette,
  PALETTE_SOURCE_LABELS,
  swatchHex,
  VISIBLE_PALETTE_SOURCES,
} from '../src/core/palette.ts'
import { PaletteOptimizer, targetsFromPixmap, DEFAULT_OPTIMIZE_CONFIG } from '../src/core/optimize.ts'
import { deltaE, hexToRgb, rgbToHex, rgbToLab } from '../src/core/color.ts'
import { buildPaletteExport, packPixels, safeFileName, unpackPixels } from '../src/core/export.ts'
import {
  boardLayout,
  boardInset,
  buildBoardPatternSvg,
  buildPatternSvg,
  clampPreviewCellSize,
  estimateSvgSize,
  SVG_FONT,
  DEFAULT_RENDER_OPTIONS,
  type RenderOptions,
} from '../src/core/svg.ts'
import type { Pixmap, RGB, SampleMode } from '../src/core/types.ts'

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

  // 四角变换和自动识别共用同一套格内取样方式
  const quadModes: SampleMode[] = ['center', 'mean', 'median', 'geometric', 'mode']
  const sameAsArt = (pm: Pixmap): boolean => {
    for (let y = 0; y < CELLS_H; y++) {
      for (let x = 0; x < CELLS_W; x++) {
        const a = getPixel(pm, x, y)
        const b = getPixel(art, x, y)
        if (a[0] !== b[0] || a[1] !== b[1] || a[2] !== b[2]) return false
      }
    }
    return true
  }
  check('四角变换默认就是中心点取样', sameAsArt(sampleQuad(canvas, [...corners], CELLS_W, CELLS_H)))
  check(
    '四角变换支持全部五种取样方式',
    quadModes.every((m) => sameAsArt(sampleQuad(canvas, [...corners], CELLS_W, CELLS_H, m))),
    quadModes.join(),
  )

  // 一格跨两种颜色时，中心点和平均给的结果不一样（说明 mode 真的生效了）
  const twoTone = makePixmap(2, 2, [0, 0, 0])
  setPixel(twoTone, 0, 0, [255, 0, 0])
  setPixel(twoTone, 1, 1, [0, 0, 255])
  const whole = [
    { x: 0, y: 0 },
    { x: 2, y: 0 },
    { x: 2, y: 2 },
    { x: 0, y: 2 },
  ] as const
  const oneCell = (m: SampleMode) => getPixel(sampleQuad(twoTone, [...whole], 1, 1, m), 0, 0)
  check('四角 · 中心点只取格中心那一个像素', oneCell('center').slice(0, 3).join() === '0,0,255', oneCell('center').slice(0, 3).join())
  check('四角 · 平均把整格混起来', oneCell('mean').slice(0, 3).join() === '64,0,64', oneCell('mean').slice(0, 3).join())

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

  // 下载文件名：项目名里可能有文件名不允许的字符
  check('文件名去掉非法字符', safeFileName('a/b:c*d?e"f<g>h|i') === 'a b c d e f g h i', safeFileName('a/b:c*d?e"f<g>h|i'))
  check('文件名不留开头的点', safeFileName('...隐藏名') === '隐藏名', safeFileName('...隐藏名'))
  check('文件名空时用兜底', safeFileName('   ') === 'beads-studio', safeFileName('   '))
  check('正常中文名原样保留', safeFileName('小狐狸 拼豆') === '小狐狸 拼豆', safeFileName('小狐狸 拼豆'))

  // 导出的色板 JSON：版本号得是自己的（以前写着原工具的 '3.0'）
  const three = palette.slice(0, 3)
  const paletteJson = JSON.parse(buildPaletteExport(three, 'MARD', 'json')) as Record<string, unknown>
  check(
    '色板 JSON 带 app 与 version=1',
    paletteJson.app === 'beads-studio' && paletteJson.version === 1,
    JSON.stringify({ app: paletteJson.app, version: paletteJson.version }),
  )
  check('色板 JSON 里没有 3.0', !buildPaletteExport(three, 'MARD', 'json').includes('3.0'))
  check('色板 JSON 记下色号体系与数量', paletteJson.codeSystem === 'MARD' && paletteJson.totalColors === 3)
  check('色板 JSON 里颜色按色号排好', (paletteJson.codes as { code: string }[]).map((c) => c.code).join() === three.map((e) => e.codes.MARD).join())
  check(
    'HEX / 色号导出各一行',
    buildPaletteExport(three, 'MARD', 'hex').split('\n').length === 3 &&
      buildPaletteExport(three, 'MARD', 'code').split('\n').length === 3,
  )
}

section('基础 24 / 48 色与 wplace 色板')
{
  const full = buildLibraryPalette({ includeExtended: true })
  const codes = new Set(full.map((e) => e.codes.MARD))

  check('套装档位是 24/48/72/96/120', KIT_SIZES.join() === '24,48,72,96,120', KIT_SIZES.join())
  for (const n of KIT_SIZES) {
    const list = KIT_MARD[n]
    check(`${n} 色套装恰好 ${n} 个色号`, list.length === n, `${list.length}`)
    check(`${n} 色套装无重复`, new Set(list).size === n)
    check(`${n} 色套装色号都在色号库里`, list.every((c) => codes.has(c)))
  }
  // 24 → 48 → 72 → 96 → 120 严格逐级包含，每档正好多 24 色
  for (let i = 1; i < KIT_SIZES.length; i++) {
    const small = new Set(KIT_MARD[KIT_SIZES[i - 1]])
    const big = KIT_MARD[KIT_SIZES[i]]
    check(
      `${KIT_SIZES[i]} 色套装包含 ${KIT_SIZES[i - 1]} 色套装且多 24 色`,
      [...small].every((c) => big.includes(c)) && big.length - small.size === 24,
    )
  }

  const p24 = buildKitPalette(24)
  const p120 = buildKitPalette(120)
  check('24 色套装解析出 24 个颜色', p24.length === 24, `${p24.length}`)
  check('120 色套装解析出 120 个颜色', p120.length === 120, `${p120.length}`)
  check('24 色全部包含在 120 色里', p24.every((e) => p120.some((x) => x.hex === e.hex)))
  check('套装色板都带 MARD 色号', p120.every((e) => Boolean(e.codes.MARD)))
  check(
    '套装色板按色号排序',
    p120.map((e) => e.codes.MARD).join() ===
      [...p120.map((e) => e.codes.MARD)].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).join(),
  )

  // H01 是透明塑料豆：等效 #FFFFFF40（白色 25% 不透明），不能当实心白用
  const h01 = palette.find((e) => e.codes.MARD === 'H01')
  const h02 = palette.find((e) => e.codes.MARD === 'H02')
  check('H01 在标准色板里', Boolean(h01))
  check('H01 带 0x40 的透明度', Math.abs((h01?.alpha ?? 1) - 0x40 / 255) < 1e-6, String(h01?.alpha))
  check('H02 是实心白（没有 alpha）', h02?.alpha === undefined, String(h02?.alpha))
  check('H01 的实色仍是色卡上的 #FDFBFF', h01?.hex === '#FDFBFF', h01?.hex)

  // 观感 = 叠在背景上；匹配用的是观感色
  const overWhite = appearanceRgb(h01!, '#FFFFFF')
  check('H01 叠在白底上就是白色', overWhite.join() === '255,255,255', overWhite.join())
  const overDark = appearanceRgb(h01!, '#121212')
  check(
    'H01 叠在深色图纸背景上是不透明的浅灰',
    overDark[0] < 120 && overDark[0] > 60 && Math.abs(overDark[0] - overDark[2]) <= 1,
    overDark.join(),
  )
  check('实心色叠背景后不变', appearanceRgb(h02!, '#121212').join() === h02!.rgb.join())
  const darkMatch = matchPalette(palette, '#121212')
  const h01InMatch = darkMatch.find((e) => e.codes.MARD === 'H01')
  check('匹配用的调色板里 H01 换成观感色', h01InMatch?.rgb.join() === overDark.join(), h01InMatch?.rgb.join())
  check('匹配用调色板不改变色号', h01InMatch?.hex === '#FDFBFF' && h01InMatch?.codes.MARD === 'H01')

  // 纯白的目标色不该再被 H01 抢走
  const whiteTarget: Pixmap = { width: 1, height: 1, data: new Uint8ClampedArray([255, 255, 255, 255]) }
  const whiteHit = quantizeToPalette(whiteTarget, darkMatch, { metric: 'lab', quantize: true, dither: 'none' })
  const whiteHex = rgbToHex([whiteHit.data[0], whiteHit.data[1], whiteHit.data[2]])
  check('深色背景：纯白像素匹配到 H02', whiteHex === h02?.hex, `${whiteHex}（H01=${h01?.hex}）`)

  // 白底上 H01 的观感和 H02 没区别 → 直接不参与匹配，免得顶替白色
  const whiteMatch = matchPalette(palette, '#FFFFFF')
  check('白底上 H01 不参与匹配', !whiteMatch.some((e) => e.codes.MARD === 'H01'))
  const whiteOnWhite = quantizeToPalette(whiteTarget, whiteMatch, { metric: 'lab', quantize: true, dither: 'none' })
  check(
    '白底：纯白像素同样匹配到 H02',
    rgbToHex([whiteOnWhite.data[0], whiteOnWhite.data[1], whiteOnWhite.data[2]]) === h02?.hex,
  )
  // 深色底上 H01 是明显的浅灰，该留着（真要用透明豆时能选到）
  check('深色底上 H01 仍在候选里', darkMatch.some((e) => e.codes.MARD === 'H01'))
  const swatch = swatchHex(h01!)
  check('色块界面色是叠在深色面板上的观感', swatch !== h01!.hex && swatch.startsWith('#'), `${swatch}`)

  // 导出 1:1 像素图：H01 的格子写成真·半透明 (#FFFFFF40)
  const h01Hex = h01!.hex
  const h01Rgb = hexToRgb(h01Hex)
  const alphaPixmap: Pixmap = { width: 1, height: 1, data: new Uint8ClampedArray([...h01Rgb, 255]) }
  const withAlpha = applyBeadAlpha(alphaPixmap, palette)
  check(
    '导出的 H01 是 #FFFFFF40',
    withAlpha.data[0] === 255 && withAlpha.data[1] === 255 && withAlpha.data[2] === 255 && withAlpha.data[3] === 0x40,
    [...withAlpha.data].join(),
  )
  const solidPixmap: Pixmap = { width: 1, height: 1, data: new Uint8ClampedArray([...h02!.rgb, 255]) }
  check('实心豆导出不受影响', applyBeadAlpha(solidPixmap, palette).data[3] === 255)

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

// ---------------------------------------------------------------- 像素编辑
section('像素编辑（第 2 步）')
{
  const w = 3
  const h = 2
  const pixmap: Pixmap = { width: w, height: h, data: new Uint8ClampedArray(w * h * 4).fill(255) }
  // 先把底色都刷成红，方便看覆盖效果
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) writeCell(pixmap.data, w, x, y, '#E53935')
  // 预设色板 = MARD 24 色套装，其中 H01 当作「透明（忽略）」
  const presetCodes = EDIT_PRESETS.map((p) => p.code)
  const libraryByCode = new Map(palette.map((e) => [e.codes.MARD, e.hex]))
  check('预设色板就是 24 色套装', EDIT_PRESETS.length === 24 && presetCodes.join() === [...KIT_MARD[24]].join(), presetCodes.join())
  check('预设里 H01 是透明档', EDIT_PRESETS.find((p) => p.code === 'H01')?.transparent === true)
  check('预设其它颜色都是真实色号色值', EDIT_PRESETS.filter((p) => !p.transparent).every((p) => libraryByCode.get(p.code) === p.hex), '')
  check('预设里有白（H02）和黑（H07）', presetCodes.includes('H02') && presetCodes.includes('H07'))

  writeCell(pixmap.data, w, 1, 0, '#1E88E5')
  check('涂色写入指定格子', readCell(pixmap, 1, 0) === '#1E88E5', String(readCell(pixmap, 1, 0)))
  check('只改了那一格', readCell(pixmap, 0, 0) === '#E53935' && readCell(pixmap, 2, 0) === '#E53935')
  check('初始没有被忽略的格子', countIgnored(pixmap) === 0)

  // 涂成透明 = 忽略
  writeCell(pixmap.data, w, 0, 0, null)
  writeCell(pixmap.data, w, 2, 1, null)
  check('涂透明后 alpha 归零', pixmap.data[3] === 0 && pixmap.data[3] < IGNORED_ALPHA)
  check('涂透明的格子被判定为忽略', isIgnoredAt(pixmap, 0, 0) && isIgnoredAt(pixmap, 2, 1))
  check('被忽略的格子取色返回 null', readCell(pixmap, 0, 0) === null)
  check('越界当作忽略', isIgnoredAt(pixmap, -1, 0) && isIgnoredAt(pixmap, w, 0))
  check('忽略计数正确', countIgnored(pixmap) === 2, String(countIgnored(pixmap)))

  const usage = colorUsage(pixmap)
  // 6 格里：1 格改成蓝、2 格涂成透明 → 红色剩 3 格
  check('忽略的格子不计入颜色统计', usage.find((u) => u.hex === '#E53935')?.count === 3, JSON.stringify(usage))
  check('统计里没有透明格', usage.every((u) => u.count > 0) && usage.length === 2, JSON.stringify(usage))
  check('统计按数量从多到少', usage[0].count >= usage[usage.length - 1].count)
  check(
    '撤销栈容量随网格大小收缩',
    historyLimit(pixmap) > historyLimit({ width: 400, height: 400, data: new Uint8ClampedArray(0) }),
    `${historyLimit(pixmap)} / ${historyLimit({ width: 400, height: 400, data: new Uint8ClampedArray(0) })}`,
  )

  // 下游：优化目标必须跳过忽略的格子
  const target = targetsFromPixmap(pixmap)
  const targetPixels = target.samples.reduce((a, s) => a + s.count, 0)
  check('优化目标跳过被忽略的格子', targetPixels === w * h - 2, `${targetPixels} / ${w * h}`)

  // 下游：用料清单不能把忽略的格子算成豆子
  const red = palette.find((e) => e.hex === '#E53935') ?? { hex: '#E53935', rgb: hexToRgb('#E53935'), lab: rgbToLab(hexToRgb('#E53935')), codes: {} }
  const blue = palette.find((e) => e.hex === '#1E88E5') ?? { hex: '#1E88E5', rgb: hexToRgb('#1E88E5'), lab: rgbToLab(hexToRgb('#1E88E5')), codes: {} }
  const smallPalette = [red, blue]
  const counts = usageCounts(pixmap, smallPalette)
  check('用量统计跳过被忽略的格子', counts[0] === 3 && counts[1] === 1, [...counts].join())

  // 下游：出图不给忽略的格子画豆子，也不写色号
  const chart = buildPatternSvg(pixmap, smallPalette, { ...DEFAULT_RENDER_OPTIONS, codes: true, grid: false, rulers: false })
  const cells = (chart.svg.match(/h1v1h-1z/g) ?? []).length
  check('图纸里只画有效格子', cells === w * h - 2, `${cells} 个格子元素`)

  // 存档往返：忽略状态（alpha=0）必须原样带回
  const roundTrip = unpackPixels(w, h, packPixels(pixmap))
  check('存档往返保留透明格', countIgnored({ width: w, height: h, data: roundTrip }) === 2)

  // 油漆桶：整片同色区域一次填掉
  const fillCanvas: Pixmap = { width: 4, height: 3, data: new Uint8ClampedArray(4 * 3 * 4).fill(255) }
  for (let y = 0; y < 3; y++) for (let x = 0; x < 4; x++) writeCell(fillCanvas.data, 4, x, y, x < 2 ? '#FFFFFF' : '#000000')
  const filled = floodFill(fillCanvas.data, 4, 3, 0, 0, '#FF0000')
  check('油漆桶填满整片同色区域', filled === 6, `${filled} 格`)
  check('油漆桶不越过边界', readCell(fillCanvas, 0, 0) === '#FF0000' && readCell(fillCanvas, 2, 0) === '#000000')
  check('油漆桶填充同色时不做事', floodFill(fillCanvas.data, 4, 3, 0, 0, '#FF0000') === 0)
  // 整张图和起点同色时，重复填充同一个颜色不产生变化
  const oneColor: Pixmap = { width: 3, height: 1, data: new Uint8ClampedArray(3 * 4).fill(255) }
  check('油漆桶可以填成透明', floodFill(oneColor.data, 3, 1, 1, 0, null) === 3 && countIgnored(oneColor) === 3)

  // 油漆桶的两种口径：按颜色只认一模一样的，按聚类把同色系一起填
  const band: Pixmap = { width: 6, height: 1, data: new Uint8ClampedArray(6 * 4) }
  writeCell(band.data, 6, 0, 0, '#E53935')
  writeCell(band.data, 6, 1, 0, '#E43834') // 和 0 号差一点点的红
  writeCell(band.data, 6, 2, 0, '#E53733') // 还是那一片红
  writeCell(band.data, 6, 3, 0, '#1E88E5') // 蓝：另一类
  writeCell(band.data, 6, 4, 0, '#1E88E5')
  writeCell(band.data, 6, 5, 0, '#000000')
  const bandClusters = clusterColors(band, 24)
  const byColor: Pixmap = { width: 6, height: 1, data: new Uint8ClampedArray(band.data) }
  check('按颜色只填一模一样的相邻格', floodFill(byColor.data, 6, 1, 0, 0, '#00FF00') === 1)
  const byCluster: Pixmap = { width: 6, height: 1, data: new Uint8ClampedArray(band.data) }
  check(
    '按聚类把同色系的相邻格一起填',
    floodFill(byCluster.data, 6, 1, 0, 0, '#00FF00', { mode: 'cluster', clusters: bandClusters }) === 3,
    String(readCell(byCluster, 0, 0)),
  )
  check('按聚类不越到别的类', readCell(byCluster, 3, 0) === '#1E88E5' && readCell(byCluster, 5, 0) === '#000000')
  const noClusters: Pixmap = { width: 6, height: 1, data: new Uint8ClampedArray(band.data) }
  check(
    '按聚类但没给类时退回按颜色',
    floodFill(noClusters.data, 6, 1, 0, 0, '#00FF00', { mode: 'cluster' }) === 1,
  )
  const withHole: Pixmap = { width: 6, height: 1, data: new Uint8ClampedArray(band.data) }
  writeCell(withHole.data, 6, 1, 0, null)
  check(
    '按聚类不会跨过被忽略的格子',
    floodFill(withHole.data, 6, 1, 0, 0, '#00FF00', { mode: 'cluster', clusters: bandClusters }) === 1,
  )

  // 调色板：新增色按加入顺序排，最多 24 个（满了挤掉最早的）
  check('新增色上限 24', MAX_ADDED_SWATCHES === 24)
  let added: string[] = []
  for (let i = 1; i <= 26; i++) added = appendSwatch(added, `#${i.toString(16).padStart(2, '0').toUpperCase()}0000`)
  check('超过 24 个会挤掉最早的', added.length === 24 && !added.includes('#010000') && added[0] === '#030000', `${added.length} 个，首个 ${added[0]}`)
  check('新加的排在最后', added[added.length - 1] === '#1A0000', added[added.length - 1])
  const again = appendSwatch(added, added[3])
  check('重复添加同一个颜色不重排', again === added)

  // 颜色聚类：相近的颜色并成一类，最多 24 类，代表色取该类里出现最多的那个
  const photo: Pixmap = { width: 20, height: 10, data: new Uint8ClampedArray(20 * 10 * 4) }
  for (let y = 0; y < 10; y++) {
    for (let x = 0; x < 20; x++) {
      // 左半 10×10 是两种几乎一样的红，右半是蓝色（渐变出 20 种）
      const hex = x < 10 ? (y < 5 ? '#E53935' : '#E43834') : `#${(0x20 + x * 3).toString(16).padStart(2, '0')}88E5`
      writeCell(photo.data, 20, x, y, hex)
    }
  }
  const clusters = clusterColors(photo, 24)
  check('聚类把相近的红并成一类', clusters.filter((c) => c.hex.startsWith('#E4') || c.hex.startsWith('#E5')).length === 1, JSON.stringify(clusters.slice(0, 4)))
  check('聚类结果按出现次数排序', clusters.every((c, i) => i === 0 || clusters[i - 1].count >= c.count))
  check('聚类代表色是图里真实存在的颜色', clusters.every((c) => colorUsage(photo).some((u) => u.hex === c.hex)))
  const manyColors: Pixmap = { width: 40, height: 10, data: new Uint8ClampedArray(40 * 10 * 4) }
  for (let y = 0; y < 10; y++) for (let x = 0; x < 40; x++) writeCell(manyColors.data, 40, x, y, `#${(x * 6).toString(16).padStart(2, '0')}${(y * 25).toString(16).padStart(2, '0')}80`)
  check('颜色很多时聚成 24 类', clusterColors(manyColors, 24).length <= 24, `${clusterColors(manyColors, 24).length}`)
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
  check('带 viewBox（可任意缩放）', out.svg.includes('viewBox="0 0 26.2 17.2"'), out.svg.slice(0, 80))
  check('图纸四边留出同样的边距', out.svg.includes('transform="translate(2.6 2.6)"'), out.svg.slice(0, 160))
  check(
    '固有尺寸 = (格数 + 两边边距) × 格子大小',
    out.width === Math.round((W + opts.margin * 2) * opts.cellSize) &&
      out.height === Math.round((H + opts.margin * 2) * opts.cellSize),
    `${out.width}×${out.height}`,
  )
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

  // 标尺数字写在留白里，不再自己撑开一条边
  check('标尺不改变图纸尺寸', estimateSvgSize(png, { ...opts, rulers: true }).width === out.width)
  const withRulers = buildPatternSvg(png, palette, { ...opts, rulers: true })
  check('标尺数字写在留白里', withRulers.svg.includes(`<text x="3.1" y="1.5"`), withRulers.svg.slice(0, 200))
  const tight = buildPatternSvg(png, palette, { ...opts, margin: 0 })
  check(
    '边距设 0 时图纸贴边',
    tight.svg.includes('viewBox="0 0 21 12"') && tight.width === W * opts.cellSize,
    `${tight.width}`,
  )
  check(
    '超大图纸预览会自动降格子尺寸',
    clampPreviewCellSize(makePixmap(600, 400, [0, 0, 0]), DEFAULT_RENDER_OPTIONS, 1600) <
      DEFAULT_RENDER_OPTIONS.cellSize,
  )
}

section('③ 转拼豆图纸 · 拼豆板拆分')
{
  // 120×80 的图按 50×50 的板拆：3 × 2 = 6 块，最后一块是零头 20×30
  const boardOpts: RenderOptions = { ...DEFAULT_RENDER_OPTIONS, boardSize: 50, rulers: true }
  const big = makePixmap(120, 80, [200, 60, 60])
  const layout = boardLayout(big, boardOpts)
  check(
    '120×80 按 50 拆成 3 × 2 = 6 块',
    layout.boardCols === 3 && layout.boardRows === 2 && layout.boards.length === 6,
    `${layout.boardCols}×${layout.boardRows} / ${layout.boards.length} 块`,
  )
  check('板按 1..6 从左到右、从上到下编号', layout.boards.map((b) => b.index).join() === '1,2,3,4,5,6')
  check('第一块是完整的 50×50', layout.boards[0].cols === 50 && layout.boards[0].rows === 50)
  check(
    '最后一块也是整块板（超出的补空，不切半块）',
    layout.boards[5].cols === 50 && layout.boards[5].rows === 50,
    `${layout.boards[5].cols}×${layout.boards[5].rows}`,
  )
  check(
    '板与板之间留了空隙（排版比原图宽）',
    layout.widthCells > 120 && layout.heightCells > 80,
    `${layout.widthCells.toFixed(1)} × ${layout.heightCells.toFixed(1)} 格`,
  )

  // 「留一圈」只对 52×52 有意义：50×50 一律直接画
  check('50×50 没有留一圈这一步', boardInset({ ...boardOpts, boardSize: 50 }) === 0)
  check('52×52 默认留一圈', boardInset({ ...boardOpts, boardSize: 52 }) === 1)
  check('52×52 也能切成直接画', boardInset({ ...boardOpts, boardSize: 52, boardEdge: 'flush' }) === 0)
  const ring52 = boardLayout(big, { ...boardOpts, boardSize: 52 })
  const flush52 = boardLayout(big, { ...boardOpts, boardSize: 52, boardEdge: 'flush' })
  check(
    '留一圈时每块板四周多一格',
    ring52.widthCells - flush52.widthCells === ring52.boardCols * 2 &&
      ring52.heightCells - flush52.heightCells === ring52.boardRows * 2,
    `${ring52.widthCells.toFixed(1)} vs ${flush52.widthCells.toFixed(1)}`,
  )

  const split = buildBoardPatternSvg(big, palette, boardOpts)
  check('每块板各生成一张图纸', (split.svg.match(/<g transform="translate/g) ?? []).length === 6)
  check('每块板都标了编号', (split.svg.match(/板 \d+/g) ?? []).length === 6)
  check(
    '格子总数不变（拆分只是排版）',
    (split.svg.match(/h1v1h-1z/g) ?? []).length === 120 * 80,
    `${(split.svg.match(/h1v1h-1z/g) ?? []).length} 格`,
  )
  check(
    '固有尺寸 = 排版格数 × 格子大小',
    split.width === Math.round(layout.widthCells * boardOpts.cellSize) &&
      split.height === Math.round(layout.heightCells * boardOpts.cellSize),
    `${split.width}×${split.height}`,
  )
  check(
    '拆分后预估尺寸变大',
    estimateSvgSize(big, boardOpts).width > estimateSvgSize(big, { ...boardOpts, boardSize: 0 }).width,
  )
  check(
    '预览降档按拆分后的排版算',
    clampPreviewCellSize(big, boardOpts, 400) < clampPreviewCellSize(big, { ...boardOpts, boardSize: 0 }, 400),
  )

  // 不拆分 / 整张图本来就装得下一块板：和原来的图纸一模一样
  const plain = buildPatternSvg(big, palette, { ...boardOpts, boardSize: 0 })
  check('不拆分就是普通图纸', buildBoardPatternSvg(big, palette, { ...boardOpts, boardSize: 0 }).svg === plain.svg)
  const smallImg = makePixmap(30, 20, [10, 120, 200])
  check(
    '装得下一块板的图不会硬拆',
    buildBoardPatternSvg(smallImg, palette, boardOpts).svg ===
      buildPatternSvg(smallImg, palette, { ...boardOpts, boardSize: 0 }).svg,
  )
  check('默认不拆分', DEFAULT_RENDER_OPTIONS.boardSize === 0)

  // 每格一个唯一颜色：验证第 N 块板切到的确实是那一片
  const uniq = makePixmap(120, 80, [0, 0, 0])
  for (let y = 0; y < 80; y++) {
    for (let x = 0; x < 120; x++) setPixel(uniq, x, y, [(x * 2) % 256, (y * 3) % 256, ((x + y) * 5) % 256])
  }
  const hexOf = (x: number, y: number) =>
    '#' + [(x * 2) % 256, (y * 3) % 256, ((x + y) * 5) % 256].map((v) => v.toString(16).padStart(2, '0').toUpperCase()).join('')
  const splitGroups = buildBoardPatternSvg(uniq, palette, boardOpts).svg.split('<g transform="translate')
  // splitGroups[0] 是根节点到第一块板之间，[1] 就是第一块板
  check('第 1 块板画的是左上角那一片', splitGroups[1].includes(hexOf(0, 0)) && splitGroups[1].includes(hexOf(49, 49)))
  check(
    '第 2 块板接的是第 51–100 列',
    splitGroups[2].includes(hexOf(50, 0)) && !splitGroups[2].includes(hexOf(49, 0)),
  )
  check('第 4 块板是第二行的第一块', splitGroups[4].includes(hexOf(0, 50)) && !splitGroups[4].includes(hexOf(0, 49)))
}

// ---------------------------------------------------------------- 汇总
console.log(`\n${'─'.repeat(52)}`)
console.log(`通过 ${passed} 项，失败 ${failed} 项`)
if (failed > 0) process.exit(1)
