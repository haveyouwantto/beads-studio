import type { ReactNode } from 'react'
import { useEffect } from 'react'

/**
 * MD 涟漪：在点击位置扩散一圈。
 *
 * 用事件委托挂在 document 上，这样动态新增的按钮（标签栏、弹窗里的）也自动生效，
 * 不用给每个按钮单独接线。和 Materialize 的 Waves 思路一致，但不依赖它的 JS
 * —— Materialize 的 JS 组件会改 DOM 结构，和 React 受控节点冲突。
 */
export function useMaterialRipple(): void {
  useEffect(() => {
    const selector = '.btn, .tab, .rail-step, .tab-new, .tab-close, .swatch, .candidate, .segmented button'

    const onPointerDown = (e: PointerEvent) => {
      if (e.button !== 0) return
      const target = e.target as Element | null
      const host = target?.closest?.(selector) as HTMLElement | null
      if (!host || host.hasAttribute('disabled')) return
      if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return

      const rect = host.getBoundingClientRect()
      // 半径取到最远角，保证涟漪铺满整个控件
      const radius = Math.hypot(Math.max(e.clientX - rect.left, rect.right - e.clientX), Math.max(e.clientY - rect.top, rect.bottom - e.clientY))
      const ripple = document.createElement('span')
      ripple.className = 'md-ripple'
      ripple.style.width = `${radius * 2}px`
      ripple.style.height = `${radius * 2}px`
      ripple.style.left = `${e.clientX - rect.left - radius}px`
      ripple.style.top = `${e.clientY - rect.top - radius}px`
      host.appendChild(ripple)
      ripple.addEventListener('animationend', () => ripple.remove(), { once: true })
    }

    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [])
}

export function Panel({
  title,
  hint,
  actions,
  children,
  tight,
}: {
  title?: ReactNode
  hint?: ReactNode
  actions?: ReactNode
  children: ReactNode
  tight?: boolean
}) {
  return (
    <section className="card panel">
      {(title || actions) && (
        <header className="panel-head card-title">
          {title}
          {hint && <span className="hint">{hint}</span>}
          <span className="grow" />
          {actions}
        </header>
      )}
      <div className={tight ? 'card-content panel-body tight' : 'card-content panel-body'}>{children}</div>
    </section>
  )
}

export function Field({
  label,
  value,
  children,
  hint,
}: {
  label: ReactNode
  value?: ReactNode
  children: ReactNode
  hint?: ReactNode
}) {
  return (
    <div className="field">
      <div className="field-label">
        <span>{label}</span>
        {value !== undefined && <b>{value}</b>}
      </div>
      {children}
      {hint && <span className="tiny muted">{hint}</span>}
    </div>
  )
}

export function Stat({ k, v, small }: { k: ReactNode; v: ReactNode; small?: boolean }) {
  return (
    <div className="stat">
      <div className="k">{k}</div>
      <div className={small ? 'v sm' : 'v'}>{v}</div>
    </div>
  )
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T
  options: { value: T; label: string; title?: string }[]
  onChange: (v: T) => void
}) {
  const index = options.findIndex((o) => o.value === value)
  return (
    // Materialize tabs：ul.tabs > li.tab > a，激活项加 .active
    <ul className="tabs tabs-fixed-width segmented">
      {options.map((o) => (
        <li key={o.value} className="tab">
          <a
            href="#!"
            title={o.title}
            className={o.value === value ? 'active waves-effect' : 'waves-effect'}
            onClick={(e) => {
              e.preventDefault()
              onChange(o.value)
            }}
          >
            {o.label}
          </a>
        </li>
      ))}
      {/* Materialize 的移动下划线由它的 JS 注入，这里由 React 按等分宽度直接定位 */}
      {index >= 0 && (
        <li
          className="indicator"
          style={{ left: `${(index / options.length) * 100}%`, width: `${100 / options.length}%` }}
        />
      )}
    </ul>
  )
}

export function Check({
  checked,
  onChange,
  children,
}: {
  checked: boolean
  onChange: (v: boolean) => void
  children: ReactNode
}) {
  return (
    <label className="check">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>{children}</span>
    </label>
  )
}

export function Notice({
  kind = 'info',
  children,
}: {
  kind?: 'info' | 'warn' | 'error'
  children: ReactNode
}) {
  const icon = kind === 'error' ? 'error' : kind === 'warn' ? 'warning' : 'info'
  return (
    <div className={`card-panel notice ${kind}`}>
      <i className="material-icons">{icon}</i>
      <div>{children}</div>
    </div>
  )
}

/** icon 传 Material Icons 的名字，例如 image / palette / grid_on */
export function Empty({ icon = 'image', title, children }: { icon?: string; title: string; children?: ReactNode }) {
  return (
    <div className="card-panel empty">
      <div>
        <i className="material-icons lg empty-icon">{icon}</i>
        <div style={{ fontWeight: 600, color: 'var(--text)' }}>{title}</div>
        {children && <div style={{ marginTop: 6, maxWidth: 460 }}>{children}</div>}
      </div>
    </div>
  )
}

export function NumberField({
  label,
  value,
  min,
  max,
  step,
  onChange,
  hint,
  suffix,
}: {
  label: ReactNode
  value: number
  min?: number
  max?: number
  step?: number
  onChange: (v: number) => void
  hint?: ReactNode
  suffix?: string
}) {
  return (
    <Field label={label} value={suffix ? `${value} ${suffix}` : value} hint={hint}>
      <input
        type="number"
        value={value}
        min={min}
        max={max}
        step={step}
        onChange={(e) => {
          const n = Number(e.target.value)
          if (Number.isFinite(n)) onChange(n)
        }}
      />
    </Field>
  )
}
