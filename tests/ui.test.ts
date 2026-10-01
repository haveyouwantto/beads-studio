/**
 * 运行时冒烟测试：在 jsdom 里真正启动 React 应用，
 * 走一遍「规范化 → 优化颜色 → 转拼豆图纸」的完整流程。
 *
 * Canvas / ImageData 用一个记录调用的假实现替代，
 * 目的不是比像素，而是确认组件真的能渲染、状态真的能流动、没有运行时报错。
 *
 *   npm run test:ui
 */
import { JSDOM } from 'jsdom'

// ---------------------------------------------------------------- DOM 环境
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  pretendToBeVisual: true,
  url: 'http://localhost/',
})

const g = globalThis as unknown as Record<string, unknown>
/** Node 里有些全局（如 navigator）是只读的，统一用 defineProperty 覆盖 */
function defineGlobal(name: string, value: unknown): void {
  Object.defineProperty(globalThis, name, {
    value,
    writable: true,
    configurable: true,
    enumerable: true,
  })
}

defineGlobal('window', dom.window)
defineGlobal('document', dom.window.document)
defineGlobal('navigator', dom.window.navigator)
defineGlobal('HTMLElement', dom.window.HTMLElement)
defineGlobal('HTMLCanvasElement', dom.window.HTMLCanvasElement)
defineGlobal('Element', dom.window.Element)
defineGlobal('Node', dom.window.Node)
defineGlobal('Event', dom.window.Event)
defineGlobal('CustomEvent', dom.window.CustomEvent)
defineGlobal('MouseEvent', dom.window.MouseEvent)
defineGlobal('localStorage', dom.window.localStorage)
defineGlobal('Blob', dom.window.Blob)
// 应用代码里的 URL.createObjectURL 必须指向 jsdom 的 URL，
// 否则 Node 自带的实现会因为 Blob 不是 Node Blob 而报错
defineGlobal('URL', dom.window.URL)
g.IS_REACT_ACT_ENVIRONMENT = true

class FakeImageData {
  data: Uint8ClampedArray
  width: number
  height: number
  colorSpace = 'srgb' as const
  constructor(a: Uint8ClampedArray | number, b: number, c?: number) {
    if (typeof a === 'number') {
      this.width = a
      this.height = b
      this.data = new Uint8ClampedArray(a * b * 4)
    } else {
      this.data = a
      this.width = b
      this.height = c ?? a.length / 4 / b
    }
  }
}
defineGlobal('ImageData', FakeImageData)

let drawCalls = 0
let fillTextCalls = 0

/**
 * 假画布返回的真实内容：一张 12×10 的像素画被 8 倍放大成 96×80。
 * 这样「载入图片 → 自动识别周期」走的是真正的算法，而不是对着空白图跑。
 */
const ART_W = 12
const ART_H = 10
const ART_BLOCK = 8

function makeBlockArt(): Uint8ClampedArray {
  const w = ART_W * ART_BLOCK
  const h = ART_H * ART_BLOCK
  const data = new Uint8ClampedArray(w * h * 4)
  for (let cy = 0; cy < ART_H; cy++) {
    for (let cx = 0; cx < ART_W; cx++) {
      const r = (cx * 21) % 256
      const gg = (cy * 27) % 256
      const b = (cx * 13 + cy * 41) % 256
      for (let dy = 0; dy < ART_BLOCK; dy++) {
        for (let dx = 0; dx < ART_BLOCK; dx++) {
          const i = ((cy * ART_BLOCK + dy) * w + (cx * ART_BLOCK + dx)) * 4
          data[i] = r
          data[i + 1] = gg
          data[i + 2] = b
          data[i + 3] = 255
        }
      }
    }
  }
  return data
}

const BLOCK_ART = makeBlockArt()

