import { useEffect, useMemo, useRef, useState } from 'react'
import { useStudio } from '../store/studio.ts'
import { clampRect, MIN_CROP } from '../core/crop.ts'
import { drawPixmap } from '../core/render.ts'
import type { Rect } from '../core/types.ts'

/** 预览画布的最大显示尺寸（CSS 像素） */
const MAX_W = 760
const MAX_H = 520

type Handle = 'move' | 'nw' | 'ne' | 'sw' | 'se'

/**
 * 上传后的预处理：矩形裁剪，只做这一次（不进存档）。
 * 拖框内平移、拖四角改大小；「跳过裁剪」= 整张用原图。
 */
export function CropDialog() {
  const crop = useStudio((s) => s.crop)
  const applyCrop = useStudio((s) => s.applyCrop)
  const cancelCrop = useStudio((s) => s.cancelCrop)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const boxRef = useRef<HTMLDivElement>(null)

  const img = crop?.pixmap ?? null
  const [rect, setRect] = useState<Rect>(() => ({ x: 0, y: 0, width: 0, height: 0 }))
  const drag = useRef<{ mode: Handle; startX: number; startY: number; start: Rect } | null>(null)

  // 换图时把框重置成整张
  useEffect(() => {
    if (!img) return
    setRect({ x: 0, y: 0, width: img.width, height: img.height })
  }, [img])

  const scale = useMemo(() => {
    if (!img) return 1
    return Math.min(1, MAX_W / img.width, MAX_H / img.height)
  }, [img])

  useEffect(() => {
    if (!img || !canvasRef.current) return
    drawPixmap(canvasRef.current, img, scale, scale < 1)
  }, [img, scale])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') cancelCrop()
      if (e.key === 'Enter') applyCrop(rect)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [applyCrop, cancelCrop, rect])

  if (!crop || !img) return null

  const viewW = Math.max(1, Math.round(img.width * scale))
  const viewH = Math.max(1, Math.round(img.height * scale))

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement
    const handle = target.dataset.handle as Handle | undefined
    if (!handle && !target.closest('.crop-rect')) return
    e.currentTarget.setPointerCapture(e.pointerId)
    drag.current = { mode: handle ?? 'move', startX: e.clientX, startY: e.clientY, start: rect }
  }

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current
    if (!d) return
    const dx = (e.clientX - d.startX) / scale
    const dy = (e.clientY - d.startY) / scale
    const s = d.start
    let next: Rect = s
    if (d.mode === 'move') {
      next = { ...s, x: s.x + dx, y: s.y + dy }
    } else {
      // 拖角：固定对角，另一角跟着走
      const left = d.mode === 'nw' || d.mode === 'sw' ? s.x + dx : s.x
      const top = d.mode === 'nw' || d.mode === 'ne' ? s.y + dy : s.y
      const right = d.mode === 'ne' || d.mode === 'se' ? s.x + s.width + dx : s.x + s.width
      const bottom = d.mode === 'sw' || d.mode === 'se' ? s.y + s.height + dy : s.y + s.height
      next = { x: left, y: top, width: right - left, height: bottom - top }
    }
    // 让宽高至少 MIN_CROP，再夹进图片里
    if (next.width < MIN_CROP) next = { ...next, width: MIN_CROP }
    if (next.height < MIN_CROP) next = { ...next, height: MIN_CROP }
    setRect(clampRect(next, img.width, img.height))
  }

  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    drag.current = null
    try {
      e.currentTarget.releasePointerCapture(e.pointerId)
    } catch {
      /* 已经释放 */
    }
  }

  const cropped = rect.width < img.width || rect.height < img.height
  // 遮罩拆成四块，而不是给裁剪框加 9999px 的 box-shadow ——
  // 那样会把外层 .crop-body 的滚动区域撑到几万像素，四角的手柄被挤到滚动条底下，
  // 拖一小段就抓不住了（尤其是框拉到最大的时候）。
  const rl = rect.x * scale
  const rt = rect.y * scale
  const rw = rect.width * scale
  const rh = rect.height * scale

  return (
    <div className="modal-overlay open" role="presentation">
      <div className="modal open crop-modal" role="dialog" aria-modal="true" aria-label="裁剪图片">
        <header className="modal-head">
          <div>
            <h2>裁剪图片</h2>
            <p className="tiny muted">
              {crop.name} · 原图 {img.width} × {img.height}
            </p>
          </div>
          <span style={{ flex: 1 }} />
          <span className="tiny muted">
            裁剪后 {Math.round(rect.width)} × {Math.round(rect.height)}
          </span>
        </header>

        <div className="modal-content modal-body crop-body">
          <div
            className="crop-stage"
            ref={boxRef}
            style={{ width: viewW, height: viewH }}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
          >
            <canvas ref={canvasRef} />
            <div className="crop-mask" style={{ left: 0, top: 0, right: 0, height: rt }} />
            <div className="crop-mask" style={{ left: 0, top: rt + rh, right: 0, bottom: 0 }} />
            <div className="crop-mask" style={{ left: 0, top: rt, width: rl, height: rh }} />
            <div className="crop-mask" style={{ left: rl + rw, top: rt, right: 0, height: rh }} />
            <div
              className="crop-rect"
              style={{
                left: rl,
                top: rt,
                width: rw,
                height: rh,
              }}
            >
              {(['nw', 'ne', 'sw', 'se'] as const).map((h) => (
                <span key={h} className={`crop-handle ${h}`} data-handle={h} />
              ))}
            </div>
          </div>
        </div>

        <footer className="modal-foot">
          <button className="btn-flat waves-effect" onClick={cancelCrop}>
            取消
          </button>
          <span style={{ flex: 1 }} />
          <button className="btn-flat waves-effect" onClick={() => applyCrop(null)} disabled={cropped}>
            整张使用
          </button>
          <button className="btn waves-effect waves-light" onClick={() => applyCrop(rect)}>
            确认裁剪
          </button>
        </footer>
      </div>
    </div>
  )
}
