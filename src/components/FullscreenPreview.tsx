import { useEffect, useMemo, useRef, useState } from 'react'
import { buildPatternSvg } from '../core/svg.ts'
import { useStudio } from '../store/studio.ts'
import type { Pixmap } from '../core/types.ts'

/**
 * 全屏看图：拼豆时要对着屏幕一颗颗摆，需要放大 + 拖动，并且屏幕别自动熄灭。
 * 图纸是 SVG，缩放只是改 CSS 尺寸，不会像 canvas 那样放大就糊。
 */
export function FullscreenPreview({
  pixmap,
  label,
  onClose,
}: {
  pixmap: Pixmap
  label: string
  onClose: () => void
}) {
  const palette = useStudio((s) => s.palette)
  const renderOptions = useStudio((s) => s.renderOptions)
  const [zoom, setZoom] = useState(1)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  // 拖动状态放 ref：用 state 会因为更新时机和 pointercancel 漏掉，拖两下就断
  const drag = useRef({ active: false, x: 0, y: 0 })
  const wakeLock = useRef<WakeLockSentinel | null>(null)

  const endDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    drag.current.active = false
    try {
      e.currentTarget.releasePointerCapture(e.pointerId)
    } catch {
      // 指针已经不在捕获状态，忽略
    }
  }

  const pattern = useMemo(
    () =>
      buildPatternSvg(pixmap, palette, {
        ...renderOptions,
        rulers: true,
        grid: true,
        background: renderOptions.background,
      }),
    [pixmap, palette, renderOptions],
  )

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)

    let cancelled = false
    const request = async () => {
      try {
        if ('wakeLock' in navigator) {
          const sentinel = await navigator.wakeLock.request('screen')
          if (cancelled) void sentinel.release()
          else wakeLock.current = sentinel
        }
      } catch {
        /* Wake Lock 不可用时静默降级 */
      }
    }
    void request()

    return () => {
      cancelled = true
      window.removeEventListener('keydown', onKey)
      void wakeLock.current?.release().catch(() => undefined)
      wakeLock.current = null
    }
  }, [onClose])

  return (
    <div className="fullscreen-stage">
      <div className="fs-bar">
        <strong>图纸预览</strong>
        <span className="muted tiny">{label}</span>
        <span style={{ flex: 1 }} />
        <button className="btn-flat btn-small waves-effect" onClick={() => setZoom((z) => Math.max(0.2, z / 1.2))}>
          <i className="material-icons sm">remove</i>
        </button>
        <span className="mono tiny" style={{ width: 56, textAlign: 'center' }}>
          {Math.round(zoom * 100)}%
        </span>
        <button className="btn-flat btn-small waves-effect" onClick={() => setZoom((z) => Math.min(16, z * 1.2))}>
          <i className="material-icons sm">add</i>
        </button>
        <button
          className="btn-flat btn-small waves-effect"
          onClick={() => {
            setZoom(1)
            setPan({ x: 0, y: 0 })
          }}
        >
          重置
        </button>
        <button className="btn btn-small waves-effect waves-light" onClick={onClose}>
          退出 (Esc)
        </button>
      </div>

      <div
        className="fs-canvas"
        onWheel={(e) => {
          setZoom((z) => Math.min(16, Math.max(0.2, z * (e.deltaY > 0 ? 0.9 : 1.1))))
        }}
        onPointerDown={(e) => {
          if (e.pointerType === 'mouse' && e.button !== 0) return
          drag.current = { active: true, x: e.clientX, y: e.clientY }
          try {
            e.currentTarget.setPointerCapture(e.pointerId)
          } catch {
            // 某些环境不支持捕获，退化成普通拖动
          }
        }}
        onPointerMove={(e) => {
          if (!drag.current.active) return
          const dx = e.clientX - drag.current.x
          const dy = e.clientY - drag.current.y
          drag.current.x = e.clientX
          drag.current.y = e.clientY
          setPan((p) => ({ x: p.x + dx, y: p.y + dy }))
        }}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        <div
          className="pattern-svg"
          style={{
            width: pattern.width * zoom,
            height: pattern.height * zoom,
            transform: `translate(${pan.x}px, ${pan.y}px)`,
            boxShadow: '0 20px 60px rgba(0, 0, 0, 0.6)',
          }}
          dangerouslySetInnerHTML={{ __html: pattern.svg }}
        />
      </div>

      <div
        style={{
          padding: '8px 16px',
          background: 'var(--panel)',
          borderTop: '1px solid var(--border)',
          fontSize: 11.5,
          color: 'var(--muted-2)',
        }}
      >
        滚轮缩放 · 拖动平移 · 屏幕保持常亮
      </div>
    </div>
  )
}
