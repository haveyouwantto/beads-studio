import { useEffect } from 'react'

export interface DrawerItem {
  icon: string
  label: string
  badge?: number
  disabled?: boolean
  onClick: () => void
}

/**
 * 手机上的侧边栏：顶部工具栏在窄屏放不下，收进抽屉里选。
 * 遮罩点击 / Esc / 选中任一项都关闭。
 */
export function MenuDrawer({ items, onClose }: { items: DrawerItem[]; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <>
      <div className="drawer-scrim" onClick={onClose} />
      <aside className="drawer" role="navigation">
        <div className="drawer-head">
          <span className="brand-mark">
            <i className="material-icons sm">blur_on</i>
          </span>
          <span className="drawer-title">Beads Studio</span>
        </div>
        <ul className="drawer-list">
          {items.map((item) => (
            <li key={item.label}>
              <button
                className="drawer-item waves-effect"
                disabled={item.disabled}
                onClick={() => {
                  item.onClick()
                  onClose()
                }}
              >
                <i className="material-icons">{item.icon}</i>
                <span className="drawer-label">{item.label}</span>
                {item.badge ? <span className="pill">{item.badge}</span> : null}
              </button>
            </li>
          ))}
        </ul>
      </aside>
    </>
  )
}
