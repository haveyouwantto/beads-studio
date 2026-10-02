import { useEffect, useState } from 'react'

const HEX_RE = /^#?([0-9a-fA-F]{6})$/

/**
 * 取色对话框。
 *
 * 为什么不直接用隐藏的 `<input type="color">`：
 * - 浏览器只在「用户激活」的事件里才允许打开系统取色器。右键菜单（contextmenu）
 *   不算用户激活，从那里调 `.click()` 会静默失败 —— 现象就是「取色器打不开」。
 * - 系统取色器拖动时 `onChange` 会连续触发，一不小心就把调色板刷满。
 *
 * 所以这里画一个自己的对话框：在对话框里点那个大的色块才会（由真实点击）唤起系统取色器，
 * 也可以直接填 HEX；只有按「确定」才把颜色交出去，一次只加一个颜色。
 */
export function ColorPickerDialog({
  title,
  initial,
  onCancel,
  onConfirm,
}: {
  title: string
  initial: string
  onCancel: () => void
  onConfirm: (hex: string) => void
}) {
  const [value, setValue] = useState(initial.toUpperCase())
  const [text, setText] = useState(initial.toUpperCase())

  const apply = (hex: string) => {
    const next = hex.toUpperCase()
    setValue(next)
    setText(next)
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel()
      if (e.key === 'Enter') onConfirm(value)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel, onConfirm, value])

  const onTextChange = (raw: string) => {
    setText(raw)
    const m = HEX_RE.exec(raw.trim())
    if (m) setValue(`#${m[1].toUpperCase()}`)
  }

  return (
    <div className="modal-overlay open" onClick={onCancel}>
      <div className="modal open" onClick={(e) => e.stopPropagation()}>
        <header className="modal-head">
          <div>
            <h2>{title}</h2>
          </div>
          <span style={{ flex: 1 }} />
          <button className="btn-flat btn-small waves-effect" onClick={onCancel}>
            取消
          </button>
        </header>

        <div className="modal-content modal-body">
          <div className="row" style={{ gap: 16, alignItems: 'center' }}>
            <input
              type="color"
              className="picker-swatch"
              value={value}
              onChange={(e) => apply(e.target.value)}
              aria-label="打开系统取色器"
            />
            <div style={{ flex: 1, minWidth: 160 }}>
              <div className="field-label">
                <span>HEX</span>
              </div>
              <input
                type="text"
                value={text}
                spellCheck={false}
                onChange={(e) => onTextChange(e.target.value)}
                placeholder="#RRGGBB"
              />
            </div>
          </div>
        </div>

        <footer className="modal-foot">
          <span style={{ flex: 1 }} />
          <button className="btn-flat waves-effect" onClick={onCancel}>
            取消
          </button>
          <button className="btn waves-effect waves-light" onClick={() => onConfirm(value)}>
            确定
          </button>
        </footer>
      </div>
    </div>
  )
}
