import { useState } from 'react'
import { getTabSnapshot, useStudio } from '../store/studio.ts'

/**
 * 浏览器式的项目标签栏。
 * 每个标签页是一个独立项目（各自的图、网格、色板、配色结果），
 * 点击切换，右侧 × 关闭，双击名字可以改名。
 */
export function TabBar({ onRequestFile }: { onRequestFile: () => void }) {
  const tabs = useStudio((s) => s.tabs)
  const activeTabId = useStudio((s) => s.activeTabId)
  const source = useStudio((s) => s.source)
  const switchTab = useStudio((s) => s.switchTab)
  const closeTab = useStudio((s) => s.closeTab)
  const newTab = useStudio((s) => s.newTab)
  const renameTab = useStudio((s) => s.renameTab)

  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft] = useState('')

  const commit = () => {
    if (editingId) renameTab(editingId, draft.trim())
    setEditingId(null)
  }

  return (
    <div className="tabstrip">
      <div className="tabstrip-scroll">
        {tabs.map((tab) => {
          const active = tab.id === activeTabId
          const preview = tab.thumb ?? (active ? source?.url : getTabSnapshot(tab.id)?.source?.url)
          return (
            <div
              key={tab.id}
              className={active ? 'tab active' : 'tab'}
              onClick={() => switchTab(tab.id)}
              title={`${tab.name}${active ? '（当前）' : ''}`}
            >
              {preview ? <img className="tab-thumb" src={preview} alt="" /> : <span className="tab-blank" />}

              {editingId === tab.id ? (
                <input
                  className="tab-rename"
                  autoFocus
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onClick={(e) => e.stopPropagation()}
                  onBlur={commit}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') commit()
                    if (e.key === 'Escape') setEditingId(null)
                  }}
                />
              ) : (
                <span
                  className="tab-name"
                  onDoubleClick={(e) => {
                    e.stopPropagation()
                    setEditingId(tab.id)
                    setDraft(tab.name)
                  }}
                >
                  {tab.name}
                </span>
              )}

              <button
                className="tab-close"
                title="关闭标签页"
                onClick={(e) => {
                  e.stopPropagation()
                  closeTab(tab.id)
                }}
              >
                ×
              </button>
            </div>
          )
        })}
      </div>

      <button
        className="tab-new"
        title="新建标签页并打开图片"
        onClick={() => {
          newTab()
          onRequestFile()
        }}
      >
        ＋
      </button>
    </div>
  )
}
