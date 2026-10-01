import { useEffect, useMemo, useRef, useState } from 'react'
import { buildPatternSvg } from '../core/svg.ts'
import { useStudio } from '../store/studio.ts'
import type { Pixmap } from '../core/types.ts'
import { clampZoom, usePinchPan } from './gestures.ts'

const MIN_ZOOM = 0.2
const MAX_ZOOM = 16

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
  const stageRef = useRef<HTMLDivElement>(null)
  // 手势回调里要读到最新的缩放值，state 更新是异步的，所以另存一份
  const zoomRef = useRef(zoom)
  const wakeLock = useRef<WakeLockSentinel | null>(null)

  /**
   * 以某个屏幕点为锚缩放：缩放前后，那个点下面的豆子待在原地。
   *
   * 内容在舞台里居中，再叠加 pan 位移，于是：
   *   视口点 = 舞台中心 + pan + zoom × (内容坐标 − 内容中心)
   * 令锚点下的内容坐标不变，解出 pan' = d1 − k × (d0 − pan)，d = 锚点 − 舞台中心。
   * 不传锚点（加减按钮、滚轮）时 d0 = d1 = 0，退化成「以视口中心为基准」，
   * 也就是 pan' = pan × k。捏合时 d0/d1 分别是前后两指中点，顺带处理了双指平移。
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
          退出<span className="kbd-hint"> (Esc)</span>
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
            // 先缩放到画布中心，再按 pan 平移，最后把自身中心摆到舞台中心。
            // 这样「内容中心」永远等于 舞台中心 + pan，缩放锚点的公式才成立
            // （靠 grid 居中在内容比容器大时会被夹到起始边，锚点就偏了）。
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
