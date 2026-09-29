/**
 * 生成一张示例图纸 SVG，方便直接用浏览器打开肉眼检查样式。
 * 不依赖任何额外包。
 *
 *   npx tsx --tsconfig tsconfig.app.json tests/sample-svg.gen.ts [输出路径]
 *
 * 默认写到系统临时目录下的 beads-sample-chart.svg。
 */
import { writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildPatternSvg, DEFAULT_RENDER_OPTIONS } from '../src/core/svg.ts'
import { buildLibraryPalette } from '../src/core/palette.ts'
import { quantizeToPalette } from '../src/core/quantize.ts'
import type { Pixmap } from '../src/core/types.ts'

const W = 26
const H = 18
const out = process.argv[2] ?? join(tmpdir(), 'beads-sample-chart.svg')

// 造一张有结构的图案：渐变底 + 色块 + 斜线，方便看清格子与线条
const img: Pixmap = { width: W, height: H, data: new Uint8ClampedArray(W * H * 4) }
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    let r = 40 + x * 6
    let g = 90 + y * 7
    let b = 200 - x * 4
    if (x > 5 && x < 14 && y > 4 && y < 12) {
      r = 240
      g = 80
      b = 60
    }
    if (x === y || x === W - 1 - y) {
      r = 25
      g = 25
      b = 30
    }
    const i = (y * W + x) * 4
    img.data[i] = r
    img.data[i + 1] = g
    img.data[i + 2] = b
    img.data[i + 3] = 255
  }
}

// 和真实流程一致：先量化到色板，再出图纸（量化后颜色数受色板规模限制）
const palette = buildLibraryPalette({ includeExtended: false })
const quantized = quantizeToPalette(img, palette, { metric: 'lab', quantize: true, dither: 'none' })

const pattern = buildPatternSvg(quantized, palette, {
  ...DEFAULT_RENDER_OPTIONS,
  cellSize: 36,
})

writeFileSync(out, pattern.svg, 'utf8')
console.log(`已写出 ${out}`)
console.log(`固有尺寸 ${pattern.width}×${pattern.height}，${W} × ${H} 格，可任意缩放不变糊`)
console.log(`色号${pattern.codesSuppressed ? '已省略' : '已标注'}，粗线间隔 ${DEFAULT_RENDER_OPTIONS.majorEvery} 格`)