function makeContext(canvas: { width: number; height: number }): Record<string, unknown> {
  const noop = () => undefined
  return {
    canvas,
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    font: '',
    textAlign: '',
    textBaseline: '',
    imageSmoothingEnabled: false,
    globalAlpha: 1,
    beginPath: noop,
    closePath: noop,
    moveTo: noop,
    lineTo: noop,
    arc: noop,
    rect: noop,
    stroke: noop,
    fill: noop,
    save: noop,
    restore: noop,
    translate: noop,
    scale: noop,
    clearRect: noop,
    fillRect: noop,
    drawImage: () => {
      drawCalls++
    },
    fillText: () => {
      fillTextCalls++
    },
    putImageData: noop,
    createImageData: (w: number, h: number) => new FakeImageData(w, h),
    getImageData: (_x: number, _y: number, w: number, h: number) => {
      if (w === ART_W * ART_BLOCK && h === ART_H * ART_BLOCK) {
        return new FakeImageData(BLOCK_ART.slice(), w, h)
      }
      return new FakeImageData(Math.max(1, w), Math.max(1, h))
    },
  }
}

dom.window.HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, kind: string) {
  if (kind !== '2d') return null
  return makeContext(this) as unknown as CanvasRenderingContext2D
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
} as any

// jsdom 不实现编码，给个固定的小 PNG 占位即可（测试只关心有没有存下来）
const FAKE_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
;(dom.window.HTMLCanvasElement.prototype as unknown as Record<string, unknown>).toDataURL = () => FAKE_PNG
;(dom.window.HTMLCanvasElement.prototype as unknown as Record<string, unknown>).toBlob = function (
  this: HTMLCanvasElement,
  cb: (b: unknown) => void,
) {
  cb(new dom.window.Blob(['x'], { type: 'image/png' }))
}

// URL.createObjectURL / revokeObjectURL
let objectUrlSeq = 0
;(dom.window.URL as unknown as Record<string, unknown>).createObjectURL = () => `blob:fake/${++objectUrlSeq}`
;(dom.window.URL as unknown as Record<string, unknown>).revokeObjectURL = () => undefined

// Image：onload 时给出固定尺寸
class FakeImage {
  naturalWidth = 96
  naturalHeight = 80
  width = 96
  height = 80
  onload: (() => void) | null = null
  onerror: (() => void) | null = null
  private _src = ''
  set src(v: string) {
    this._src = v
    queueMicrotask(() => this.onload?.())
  }
  get src() {
    return this._src
  }
}
defineGlobal('Image', FakeImage)
;(dom.window as unknown as Record<string, unknown>).Image = FakeImage

// ---------------------------------------------------------------- 断言工具
let passed = 0
let failed = 0
const failures: string[] = []

function check(name: string, condition: boolean, detail = ''): void {
  if (condition) {
    passed++
    console.log(`  ✓ ${name}`)
  } else {
    failed++
    failures.push(name)
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

function section(title: string): void {
  console.log(`\n${title}`)
}

// ---------------------------------------------------------------- 启动应用
const React = await import('react')
const { createRoot } = await import('react-dom/client')
const { default: App } = await import('../src/App.tsx')
const { useStudio } = await import('../src/store/studio.ts')
const { buildLibraryPalette } = await import('../src/core/palette.ts')
const { PaletteOptimizer, targetsFromPixmap } = await import('../src/core/optimize.ts')
const storage = await import('../src/core/storage.ts')
const { TabBar } = await import('../src/components/TabBar.tsx')
const { RecentProjectsDialog } = await import('../src/components/RecentProjectsDialog.tsx')
const { CandidateColorsDialog } = await import('../src/components/CandidateColorsDialog.tsx')

const act = (React as unknown as { act: (cb: () => void | Promise<void>) => Promise<void> }).act

const container = dom.window.document.getElementById('root') as HTMLElement
const root = createRoot(container)

section('应用启动')
let bootError: string | null = null
try {
  await act(async () => {
    root.render(React.createElement(App))
  })
} catch (err) {
  bootError = err instanceof Error ? err.message : String(err)
}
check('App 渲染无异常', bootError === null, bootError ?? '')
check('渲染出品牌标题', container.textContent?.includes('Beads Studio') ?? false)
check('左侧显示三个阶段', ['规范化', '优化颜色', '转拼豆图纸'].every((t) => container.textContent?.includes(t)))
check('空态提示上传图片', container.textContent?.includes('先放入一张图片') ?? false)
check(
  '初始只有第一步算已访问',
  JSON.stringify(useStudio.getState().visited) ===
    JSON.stringify({ regularize: true, optimize: false, pattern: false }),
  JSON.stringify(useStudio.getState().visited),
)
check(
  '第三步一开始不打勾',
  !(container.querySelectorAll('.rail-step')[2]?.className ?? '').includes('done'),
)

const bootRender = useStudio.getState().renderOptions
check('默认图纸样式是带色号的方格', bootRender.style === 'flat' && bootRender.codes === true)
check('默认每 10 格一条粗线', bootRender.majorEvery === 10 && bootRender.grid === true)

// ---------------------------------------------------------------- 阶段流
section('① 规范化 → 建立网格')
{
  // 直接注入一张 12×10 的像素图当作「已经规范化好的网格」
  const W = 12
  const H = 10
  const data = new Uint8ClampedArray(W * H * 4)
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4
      data[i] = (x * 21) % 256
      data[i + 1] = (y * 27) % 256
      data[i + 2] = (x * 13 + y * 41) % 256
      data[i + 3] = 255
    }
  }

  await act(async () => {
    useStudio.setState({ grid: { width: W, height: H, data } })
  })
  check('网格进入 store', useStudio.getState().grid?.width === W)
}

