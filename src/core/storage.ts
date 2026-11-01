/**
 * localStorage 持久化封装。
 */
import type { Pixmap } from './types.ts'

export const INDEX_KEY = 'beads-studio:index'
export const PROJECT_KEY_PREFIX = 'beads-studio:project:'
export const SESSION_KEY = 'beads-studio:session'
export const CANDIDATE_SETS_KEY = 'beads-studio:candidate-sets'

/** 跨项目候选色方案 */
export interface CandidateSet {
  id: string
  name: string
  hexes: string[]
  savedAt: number
}

export function readCandidateSets(): CandidateSet[] {
  const ls = safeStorage()
  if (!ls) return []
  try {
    const raw = ls.getItem(CANDIDATE_SETS_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter((item): item is CandidateSet => {
        if (!item || typeof item !== 'object') return false
        const s = item as Partial<CandidateSet>
        return (
          typeof s.id === 'string' &&
          typeof s.name === 'string' &&
          Array.isArray(s.hexes) &&
          s.hexes.every((h) => typeof h === 'string')
        )
      })
      .map((s) => ({ id: s.id, name: s.name, hexes: [...s.hexes], savedAt: Number(s.savedAt) || 0 }))
  } catch {
    return []
  }
}

export function writeCandidateSets(sets: CandidateSet[]): void {
  const ls = safeStorage()
  if (!ls) return
  try {
    ls.setItem(CANDIDATE_SETS_KEY, JSON.stringify(sets))
  } catch {
    /* 存储不可用或满时忽略 */
  }
}

/** 退出时打开的会话状态 */
export interface SessionState {
  tabs: { id: string; name: string }[]
  activeId: string
}

export function readSession(): SessionState | null {
  const ls = safeStorage()
  if (!ls) return null
  try {
    const raw = ls.getItem(SESSION_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as SessionState
    if (!parsed || !Array.isArray(parsed.tabs) || !parsed.tabs.length) return null
    return parsed
  } catch {
    return null
  }
}

export function writeSession(session: SessionState): void {
  const ls = safeStorage()
  if (!ls) return
  try {
    ls.setItem(SESSION_KEY, JSON.stringify(session))
  } catch {
    /* 会话写入失败不影响主数据 */
  }
}

export interface IndexEntry {
  id: string
  name: string
  savedAt: number
  gridWidth: number
  gridHeight: number
  /** 小尺寸 PNG dataURL，用于最近项目列表 */
  thumbnail: string
  /** 正文占用的大致字节数 */
  bytes: number
  /** 原图是否成功存下 */
  hasSource: boolean
}

export interface PersistedSource {
  name: string
  width: number
  height: number
  /** PNG dataURL */
  png: string
}

export interface PersistedProject {
  alignmentMode: string
  periodX: number
  periodY: number
  phaseX: number
  phaseY: number
  sampleMode: string
  corners: { x: number; y: number }[]
  manualCols: number
  manualRows: number
  directBlock: number
  paletteSource: string
  /** 套装色板规模（24/48/72/96/120） */
  kitSize?: number
  /** 当前所在步骤 */
  activeStage?: string
  /** 是否经过像素编辑 */
  edited?: boolean
  /** 优化候选色 */
  candidateHex?: string[]
  includeExtended: boolean
  paletteHex: string[]
  codeSystem: string
  quantizeOptions: unknown
  renderOptions: unknown
  optimizeTargetMode: string
  optimizeConfig: unknown
  optimizedHex: string[]
  /** 优化源色到色号的映射 */
  optimizedMap?: { key: number; hex: string }[] | null
  /** 规范化原始结果 */
  regularizedGrid?: { width: number; height: number; data: string } | null
  source: PersistedSource | null
  sourceOmitted: boolean
  grid: { width: number; height: number; data: string } | null
}

export interface ProjectRecord {
  id: string
  name: string
  savedAt: number
  project: PersistedProject
}

/** localStorage 在隐私模式 / 沙箱里可能直接不可用 */
export function safeStorage(): Storage | null {
  try {
    const ls = (globalThis as { localStorage?: Storage }).localStorage
    if (!ls) return null
    // 真正探一次读写，某些环境 getter 存在但会抛
    const probe = '__beads_probe__'
    ls.setItem(probe, '1')
    ls.removeItem(probe)
    return ls
  } catch {
    return null
  }
}

export function isQuotaError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const e = err as { name?: string; code?: number; message?: string }
  return (
    e.name === 'QuotaExceededError' ||
    e.name === 'NS_ERROR_DOM_QUOTA_REACHED' ||
    e.code === 22 ||
    e.code === 1014 ||
    /quota/i.test(e.message ?? '')
  )
}

/** 像素缓冲 → PNG dataURL */
export function pixmapToDataUrl(img: Pixmap): string {
  const canvas = document.createElement('canvas')
  canvas.width = img.width
  canvas.height = img.height
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('无法创建画布上下文')
  ctx.putImageData(new ImageData(new Uint8ClampedArray(img.data), img.width, img.height), 0, 0)
  return canvas.toDataURL('image/png')
}

/** 缩略图：把网格按最近邻缩到最长边不超过 maxSide，再编码 PNG */
export function makeThumbnail(img: Pixmap, maxSide = 96): string {
  const scale = Math.max(1, Math.ceil(Math.max(img.width, img.height) / maxSide))
  if (scale === 1) return pixmapToDataUrl(img)

  const src = document.createElement('canvas')
  src.width = img.width
  src.height = img.height
  const sctx = src.getContext('2d')
  if (!sctx) return ''
  sctx.putImageData(new ImageData(new Uint8ClampedArray(img.data), img.width, img.height), 0, 0)

  const w = Math.max(1, Math.floor(img.width / scale))
  const h = Math.max(1, Math.floor(img.height / scale))
  const dst = document.createElement('canvas')
  dst.width = w
  dst.height = h
  const dctx = dst.getContext('2d')
  if (!dctx) return ''
  dctx.imageSmoothingEnabled = false
  dctx.drawImage(src, 0, 0, w, h)
  return dst.toDataURL('image/png')
}

/** PNG / 任意图片 dataURL → 像素缓冲 */
export async function dataUrlToPixmap(dataUrl: string): Promise<Pixmap> {
  const image = await new Promise<HTMLImageElement>((resolve, reject) => {
    const el = new Image()
    el.onload = () => resolve(el)
    el.onerror = () => reject(new Error('无法解码存档中的图片'))
    el.src = dataUrl
  })
  const w = image.naturalWidth || image.width
  const h = image.naturalHeight || image.height
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) throw new Error('无法创建画布上下文')
  ctx.drawImage(image, 0, 0)
  const data = ctx.getImageData(0, 0, w, h)
  return { width: w, height: h, data: new Uint8ClampedArray(data.data) }
}

