import { useCallback, useEffect, useRef, useState } from 'react'
import { useStudio, type StageId } from './store/studio.ts'
import { RegularizeStep } from './components/RegularizeStep.tsx'
import { OptimizeStep } from './components/OptimizeStep.tsx'
import { PatternStep } from './components/PatternStep.tsx'
import { FullscreenPreview } from './components/FullscreenPreview.tsx'
import { TabBar } from './components/TabBar.tsx'
import { RecentProjectsDialog } from './components/RecentProjectsDialog.tsx'
import { Notice, useMaterialRipple } from './components/ui.tsx'
import { packPixels, unpackPixels, downloadText, type ProjectFile } from './core/export.ts'
import { formatTime } from './core/storage.ts'

const STAGES: { id: StageId; label: string; desc: string }[] = [
  {
    id: 'regularize',
    label: '规范化',
    desc: '四角变换 / 像素自动识别 / 直接上传 1:1 像素图',
  },
  {
    id: 'optimize',
    label: '优化颜色',
    desc: '以规范化结果为优化目标，选出最终色号',
  },
  {
    id: 'pattern',
    label: '转拼豆图纸',
    desc: '量化到色板、珠子预览、出图与用料清单',
  },
]

export default function App() {
  const activeStage = useStudio((s) => s.activeStage)
  const setStage = useStudio((s) => s.setStage)
  const source = useStudio((s) => s.source)
  const error = useStudio((s) => s.error)
  const loading = useStudio((s) => s.loading)
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
  const fileRef = useRef<HTMLInputElement>(null)
  const projectRef = useRef<HTMLInputElement>(null)

  const openFile = useCallback(() => fileRef.current?.click(), [])
  useMaterialRipple()

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

  // Ctrl/Cmd + 1/2/3 切换阶段
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return
      const idx = ['1', '2', '3'].indexOf(e.key)
      if (idx >= 0) {
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
    downloadText(JSON.stringify(project), `beads-studio-${Date.now()}.json`, 'application/json')
  }

  const loadProject = async (file: File) => {
    try {
      const text = await file.text()
      const project = JSON.parse(text) as ProjectFile
      if (project.app !== 'beads-studio') throw new Error('不是 Beads Studio 项目文件')
      const s = useStudio.getState()
      if (project.grid) {
        useStudio.setState({
          grid: {
            width: project.grid.width,
            height: project.grid.height,
            data: unpackPixels(project.grid.width, project.grid.height, project.grid.data),
          },
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
          optimizeConfig: (settings.optimizeConfig as typeof s.optimizeConfig) ?? s.optimizeConfig,
          optimizeTargetMode:
            (settings.optimizeTargetMode as typeof s.optimizeTargetMode) ?? s.optimizeTargetMode,
        })
      }
      useStudio.getState().recomputeResult()
    } catch (err) {
      useStudio.setState({ error: err instanceof Error ? err.message : '项目文件读取失败' })
    }
  }

  const stageDone: Record<StageId, boolean> = {
    // 没进过的阶段不算完成：图纸是自动生成的，否则一做完第一步第三步就提前打勾了
    regularize: visited.regularize && Boolean(grid),
    optimize: visited.optimize && optimizedPalette.length > 0,
    pattern: visited.pattern && Boolean(result),
  }

  return (
    <div className={dragOver ? 'app drop-active' : 'app'}>
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">
            <i className="material-icons sm">blur_on</i>
          </span>
          <div>
            Beads Studio
            <br />
            <small>拼豆工作流工作室</small>
          </div>
        </div>

        <TabBar onRequestFile={openFile} />

        <span className="topbar-spacer" />

        <div className="row tight">
          <button className="btn waves-effect waves-light" onClick={openFile} disabled={loading}>
            {loading ? '载入中…' : source ? '更换图片' : '打开图片'}
          </button>
          <button className="btn-flat waves-effect" onClick={() => setShowFullscreen(true)} disabled={!result}>
            全屏预览
          </button>
          <button className="btn-flat waves-effect" onClick={saveProject} disabled={!grid} title="导出成项目文件">
            导出文件
          </button>
          <button className="btn-flat waves-effect" onClick={() => projectRef.current?.click()} title="从项目文件导入">
            导入文件
          </button>
          <button className="btn-flat waves-effect" onClick={() => setShowRecent(true)}>
            最近项目
            {recentCount > 0 && <span className="pill">{recentCount}</span>}
          </button>
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
          <div className="rail-title">工作流</div>
          {STAGES.map((s, i) => (
            <button
              key={s.id}
              className={`rail-step collection-item ${activeStage === s.id ? 'active' : ''} ${stageDone[s.id] ? 'done' : ''}`}
              onClick={() => setStage(s.id)}
            >
              <span className="rail-num">
                {stageDone[s.id] ? <i className="material-icons sm">check</i> : i + 1}
              </span>
              <span>
                <span className="rail-label">{s.label}</span>
                <span className="rail-desc">{s.desc}</span>
              </span>
            </button>
          ))}
          <div className="rail-foot">
            图片只在本地浏览器内处理，不会上传。
            <br />
            快捷键 ⌘/Ctrl + 1 · 2 · 3 切换阶段。
            <div className="divider" />
            当前色板 {palette.length} 色 · {codeSystem}
            <div className="divider" />
            {autosave ? (
              <>已开启自动保存{savedAt ? ` · ${formatTime(savedAt)}` : ''}</>
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
          {activeStage === 'optimize' && <OptimizeStep />}
          {activeStage === 'pattern' && <PatternStep />}
        </main>
      </div>

      {showFullscreen && result && (
        <FullscreenPreview
          pixmap={result}
          onClose={() => setShowFullscreen(false)}
          label={`${result.width} × ${result.height} 格 · ${palette.length} 个色号（${codeSystem}）`}
        />
      )}

      {showRecent && <RecentProjectsDialog onClose={() => setShowRecent(false)} />}
    </div>
  )
}
