import { useEffect, useState } from 'react'

const HEX_RE = /^#?([0-9a-fA-F]{6})$/

/**
 * 颜色拾取与输入对话框。
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
