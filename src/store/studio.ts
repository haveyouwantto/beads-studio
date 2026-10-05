import { create } from 'zustand'
import {
  buildKitPalette,
  buildLibraryPalette,
  buildWplacePalette,
  KIT_SIZES,
  matchPalette,
  type KitSize,
  type CodeSystem,
  type PaletteEntry,
  type PaletteSource,
} from '../core/palette.ts'
import { DEFAULT_QUANTIZE_OPTIONS, quantizeToPalette, type QuantizeOptions } from '../core/quantize.ts'
import { DEFAULT_RENDER_OPTIONS, type RenderOptions } from '../core/svg.ts'
import { analyzePeriods, sampleImage, type DetectReport } from '../core/regularize.ts'
import { defaultCorners, sampleQuad } from '../core/warp.ts'
import { collapseBlocks, detectUniformBlock } from '../core/direct.ts'
import { packPixels, unpackPixels } from '../core/export.ts'
import { appendSwatch } from '../core/edit.ts'
import {
  dataUrlToPixmap,
  listProjects,
  makeThumbnail,
  readCandidateSets,
  readSession,
  readProject,
  renameProjectEntry,
  removeProject,
  saveProject,
  writeCandidateSets,
  writeSession,
  type CandidateSet,
  type IndexEntry,
  type PersistedProject,
} from '../core/storage.ts'
import type { Pixmap, Quad, SampleMode } from '../core/types.ts'
import {
  DEFAULT_OPTIMIZE_CONFIG,
  PaletteOptimizer,
  targetsFromPixmap,
  type OptimizeConfig,
  type OptimizeStats,
  type TargetSample,
  type TargetMode,
} from '../core/optimize.ts'

/**
 * 三个阶段：① 规范化 → ② 优化颜色 → ③ 转拼豆图纸。
 * 规范化产出 1:1 网格，作为「优化颜色」的优化目标，再交给「转拼豆图纸」出图。
 */
export type StageId = 'regularize' | 'edit' | 'optimize' | 'pattern'

/** 工作流顺序：规范化 → 像素编辑 → 优化颜色 → 转拼豆图纸 */
export const STAGE_ORDER: StageId[] = ['regularize', 'edit', 'optimize', 'pattern']

/** 编辑器工具：画笔 / 油漆桶 / 吸管 */
export type EditTool = 'paint' | 'fill' | 'pick' | 'pan'

/**
 * 规范化的三种输入方式：
 * - auto   像素自动识别（FFT 自相关检测周期/相位）
 * - quad   四角变换（手动拖四角，适配拍照透视）
 * - direct 已经是 1:1 的设计稿，直接作为网格
 */
export type AlignmentMode = 'auto' | 'quad' | 'direct'

/** 载入图片时的最长边上限：太大既慢又没必要 */
export const MAX_IMAGE_DIM = 2400

export interface SourceImage {
  name: string
  width: number
  height: number
  pixmap: Pixmap
  /** object URL，用于 <img> 预览 */
  url: string
}

export interface OptimizeRunState {
  status: 'idle' | 'running' | 'done' | 'stopped'
  progress: number
  step: number
  temperature: number
  stats: OptimizeStats | null
  candidates: number
  targets: number
  uniqueColors: number
  pixels: number
  bucket: number
  elapsedMs: number
  reason: string
}

const EMPTY_RUN: OptimizeRunState = {
  status: 'idle',
  progress: 0,
  step: 0,
  temperature: 0,
  stats: null,
  candidates: 0,
  targets: 0,
  uniqueColors: 0,
  pixels: 0,
  bucket: 0,
  elapsedMs: 0,
  reason: '',
}

export interface ProjectTab {
  id: string
  name: string
  /** 小缩略图（PNG dataURL），自动保存时更新 */
  thumb?: string
}

/**
 * 属于「单个项目」的字段。
 * 每个标签页各存一份，切换标签页时整组换掉，其余（当前阶段、色号库、存储状态）是全局的。
 */
const PROJECT_KEYS = [
  'visited',
  'activeStage',
  'edited',
  'source',
  'analysis',
  'alignmentMode',
  'periodX',
  'periodY',
  'phaseX',
  'phaseY',
  'sampleMode',
  'corners',
  'manualCols',
  'manualRows',
  'directBlock',
  'grid',
  'regularizedGrid',
  'paletteSource',
  'kitSize',
  'candidateHex',
  'includeExtended',
  'palette',
  'quantizeOptions',
  'renderOptions',
  'result',
  'codeSystem',
  'optimizeTargetMode',
  'optimizeConfig',
  'optimizedPalette',
] as const

type ProjectKey = (typeof PROJECT_KEYS)[number]
export type ProjectState = Pick<StudioState, ProjectKey>

interface StudioState {
  activeStage: StageId
  /** 网格是不是被「像素编辑」改过 —— 回规范化重新生成会丢掉这些修改 */
  edited: boolean

  // --- 标签页与本地存档 ---
  tabs: ProjectTab[]
  activeTabId: string
  recent: IndexEntry[]
  savedAt: number | null
  autosave: boolean
  notice: { kind: 'info' | 'warn' | 'error'; text: string } | null

  // --- 阶段 1：规范化 ---
  source: SourceImage | null
  loading: boolean
  error: string | null
  alignmentMode: AlignmentMode
  analysis: DetectReport | null
  periodX: number
  periodY: number
  phaseX: number
  phaseY: number
  sampleMode: SampleMode
  corners: Quad
  manualCols: number
  manualRows: number
  /** direct 模式：把 N×N 像素块压成一颗豆（自动探测原图被放大的倍数） */
  directBlock: number
  grid: Pixmap | null
  /**
   * 规范化的原始结果（像素编辑没动过的那份）。
   * 规范化页显示它、编辑页改的是 grid，所以两边互不影响。
   */
  regularizedGrid: Pixmap | null

