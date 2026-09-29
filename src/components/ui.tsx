import type { ReactNode } from 'react'

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
    <section className="panel">
      {(title || actions) && (
        <header className="panel-head">
          {title}
          {hint && <span className="hint">{hint}</span>}
          <span className="grow" />
          {actions}
        </header>
      )}
      <div className={tight ? 'panel-body tight' : 'panel-body'}>{children}</div>
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
  return (
    <div className="segmented">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          title={o.title}
          className={o.value === value ? 'active' : ''}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
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
  const icon = kind === 'error' ? '⛔' : kind === 'warn' ? '⚠️' : 'ℹ️'
  return (
    <div className={`notice ${kind}`}>
      <span>{icon}</span>
      <div>{children}</div>
    </div>
  )
}

export function Empty({ icon = '🖼️', title, children }: { icon?: string; title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <div>
        <div className="big">{icon}</div>
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