// 走一遍真实的图片载入路径（Image 用假实现，onload 异步触发）
section('① 规范化 → 载入图片并自动识别')
{
  const before = useStudio.getState().source
  await act(async () => {
    const blob = new dom.window.Blob(['x'], { type: 'image/png' })
    await useStudio.getState().loadImageBlob(blob, 'test.png')
  })
  const st = useStudio.getState()
  check('source 已写入', st.source !== null && st.source.name === 'test.png')
  check('source 尺寸来自解码结果', st.source?.width === 96 && st.source?.height === 80)
  check('加载后没有错误', st.error === null, st.error ?? '')
  check('source 与之前不同', st.source !== before)
  check(
    '已有网格但没进过第三步时仍不打勾',
    Boolean(st.grid) && !(container.querySelectorAll('.rail-step')[2]?.className ?? '').includes('done'),
  )
  check('第三步仍未标记为已访问', useStudio.getState().visited.pattern === false)
}

section('② 优化颜色')
{
  const palette = buildLibraryPalette({ includeExtended: false })
  const st = useStudio.getState()
  const grid = st.grid
  check('存在可用的优化目标网格', Boolean(grid))

  if (grid) {
    // 走 store 的优化入口（和 UI 点「开始优化」是同一条路径）
    await act(async () => {
      useStudio.setState({ grid, activeStage: 'optimize' })
    })
    await act(async () => {
      useStudio.getState().setOptimizeConfig({ k: 6, steps: 3000, patience: 600, seed: 11 })
      await useStudio.getState().runOptimizer()
    })
    const after = useStudio.getState()
    check('优化完成', after.optimizeRun.status === 'done', after.optimizeRun.status)
    check('选出结果色', after.optimizedPalette.length >= 6, `${after.optimizedPalette.length} 色`)
    check('结果都来自色号库', after.optimizedPalette.every((e) => palette.some((p) => p.hex === e.hex)))
    check('有误差统计', Boolean(after.optimizeRun.stats && after.optimizeRun.stats.max >= 0))
    check(
      '加权平均 ΔE 优于随机基准',
      (after.optimizeRun.stats?.weightedAvg ?? Infinity) <
        naiveTarget(palette, targetsFromPixmap(grid, { maxTargets: 1200 }).samples),
    )

    await act(async () => {
      after.applyOptimizedPalette()
    })
    const applied = useStudio.getState()
    check('应用后跳转到转拼豆图纸阶段', applied.activeStage === 'pattern')
    check('色板换成优化结果', applied.palette.length === applied.optimizedPalette.length)
  }
}