  // --- 阶段 3：转拼豆图纸 ---
  paletteSource: PaletteSource
  /**
   * 像素编辑器的工具状态。这几个只是「当前在用什么」，
   * 和项目内容无关，所以切标签页/重开都无所谓，放全局就够。
   */
  editTool: EditTool
  /** 油漆桶按什么填：一模一样的颜色，还是同一类（同色系） */
  editFillMode: 'color' | 'cluster'
  editColor: string | null
  /** 自己加进来的颜色（吸管取的、配色器挑的），最多 MAX_ADDED_SWATCHES 个 */
  editSwatches: string[]
  /** 选了「套装」时用哪一档：24 / 48 / 72 / 96 / 120 */
  kitSize: KitSize
  /**
   * 参与配色优化的候选色（HEX 列表）。
   * 空数组 = 未筛选，表示色号库全部参与。
   */
  candidateHex: string[]
  /** 候选色方案（全局，跨项目），只存本地 */
  candidateSets: CandidateSet[]
  includeExtended: boolean
  libraryPalette: PaletteEntry[]
  /** 哪些阶段真正被打开过（按项目记）；没进过的阶段不显示「已完成」勾 */
  visited: Record<StageId, boolean>
  palette: PaletteEntry[]
  quantizeOptions: QuantizeOptions
  renderOptions: RenderOptions
  result: Pixmap | null

  // --- 阶段 2：优化颜色 ---
  optimizeTargetMode: TargetMode
  optimizeConfig: OptimizeConfig
  optimizeRun: OptimizeRunState
  optimizedPalette: PaletteEntry[]
  codeSystem: CodeSystem

  // --- actions ---
  setStage: (s: StageId) => void
  goNext: () => void
  goPrev: () => void

  loadImageFile: (file: File) => Promise<void>
  loadImageBlob: (blob: Blob, name: string) => Promise<void>
  clearSource: () => void

  setAlignmentMode: (m: AlignmentMode) => void
  setSampleMode: (m: SampleMode) => void
  runAnalysis: () => void
  setPeriod: (axis: 'x' | 'y', value: number) => void
  setPhase: (axis: 'x' | 'y', value: number) => void
  setCorner: (index: number, x: number, y: number) => void
  resetCorners: () => void
  setManualSize: (cols: number, rows: number) => void
  setDirectBlock: (n: number) => void
  detectDirectBlock: () => void
  buildGrid: () => void
  /** 像素编辑：提交编辑后的网格（透明格 = 忽略） */
  applyGridEdit: (next: Pixmap) => void
  /** 像素编辑：丢掉修改，回到规范化的原始结果（没有原图也能用） */
  resetToRegularized: () => void
  /** 规范化里看过「网格被改过」的强制提示，确认掉这个标记 */
  clearEdited: () => void
  setEditTool: (tool: EditTool) => void
  setEditFillMode: (mode: 'color' | 'cluster') => void
  setEditColor: (hex: string | null) => void
  /** 往「新增色」里放一个颜色（已存在则不动，满了挤掉最早的那个） */
  addEditSwatch: (hex: string) => void

  setPaletteSource: (s: PaletteSource) => void
  setKitSize: (size: KitSize) => void
  /** 设置配色优化的候选色（传空数组 = 全部参与） */
  setCandidateHex: (hexes: string[]) => void
  /** 候选色方案：保存 / 套用 / 删除，存在本地，跨项目可用 */
  saveCandidateSet: (name: string, hexes: string[]) => void
  applyCandidateSet: (id: string) => void
  deleteCandidateSet: (id: string) => void
  setIncludeExtended: (v: boolean) => void
  setPalette: (entries: PaletteEntry[]) => void
  setQuantizeOptions: (patch: Partial<QuantizeOptions>) => void
  setRenderOptions: (patch: Partial<RenderOptions>) => void
  setCodeSystem: (s: CodeSystem) => void
  recomputeResult: () => void

  setOptimizeConfig: (patch: Partial<OptimizeConfig>) => void
  setOptimizeTargetMode: (m: TargetMode) => void
  runOptimizer: () => Promise<void>
  stopOptimizer: () => void
  applyOptimizedPalette: () => void
  clearOptimizedPalette: () => void

  // --- 标签页 ---
  newTab: () => void
  openInNewTab: (blob: Blob, name: string) => Promise<void>
  switchTab: (id: string) => void
  closeTab: (id: string) => void
  renameTab: (id: string, name: string) => void

  // --- 本地存档 ---
  initPersistence: () => () => void
  saveCurrentProject: () => void
  refreshRecent: () => void
  openRecentProject: (id: string) => Promise<boolean>
  deleteRecentProject: (id: string) => void
  setAutosave: (v: boolean) => void
  clearNotice: () => void
}

let activeOptimizer: PaletteOptimizer | null = null

function newTabId(): string {
  return `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`
}

export const NEW_TAB_NAME = '未命名项目'
const FIRST_TAB_ID = newTabId()
/** 四角变换的默认分辨率（列 × 行） */
export const DEFAULT_QUAD_SIZE = 52

/** 读取某个非激活标签页的内存快照（用于标签栏缩略图等展示） */
export function getTabSnapshot(id: string): ProjectState | undefined {
  return tabSnapshots.get(id)
}

/** 一个全新项目的默认值 */
function freshProject(): ProjectState {
  const library = buildLibraryPalette({ includeExtended: false })
  return {
    visited: { regularize: true, edit: false, optimize: false, pattern: false },
    activeStage: 'regularize',
    edited: false,
    source: null,
    analysis: null,
    alignmentMode: 'auto',
    periodX: 1,
    periodY: 1,
    phaseX: 0,
    phaseY: 0,
    sampleMode: 'center',
    corners: defaultCorners(1, 1),
    manualCols: DEFAULT_QUAD_SIZE,
    manualRows: DEFAULT_QUAD_SIZE,
    directBlock: 1,
    grid: null,
    regularizedGrid: null,
    paletteSource: 'library',
    kitSize: 24,
    candidateHex: [],
    includeExtended: false,
    palette: library,
    quantizeOptions: { ...DEFAULT_QUANTIZE_OPTIONS },
    renderOptions: { ...DEFAULT_RENDER_OPTIONS },
    result: null,
    codeSystem: 'MARD',
    optimizeTargetMode: 'grid',
    optimizeConfig: { ...DEFAULT_OPTIMIZE_CONFIG },
    optimizedPalette: [],
  }
}

