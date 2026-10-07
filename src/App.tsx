import { useCallback, useEffect, useRef, useState } from 'react'
import { useStudio, type StageId } from './store/studio.ts'
import { RegularizeStep } from './components/RegularizeStep.tsx'
import { EditStep } from './components/EditStep.tsx'
import { OptimizeStep } from './components/OptimizeStep.tsx'
import { PatternStep } from './components/PatternStep.tsx'
import { FullscreenPreview } from './components/FullscreenPreview.tsx'
import { TabBar } from './components/TabBar.tsx'
import { RecentProjectsDialog } from './components/RecentProjectsDialog.tsx'
import { MenuDrawer, type DrawerItem } from './components/MenuDrawer.tsx'
import { CropDialog } from './components/CropDialog.tsx'
import { STAGE_META, STAGE_ORDER } from './components/stages.ts'
import { BeadLogo } from './components/BeadLogo.tsx'
import { Notice, useMaterialRipple } from './components/ui.tsx'
import { packPixels, unpackPixels, downloadText, safeFileName, type ProjectFile } from './core/export.ts'
import { formatTime } from './core/storage.ts'

const STAGES = STAGE_ORDER.map((id) => ({ id, ...STAGE_META[id] }))

export default function App() {
  const activeStage = useStudio((s) => s.activeStage)
  const setStage = useStudio((s) => s.setStage)
  const error = useStudio((s) => s.error)
  const grid = useStudio((s) => s.grid)
  const result = useStudio((s) => s.result)
  const optimizedPalette = useStudio((s) => s.optimizedPalette)
  const palette = useStudio((s) => s.palette)
  const codeSystem = useStudio((s) => s.codeSystem)
  const savedAt = useStudio((s) => s.savedAt)
  const notice = useStudio((s) => s.notice)
  const autosave = useStudio((s) => s.autosave)
  const recentCount = useStudio((s) => s.recent.length)
  const visited = useStudio((s) => s.visited)

  const [dragOver, setDragOver] = useState(false)
  const [showFullscreen, setShowFullscreen] = useState(false)
  const [showRecent, setShowRecent] = useState(false)
  const [showMenu, setShowMenu] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)
  const projectRef = useRef<HTMLInputElement>(null)
  const activeRailRef = useRef<HTMLButtonElement>(null)

  const openFile = useCallback(() => fileRef.current?.click(), [])
  useMaterialRipple()

  // 手机上步骤栏是横向滚动的：切到某一步时把它滚进可视区，
  // 不然用快捷键 / 恢复存档跳到第 4 步时，选中的那一项在屏幕外面。
  useEffect(() => {
    const el = activeRailRef.current
    if (el && typeof el.scrollIntoView === 'function') {
      el.scrollIntoView({ block: 'nearest', inline: 'center' })
    }
  }, [activeStage])

  const onPickFile = (files: FileList | null) => {
    const file = files?.[0]
    if (!file) return
    // 拖入 / 选择图片 = 开一个新标签页，和浏览器标签栏的行为一致
    void useStudio.getState().openInNewTab(file, file.name)
  }

  // 启动时接上自动保存，并恢复最近的存档列表
  useEffect(() => {
    const stop = useStudio.getState().initPersistence()
    return stop
  }, [])

  // 全局拖放 + 粘贴
  useEffect(() => {
    const onDragOver = (e: DragEvent) => {
      e.preventDefault()
      setDragOver(true)
    }
    const onDragLeave = (e: DragEvent) => {
      if (e.relatedTarget === null) setDragOver(false)
    }
    const onDrop = (e: DragEvent) => {
      e.preventDefault()
      setDragOver(false)
      const file = e.dataTransfer?.files?.[0]
      if (file) void useStudio.getState().openInNewTab(file, file.name)
    }
    const onPaste = (e: ClipboardEvent) => {
      const target = e.target as HTMLElement | null
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return
      const item = [...(e.clipboardData?.items ?? [])].find((i) => i.type.startsWith('image/'))
      const file = item?.getAsFile()
      if (file) void useStudio.getState().openInNewTab(file, '剪贴板图片')
    }
    window.addEventListener('dragover', onDragOver)
    window.addEventListener('dragleave', onDragLeave)
    window.addEventListener('drop', onDrop)
    window.addEventListener('paste', onPaste)
    return () => {
      window.removeEventListener('dragover', onDragOver)
      window.removeEventListener('dragleave', onDragLeave)
      window.removeEventListener('drop', onDrop)
      window.removeEventListener('paste', onPaste)
    }
  }, [])

  // Ctrl/Cmd + 1/2/3/4 切换阶段
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return
      const idx = Number(e.key) - 1
      if (Number.isInteger(idx) && idx >= 0 && idx < STAGES.length) {
        e.preventDefault()
        setStage(STAGES[idx].id)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [setStage])

  const saveProject = () => {
    const s = useStudio.getState()
    const project: ProjectFile = {
      app: 'beads-studio',
      version: 1,
      savedAt: new Date().toISOString(),
      name: s.tabs.find((t) => t.id === s.activeTabId)?.name ?? '未命名项目',
      activeStage: s.activeStage,
      edited: s.edited,
      grid: s.grid ? { width: s.grid.width, height: s.grid.height, data: packPixels(s.grid) } : undefined,
      paletteHex: s.palette.map((e) => e.hex),
      settings: {
        codeSystem: s.codeSystem,
        quantizeOptions: s.quantizeOptions,
        renderOptions: s.renderOptions,
        optimizeConfig: s.optimizeConfig,
        optimizeTargetMode: s.optimizeTargetMode,
      },
    }
    // 文件名用项目名，别让一堆导出都叫 beads-xxxx
    downloadText(JSON.stringify(project), `${safeFileName(project.name ?? '未命名项目')}.json`, 'application/json')
  }

  const loadProject = async (file: File) => {
    try {
      const text = await file.text()
      const project = JSON.parse(text) as ProjectFile
      if (project.app !== 'beads-studio') throw new Error('不是 Beads Studio 项目文件')
      const s = useStudio.getState()
      if (project.grid) {
        const grid = {
          width: project.grid.width,
          height: project.grid.height,
          data: unpackPixels(project.grid.width, project.grid.height, project.grid.data),
        }
        useStudio.setState({
          grid,
          // 导入的项目文件里没有单独的「规范化原始结果」：没编辑过就按这份网格算，
          // 编辑过的话规范化页退回显示工作网格（总比显示上一个项目的结果强）
          regularizedGrid: project.edited ? null : grid,
        })
      }
      if (project.paletteHex?.length) {
        const map = new Map(s.libraryPalette.map((e) => [e.hex, e]))
        const entries = project.paletteHex
          .map((h) => map.get(h))
          .filter((e): e is NonNullable<typeof e> => Boolean(e))
        if (entries.length) useStudio.setState({ palette: entries, paletteSource: 'custom' })
      }
      const settings = project.settings as Record<string, unknown> | undefined
      if (settings) {
        useStudio.setState({
          codeSystem: (settings.codeSystem as typeof s.codeSystem) ?? s.codeSystem,
          quantizeOptions: (settings.quantizeOptions as typeof s.quantizeOptions) ?? s.quantizeOptions,
          renderOptions: (settings.renderOptions as typeof s.renderOptions) ?? s.renderOptions,
          // 老项目文件里可能缺后来才加的字段，要和默认值合并后再用
          optimizeConfig: { ...s.optimizeConfig, ...((settings.optimizeConfig as object) ?? {}) },
          optimizeTargetMode:
            (settings.optimizeTargetMode as typeof s.optimizeTargetMode) ?? s.optimizeTargetMode,
        })
      }
      useStudio.getState().recomputeResult()
      // 存档里的项目名：导入后当前标签页跟着改名
      if (typeof project.name === 'string' && project.name.trim()) {
        useStudio.getState().renameTab(useStudio.getState().activeTabId, project.name.trim())
      }
      // 存档里记了当时停在哪一步，导入后直接跳过去
      const stage = project.activeStage
      if (stage && STAGE_ORDER.includes(stage as StageId)) {
        useStudio.setState({
          activeStage: stage as StageId,
          edited: Boolean(project.edited),
          visited: { ...useStudio.getState().visited, [stage as StageId]: true },
        })
      } else if (project.edited) {
        useStudio.setState({ edited: true })
      }
    } catch (err) {
      useStudio.setState({ error: err instanceof Error ? err.message : '项目文件读取失败' })
    }
  }

  const stageDone: Record<StageId, boolean> = {
    // 没进过的阶段不算完成：图纸是自动生成的，否则一做完第一步第三步就提前打勾了
    regularize: visited.regularize && Boolean(grid),
    edit: visited.edit && Boolean(grid),
    optimize: visited.optimize && optimizedPalette.length > 0,
    pattern: visited.pattern && Boolean(result),
  }

  // 顶部工具：宽屏是图标按钮，窄屏收进侧边栏，两边用同一份定义
  const tools: DrawerItem[] = [
    {
      icon: 'fullscreen',
      label: '全屏预览',
      disabled: !result,
      onClick: () => setShowFullscreen(true),
    },
    { icon: 'download', label: '导出文件', disabled: !grid, onClick: saveProject },
    { icon: 'upload', label: '导入文件', onClick: () => projectRef.current?.click() },
    { icon: 'folder_open', label: '最近项目', badge: recentCount, onClick: () => setShowRecent(true) },
  ]

  return (
    <div className={dragOver ? 'app drop-active' : 'app'}>
      <header className="topbar">
        <button
          className="topbar-menu btn-floating waves-effect"
          onClick={() => setShowMenu(true)}
          title="工具菜单"
          aria-label="工具菜单"
        >
          <i className="material-icons">menu</i>
        </button>

        <div className="brand">
          <span className="brand-mark">
            <BeadLogo />
          </span>
          <div className="brand-text">
            <span className="brand-name">Beads Studio</span>
            <small>拼豆工作室</small>
          </div>
        </div>

        <TabBar onRequestFile={openFile} />

        <span className="topbar-spacer" />

        <div className="row tight topbar-actions">
          {tools.map((t) => (
            <button
              key={t.label}
              className="btn-flat icon-only waves-effect"
              onClick={t.onClick}
              disabled={t.disabled}
              title={t.label}
              aria-label={t.label}
            >
              <i className="material-icons sm">{t.icon}</i>
              {t.badge ? <span className="pill">{t.badge}</span> : null}
            </button>
          ))}
        </div>

        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          hidden
          onChange={(e) => {
            onPickFile(e.target.files)
            e.target.value = ''
          }}
        />
        <input
          ref={projectRef}
          type="file"
          accept="application/json,.json"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0]
            if (f) void loadProject(f)
            e.target.value = ''
          }}
        />
      </header>

      <div className="body">
        <nav className="rail collection">
          {STAGES.map((s) => (
            <button
              key={s.id}
              ref={activeStage === s.id ? activeRailRef : undefined}
              className={`rail-step collection-item ${activeStage === s.id ? 'active' : ''} ${stageDone[s.id] ? 'done' : ''}`}
              onClick={() => setStage(s.id)}
            >
              <span className="rail-num">
                <i className="material-icons sm">{stageDone[s.id] ? 'check' : s.icon}</i>
              </span>
              <span className="rail-label">{s.label}</span>
            </button>
          ))}
          <div className="rail-foot">
            {autosave ? (
              <>自动保存{savedAt ? ` · ${formatTime(savedAt)}` : ''}</>
            ) : (
              <>自动保存已关闭</>
            )}
          </div>
        </nav>

        <main className="main">
          {error && (
            <div style={{ marginBottom: 14 }}>
              <Notice kind="error">
                {error}
                <button
                  className="btn-flat btn-small waves-effect"
                  style={{ marginLeft: 10 }}
                  onClick={() => useStudio.setState({ error: null })}
                >
                  知道了
                </button>
              </Notice>
            </div>
          )}

          {notice && (
            <div style={{ marginBottom: 14 }}>
              <Notice kind={notice.kind}>
                {notice.text}
                <button
                  className="btn-flat btn-small waves-effect"
                  style={{ marginLeft: 10 }}
                  onClick={() => useStudio.getState().clearNotice()}
                >
                  知道了
                </button>
              </Notice>
            </div>
          )}

          {activeStage === 'regularize' && <RegularizeStep onOpenFile={openFile} />}
          {activeStage === 'edit' && <EditStep />}
          {activeStage === 'optimize' && <OptimizeStep />}
          {activeStage === 'pattern' && <PatternStep onOpenFullscreen={() => setShowFullscreen(true)} />}
        </main>
      </div>

      {showMenu && <MenuDrawer items={tools} onClose={() => setShowMenu(false)} />}

      {showFullscreen && result && (
        <FullscreenPreview
          pixmap={result}
          onClose={() => setShowFullscreen(false)}
          label={`${result.width} × ${result.height} 格 · ${palette.length} 个色号（${codeSystem}）`}
        />
      )}

      {showRecent && <RecentProjectsDialog onClose={() => setShowRecent(false)} />}

      {/* 上传预处理：只在上传时出现一次，裁剪完才进规范化 */}
      <CropDialog />
    </div>
  )
}