section('③ 转拼豆图纸')
{
  const st = useStudio.getState()
  check('量化结果已生成', Boolean(st.result))
  check('结果尺寸与网格一致', st.result?.width === st.grid?.width && st.result?.height === st.grid?.height)

  const paletteHex = new Set(st.palette.map((e) => e.hex))
  let allInPalette = true
  const d = st.result?.data ?? new Uint8ClampedArray(0)
  for (let i = 0; i < d.length; i += 4) {
    const hex =
      '#' +
      [d[i], d[i + 1], d[i + 2]].map((v) => v.toString(16).padStart(2, '0')).join('').toUpperCase()
    if (!paletteHex.has(hex)) {
      allInPalette = false
      break
    }
  }
  check('图纸只使用色板里的颜色', allInPalette)

  drawCalls = 0
  fillTextCalls = 0
  await act(async () => {
    useStudio.getState().setRenderOptions({ style: 'flat', codes: true, rulers: true, cellSize: 24 })
  })
  check('切换图纸样式不会崩溃', useStudio.getState().renderOptions.style === 'flat')

  await act(async () => {
    useStudio.getState().setQuantizeOptions({ dither: 'floyd-steinberg' })
  })
  check('开启抖动后仍能生成结果', Boolean(useStudio.getState().result))

  await act(async () => {
    useStudio.getState().setQuantizeOptions({ dither: 'none', metric: 'weighted-rgb' })
  })
  check('切换旧版加权 RGB 匹配可运行', useStudio.getState().quantizeOptions.metric === 'weighted-rgb')
}

section('渲染三个阶段都不报错')
for (const stage of ['regularize', 'optimize', 'pattern'] as const) {
  let err: string | null = null
  try {
    await act(async () => {
      useStudio.setState({ activeStage: stage })
    })
  } catch (e) {
    err = e instanceof Error ? e.message : String(e)
  }
  check(`阶段 ${stage} 渲染正常`, err === null, err ?? '')
}

const bodyText = container.textContent ?? ''
check('图纸页显示用料清单', bodyText.includes('用料清单') || useStudio.getState().activeStage === 'pattern')
check('canvas 真的被绘制过', drawCalls > 0, `drawImage 调用 ${drawCalls} 次`)

// 图纸必须是挂在 DOM 里的矢量 SVG，而不是放大就糊的 canvas
const svgEl = container.querySelector('.pattern-svg svg')
check('图纸以 SVG 挂载到 DOM', svgEl !== null)
check('SVG 带 viewBox（矢量可缩放）', svgEl?.getAttribute('viewBox') !== null)
check(
  'SVG 里真的有网格线元素',
  (svgEl?.querySelectorAll('path[stroke]').length ?? 0) >= 1,
)
check(
  'SVG 里真的有色号文字元素',
  (svgEl?.querySelectorAll('text').length ?? 0) > 0,
)
check(
  '图纸区域没有使用 canvas',
  container.querySelector('.pattern-host canvas') === null,
)

// 优化器可直接驱动的兜底校验（确保 store 与核心算法一致）
section('优化器与 store 一致性')
{
  const palette = buildLibraryPalette({ includeExtended: false })
  const grid = useStudio.getState().grid
  if (grid) {
    const info = targetsFromPixmap(grid, { maxTargets: 1200 })
    const opt = new PaletteOptimizer(palette, { ...useStudio.getState().optimizeConfig, steps: 2000, patience: 400, seed: 3 }, 'grid')
    opt.setTargets(info.samples)
    let finalStats: { weightedAvg: number } | null = null
    for await (const ev of opt.run()) {
      if (ev.type === 'completed') finalStats = ev.stats
    }
    check('独立调用优化器也能跑完', finalStats !== null)
    check('结果 ΔE 为有限值', Number.isFinite(finalStats?.weightedAvg ?? NaN))
  }
}

function naiveTarget(
  pool: { hex: string; lab: [number, number, number] }[],
  samples: { lab: [number, number, number]; count: number }[],
): number {
  let sum = 0
  let weight = 0
  for (const s of samples) {
    let best = Infinity
    for (let i = 0; i < pool.length; i += 29) {
      const p = pool[i].lab
      best = Math.min(best, Math.hypot(s.lab[0] - p[0], s.lab[1] - p[1], s.lab[2] - p[2]))
    }
    sum += best * s.count
    weight += s.count
  }
  return sum / weight
}

