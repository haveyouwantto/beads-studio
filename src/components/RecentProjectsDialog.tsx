import { useEffect, useState } from 'react'
import { useStudio } from '../store/studio.ts'
import { estimateUsage, formatBytes, formatTime } from '../core/storage.ts'
import { Check } from './ui.tsx'

/**
 * 「最近项目」弹窗：列出 localStorage 里自动存档的项目，可以打开或删除。
 * 索引里只存缩略图和元信息，所以打开这个弹窗不会去解析上兆的项目正文。
 */
export function RecentProjectsDialog({
  onClose,
  onExportProject,
  onImportProject,
  hasGrid,
}: {
  onClose: () => void
  onExportProject: () => void
  onImportProject: () => void
  hasGrid: boolean
}) {
  const recent = useStudio((s) => s.recent)
  const refreshRecent = useStudio((s) => s.refreshRecent)
  const openRecentProject = useStudio((s) => s.openRecentProject)
  const deleteRecentProject = useStudio((s) => s.deleteRecentProject)
  const autosave = useStudio((s) => s.autosave)
  const setAutosave = useStudio((s) => s.setAutosave)
  const tabs = useStudio((s) => s.tabs)
  const [usage, setUsage] = useState(() => estimateUsage())
  const [confirmId, setConfirmId] = useState<string | null>(null)

  useEffect(() => {
    refreshRecent()
    setUsage(estimateUsage())
  }, [refreshRecent])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const openIds = new Set(tabs.map((t) => t.id))

  return (
    <div className="modal-overlay open" onClick={onClose}>
      <div className="modal open" onClick={(e) => e.stopPropagation()}>
        <header className="modal-head">
          <div>
            <h2>最近项目</h2>
            <p className="tiny muted">
              自动保存在本机浏览器里，共 {usage.count} 个 · 占用 {formatBytes(usage.bytes)}
            </p>
          </div>
          <span style={{ flex: 1 }} />
          <button className="btn-flat btn-small waves-effect" onClick={onClose}>
            关闭 (Esc)
          </button>
        </header>

        <div className="modal-content modal-body">
          <div className="row tight project-file-row">
            <button
              className="btn-flat btn-small waves-effect"
              onClick={onExportProject}
              disabled={!hasGrid}
              title="把当前项目导出成文件"
            >
              <i className="material-icons sm">download</i>
              <span className="btn-label">导出当前项目</span>
            </button>
            <button
              className="btn-flat btn-small waves-effect"
              onClick={onImportProject}
              title="从项目文件导入"
            >
              <i className="material-icons sm">upload</i>
              <span className="btn-label">导入项目文件</span>
            </button>
          </div>
          <div className="divider" />

          {recent.length === 0 ? (
            <div className="empty" style={{ minHeight: 180 }}>
              <div>
                <i className="material-icons lg empty-icon">folder_open</i>
                <div style={{ fontWeight: 600, color: 'var(--text)' }}>还没有自动存档</div>
                <div style={{ marginTop: 6 }}>
                  打开一张图片后，项目会自动存到这里；下次打开应用可以直接接着做。
                </div>
              </div>
            </div>
          ) : (
            <ul className="recent-list">
              {recent.map((item) => (
                <li key={item.id} className="recent-item">
                  {item.thumbnail ? (
                    <img className="recent-thumb" src={item.thumbnail} alt="" />
                  ) : (
                    <span className="recent-thumb blank" />
                  )}

                  <div className="recent-meta">
                    <div className="recent-name">
                      {item.name}
                      {openIds.has(item.id) && <span className="badge">已打开</span>}
                    </div>
                    <div className="tiny muted">
                      {item.gridWidth > 0 ? `${item.gridWidth} × ${item.gridHeight} 格` : '尚未生成网格'} ·{' '}
                      {formatTime(item.savedAt)} · {formatBytes(item.bytes)}
                      {!item.hasSource && ' · 未存原图'}
                    </div>
                  </div>

                  <div className="row tight">
                    <button
                      className="btn btn-small waves-effect waves-light"
                      onClick={async () => {
                        const ok = await openRecentProject(item.id)
                        if (ok) onClose()
                      }}
                    >
                      {openIds.has(item.id) ? '切换过去' : '打开'}
                    </button>
                    {confirmId === item.id ? (
                      <button
                        className="btn-flat btn-small waves-effect danger"
                        onClick={() => {
                          deleteRecentProject(item.id)
                          setUsage(estimateUsage())
                          setConfirmId(null)
                        }}
                      >
                        确认删除
                      </button>
                    ) : (
                      <button className="btn-flat btn-small waves-effect" onClick={() => setConfirmId(item.id)}>
                        删除
                      </button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>

        <footer className="modal-foot">
          <Check checked={autosave} onChange={setAutosave}>
            自动保存到本机浏览器（关闭后只保留当前会话）
          </Check>
          <span style={{ flex: 1 }} />
          <span className="tiny muted">存档只在本机</span>
        </footer>
      </div>
    </div>
  )
}
