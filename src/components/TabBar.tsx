import { useState } from 'react'
import { getTabSnapshot, useStudio } from '../store/studio.ts'

/**
 * 浏览器式的项目标签栏。
 * 每个标签页是一个独立项目（各自的图、网格、色板、配色结果），
 * 点一下切换，右侧 × 关闭；点当前标签的名字就地改名（双击任意标签也行）。
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

  const startRename = (id: string, name: string) => {
    setEditingId(id)
    setDraft(name)
  }

  return (
    <div className="tabstrip">
      <div className="tabstrip-scroll tabs">
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
                  onFocus={(e) => e.currentTarget.select()}
                  onBlur={commit}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') commit()
                    if (e.key === 'Escape') setEditingId(null)
                  }}
                />
              ) : (
                <span
                  className="tab-name"
                  onClick={(e) => {
                    // 点当前标签的名字 = 改名；点别的标签 = 切过去
                    e.stopPropagation()
                    if (active) startRename(tab.id, tab.name)
                    else switchTab(tab.id)
                  }}
                  onDoubleClick={(e) => {
                    e.stopPropagation()
                    startRename(tab.id, tab.name)
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
                <i className="material-icons sm">close</i>
              </button>
            </div>
          )
        })}
      </div>

      <button
        className="tab-new btn-floating btn-small waves-effect"
        title="新建标签页并打开图片"
        onClick={() => {
          newTab()
          onRequestFile()
        }}
      >
        <i className="material-icons sm">add</i>
      </button>
    </div>
  )
}