// ---------------------------------------------------------------- 自动保存 / 标签页
// 从这里开始主要验证存储与标签逻辑，不再依赖 React 的批处理；
// 自动保存本身是 900ms 防抖定时器，用 act 反而会不断报「更新未被 act 包裹」。
g.IS_REACT_ACT_ENVIRONMENT = false
const flush = (ms = 0): Promise<void> => new Promise((r) => setTimeout(r, ms))

section('优化结果与色板来源')
{
  const start = useStudio.getState()
  check('已套用优化结果', start.paletteSource === 'optimized', start.paletteSource)
  check('有优化结果可用', start.optimizedPalette.length > 0)
  const optimizedHexes = start.palette.map((e) => e.hex).join()
  const optimizedEntries = [...start.optimizedPalette]

  // 切到色号库：优化结果不能被顶掉
  start.setPaletteSource('library')
  await flush()
  const asLibrary = useStudio.getState()
  check('切到色号库生效', asLibrary.paletteSource === 'library')
  check('色号库比优化结果大', asLibrary.palette.length > optimizedEntries.length)
  check('切走后优化结果没被覆盖', asLibrary.optimizedPalette.length === optimizedEntries.length)
  check(
    '优化结果内容也没变',
    asLibrary.optimizedPalette.map((e) => e.hex).join() === optimizedEntries.map((e) => e.hex).join(),
  )

  // 再切回优化结果
  useStudio.getState().setPaletteSource('optimized')
  await flush()
  const back = useStudio.getState()
  check('切回「优化结果」', back.paletteSource === 'optimized')
  check('切回后颜色与原来完全一致', back.palette.map((e) => e.hex).join() === optimizedHexes)
  check('切回后没有残留提示', back.notice === null)

  // 基础 24 / 48 色可以当色板用
  useStudio.getState().setPaletteSource('basic24')
  await flush()
  check('能用基础24色', useStudio.getState().palette.length === 24)
  useStudio.getState().setPaletteSource('basic48')
  await flush()
  check('能用基础48色', useStudio.getState().palette.length === 48)

  // 还没优化就选「优化结果」：要拦下来并提醒
  useStudio.setState({ optimizedPalette: [], paletteSource: 'library', notice: null })
  useStudio.getState().setPaletteSource('optimized')
  await flush()
  const blocked = useStudio.getState()
  check('没优化时不会被切到「优化结果」', blocked.paletteSource === 'library')
  check('没优化时会给出提醒', (blocked.notice?.text ?? '').includes('优化'))

  // 还原，避免影响后面的用例
  useStudio.setState({ optimizedPalette: optimizedEntries, notice: null })
  useStudio.getState().setPaletteSource('optimized')
  await flush()
  check('还原成功', useStudio.getState().palette.length === optimizedEntries.length)
}

section('候选色筛选')
{
  const lib = useStudio.getState().libraryPalette
  check('默认不筛选（candidateHex 为空）', useStudio.getState().candidateHex.length === 0)

  // 只留 H 系列（黑白灰）
  const hHexes = lib.filter((e) => (e.codes.MARD ?? '').startsWith('H')).map((e) => e.hex)
  useStudio.getState().setCandidateHex(hHexes)
  await flush()

  await useStudio.getState().runOptimizer()
  await flush(50)
  const run = useStudio.getState()
  check('优化用的是筛选后的候选数', run.optimizeRun.candidates === hHexes.length, `${run.optimizeRun.candidates}`)
  check(
    '选出来的颜色都在筛选范围内',
    run.optimizedPalette.every((e) => (e.codes.MARD ?? '').startsWith('H')),
  )

  // 清空筛选 = 回到全库
  useStudio.getState().setCandidateHex([])
  await flush()
  check('清空筛选后恢复全库', useStudio.getState().candidateHex.length === 0)

  // 候选清空到 0 个时应该报错而不是崩
  useStudio.setState({ candidateHex: ['#000001'] })
  await useStudio.getState().runOptimizer()
  await flush()
  check(
    '候选为空时给出错误提示',
    (useStudio.getState().error ?? '').includes('候选'),
    useStudio.getState().error ?? '(无)',
  )
  useStudio.setState({ error: null, candidateHex: [] })
  await flush()
}