export function readIndex(): IndexEntry[] {
  const ls = safeStorage()
  if (!ls) return []
  try {
    const raw = ls.getItem(INDEX_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter((e): e is IndexEntry => Boolean(e) && typeof (e as IndexEntry).id === 'string')
  } catch {
    return []
  }
}

function writeIndex(entries: IndexEntry[]): void {
  const ls = safeStorage()
  if (!ls) return
  try {
    ls.setItem(INDEX_KEY, JSON.stringify(entries))
  } catch {
    /* 索引写不进去就算了，正文仍然可读 */
  }
}

export function listProjects(): IndexEntry[] {
  return readIndex().sort((a, b) => b.savedAt - a.savedAt)
}

/** 更新项目索引条目的名称 */
export function renameProjectEntry(id: string, name: string): void {
  const entries = readIndex()
  if (!entries.some((e) => e.id === id)) return
  writeIndex(entries.map((e) => (e.id === id ? { ...e, name } : e)))
}

export function readProject(id: string): ProjectRecord | null {
  const ls = safeStorage()
  if (!ls) return null
  try {
    const raw = ls.getItem(PROJECT_KEY_PREFIX + id)
    if (!raw) return null
    return JSON.parse(raw) as ProjectRecord
  } catch {
    return null
  }
}

export function removeProject(id: string): void {
  const ls = safeStorage()
  if (!ls) return
  try {
    ls.removeItem(PROJECT_KEY_PREFIX + id)
  } catch {
    /* ignore */
  }
  writeIndex(readIndex().filter((e) => e.id !== id))
}

export interface SaveOutcome {
  ok: boolean
  /** 为了腾地方被淘汰的其它项目 */
  evicted: string[]
  error?: string
  bytes: number
}

export interface SaveInput {
  id: string
  name: string
  project: PersistedProject
  thumbnail: string
  gridWidth: number
  gridHeight: number
}

/**
 * 保存一个项目。
 * keepIds 是需要保留的正在打开的标签（淘汰时不会动它们）。
 */
export function saveProject(input: SaveInput, keepIds: string[] = []): SaveOutcome {
  const ls = safeStorage()
  if (!ls) {
    return { ok: false, evicted: [], error: '当前环境不支持本地存储', bytes: 0 }
  }

  const evicted: string[] = []

  const attempt = (payload: PersistedProject): { ok: boolean; error?: string; bytes: number } => {
    const record: ProjectRecord = { id: input.id, name: input.name, savedAt: Date.now(), project: payload }
    const text = JSON.stringify(record)
    try {
      ls.setItem(PROJECT_KEY_PREFIX + input.id, text)
      return { ok: true, bytes: text.length }
    } catch (err) {
      return { ok: false, error: isQuotaError(err) ? 'quota' : String(err), bytes: text.length }
    }
  }

  // 存档里只有网格（原图不存），空间不够就淘汰最旧的其它项目，逐个重试
  const payload = input.project
  let result = attempt(payload)
  let guard = 0
  while (!result.ok && result.error === 'quota' && guard++ < 20) {
    const candidates = listProjects().filter((e) => e.id !== input.id && !keepIds.includes(e.id))
    const oldest = candidates[candidates.length - 1]
    if (!oldest) break
    removeProject(oldest.id)
    evicted.push(oldest.id)
    result = attempt(payload)
  }

  if (!result.ok) {
    return {
      ok: false,
      evicted,
      error: result.error === 'quota' ? '本地存储空间不足，无法保存' : result.error,
      bytes: result.bytes,
    }
  }

  const entry: IndexEntry = {
    id: input.id,
    name: input.name,
    savedAt: Date.now(),
    gridWidth: input.gridWidth,
    gridHeight: input.gridHeight,
    thumbnail: input.thumbnail,
    bytes: result.bytes,
    hasSource: Boolean(payload.source),
  }
  const next = readIndex().filter((e) => e.id !== input.id)
  next.push(entry)
  writeIndex(next)

  return { ok: true, evicted, bytes: result.bytes }
}

/** 粗略估算当前已用空间，用于界面提示 */
export function estimateUsage(): { bytes: number; count: number } {
  const list = readIndex()
  let bytes = 0
  for (const e of list) bytes += e.bytes
  return { bytes, count: list.length }
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`
}

export function formatTime(ts: number): string {
  const d = new Date(ts)
  const pad = (v: number) => String(v).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}
