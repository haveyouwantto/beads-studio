import { useRef } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'

export type Pt = { x: number; y: number }

/**
 * 图纸预览的手势：单指（鼠标左键）平移，双指捏合缩放。
 *
 * 用 React 的 pointer 事件而不是 touch 事件：
 * 一套逻辑同时覆盖鼠标拖动、触控板、触屏，也省掉 touch/mouse 双份代码。
 * 元素上必须声明 touch-action: none，否则浏览器会把捏合当成页面缩放手势。
 */
export function usePinchPan(handlers: {
  /** 平移增量，单位是屏幕像素 */
  onPan: (dx: number, dy: number) => void
  /** 捏合倍数（相对上一次事件）、当前两指中点、上一次的两指中点 */
  onPinch: (scale: number, center: Pt, previous: Pt) => void
}) {
  const latest = useRef(handlers)
  latest.current = handlers

  const state = useRef({
    pointers: new Map<number, Pt>(),
    lastDist: 0,
    lastMid: { x: 0, y: 0 } as Pt,
  })

  const syncPair = () => {
    const s = state.current
    const pair = [...s.pointers.values()].slice(0, 2)
    if (pair.length < 2) {
      s.lastDist = 0
      return
    }
    s.lastDist = Math.hypot(pair[0].x - pair[1].x, pair[0].y - pair[1].y)
    s.lastMid = { x: (pair[0].x + pair[1].x) / 2, y: (pair[0].y + pair[1].y) / 2 }
  }

  const onPointerDown = (e: ReactPointerEvent<HTMLElement>) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return
    const s = state.current
    s.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY })
    if (s.pointers.size >= 2) syncPair()
    try {
      e.currentTarget.setPointerCapture(e.pointerId)
    } catch {
      // 某些环境不支持捕获，退化成普通拖动
    }
  }

  const onPointerMove = (e: ReactPointerEvent<HTMLElement>) => {
    const s = state.current
    const prev = s.pointers.get(e.pointerId)
    if (!prev) return
    const next = { x: e.clientX, y: e.clientY }
    s.pointers.set(e.pointerId, next)

    if (s.pointers.size >= 2) {
      const pair = [...s.pointers.values()].slice(0, 2)
      const dist = Math.hypot(pair[0].x - pair[1].x, pair[0].y - pair[1].y)
      const mid = { x: (pair[0].x + pair[1].x) / 2, y: (pair[0].y + pair[1].y) / 2 }
      if (s.lastDist > 0 && dist > 0) {
        // 中点位移交给 onPinch 一起算：缩放锚点本身就是中点，
        // 两指整体平移是它的特例（scale = 1）
        latest.current.onPinch(dist / s.lastDist, mid, s.lastMid)
      }
      s.lastDist = dist
      s.lastMid = mid
      return
    }

    latest.current.onPan(next.x - prev.x, next.y - prev.y)
  }

  const onPointerUp = (e: ReactPointerEvent<HTMLElement>) => {
    const s = state.current
    s.pointers.delete(e.pointerId)
    if (s.pointers.size < 2) s.lastDist = 0
    try {
      e.currentTarget.releasePointerCapture(e.pointerId)
    } catch {
      // 已经不在捕获状态，忽略
    }
  }

  return {
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onPointerCancel: onPointerUp,
  }
}

/** 把缩放值夹在允许区间内 */
export function clampZoom(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}