function snapshotProject(s: StudioState): ProjectState {
  const out = {} as ProjectState
  for (const key of PROJECT_KEYS) {
    // 逐字段拷贝，保持类型安全
    Object.assign(out, { [key]: s[key] })
  }
  return out
}

/** 把项目字段写回 store，并同步派生数据、清掉上一段的优化运行态 */
function projectPatch(project: ProjectState): Partial<StudioState> {
  return {
    ...project,
    libraryPalette: buildLibraryPalette({ includeExtended: project.includeExtended }),
    optimizeRun: { ...EMPTY_RUN },
  }
}

/**
 * 按「色板来源」算出实际要用的色板。
 *
 * 关键点：优化结果一直存在 optimizedPalette 里，不会被别的来源覆盖，
 * 所以「切到色号库再切回优化结果」能原样拿回自己那套颜色。
 * 返回 null 表示这个来源当前不可用（例如还没跑过优化）。
 */
function resolvePaletteForSource(source: PaletteSource, s: StudioState): PaletteEntry[] | null {
  switch (source) {
    case 'optimized':
      return s.optimizedPalette.length ? s.optimizedPalette : null
    case 'library':
      return s.libraryPalette
    case 'kit':
      return buildKitPalette(s.kitSize)
    case 'wplace':
      return buildWplacePalette()
    case 'custom':
    default:
      return s.palette
  }
}

/** 更新当前标签页的标题 */
function withRenamedTab(tabs: ProjectTab[], id: string, name: string): ProjectTab[] {
  return tabs.map((t) => (t.id === id ? { ...t, name } : t))
}

/** 记下「现在开着哪些标签页」，下次启动时照着恢复 */
function persistSession(s: StudioState): void {
  writeSession({
    tabs: s.tabs.map((t) => ({ id: t.id, name: t.name })),
    activeId: s.activeTabId,
  })
}

/**
 * 非激活标签的项目快照。
 * store 里只有一份「当前项目」的字段，所以切走时必须把快照留在这儿，切回来再放回去。
 */
const tabSnapshots = new Map<string, ProjectState>()

/** 当前项目的名字（就是标签页标题）：导出文件名等地方用 */
export function tabNameOf(s: StudioState): string {
  return s.tabs.find((t) => t.id === s.activeTabId)?.name ?? NEW_TAB_NAME
}

/** 标签页标题：去掉扩展名，太长就截断 */
function shortName(name: string): string {
  const base = name.replace(/\.[a-z0-9]{1,6}$/i, '').trim() || name
  return base.length > 22 ? `${base.slice(0, 21)}…` : base
}

/**
 * 对象身份编号：用来做「有没有变化」的廉价指纹。
 * 项目里的像素对象每次重算都是新对象，所以身份变了就说明内容变了。
 */
const objectIds = new WeakMap<object, number>()
let objectIdSeq = 0
function idOf(value: object | null | undefined): number {
  if (!value) return 0
  let id = objectIds.get(value)
  if (id === undefined) {
    id = ++objectIdSeq
    objectIds.set(value, id)
  }
  return id
}

/** 便宜的变更指纹：不碰大像素数据，只看标量 + 对象身份 */
function fingerprint(s: StudioState): string {
  return [
    s.activeTabId,
    s.codeSystem,
    s.alignmentMode,
    s.periodX,
    s.periodY,
    s.phaseX,
    s.phaseY,
    s.sampleMode,
    s.manualCols,
    s.manualRows,
    s.directBlock,
    s.paletteSource,
    s.includeExtended,
    s.optimizeTargetMode,
    idOf(s.source),
    idOf(s.grid),
    idOf(s.result),
    idOf(s.palette),
    idOf(s.optimizedPalette),
    idOf(s.corners),
    idOf(s.quantizeOptions),
    idOf(s.renderOptions),
    idOf(s.optimizeConfig),
  ].join('|')
}

// 网格编码结果缓存：像素对象没换就不用重新编码（WeakMap 不会留垃圾）
const gridCache = new WeakMap<Pixmap, string>()

function encodeGrid(g: Pixmap | null): { width: number; height: number; data: string } | null {
  if (!g) return null
  let data = gridCache.get(g)
  if (data === undefined) {
    data = packPixels(g)
    gridCache.set(g, data)
  }
  return { width: g.width, height: g.height, data }
}

/** store 状态 → 可写进 localStorage 的纯数据 */
function serializeProject(s: StudioState): PersistedProject {
  return {
    alignmentMode: s.alignmentMode,
    periodX: s.periodX,
    periodY: s.periodY,
    phaseX: s.phaseX,
    phaseY: s.phaseY,
    sampleMode: s.sampleMode,
    corners: s.corners.map((p) => ({ x: p.x, y: p.y })),
    manualCols: s.manualCols,
    manualRows: s.manualRows,
    directBlock: s.directBlock,
    paletteSource: s.paletteSource,
    kitSize: s.kitSize,
    candidateHex: [...s.candidateHex],
    includeExtended: s.includeExtended,
    paletteHex: s.palette.map((e) => e.hex),
    codeSystem: s.codeSystem,
    quantizeOptions: s.quantizeOptions,
    renderOptions: s.renderOptions,
    optimizeTargetMode: s.optimizeTargetMode,
    optimizeConfig: s.optimizeConfig,
    optimizedHex: s.optimizedPalette.map((e) => e.hex),
    activeStage: s.activeStage,
    edited: s.edited,
    // 不存原图：原图动辄几 MB，localStorage 放不下；下次打开只需要规格化结果，
    // 想重新规范化就从「规范化」页的「重新上传」重来。
    source: null,
    sourceOmitted: false,
    grid: encodeGrid(s.grid),
    regularizedGrid: encodeGrid(s.regularizedGrid),
  }
}

