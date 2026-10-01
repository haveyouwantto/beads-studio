import { useEffect, useMemo, useRef, useState } from 'react'
import { useStudio } from '../store/studio.ts'
import { Field, Panel, Segmented, Stat, Notice, Empty } from './ui.tsx'
import { drawPixmap } from '../core/render.ts'
import { countUniqueColors } from '../core/quantize.ts'
import { SAMPLE_MODE_LABELS, type SampleMode } from '../core/types.ts'
import { STAGE_META } from './stages.ts'

const VIEW_MAX_W = 760
const VIEW_MAX_H = 540

/** 自相关曲线 + 峰标记（沿用旧「像素图自动规范化」的可视化） */
function AutocorrelationChart({
  data,
  peaks,
  title,
  period,
}: {
  data: Float64Array
  peaks: number[]
  title: string
  period: number | null
}) {
  const ref = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return
    const width = 340
    const height = 110
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    ctx.fillStyle = '#0b1119'
    ctx.fillRect(0, 0, width, height)

    const n = Math.min(data.length, Math.floor(data.length * 0.55) || 1)
    let max = -Infinity
    let min = Infinity
    for (let i = 0; i < n; i++) {
      max = Math.max(max, data[i])
      min = Math.min(min, data[i])
    }
    const range = max - min || 1

    ctx.strokeStyle = '#8fb6e8'
    ctx.lineWidth = 1
    ctx.beginPath()
    for (let i = 0; i < n; i++) {
      const x = (i / Math.max(1, n - 1)) * width
      const y = height - 10 - ((data[i] - min) / range) * (height - 20)
      if (i === 0) ctx.moveTo(x, y)
      else ctx.lineTo(x, y)
    }
    ctx.stroke()

    ctx.strokeStyle = 'rgba(240,82,82,0.5)'
    for (const p of peaks) {
      if (p >= n) continue
      const x = (p / Math.max(1, n - 1)) * width
      ctx.beginPath()
      ctx.moveTo(x, height)
      ctx.lineTo(x, 0)
      ctx.stroke()
    }

    if (period && period > 0) {
      ctx.strokeStyle = 'rgba(52,211,153,0.85)'
      ctx.lineWidth = 1.5
      for (let k = 1; k * period < n; k++) {
        const x = ((k * period) / Math.max(1, n - 1)) * width
        ctx.beginPath()
        ctx.moveTo(x, 0)
        ctx.lineTo(x, height)
        ctx.stroke()
      }
    }
  }, [data, peaks, period])

  return (
    <div>
      <div className="tiny muted" style={{ marginBottom: 4 }}>
        {title}
        {period ? ` · 基频 ${period.toFixed(2)} px` : ''}
      </div>
      <canvas ref={ref} style={{ width: '100%', height: 'auto', display: 'block', borderRadius: 6 }} />
    </div>
  )
}

