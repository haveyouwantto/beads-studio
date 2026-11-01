import type { ReactNode } from 'react'
import { useEffect } from 'react'
import { hexToRgb, idealTextColor } from '../core/color.ts'

/**
 * 通用色块组件。
 *
 * size:
 * - md: 默认，支持色号与 HEX
 * - dense: 色板用量紧凑网格
 * - chip: 调色板小方块
 * - dot: 用料清单/方案预览小圆点
 */
export function Swatch({
  hex,
  code,
  hexLabel,
  count,
  title,
  lock = false,
  selected = false,
  dimmed = false,
  transparent = false,
  add = false,
  size = 'md',
  onClick,
  onContextMenu,
}: {
  hex?: string
  code?: string
  hexLabel?: string
  count?: number
  title?: string
  lock?: boolean
  selected?: boolean
  dimmed?: boolean
  /** 透明格样式 */
  transparent?: boolean
  /** 添加按钮样式 */
  add?: boolean
  size?: 'md' | 'dense' | 'chip' | 'dot'
  onClick?: () => void
  onContextMenu?: (e: React.MouseEvent) => void
}) {
  const cls = ['swatch', size]
  if (dimmed) cls.push('dimmed')
  if (selected) cls.push('on')
  if (transparent) cls.push('transparent')
  if (add) cls.push('add')

  // 根据背景色动态匹配前景色
  const style = add || transparent ? undefined : { background: hex, color: idealTextColor(hexToRgb(hex ?? '#000000')) }
  const Tag = onClick || onContextMenu ? 'button' : 'div'

  return (
    <Tag
      type={Tag === 'button' ? 'button' : undefined}
      className={cls.join(' ')}
      style={style}
      title={title}
      aria-label={title ?? code}
      onClick={onClick}
      onContextMenu={onContextMenu}
    >
      {selected && !add && (
        <span className="pick">
          <i className="material-icons sm">check</i>
        </span>
      )}
      {lock && (
        <span className="lock">
          <i className="material-icons sm">lock</i>
        </span>
      )}
      {count !== undefined && <span className="count">{count}</span>}
      {add && <i className="material-icons sm">add</i>}
      {code && <div className="code">{code}</div>}
      {hexLabel && <div className="hex">{hexLabel}</div>}
    </Tag>
  )
}

/**
 * 涟漪动画：挂载在 document 实现全局事件委托。
 */
export function useMaterialRipple(): void {
  useEffect(() => {
    const selector = '.btn, .tab, .rail-step, .tab-new, .tab-close, button.swatch, .segmented button'

    const onPointerDown = (e: PointerEvent) => {
      if (e.button !== 0) return
      const target = e.target as Element | null
      const host = target?.closest?.(selector) as HTMLElement | null
      if (!host || host.hasAttribute('disabled')) return
      if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return

      const rect = host.getBoundingClientRect()
      // 计算涟漪范围
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