/** 存档里的阶段名可能来自旧版本 / 被手改过，认不出来就退回第一步 */
function restoreStage(stage: unknown): StageId {
  return STAGE_ORDER.includes(stage as StageId) ? (stage as StageId) : 'regularize'
}

/**
 * 存档里的色板来源 → 当前来源 + 套装档位。
 * 老存档里的「基础24色 / 基础48色」已经合并成「套装」+ 档位，这里做一次迁移。
 */
function resolveStoredPaletteSource(p: PersistedProject): { paletteSource: PaletteSource; kitSize: KitSize } {
  if (p.paletteSource === 'basic24') return { paletteSource: 'kit', kitSize: 24 }
  if (p.paletteSource === 'basic48') return { paletteSource: 'kit', kitSize: 48 }
  const size = (KIT_SIZES as readonly number[]).includes(Number(p.kitSize)) ? (Number(p.kitSize) as KitSize) : 24
  return { paletteSource: p.paletteSource as PaletteSource, kitSize: size }
}

/** 存档读回 store 可用的项目状态（需要解码原图，所以是异步的） */
async function deserializeProject(p: PersistedProject): Promise<ProjectState> {
  const fullLibrary = buildLibraryPalette({ includeExtended: true })
  const byHex = new Map(fullLibrary.map((e) => [e.hex, e]))
  const resolve = (hexes: string[]) =>
    hexes.map((h) => byHex.get(h)).filter((e): e is PaletteEntry => Boolean(e))

  const library = buildLibraryPalette({ includeExtended: p.includeExtended })
  let source: SourceImage | null = null
  if (p.source) {
    const pixmap = await dataUrlToPixmap(p.source.png)
    source = { name: p.source.name, width: pixmap.width, height: pixmap.height, pixmap, url: p.source.png }
  }

  let grid: Pixmap | null = null
  if (p.grid) {
    grid = {
      width: p.grid.width,
      height: p.grid.height,
      data: unpackPixels(p.grid.width, p.grid.height, p.grid.data),
    }
  }
  // 规范化原始结果：老存档没有这一份，就按当时的 grid 兜底
  const regularizedGrid: Pixmap | null = p.regularizedGrid
    ? {
        width: p.regularizedGrid.width,
        height: p.regularizedGrid.height,
        data: unpackPixels(p.regularizedGrid.width, p.regularizedGrid.height, p.regularizedGrid.data),
      }
    : grid

  return {
    // 存的时候在哪一步，读回来就还在哪一步（顺带把那一步标成「进过」）
    activeStage: restoreStage(p.activeStage),
    edited: Boolean(p.edited),
    visited: {
      regularize: true,
      edit: false,
      optimize: false,
      pattern: false,
      [restoreStage(p.activeStage)]: true,
    },
    source,
    analysis: null,
    alignmentMode: p.alignmentMode as AlignmentMode,
    periodX: p.periodX,
    periodY: p.periodY,
    phaseX: p.phaseX,
    phaseY: p.phaseY,
    sampleMode: p.sampleMode as SampleMode,
    corners: (p.corners.length === 4
      ? p.corners.map((pt) => ({ x: pt.x, y: pt.y }))
      : defaultCorners(source?.width ?? 1, source?.height ?? 1)) as Quad,
    manualCols: p.manualCols,
    manualRows: p.manualRows,
    directBlock: p.directBlock,
    grid,
    regularizedGrid,
    ...resolveStoredPaletteSource(p),
    candidateHex: Array.isArray(p.candidateHex) ? [...p.candidateHex] : [],
    includeExtended: p.includeExtended,
    palette: resolve(p.paletteHex).length ? resolve(p.paletteHex) : library,
    quantizeOptions: { ...DEFAULT_QUANTIZE_OPTIONS, ...(p.quantizeOptions as object) },
    renderOptions: { ...DEFAULT_RENDER_OPTIONS, ...(p.renderOptions as object) },
    result: null,
    codeSystem: p.codeSystem as CodeSystem,
    optimizeTargetMode: p.optimizeTargetMode as TargetMode,
    optimizeConfig: { ...DEFAULT_OPTIMIZE_CONFIG, ...(p.optimizeConfig as object) },
    optimizedPalette: resolve(p.optimizedHex),
  }
}

/** 解码图片并按上限缩放，返回可直接参与计算的像素缓冲 */
async function decodeImage(blob: Blob): Promise<{ pixmap: Pixmap; url: string }> {
  const url = URL.createObjectURL(blob)
  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const el = new Image()
    el.onload = () => resolve(el)
    el.onerror = () => reject(new Error('无法解码该图片文件'))
    el.src = url
  })

  let w = img.naturalWidth || img.width
  let h = img.naturalHeight || img.height
  if (!w || !h) throw new Error('图片尺寸为空')

  const scale = Math.min(1, MAX_IMAGE_DIM / Math.max(w, h))
  w = Math.max(1, Math.floor(w * scale))
  h = Math.max(1, Math.floor(h * scale))

  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) throw new Error('无法创建 2D 画布上下文')
  ctx.drawImage(img, 0, 0, w, h)
  const data = ctx.getImageData(0, 0, w, h)

  return {
    pixmap: { width: w, height: h, data: new Uint8ClampedArray(data.data) },
    url,
  }
}

