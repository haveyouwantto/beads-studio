import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useStudio, type EditTool } from '../store/studio.ts'
import { Empty, Notice, Panel, Segmented, Stat, Swatch } from './ui.tsx'
import { ColorPickerDialog } from './ColorPickerDialog.tsx'
import { panScrollable } from './gestures.ts'
import { STAGE_META } from './stages.ts'
import {
  clusterColors,
  colorUsage,
  countIgnored,
  EDIT_PRESETS,
  floodFill,
  historyLimit,
  IGNORED_ALPHA,
  readCell,
  writeCell,
} from '../core/edit.ts'
import type { Pixmap } from '../core/types.ts'

/** 编辑区里的一格画多大（屏幕像素），太大就看不下整张图，太小点不准 */
const MIN_CELL = 4
const MAX_CELL = 40
/** 打开时先按容器宽度适应，但别超过这个值（小图在宽屏上不至于一格顶满屏） */
const FIT_MAX_CELL = 24

/** 工具按钮：图标用 Material Icons（和界面其它地方一致） */
const TOOLS: { id: EditTool; icon: string; label: string }[] = [
  { id: 'paint', icon: 'brush', label: '画笔' },
  { id: 'fill', icon: 'format_color_fill', label: '填充（油漆桶）' },
  { id: 'pick', icon: 'colorize', label: '吸管（取色并加入调色板）' },
  { id: 'pan', icon: 'pan_tool', label: '移动（拖动滚动画布）' },
]

/**
 * 像素编辑：一个够用的迷你画板。
 *
 * 只做三件事：拿预设色涂格子、吸管取色、把格子涂成「透明」（= 忽略）。
 * 忽略的格子后面既不参与配色优化，也不出图、不计数。
 */
