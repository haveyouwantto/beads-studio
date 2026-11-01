import { useEffect, useMemo, useRef, useState } from 'react'
import { buildBoardPatternSvg } from '../core/svg.ts'
import { useStudio } from '../store/studio.ts'
import type { Pixmap } from '../core/types.ts'
import { clampZoom, usePinchPan } from './gestures.ts'

const MIN_ZOOM = 0.2
const MAX_ZOOM = 16

/**
 * 全屏图纸预览组件。
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
  const stageRef = useRef<HTMLDivElement>(null)
  // 手势回调里要读到最新的缩放值，state 更新是异步的，所以另存一份
  const zoomRef = useRef(zoom)
  const wakeLock = useRef<WakeLockSentinel | null>(null)

  /**
   * 以指定屏幕点为锚点缩放。
   */
  const zoomTo = (next: number, anchor?: { x: number; y: number }, prevAnchor?: { x: number; y: number }) => {
    const stage = stageRef.current
    const from = zoomRef.current
    const to = clampZoom(next, MIN_ZOOM, MAX_ZOOM)
    if (to === from) return
    const k = to / from
    let d0 = { x: 0, y: 0 }
    let d1 = { x: 0, y: 0 }
    if (stage && anchor) {
      const rect = stage.getBoundingClientRect()
      const cx = rect.left + rect.width / 2
      const cy = rect.top + rect.height / 2
      d1 = { x: anchor.x - cx, y: anchor.y - cy }
      const p = prevAnchor ?? anchor
      d0 = { x: p.x - cx, y: p.y - cy }
    }
    if (d0.x !== d1.x || d0.y !== d1.y || k !== 1) {
      setPan((p) => ({ x: d1.x - k * (d0.x - p.x), y: d1.y - k * (d0.y - p.y) }))
    }
    zoomRef.current = to
    setZoom(to)
  }

  // 单指拖动平移，双指捏合缩放（摆豆子时捏合是最顺手的操作）
  const gesture = usePinchPan({
    onPan: (dx, dy) => setPan((p) => ({ x: p.x + dx, y: p.y + dy })),
    onPinch: (scale, center, previous) => zoomTo(zoomRef.current * scale, center, previous),
  })

  const pattern = useMemo(
    () =>
      buildBoardPatternSvg(pixmap, palette, {
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
        <strong className="fs-title">图纸预览</strong>
        <span className="muted tiny fs-label">{label}</span>
        <span style={{ flex: 1 }} />
        <button className="btn-flat btn-small waves-effect" onClick={() => zoomTo(zoomRef.current / 1.2)}>
          <i className="material-icons sm">remove</i>
        </button>
        <span className="mono tiny" style={{ width: 56, textAlign: 'center' }}>
          {Math.round(zoom * 100)}%
        </span>
        <button className="btn-flat btn-small waves-effect" onClick={() => zoomTo(zoomRef.current * 1.2)}>
          <i className="material-icons sm">add</i>
        </button>
        <button
          className="btn-flat btn-small waves-effect"
          onClick={() => {
            zoomRef.current = 1
            setZoom(1)
            setPan({ x: 0, y: 0 })
          }}
        >
          重置
        </button>
        <button className="btn btn-small waves-effect waves-light" onClick={onClose}>
          退出
        </button>
      </div>

      <div
        ref={stageRef}
        className="fs-canvas"
        onWheel={(e) => zoomTo(zoomRef.current * (e.deltaY > 0 ? 0.9 : 1.1), { x: e.clientX, y: e.clientY })}
        {...gesture}
      >
        <div
          className="pattern-svg"
          style={{
            position: 'absolute',
            left: '50%',
            top: '50%',
            width: pattern.width,
            height: pattern.height,
            transform: `translate(-50%, -50%) translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
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
        拖动平移 · 滚轮或 +/- 缩放 · 屏幕保持常亮
      </div>
    </div>
  )
}