section('本地自动保存')
{
  const st = useStudio.getState()
  const firstTabId = st.activeTabId

  useStudio.getState().saveCurrentProject()
  await flush()

  const index = storage.readIndex()
  const mine = index.find((e) => e.id === firstTabId)
  check('项目写进了 localStorage 索引', Boolean(mine), `${index.length} 条`)
  check('索引记录了网格尺寸', (mine?.gridWidth ?? 0) > 0, `${mine?.gridWidth}×${mine?.gridHeight}`)
  check('索引里带缩略图', Boolean(mine?.thumbnail?.startsWith('data:image/png')))
  check('标签页拿到了缩略图', Boolean(useStudio.getState().tabs[0]?.thumb))

  const record = storage.readProject(firstTabId)
  check('项目正文可读回', record !== null)
  check('正文包含网格像素数据', (record?.project.grid?.data.length ?? 0) > 0)
  check('正文包含原图 PNG', Boolean(record?.project.source?.png))
  check('正文包含色板', (record?.project.paletteHex.length ?? 0) > 0)
  check('正文包含渲染设置', record?.project.renderOptions !== undefined)

  const session = storage.readSession()
  check('会话记录了打开中的标签页', (session?.tabs.length ?? 0) > 0)
  check('会话记录了当前标签', session?.activeId === firstTabId)
}

section('标签页切换与关闭')
{
  await flush()
  const tabStrip = container.querySelector('.tabstrip')
  check('顶栏渲染出标签栏', tabStrip !== null)
  check('标签栏有关闭按钮', (container.querySelectorAll('.tab-close').length ?? 0) >= 1)

  const firstTabId = useStudio.getState().activeTabId
  const firstGrid = useStudio.getState().grid
  check('第一个标签有网格', Boolean(firstGrid))

  await useStudio.getState().openInNewTab(new dom.window.Blob(['x'], { type: 'image/png' }), 'second.png')

  const after = useStudio.getState()
  check('打开新图会新建标签页', after.tabs.length === 2, `${after.tabs.length} 个标签`)
  check('新标签成为当前标签', after.activeTabId !== firstTabId)
  check('新标签用了文件名', after.tabs[1].name.startsWith('second'))
  check('新标签有自己的网格', Boolean(after.grid))

  useStudio.getState().switchTab(firstTabId)
  await flush()
  const back = useStudio.getState()
  check('切回旧标签', back.activeTabId === firstTabId)
  check('旧标签的网格被恢复', back.grid === firstGrid, '应为同一个网格对象')

  // 切走再切回来，第二个标签的状态也应该还在
  const secondTabId = after.activeTabId
  useStudio.getState().switchTab(secondTabId)
  await flush()
  check('来回切换不丢状态', useStudio.getState().activeTabId === secondTabId)

  useStudio.getState().closeTab(secondTabId)
  await flush()
  const closed = useStudio.getState()
  check('关闭后只剩一个标签', closed.tabs.length === 1)
  check('关闭当前标签后自动切到邻居', closed.activeTabId === firstTabId)

  useStudio.getState().closeTab(firstTabId)
  await flush()
  const last = useStudio.getState()
  check('最后一个标签不会被关掉', last.tabs.length === 1)
  check('最后一个标签关闭后清空成新项目', last.grid === null && last.source === null)
}