export function RegularizeStep({ onOpenFile }: { onOpenFile: () => void }) {
  const source = useStudio((s) => s.source)
  const alignmentMode = useStudio((s) => s.alignmentMode)
  const setAlignmentMode = useStudio((s) => s.setAlignmentMode)
  const sampleMode = useStudio((s) => s.sampleMode)
  const setSampleMode = useStudio((s) => s.setSampleMode)
  const analysis = useStudio((s) => s.analysis)
  const periodX = useStudio((s) => s.periodX)
  const periodY = useStudio((s) => s.periodY)
  const phaseX = useStudio((s) => s.phaseX)
  const phaseY = useStudio((s) => s.phaseY)
  const setPeriod = useStudio((s) => s.setPeriod)
  const setPhase = useStudio((s) => s.setPhase)
  const runAnalysis = useStudio((s) => s.runAnalysis)
  const corners = useStudio((s) => s.corners)
  const setCorner = useStudio((s) => s.setCorner)
  const resetCorners = useStudio((s) => s.resetCorners)
  const manualCols = useStudio((s) => s.manualCols)
  const manualRows = useStudio((s) => s.manualRows)
  const setManualSize = useStudio((s) => s.setManualSize)
  const directBlock = useStudio((s) => s.directBlock)
  const setDirectBlock = useStudio((s) => s.setDirectBlock)
  const detectDirectBlock = useStudio((s) => s.detectDirectBlock)
  const grid = useStudio((s) => s.grid)
  const goNext = useStudio((s) => s.goNext)

  const [dragging, setDragging] = useState(-1)
  const imgRef = useRef<HTMLCanvasElement>(null)
  const overlayRef = useRef<HTMLCanvasElement>(null)
  const gridRef = useRef<HTMLCanvasElement>(null)

  const scale = useMemo(() => {
    if (!source) return 1
    return Math.min(1, VIEW_MAX_W / source.width, VIEW_MAX_H / source.height)
  }, [source])

  const viewW = source ? Math.round(source.width * scale) : 0
  const viewH = source ? Math.round(source.height * scale) : 0

  // 源图
  useEffect(() => {
    if (!source || !imgRef.current) return
    drawPixmap(imgRef.current, source.pixmap, scale, scale < 1)
  }, [source, scale])

  // 覆盖层：自动模式画网格，四角模式画控制点
  useEffect(() => {
    const canvas = overlayRef.current
    if (!source || !canvas) return
    canvas.width = viewW
    canvas.height = viewH
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.clearRect(0, 0, viewW, viewH)

    if (alignmentMode === 'auto' && analysis) {
      ctx.strokeStyle = 'rgba(120,200,255,0.55)'
      ctx.lineWidth = 1
      ctx.beginPath()
      const startX = ((phaseX % periodX) + periodX) % periodX
      for (let x = startX; x < source.width; x += periodX) {
        ctx.moveTo(x * scale, 0)
        ctx.lineTo(x * scale, viewH)
      }
      for (let x = startX - periodX; x >= 0; x -= periodX) {
        ctx.moveTo(x * scale, 0)
        ctx.lineTo(x * scale, viewH)
      }
      const startY = ((phaseY % periodY) + periodY) % periodY
      for (let y = startY; y < source.height; y += periodY) {
        ctx.moveTo(0, y * scale)
        ctx.lineTo(viewW, y * scale)
      }
      for (let y = startY - periodY; y >= 0; y -= periodY) {
        ctx.moveTo(0, y * scale)
        ctx.lineTo(viewW, y * scale)
      }
      ctx.stroke()
    }

    if (alignmentMode === 'quad') {
      const pts = corners.map((p) => ({ x: p.x * scale, y: p.y * scale }))
      ctx.strokeStyle = 'rgba(139,92,246,0.95)'
      ctx.lineWidth = 2
      ctx.beginPath()
      ctx.moveTo(pts[0].x, pts[0].y)
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y)
      ctx.closePath()
      ctx.stroke()

      // 内部网格辅助线
      ctx.strokeStyle = 'rgba(255,255,255,0.18)'
      ctx.lineWidth = 1
      ctx.beginPath()
      const steps = Math.min(24, Math.max(4, Math.round(manualCols / 2)))
      for (let i = 1; i < steps; i++) {
        const u = i / steps
        const tx = pts[0].x + (pts[1].x - pts[0].x) * u
        const ty = pts[0].y + (pts[1].y - pts[0].y) * u
        const bx = pts[3].x + (pts[2].x - pts[3].x) * u
        const by = pts[3].y + (pts[2].y - pts[3].y) * u
        ctx.moveTo(tx, ty)
        ctx.lineTo(bx, by)
      }
      for (let i = 1; i < steps; i++) {
        const v = i / steps
        const lx = pts[0].x + (pts[3].x - pts[0].x) * v
        const ly = pts[0].y + (pts[3].y - pts[0].y) * v
        const rx = pts[1].x + (pts[2].x - pts[1].x) * v
        const ry = pts[1].y + (pts[2].y - pts[1].y) * v
        ctx.moveTo(lx, ly)
        ctx.lineTo(rx, ry)
      }
      ctx.stroke()

      pts.forEach((p, i) => {
        ctx.fillStyle = i === dragging ? '#ffffff' : '#ff2d78'
        ctx.beginPath()
        ctx.arc(p.x, p.y, 7, 0, Math.PI * 2)
        ctx.fill()
        ctx.strokeStyle = '#fff'
        ctx.lineWidth = 2
        ctx.stroke()
      })
    }
  }, [source, alignmentMode, analysis, corners, periodX, periodY, phaseX, phaseY, scale, viewW, viewH, manualCols, dragging])

  // 规范化结果
  useEffect(() => {
    if (!gridRef.current || !grid) return
    const maxSide = 320
    const s = Math.max(1, Math.min(8, Math.floor(maxSide / Math.max(grid.width, grid.height)) || 1))
    drawPixmap(gridRef.current, grid, s, false)
  }, [grid])

  const uniqueColors = useMemo(() => (grid ? countUniqueColors(grid) : 0), [grid])

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (alignmentMode !== 'quad' || !source) return
    const rect = e.currentTarget.getBoundingClientRect()
    const x = ((e.clientX - rect.left) / rect.width) * source.width
    const y = ((e.clientY - rect.top) / rect.height) * source.height
    let best = -1
    let bestDist = 18 / scale
    corners.forEach((p, i) => {
      const d = Math.hypot(p.x - x, p.y - y)
      if (d < bestDist) {
        bestDist = d
        best = i
      }
    })
    if (best >= 0) {
      setDragging(best)
      e.currentTarget.setPointerCapture(e.pointerId)
    }
  }

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (dragging < 0 || !source) return
    const rect = e.currentTarget.getBoundingClientRect()
    const x = Math.max(0, Math.min(source.width, ((e.clientX - rect.left) / rect.width) * source.width))
    const y = Math.max(0, Math.min(source.height, ((e.clientY - rect.top) / rect.height) * source.height))
    setCorner(dragging, x, y)
  }

  if (!source) {
    return (
      <div className="columns">
        <div className="stage-head">
          <div>
            <h1>
              <i className="material-icons">{STAGE_META.regularize.icon}</i>
              {STAGE_META.regularize.label}
            </h1>
          </div>
        </div>
        <Empty icon="image" title="先放入一张图片">
          <button className="btn waves-effect waves-light" onClick={onOpenFile} style={{ marginTop: 12 }}>
            打开图片
          </button>
          <div style={{ marginTop: 8 }}>也可以拖进来，或按 ⌘/Ctrl + V 粘贴</div>
          <div style={{ marginTop: 8 }} className="tiny muted">
            图片只在本机处理，不会上传
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
              <i className="material-icons">{STAGE_META.regularize.icon}</i>
              {STAGE_META.regularize.label}
            </h1>
          </div>
          <span className="grow" />
          <button className="btn-flat btn-small waves-effect" onClick={onOpenFile}>
            换一张
          </button>
        </div>

        <Panel
          title="源图"
          hint={alignmentMode === 'quad' ? '拖动 4 个控制点圈出拼豆区域' : alignmentMode === 'auto' ? '检测到的网格' : '原样使用'}
          tight
        >
          <div className="canvas-wrap fit">
            {/* 尺寸按源图比例算好（viewW × viewH），CSS 再把它等比缩进容器；
                画布和覆盖层用同一个尺寸，四角控制点才不会错位。 */}
            <div className="overlay-host" style={{ width: viewW, height: viewH }}>
              <canvas ref={imgRef} />
              <canvas
                ref={overlayRef}
                className="handle-layer"
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={(e) => {
                  setDragging(-1)
                  e.currentTarget.releasePointerCapture(e.pointerId)
                }}
              />
            </div>
          </div>
        </Panel>

        <Panel
          title="规范化结果"
          hint={grid ? `${grid.width} × ${grid.height} 格` : '尚未生成'}
          actions={
            <button className="btn btn-small waves-effect waves-light" onClick={goNext} disabled={!grid}>
              下一步：优化颜色
              <i className="material-icons sm">arrow_forward</i>
            </button>
          }
          tight
        >
          {grid ? (
            <>
              <div className="canvas-wrap">
                <canvas ref={gridRef} />
              </div>
              {grid.width * grid.height > 200000 && (
                <div style={{ marginTop: 12 }}>
                  <Notice kind="warn">网格太大，后面的优化和出图会比较慢。</Notice>
                </div>
              )}
            </>
          ) : (
            <Notice kind="warn">还没有生成网格。</Notice>
          )}
        </Panel>

        {alignmentMode === 'auto' && analysis && (
          <Panel title="周期检测" tight>
            <div className="row" style={{ gap: 12 }}>
              <div style={{ flex: '1 1 240px' }}>
                <AutocorrelationChart
                  title="X 方向"
                  data={analysis.acX}
                  peaks={analysis.resultX.peaks.map((p) => p.pos)}
                  period={analysis.periodX}
                />
              </div>
              <div style={{ flex: '1 1 240px' }}>
                <AutocorrelationChart
                  title="Y 方向"
                  data={analysis.acY}
                  peaks={analysis.resultY.peaks.map((p) => p.pos)}
                  period={analysis.periodY}
                />
              </div>
            </div>
            <div className="divider" />
            <div className="stat-grid">
              <Stat k="X 覆盖率" v={(analysis.resultX.winner?.coverage ?? 0).toFixed(3)} />
              <Stat k="X 谐波占用" v={(analysis.resultX.winner?.occupancy ?? 0).toFixed(3)} />
              <Stat k="Y 覆盖率" v={(analysis.resultY.winner?.coverage ?? 0).toFixed(3)} />
              <Stat k="Y 谐波占用" v={(analysis.resultY.winner?.occupancy ?? 0).toFixed(3)} />
            </div>
          </Panel>
        )}
      </div>

      <div>
        <Panel title="输入方式">
          <Field label="图片是什么类型？">
            <Segmented
              value={alignmentMode}
              onChange={setAlignmentMode}
              options={[
                { value: 'auto', label: '自动识别' },
                { value: 'quad', label: '四角变换' },
                { value: 'direct', label: '直接 1:1' },
              ]}
            />
          </Field>

          {alignmentMode === 'auto' && (
            <>
              <Field label="格内取样方式">
                <select value={sampleMode} onChange={(e) => setSampleMode(e.target.value as SampleMode)}>
                  {(Object.keys(SAMPLE_MODE_LABELS) as SampleMode[]).map((m) => (
                    <option key={m} value={m}>
                      {SAMPLE_MODE_LABELS[m]}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="X 周期（像素/格）" value={periodX.toFixed(2)}>
                <input
                  type="range"
                  min={1}
                  max={Math.max(8, Math.min(120, periodX * 3))}
                  step={0.25}
                  value={periodX}
                  onChange={(e) => setPeriod('x', Number(e.target.value))}
                />
              </Field>
              <Field label="Y 周期（像素/格）" value={periodY.toFixed(2)}>
                <input
                  type="range"
                  min={1}
                  max={Math.max(8, Math.min(120, periodY * 3))}
                  step={0.25}
                  value={periodY}
                  onChange={(e) => setPeriod('y', Number(e.target.value))}
                />
              </Field>
              <Field label="X 相位（偏移）" value={phaseX.toFixed(1)}>
                <input
                  type="range"
                  min={0}
                  max={Math.max(1, periodX)}
                  step={0.5}
                  value={phaseX % periodX}
                  onChange={(e) => setPhase('x', Number(e.target.value))}
                />
              </Field>
              <Field label="Y 相位（偏移）" value={phaseY.toFixed(1)}>
                <input
                  type="range"
                  min={0}
                  max={Math.max(1, periodY)}
                  step={0.5}
                  value={phaseY % periodY}
                  onChange={(e) => setPhase('y', Number(e.target.value))}
                />
              </Field>
              <button className="btn waves-effect waves-light" onClick={runAnalysis} style={{ width: '100%' }}>
                重新自动检测
              </button>
              {!analysis && <Notice kind="warn">没检测到可靠的周期，试试四角变换或直接 1:1。</Notice>}
            </>
          )}

          {alignmentMode === 'quad' && (
            <>
              <Field label="列数（横向豆数）">
                <input
                  type="number"
                  min={1}
                  value={manualCols}
                  onChange={(e) => setManualSize(Number(e.target.value), manualRows)}
                />
              </Field>
              <Field label="行数（纵向豆数）">
                <input
                  type="number"
                  min={1}
                  value={manualRows}
                  onChange={(e) => setManualSize(manualCols, Number(e.target.value))}
                />
              </Field>
              <button className="btn waves-effect waves-light" onClick={resetCorners} style={{ width: '100%' }}>
                重置四角
              </button>
            </>
          )}

          {alignmentMode === 'direct' && (
            <>
              <Notice kind="info">
                已探测到 <b>{directBlock}×</b> 整数倍放大。
              </Notice>
              <div style={{ height: 12 }} />
              <Field label="像素块压缩" value={`${directBlock}×`} hint="1 = 一个像素就是一颗豆">
                <input
                  type="range"
                  min={1}
                  max={16}
                  step={1}
                  value={directBlock}
                  onChange={(e) => setDirectBlock(Number(e.target.value))}
                />
              </Field>
              <button className="btn waves-effect waves-light" onClick={detectDirectBlock} style={{ width: '100%' }}>
                重新探测放大倍数
              </button>
            </>
          )}
        </Panel>

        <Panel title="当前状态">
          <div className="stat-grid">
            <Stat k="源图尺寸" v={`${source.width}×${source.height}`} small />
            <Stat k="网格尺寸" v={grid ? `${grid.width}×${grid.height}` : '—'} small />
            <Stat k="唯一色" v={uniqueColors || '—'} small />
            <Stat k="格式" v={alignmentMode === 'auto' ? '自动' : alignmentMode === 'quad' ? '四角' : '1:1'} small />
          </div>
        </Panel>
      </div>
    </div>
  )
}