export const useStudio = create<StudioState>((set, get) => ({
  tabs: [{ id: FIRST_TAB_ID, name: NEW_TAB_NAME }],
  activeTabId: FIRST_TAB_ID,
  recent: [],
  savedAt: null,
  autosave: true,
  notice: null,

  loading: false,
  error: null,
  editTool: 'paint',
  editFillMode: 'color',
  editColor: '#000000',
  editSwatches: [],
  libraryPalette: buildLibraryPalette({ includeExtended: false }),
  optimizeRun: { ...EMPTY_RUN },
  // 方案存在本地，跨项目共享，所以随 store 一起初始化
  candidateSets: readCandidateSets(),

  ...freshProject(),

  setStage: (s) => set((prev) => ({ activeStage: s, visited: { ...prev.visited, [s]: true } })),
  goNext: () => {
    const order: StageId[] = STAGE_ORDER
    const idx = order.indexOf(get().activeStage)
    if (idx < order.length - 1) get().setStage(order[idx + 1])
  },
  goPrev: () => {
    const order: StageId[] = STAGE_ORDER
    const idx = order.indexOf(get().activeStage)
    if (idx > 0) get().setStage(order[idx - 1])
  },

  loadImageFile: async (file) => {
    await get().loadImageBlob(file, file.name)
  },

  loadImageBlob: async (blob, name) => {
    set({ loading: true, error: null })
    try {
      const { pixmap, url } = await decodeImage(blob)
      const prevUrl = get().source?.url
      if (prevUrl) URL.revokeObjectURL(prevUrl)

      set({
        source: { name, width: pixmap.width, height: pixmap.height, pixmap, url },
        corners: defaultCorners(pixmap.width, pixmap.height),
        analysis: null,
        grid: null,
        regularizedGrid: null,
        result: null,
        edited: false,
        loading: false,
      })
      get().detectDirectBlock()
      if (get().alignmentMode === 'auto') get().runAnalysis()
      else get().buildGrid()
    } catch (err) {
      set({ loading: false, error: err instanceof Error ? err.message : '载入图片失败' })
    }
  },

  clearSource: () => {
    const prevUrl = get().source?.url
    if (prevUrl) URL.revokeObjectURL(prevUrl)
    set({
      source: null,
      analysis: null,
      grid: null,
      regularizedGrid: null,
      result: null,
      edited: false,
      error: null,
      optimizedPalette: [],
      optimizeRun: { ...EMPTY_RUN },
    })
  },

  setAlignmentMode: (m) => {
    set({ alignmentMode: m })
    if (m === 'auto') {
      if (get().analysis) get().buildGrid()
      else get().runAnalysis()
    } else {
      get().buildGrid()
    }
  },
  setSampleMode: (m) => {
    set({ sampleMode: m })
    get().buildGrid()
  },

  runAnalysis: () => {
    const src = get().source
    if (!src) return
    const report = analyzePeriods(src.pixmap)
    if (!report) {
      set({ analysis: null, error: '未能可靠检测到像素周期，请改用手动四角对齐' })
      return
    }
    set({
      analysis: report,
      periodX: report.periodX,
      periodY: report.periodY,
      phaseX: report.phaseX,
      phaseY: report.phaseY,
      error: null,
    })
    get().buildGrid()
  },

  setPeriod: (axis, value) => {
    const v = Math.max(1, value)
    set(axis === 'x' ? { periodX: v } : { periodY: v })
    get().buildGrid()
  },
  setPhase: (axis, value) => {
    set(axis === 'x' ? { phaseX: value } : { phaseY: value })
    get().buildGrid()
  },

  setCorner: (index, x, y) => {
    const corners = get().corners.map((p, i) => (i === index ? { x, y } : p)) as Quad
    set({ corners })
    if (get().alignmentMode === 'quad') get().buildGrid()
  },
  resetCorners: () => {
    const src = get().source
    if (!src) return
    set({ corners: defaultCorners(src.width, src.height) })
    get().buildGrid()
  },
  setManualSize: (cols, rows) => {
    set({ manualCols: Math.max(1, Math.round(cols)), manualRows: Math.max(1, Math.round(rows)) })
    get().buildGrid()
  },

  applyGridEdit: (next) => {
    // 只改「工作用的网格」，规范化那份原始结果原封不动
    set({ grid: next, result: null, edited: true })
    get().recomputeResult()
  },

  resetToRegularized: () => {
    const s = get()
    // 优先用规范化的原始结果：不需要原图，也不用重跑一遍
    if (s.regularizedGrid) {
      set({
        grid: { width: s.regularizedGrid.width, height: s.regularizedGrid.height, data: new Uint8ClampedArray(s.regularizedGrid.data) },
        result: null,
        edited: false,
      })
      get().recomputeResult()
      return
    }
    // 老存档没有这一份，只能按原图重新生成
    get().buildGrid()
  },

  clearEdited: () => {
    set({ edited: false })
  },

  setEditTool: (tool) => set({ editTool: tool }),
  setEditFillMode: (mode) => set({ editFillMode: mode }),
  setEditColor: (hex) => set({ editColor: hex }),
  addEditSwatch: (hex) => {
    const current = get().editSwatches
    const next = appendSwatch(current, hex)
    if (next.join() !== current.join()) set({ editSwatches: next })
  },

  setDirectBlock: (n) => {
    set({ directBlock: Math.max(1, Math.round(n)) })
    get().buildGrid()
  },
  detectDirectBlock: () => {
    const src = get().source
    if (!src) return
    const block = detectUniformBlock(src.pixmap)
    // 只记录探测到的倍数。manualCols/Rows 是四角变换的分辨率，
    // 由用户自己填（默认 52×52），不要被 1:1 模式的探测结果改掉。
    set({ directBlock: block })
  },

  buildGrid: () => {
    const state = get()
    const src = state.source
    if (!src) return

    let grid: Pixmap | null = null
    if (state.alignmentMode === 'auto') {
      const report = state.analysis
      const periodX = report ? state.periodX : 1
      const periodY = report ? state.periodY : 1
      if (!report) return
      const out = sampleImage(
        src.pixmap.data,
        src.pixmap.width,
        src.pixmap.height,
        periodX,
        periodY,
        state.phaseX % periodX,
        state.phaseY % periodY,
        state.sampleMode,
      )
      grid = out.pixmap
    } else if (state.alignmentMode === 'quad') {
      grid = sampleQuad(src.pixmap, state.corners, state.manualCols, state.manualRows, state.sampleMode)
    } else {
      grid =
        state.directBlock > 1
          ? collapseBlocks(src.pixmap, state.directBlock)
          : { width: src.pixmap.width, height: src.pixmap.height, data: new Uint8ClampedArray(src.pixmap.data) }
    }

    // 重新生成 = 丢掉编辑过的东西：grid 和「规范化原始结果」都换成新算出来的这份
    set({ grid, regularizedGrid: grid, edited: false })
    get().recomputeResult()
  },

  setPaletteSource: (s) => {
    const state = get()
    const resolved = resolvePaletteForSource(s, state)
    if (!resolved) {
      // 还没跑优化就想用优化结果：只提醒，不动当前色板
      set({
        notice: {
          kind: 'warn',
          text: '还没有配色优化结果。请先到「优化颜色」运行一次，再回来选用优化结果。',
        },
      })
      return
    }
    set({ paletteSource: s, palette: resolved, notice: null })
    get().recomputeResult()
  },

  setKitSize: (size) => {
    const state = get()
    const next: Partial<StudioState> = { kitSize: size }
    // 正在用套装当色板时，换档位要立刻换色板
    if (state.paletteSource === 'kit') next.palette = buildKitPalette(size)
    set(next)
    if (state.paletteSource === 'kit') get().recomputeResult()
  },

  setCandidateHex: (hexes) => {
    set({ candidateHex: [...new Set(hexes)] })
  },

  saveCandidateSet: (name, hexes) => {
    const trimmed = name.trim() || `方案 ${get().candidateSets.length + 1}`
    const unique = [...new Set(hexes)]
    const sets = get().candidateSets
    // 同名视为覆盖，避免反复保存同一个方案堆出一串重名
    const existing = sets.find((s) => s.name === trimmed)
    const next: CandidateSet[] = [
      {
        id: existing?.id ?? `set${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
        name: trimmed,
        hexes: unique,
        savedAt: Date.now(),
      },
      ...sets.filter((s) => s.name !== trimmed),
    ]
    writeCandidateSets(next)
    set({ candidateSets: next })
  },

  applyCandidateSet: (id) => {
    const target = get().candidateSets.find((s) => s.id === id)
    if (!target) return
    const allowed = new Set(get().libraryPalette.map((e) => e.hex))
    const usable = target.hexes.filter((h) => allowed.has(h))
    const all = usable.length >= get().libraryPalette.length
    set({ candidateHex: all ? [] : usable })
  },

  deleteCandidateSet: (id) => {
    const next = get().candidateSets.filter((s) => s.id !== id)
    writeCandidateSets(next)
    set({ candidateSets: next })
  },

  setIncludeExtended: (v) => {
    const library = buildLibraryPalette({ includeExtended: v })
    const state = get()
    // 扩展色号开关会改变色号库，候选色里不属于新库的自动丢弃
    const allowed = new Set(library.map((e) => e.hex))
    const candidateHex = state.candidateHex.filter((h) => allowed.has(h))
    set({
      includeExtended: v,
      libraryPalette: library,
      candidateHex,
      palette: state.paletteSource === 'library' ? library : state.palette,
    })
    get().recomputeResult()
  },

  setPalette: (entries) => {
    set({ palette: entries, paletteSource: 'custom' })
    get().recomputeResult()
  },

  setQuantizeOptions: (patch) => {
    set({ quantizeOptions: { ...get().quantizeOptions, ...patch } })
    get().recomputeResult()
  },

  setRenderOptions: (patch) => {
    const before = get().renderOptions
    set({ renderOptions: { ...before, ...patch } })
    // 背景色会影响半透明豆（H01 这类）的观感，观感又参与颜色匹配，所以要重算
    if (patch.background !== undefined && patch.background !== before.background) get().recomputeResult()
  },

  setCodeSystem: (s) => set({ codeSystem: s }),

  recomputeResult: () => {
    const { grid, palette, quantizeOptions, renderOptions } = get()
    if (!grid) {
      set({ result: null })
      return
    }
    // 半透明豆按叠在图纸背景上的观感参与匹配（结果里仍存它自己的 hex）
    set({ result: quantizeToPalette(grid, matchPalette(palette, renderOptions.background), quantizeOptions) })
  },

  setOptimizeConfig: (patch) => set({ optimizeConfig: { ...get().optimizeConfig, ...patch } }),
  setOptimizeTargetMode: (m) => set({ optimizeTargetMode: m }),

  runOptimizer: async () => {
    const state = get()
    const grid = state.grid
    const started = performance.now()

    if (state.optimizeTargetMode === 'grid' && !grid) {
      set({ error: '请先在「规范化」中生成像素网格，再运行配色优化' })
      return
    }

    // 候选色 = 用户在「选择候选色」里勾选过的子集；没筛过就用整本色号库
    const allowed = state.candidateHex.length ? new Set(state.candidateHex) : null
    const picked = allowed
      ? state.libraryPalette.filter((e) => allowed.has(e.hex))
      : state.libraryPalette
    // 和出图保持一致：半透明豆按叠在图纸背景上的观感参与选色
    const candidates = matchPalette(picked, state.renderOptions.background)
    if (!candidates.length) {
      set({
        error: allowed
          ? '当前勾选的候选色是空的，请先在「选择候选色」里至少勾一个颜色'
          : '色号库为空',
      })
      return
    }

    let targetInfo: { samples: TargetSample[]; uniqueColors: number; pixels: number; bucket: number } = {
      samples: [],
      uniqueColors: 0,
      pixels: 0,
      bucket: 0,
    }
    if (state.optimizeTargetMode === 'grid' && grid) {
      targetInfo = targetsFromPixmap(grid, { maxTargets: 1200 })
    } else {
      targetInfo = {
        samples: candidates.map((e) => ({ rgb: e.rgb, lab: e.lab, count: 1 })),
        uniqueColors: candidates.length,
        pixels: candidates.length,
        bucket: 0,
      }
    }

    if (!targetInfo.samples.length) {
      set({ error: '当前网格没有可用的目标颜色' })
      return
    }

    const optimizer = new PaletteOptimizer(candidates, state.optimizeConfig, state.optimizeTargetMode)
    activeOptimizer = optimizer
    optimizer.setTargets(targetInfo.samples)

    set({
      error: null,
      optimizedPalette: [],
      optimizeRun: {
        ...EMPTY_RUN,
        status: 'running',
        candidates: candidates.length,
        targets: targetInfo.samples.length,
        uniqueColors: targetInfo.uniqueColors,
        pixels: targetInfo.pixels,
        bucket: targetInfo.bucket,
      },
    })

    const indicesToEntries = (idx: number[]) => idx.map((i) => candidates[i]).filter(Boolean)

    try {
      for await (const event of optimizer.run()) {
        if (event.type === 'initialized') {
          set((s) => ({
            optimizeRun: { ...s.optimizeRun, stats: event.stats, step: 0, progress: 0 },
            optimizedPalette: indicesToEntries(event.selected),
          }))
        } else if (event.type === 'progress') {
          set((s) => ({
            optimizeRun: {
              ...s.optimizeRun,
              status: 'running',
              stats: event.stats,
              step: event.step,
              progress: event.progress,
              temperature: event.temperature,
              elapsedMs: performance.now() - started,
            },
            optimizedPalette: indicesToEntries(event.selected),
          }))
        } else {
          const reasonText =
            event.reason === 'early-exit'
              ? `提前收敛（连续 ${state.optimizeConfig.patience} 步无改进）`
              : event.reason === 'stopped'
                ? '已手动停止'
                : '已完成全部退火步数'
          set((s) => ({
            optimizeRun: {
              ...s.optimizeRun,
              status: event.reason === 'stopped' ? 'stopped' : 'done',
              stats: event.stats,
              step: event.steps,
              progress: 100,
              elapsedMs: performance.now() - started,
              reason: reasonText,
            },
            optimizedPalette: indicesToEntries(event.selected),
          }))
        }
      }
    } catch (err) {
      set({ error: err instanceof Error ? err.message : '优化过程出错' })
    } finally {
      activeOptimizer = null
    }
  },

  stopOptimizer: () => {
    activeOptimizer?.stop()
  },

  applyOptimizedPalette: () => {
    const entries = get().optimizedPalette
    if (!entries.length) return
    set({ palette: entries, paletteSource: 'optimized', activeStage: 'pattern' })
    get().recomputeResult()
  },

  clearOptimizedPalette: () => set({ optimizedPalette: [], optimizeRun: { ...EMPTY_RUN } }),

  // ---------------------------------------------------------------- 标签页

  newTab: () => {
    const s = get()
    if (s.source || s.grid) get().saveCurrentProject()
    tabSnapshots.set(s.activeTabId, snapshotProject(s))
    const id = newTabId()
    set({
      tabs: [...s.tabs, { id, name: NEW_TAB_NAME }],
      activeTabId: id,
      error: null,
      activeStage: 'regularize',
      ...projectPatch(freshProject()),
    })
  },

  openInNewTab: async (blob, name) => {
    // 当前标签还是空的就直接用它，避免留下一堆空标签
    const s = get()
    if (s.source || s.grid) get().saveCurrentProject()
    if (!s.source && !s.grid) {
      set({ tabs: withRenamedTab(s.tabs, s.activeTabId, shortName(name)) })
    } else {
      tabSnapshots.set(s.activeTabId, snapshotProject(s))
      const id = newTabId()
      set({
        tabs: [...s.tabs, { id, name: shortName(name) }],
        activeTabId: id,
        activeStage: 'regularize',
        ...projectPatch(freshProject()),
      })
    }
    await get().loadImageBlob(blob, name)
  },

  switchTab: (id) => {
    const s = get()
    if (id === s.activeTabId) return
    const target = s.tabs.find((t) => t.id === id)
    if (!target) return
    // 离开前先把当前标签写进本地存档，否则它的改动会随切换丢掉
    if (s.source || s.grid) get().saveCurrentProject()
    tabSnapshots.set(s.activeTabId, snapshotProject(s))
    const snapshot = tabSnapshots.get(id) ?? freshProject()
    set({
      activeTabId: id,
      error: null,
      notice: null,
      ...projectPatch(snapshot),
    })
  },

  closeTab: (id) => {
    const s = get()
    const index = s.tabs.findIndex((t) => t.id === id)
    if (index < 0) return

    const closingSnapshot = id === s.activeTabId ? snapshotProject(s) : tabSnapshots.get(id)
    if (closingSnapshot?.source?.url) URL.revokeObjectURL(closingSnapshot.source.url)
    tabSnapshots.delete(id)

    if (s.tabs.length === 1) {
      // 最后一个标签不真的关掉，清空成新项目。
      // 必须换一个新 id：否则它会顶着旧项目 id 却已经是空的，
      // 之后从「最近项目」打开那个项目时会误判成「已打开」而切到这个空标签。
      const freshId = newTabId()
      set({
        tabs: [{ id: freshId, name: NEW_TAB_NAME }],
        activeTabId: freshId,
        error: null,
        notice: null,
        ...projectPatch(freshProject()),
      })
      return
    }

    const tabs = s.tabs.filter((t) => t.id !== id)
    if (id !== s.activeTabId) {
      set({ tabs })
      return
    }

    const next = tabs[Math.min(index, tabs.length - 1)]
    const snapshot = tabSnapshots.get(next.id) ?? freshProject()
    set({
      tabs,
      activeTabId: next.id,
      error: null,
      ...projectPatch(snapshot),
    })
  },

  renameTab: (id, name) => {
    const next = name.trim() || NEW_TAB_NAME
    set({ tabs: withRenamedTab(get().tabs, id, next) })
    // 最近项目列表里的名字也跟着改（只动索引那一条，不重写整个项目）
    renameProjectEntry(id, next)
    set({ recent: listProjects() })
    persistSession(get())
  },

  // ---------------------------------------------------------------- 本地存档

  setAutosave: (v) => {
    set({ autosave: v })
    if (v) get().saveCurrentProject()
  },

  clearNotice: () => set({ notice: null }),
  refreshRecent: () => set({ recent: listProjects() }),

  saveCurrentProject: () => {
    const s = get()
    let payload: PersistedProject
    let thumbnail = ''
    try {
      payload = serializeProject(s)
      const thumbSource = s.result ?? s.grid
      thumbnail = thumbSource ? makeThumbnail(thumbSource, 96) : ''
    } catch (err) {
      set({
        notice: { kind: 'error', text: err instanceof Error ? err.message : '序列化失败' },
      })
      return
    }

    const outcome = saveProject(
      {
        id: s.activeTabId,
        name: tabNameOf(s),
        project: payload,
        thumbnail,
        gridWidth: s.grid?.width ?? 0,
        gridHeight: s.grid?.height ?? 0,
      },
      s.tabs.map((t) => t.id),
    )

    if (!outcome.ok) {
      set({ notice: { kind: 'error', text: outcome.error ?? '保存失败' } })
    } else {
      set({ savedAt: Date.now(), notice: null })
    }
    // 顺手把缩略图记到标签页上，标签栏就能直接显示
    if (thumbnail) {
      set({ tabs: get().tabs.map((t) => (t.id === s.activeTabId ? { ...t, thumb: thumbnail } : t)) })
    }
    persistSession(get())
    set({ recent: listProjects() })
  },

  openRecentProject: async (id) => {
    const s = get()
    if (s.tabs.some((t) => t.id === id)) {
      get().switchTab(id)
      return true
    }
    const record = readProject(id)
    if (!record) {
      set({ notice: { kind: 'error', text: '这个项目的本地数据已经不存在了' } })
      get().refreshRecent()
      return false
    }

    try {
      const project = await deserializeProject(record.project)
      if (s.source || s.grid) get().saveCurrentProject()
      tabSnapshots.set(s.activeTabId, snapshotProject(get()))
      set({
        tabs: [...s.tabs, { id, name: record.name }],
        activeTabId: id,
        activeStage: project.grid ? 'pattern' : 'regularize',
        error: null,
        notice: null,
        ...projectPatch(project),
      })
      // 读档时把目标色与派生结果补齐
      get().recomputeResult()
      return true
    } catch (err) {
      set({
        notice: {
          kind: 'error',
          text: err instanceof Error ? err.message : '读取项目失败',
        },
      })
      return false
    }
  },

  deleteRecentProject: (id) => {
    removeProject(id)
    set({ recent: listProjects() })
  },

  /**
   * 自动保存：订阅 store，停止编辑 900ms 后写一次 localStorage。
   * 序列化是同步的，所以关页面前也能补一次保存。
   */
  initPersistence: () => {
    get().refreshRecent()

    let timer: ReturnType<typeof setTimeout> | null = null
    let lastSerialized = ''

    const runSave = () => {
      const s = get()
      if (!s.autosave) return
      // 完全空的项目不用进「最近项目」
      if (!s.source && !s.grid) return
      try {
        serializeProject(s)
      } catch {
        return
      }
      const mark = fingerprint(s)
      if (mark === lastSerialized) return
      lastSerialized = mark
      get().saveCurrentProject()
    }

    const unsubscribe = useStudio.subscribe((state, prev) => {
      // 忽略保存本身引发的状态变化，避免自激循环
      if (
        state.savedAt !== prev.savedAt ||
        state.notice !== prev.notice ||
        state.recent !== prev.recent
      ) {
        return
      }
      if (timer) clearTimeout(timer)
      timer = setTimeout(runSave, 900)
    })

    const onUnload = () => {
      if (timer) clearTimeout(timer)
      runSave()
      persistSession(get())
    }
    window.addEventListener('beforeunload', onUnload)
    window.addEventListener('pagehide', onUnload)

    // 启动恢复：把上次开着的标签页装回来（只解码当前那个，其余按需解码）
    void (async () => {
      const session = readSession()
      if (!session) return
      const available = session.tabs.filter((t) => readProject(t.id))
      if (!available.length) return

      const activeId = available.some((t) => t.id === session.activeId)
        ? session.activeId
        : available[available.length - 1].id

      set({
        tabs: available.map((t) => ({ id: t.id, name: t.name })),
        activeTabId: activeId,
        loading: true,
      })

      const ordered = [...available].sort((a, b) => (a.id === activeId ? -1 : b.id === activeId ? 1 : 0))
      for (const tab of ordered) {
        const record = readProject(tab.id)
        if (!record) continue
        try {
          const project = await deserializeProject(record.project)
          tabSnapshots.set(tab.id, project)
          if (get().activeTabId !== tab.id) continue
          // 当前标签：真正放进 store
          set({ loading: false, notice: null, ...projectPatch(project) })
          get().recomputeResult()
          persistSession(get())
        } catch {
          // 单个标签恢复失败就把它去掉，不影响其它标签
          const rest = get().tabs.filter((t) => t.id !== tab.id)
          if (rest.length) set({ tabs: rest })
        }
      }
      lastSerialized = fingerprint(get())
    })()

    return () => {
      unsubscribe()
      if (timer) clearTimeout(timer)
      window.removeEventListener('beforeunload', onUnload)
      window.removeEventListener('pagehide', onUnload)
    }
  },
}))