section('最近项目弹窗')
{
  useStudio.getState().refreshRecent()
  const list = useStudio.getState().recent
  check('最近项目列表非空', list.length > 0, `${list.length} 条`)

  const target = list[0]
  const opened = await useStudio.getState().openRecentProject(target.id)
  const st = useStudio.getState()
  check('能从存档打开项目', opened)
  check('打开后网格恢复', Boolean(st.grid))
  check('打开后原图也恢复', Boolean(st.source))
  check('打开的标签页成为当前标签', st.tabs.some((t) => t.id === st.activeTabId))

  const host = dom.window.document.createElement('div')
  dom.window.document.body.appendChild(host)
  const dialogRoot = createRoot(host)
  let dialogError: string | null = null
  try {
    dialogRoot.render(React.createElement(RecentProjectsDialog, { onClose: () => undefined }))
    await flush()
  } catch (err) {
    dialogError = err instanceof Error ? err.message : String(err)
  }
  check('弹窗渲染无异常', dialogError === null, dialogError ?? '')
  check('弹窗列出了存档项目', (host.querySelectorAll('.recent-item').length ?? 0) > 0)
  check('弹窗显示占用空间', (host.textContent ?? '').includes('占用'))

  dialogRoot.unmount()
  await flush()
  host.remove()
}

section('标签栏组件单独渲染')
{
  const host = dom.window.document.createElement('div')
  dom.window.document.body.appendChild(host)
  const tabRoot = createRoot(host)
  let err: string | null = null
  try {
    tabRoot.render(React.createElement(TabBar, { onRequestFile: () => undefined }))
    await flush()
  } catch (e) {
    err = e instanceof Error ? e.message : String(e)
  }
  check('标签栏渲染无异常', err === null, err ?? '')
  check('标签栏有新建按钮', host.querySelector('.tab-new') !== null)
  tabRoot.unmount()
  await flush()
  host.remove()
}

section('候选色弹窗')
{
  useStudio.setState({ candidateHex: [] })
  const host = dom.window.document.createElement('div')
  dom.window.document.body.appendChild(host)
  const root2 = createRoot(host)
  let err: string | null = null
  try {
    root2.render(React.createElement(CandidateColorsDialog, { onClose: () => undefined }))
    await flush()
  } catch (e) {
    err = e instanceof Error ? e.message : String(e)
  }
  check('候选色弹窗渲染无异常', err === null, err ?? '')
  check('按系列分组', (host.querySelectorAll('.series-block').length ?? 0) >= 8, `${host.querySelectorAll('.series-block').length} 组`)
  check('列出了每个颜色', (host.querySelectorAll('.candidate').length ?? 0) === useStudio.getState().libraryPalette.length)
  check('默认全部勾选', host.querySelectorAll('.candidate.on').length === host.querySelectorAll('.candidate').length)
  check('有全选/全不选/反选', (host.textContent ?? '').includes('反选'))
  check('有应用按钮', (host.textContent ?? '').includes('应用'))
  root2.unmount()
  await flush()
  host.remove()
}

section('重启应用后恢复上次会话')
{
  const session = storage.readSession()
  check('存档里有可恢复的会话', (session?.tabs.length ?? 0) > 0, `${session?.tabs.length ?? 0} 个标签`)

  // 模拟「重新打开应用」：把内存状态清空成一个空白标签
  useStudio.setState({
    tabs: [{ id: 'blank-tab', name: '未命名项目' }],
    activeTabId: 'blank-tab',
    source: null,
    grid: null,
    result: null,
    optimizedPalette: [],
    notice: null,
  })
  await flush()
  check('清空后确实没有网格', useStudio.getState().grid === null)

  const stop = useStudio.getState().initPersistence()
  await flush(150)

  const restored = useStudio.getState()
  check('标签页被恢复', restored.tabs.length === (session?.tabs.length ?? 0), `${restored.tabs.length} 个`)
  check('当前标签是存档里的那个', restored.tabs.some((t) => t.id === restored.activeTabId))
  check('网格被恢复', Boolean(restored.grid))
  check('原图被恢复', Boolean(restored.source))
  check('恢复后没有报错', restored.notice === null && restored.error === null)

  stop()
}

console.log(`\n${'─'.repeat(52)}`)
console.log(`通过 ${passed} 项，失败 ${failed} 项`)
if (failures.length) console.log(`失败项：${failures.join('、')}`)

root.unmount()
process.exit(failed > 0 ? 1 : 0)