export function EditStep() {
  const grid = useStudio((s) => s.grid)
  const applyGridEdit = useStudio((s) => s.applyGridEdit)
  const goNext = useStudio((s) => s.goNext)
  const goPrev = useStudio((s) => s.goPrev)
  const buildGrid = useStudio((s) => s.buildGrid)

  const canvasRef = useRef<HTMLCanvasElement>(null)
  const hostRef = useRef<HTMLDivElement>(null)
  // 编辑期间直接改这块缓冲，松手才写回 store（否则每拖一个点就整块复制一次）
  const draft = useRef<Uint8ClampedArray | null>(null)
  const undoStack = useRef<Uint8ClampedArray[]>([])
  const redoStack = useRef<Uint8ClampedArray[]>([])
  /** 这一笔落笔前的缓冲：提交时才知道有没有真的改动 */
  const strokeStart = useRef<Uint8ClampedArray | null>(null)
  /** 自己提交出去的那个网格对象：它引起的 grid 变化不算「换了网格」 */
  const ownGrid = useRef<Pixmap | null>(null)
  const painting = useRef(false)
  const lastCell = useRef<{ x: number; y: number } | null>(null)
  /** 现在按着的手指；双指按下就是「要滚动」，不再画 */
  const pointers = useRef(new Map<number, { x: number; y: number }>())
  /** 平移中：上一次的手指中点（屏幕坐标） */
  const panFrom = useRef<{ x: number; y: number } | null>(null)

  const color = useStudio((s) => s.editColor)
  const setColor = useStudio((s) => s.setEditColor)
  const tool = useStudio((s) => s.editTool)
  const setTool = useStudio((s) => s.setEditTool)
  const fillMode = useStudio((s) => s.editFillMode)
  const setFillMode = useStudio((s) => s.setEditFillMode)
  const swatches = useStudio((s) => s.editSwatches)
  const addSwatch = useStudio((s) => s.addEditSwatch)
  const [cell, setCell] = useState(16)
  const [version, setVersion] = useState(0)

  // 取色对话框：点「+」或右键某个色块时打开，初值就是那个颜色
  const [picker, setPicker] = useState<{ title: string; initial: string } | null>(null)
  const openPicker = useCallback((from: string | null) => {
    setPicker({ title: '选择颜色', initial: from ?? color ?? '#000000' })
  }, [color])

  const onPickedColor = (hex: string) => {
    addSwatch(hex) // 一次只加一个（在对话框里按「确定」时才走到这里）
    setColor(hex)
  }

  // 网格换了（重新规范化 / 换图 / 切标签页）才重置草稿与历史。
  // 注意每落一笔也会往 store 提交一个新网格，那种变化必须保留历史，
  // 否则撤销栈刚记上就被清掉，两个按钮永远点不动。
  useEffect(() => {
    if (grid && grid === ownGrid.current) return
    draft.current = grid ? new Uint8ClampedArray(grid.data) : null
    undoStack.current = []
    redoStack.current = []
    strokeStart.current = null
    setVersion((v) => v + 1)
  }, [grid])

  const commit = useCallback(() => {
    if (!grid || !draft.current) return
    const before = strokeStart.current
    strokeStart.current = null
    if (before) {
      // 一笔下去什么都没改就别记历史，不然「撤销」第一下点了没反应
      let changed = before.length !== draft.current.length
      for (let i = 0; !changed && i < before.length; i++) if (before[i] !== draft.current[i]) changed = true
      if (!changed) return
      undoStack.current.push(before)
      const limit = historyLimit(grid)
      if (undoStack.current.length > limit) undoStack.current.shift()
      redoStack.current = []
    }
    const next: Pixmap = { width: grid.width, height: grid.height, data: new Uint8ClampedArray(draft.current) }
    ownGrid.current = next
    applyGridEdit(next)
  }, [grid, applyGridEdit])

  const draw = useCallback(() => {
    const canvas = canvasRef.current
    const data = draft.current
    if (!canvas || !grid || !data) return
    const s = cell
    canvas.width = grid.width * s
    canvas.height = grid.height * s
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.clearRect(0, 0, canvas.width, canvas.height)

    for (let y = 0; y < grid.height; y++) {
      for (let x = 0; x < grid.width; x++) {
        const i = (y * grid.width + x) * 4
        const ignored = data[i + 3] < IGNORED_ALPHA
        if (ignored) {
          // 忽略的格子画成棋盘格，一眼能和「白色」区分开
          const q = Math.max(2, Math.floor(s / 2))
          for (let dy = 0; dy < s; dy += q) {
            for (let dx = 0; dx < s; dx += q) {
              const dark = ((Math.floor(dx / q) + Math.floor(dy / q)) % 2) === 0
              ctx.fillStyle = dark ? '#3a3a3a' : '#4a4a4a'
              ctx.fillRect(x * s + dx, y * s + dy, q, q)
            }
          }
          continue
        }
        ctx.fillStyle = `rgb(${data[i]},${data[i + 1]},${data[i + 2]})`
        ctx.fillRect(x * s, y * s, s, s)
      }
    }

    // 网格线：每格细线，每 10 格粗线（和图纸一致）
    if (s >= 5) {
      ctx.strokeStyle = 'rgba(255,255,255,0.18)'
      ctx.lineWidth = 1
      ctx.beginPath()
      for (let x = 0; x <= grid.width; x++) {
        ctx.moveTo(x * s + 0.5, 0)
        ctx.lineTo(x * s + 0.5, canvas.height)
      }
      for (let y = 0; y <= grid.height; y++) {
        ctx.moveTo(0, y * s + 0.5)
        ctx.lineTo(canvas.width, y * s + 0.5)
      }
      ctx.stroke()
      ctx.strokeStyle = 'rgba(255,255,255,0.45)'
      ctx.beginPath()
      for (let x = 0; x <= grid.width; x += 10) {
        ctx.moveTo(x * s + 0.5, 0)
        ctx.lineTo(x * s + 0.5, canvas.height)
      }
      for (let y = 0; y <= grid.height; y += 10) {
        ctx.moveTo(0, y * s + 0.5)
        ctx.lineTo(canvas.width, y * s + 0.5)
      }
      ctx.stroke()
    }
  }, [cell, grid])

  useEffect(() => {
    draw()
    // version 变化表示草稿被替换过（撤销/重做/新网格），需要重画
  }, [draw, version])

  // 只在「网格尺寸」变化时重新按容器宽度算一次格子大小。
  // 不能依赖 grid 对象本身 —— 每落一笔都会提交一个新网格，那样会不停覆盖手动缩放。
  useEffect(() => {
    if (!grid || !hostRef.current) return
    const width = hostRef.current.clientWidth - 28
    const fit = Math.floor(width / grid.width)
    setCell(Math.max(MIN_CELL, Math.min(FIT_MAX_CELL, fit || MIN_CELL)))
  }, [grid?.width, grid?.height])

  const pushHistory = () => {
    if (!draft.current) return
    strokeStart.current = new Uint8ClampedArray(draft.current)
  }

  const undo = () => {
    const prev = undoStack.current.pop()
    if (!prev || !draft.current) return
    redoStack.current.push(new Uint8ClampedArray(draft.current))
    draft.current = prev
    setVersion((v) => v + 1)
    commit()
  }

  const redo = () => {
    const next = redoStack.current.pop()
    if (!next || !draft.current) return
    undoStack.current.push(new Uint8ClampedArray(draft.current))
    draft.current = next
    setVersion((v) => v + 1)
    commit()
  }

  const cellAt = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current
    if (!canvas || !grid) return null
    const rect = canvas.getBoundingClientRect()
    const x = Math.floor(((e.clientX - rect.left) / rect.width) * grid.width)
    const y = Math.floor(((e.clientY - rect.top) / rect.height) * grid.height)
    if (x < 0 || y < 0 || x >= grid.width || y >= grid.height) return null
    return { x, y }
  }

  const paintAt = (x: number, y: number) => {
    if (!draft.current || !grid) return
    writeCell(draft.current, grid.width, x, y, color)
    draw()
  }

  /** 手指中点：平移按它算位移 */
  const pointerMid = () => {
    const list = [...pointers.current.values()]
    if (!list.length) return null
    return {
      x: list.reduce((a, p) => a + p.x, 0) / list.length,
      y: list.reduce((a, p) => a + p.y, 0) / list.length,
    }
  }

  /** 手指落下第二根 = 想滚动：把这一笔已经涂的还原掉，别留孤零零一个点 */
  const cancelStroke = () => {
    if (strokeStart.current && draft.current) {
      draft.current.set(strokeStart.current)
      draw()
      setVersion((v) => v + 1)
    }
    strokeStart.current = null
    painting.current = false
    lastCell.current = null
  }

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    try {
      e.currentTarget.setPointerCapture(e.pointerId)
    } catch {
      /* 不支持捕获就退化成普通拖动 */
    }

    if (pointers.current.size >= 2) {
      cancelStroke()
      panFrom.current = pointerMid()
      return
    }
    if (tool === 'pan') {
      panFrom.current = pointerMid()
      return
    }

    const at = cellAt(e)
    if (!at || !grid) return
    if (tool === 'pick') {
      const picked = draft.current ? readCell({ width: grid.width, height: grid.height, data: draft.current }, at.x, at.y) : null
      // 取色 = 把颜色加进「新增色」并设为当前色；工具不动
      if (picked) addSwatch(picked)
      setColor(picked)
      return
    }
    pushHistory()
    if (tool === 'fill') {
      if (draft.current) {
        floodFill(draft.current, grid.width, grid.height, at.x, at.y, color, {
          mode: fillMode,
          clusters: stats?.clusters,
        })
      }
      draw()
      commit()
      return
    }
    painting.current = true
    lastCell.current = at
    paintAt(at.x, at.y)
  }

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (pointers.current.has(e.pointerId)) pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })

    // 平移中（双指，或选了「移动」工具）：按中点位移滚动
    if (panFrom.current) {
      const mid = pointerMid()
      if (mid) {
        panScrollable(hostRef.current, panFrom.current.x - mid.x, panFrom.current.y - mid.y)
        panFrom.current = mid
      }
      return
    }

    if (!painting.current || tool !== 'paint') return
    const at = cellAt(e)
    if (!at) return
    const last = lastCell.current
    if (last && (last.x !== at.x || last.y !== at.y)) {
      // 两点之间补线，快速拖动才不会漏格
      const steps = Math.max(Math.abs(at.x - last.x), Math.abs(at.y - last.y))
      for (let i = 1; i <= steps; i++) {
        paintAt(Math.round(last.x + ((at.x - last.x) * i) / steps), Math.round(last.y + ((at.y - last.y) * i) / steps))
      }
    } else {
      paintAt(at.x, at.y)
    }
    lastCell.current = at
  }

  const onPointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    try {
      e.currentTarget.releasePointerCapture(e.pointerId)
    } catch {
      /* 已经释放 */
    }

    pointers.current.delete(e.pointerId)
    // 手指还有剩就继续平移（换手指时不跳），全松开了才结束
    panFrom.current = pointers.current.size ? pointerMid() : null

    if (!painting.current) return
    painting.current = false
    lastCell.current = null
    commit()
  }

  const stats = useMemo(() => {
    if (!grid) return null
    const img: Pixmap = draft.current
      ? { width: grid.width, height: grid.height, data: draft.current }
      : grid
    const usage = colorUsage(img)
    return { ignored: countIgnored(img), usage, clusters: clusterColors(img, 24) }
    // version 变化时重算
  }, [grid, version])

  if (!grid) {
    return (
      <div className="columns">
        <div className="stage-head">
          <div>
            <h1>
              <i className="material-icons">{STAGE_META.edit.icon}</i>
              {STAGE_META.edit.label}
            </h1>
          </div>
        </div>
        <Empty icon="brush" title="还没有可编辑的网格">
          <div style={{ marginTop: 12 }}>
            <button className="btn waves-effect waves-light" onClick={goPrev}>
              <i className="material-icons sm">arrow_back</i>
              回到规范化
            </button>
          </div>
        </Empty>
      </div>
    )
  }

  return (
    <div className="columns viewer">
      <div>
        <div className="stage-head">
          <div>
            <h1>
              <i className="material-icons">{STAGE_META.edit.icon}</i>
              {STAGE_META.edit.label}
            </h1>
          </div>
          <span className="grow" />
          <button className="btn-flat btn-small waves-effect" onClick={goPrev}>
            <i className="material-icons sm">arrow_back</i>
            规范化
          </button>
        </div>

        <Panel
          title="像素画板"
          hint={`${grid.width} × ${grid.height} 格`}
          actions={
            <>
              <button
                className="btn-flat btn-small icon-only waves-effect"
                onClick={undo}
                disabled={!undoStack.current.length}
                title="撤销"
                aria-label="撤销"
              >
                <i className="material-icons sm">undo</i>
              </button>
              <button
                className="btn-flat btn-small icon-only waves-effect"
                onClick={redo}
                disabled={!redoStack.current.length}
                title="重做"
                aria-label="重做"
              >
                <i className="material-icons sm">redo</i>
              </button>
              <button
                className="btn-flat btn-small icon-only waves-effect"
                onClick={buildGrid}
                title="丢弃修改，按规范化重新生成"
                aria-label="丢弃修改"
              >
                <i className="material-icons sm">restart_alt</i>
              </button>
            </>
          }
          tight
        >
          <div className="canvas-wrap edit-host" ref={hostRef}>
            <canvas
              ref={canvasRef}
              className={tool === 'pan' ? 'panning' : tool === 'pick' ? 'picking' : ''}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerUp}
            />
          </div>

          <div className="row" style={{ marginTop: 10, alignItems: 'center' }}>
            <div className="tool-row">
              {TOOLS.map((t) => (
                <button
                  key={t.id}
                  className={tool === t.id ? 'btn-flat btn-small icon-only waves-effect on' : 'btn-flat btn-small icon-only waves-effect'}
                  onClick={() => setTool(t.id)}
                  title={t.label}
                  aria-label={t.label}
                >
                  <i className="material-icons sm">{t.icon}</i>
                </button>
              ))}
            </div>
            <span className="tiny muted">格子</span>
            <input
              type="range"
              min={MIN_CELL}
              max={MAX_CELL}
              value={cell}
              onChange={(e) => setCell(Number(e.target.value))}
              style={{ flex: 1, minWidth: 100 }}
            />
          </div>

          {tool === 'fill' && (
            <div className="field" style={{ marginTop: 10 }}>
              <div className="field-label">
                <span>填充方式</span>
              </div>
              <Segmented
                value={fillMode}
                onChange={setFillMode}
                options={[
                  { value: 'color', label: '按颜色', title: '只填颜色一模一样的相连格子' },
                  { value: 'cluster', label: '按聚类', title: '同色系（抗锯齿边、轻微渐变）当成一块' },
                ]}
              />
            </div>
          )}

          <div className="field" style={{ marginTop: 12 }}>
            <div className="field-label">
              <span>预设</span>
            </div>
            <div className="swatch-row">
              {EDIT_PRESETS.map((p) => {
                // H01 现实中是透明塑料：这一格就是「透明（忽略）」
                // 选中框跟着「当前色」走，和左边选了哪个工具无关
                const active = p.transparent ? color === null : color === p.hex
                return (
                  <Swatch
                    key={p.code}
                    size="chip"
                    hex={p.transparent ? undefined : p.hex}
                    transparent={p.transparent}
                    selected={active}
                    title={p.transparent ? `${p.code} 透明（忽略）` : `${p.code} · ${p.hex}`}
                    onClick={() => {
                      setColor(p.transparent ? null : p.hex)
                    }}
                    onContextMenu={
                      p.transparent
                        ? undefined
                        : (e) => {
                            e.preventDefault()
                            openPicker(p.hex)
                          }
                    }
                  />
                )
              })}
            </div>
          </div>

          <div className="field">
            <div className="field-label">
              <span>新增</span>
              <b>{swatches.length} / 24</b>
            </div>
            <div className="swatch-row">
              {swatches.map((hex) => (
                <Swatch
                  key={hex}
                  size="chip"
                  hex={hex}
                  selected={color === hex}
                  title={hex}
                  onClick={() => {
                    setColor(hex)
                  }}
                  onContextMenu={(e) => {
                    e.preventDefault()
                    openPicker(hex)
                  }}
                />
              ))}
              <Swatch size="chip" add title="新增颜色" onClick={() => openPicker(null)} />
            </div>
          </div>
        </Panel>
      </div>

      <div>
        <Panel title="编辑图片" tight>
          <div className="tiny muted">
            涂成<b>透明</b>的格子会被忽略（不参与配色、也不出图）。不需要编辑就直接下一步。
          </div>
          <div className="divider" />
          <div className="row tight">
            <button className="btn waves-effect waves-light" onClick={goNext} style={{ width: '100%' }}>
              下一步：优化颜色
              <i className="material-icons sm">arrow_forward</i>
            </button>
          </div>
        </Panel>

        <Panel
          title="图中颜色"
          hint={
            stats
              ? stats.usage.length > stats.clusters.length
                ? `前 ${stats.clusters.length} 类 / 共 ${stats.usage.length} 色`
                : `${stats.usage.length} 色`
              : ''
          }
          tight
        >
          {stats && stats.clusters.length ? (
            <div className="swatch-grid dense">
              {stats.clusters.map((c) => (
                <Swatch
                  key={c.hex}
                  size="dense"
                  hex={c.hex}
                  code={c.hex.slice(1, 4)}
                  count={c.count}
                  title={`${c.hex} · ${c.count} 颗`}
                  onClick={() => {
                    // 图里的颜色直接进「新增」，方便反复用
                    addSwatch(c.hex)
                    setColor(c.hex)
                  }}
                  onContextMenu={(e) => {
                    e.preventDefault()
                    openPicker(c.hex)
                  }}
                />
              ))}
            </div>
          ) : (
            <Notice kind="warn">所有格子都被忽略了。</Notice>
          )}
        </Panel>

        <Panel title="当前状态" tight>
          <div className="stat-grid">
            <Stat k="网格" v={`${grid.width}×${grid.height}`} small />
            <Stat k="被忽略" v={stats?.ignored ?? 0} small />
            <Stat k="有效格子" v={grid.width * grid.height - (stats?.ignored ?? 0)} small />
            <Stat k="颜色 / 类" v={`${stats?.usage.length ?? 0} / ${stats?.clusters.length ?? 0}`} small />
          </div>
        </Panel>
      </div>

      {picker && (
        <ColorPickerDialog
          title={picker.title}
          initial={picker.initial}
          onCancel={() => setPicker(null)}
          onConfirm={(hex) => {
            onPickedColor(hex)
            setPicker(null)
          }}
        />
      )}
    </div>
  )
}
