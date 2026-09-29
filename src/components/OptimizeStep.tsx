import { useEffect, useMemo, useRef, useState } from 'react'
import { useStudio } from '../store/studio.ts'
import { Check, Empty, Field, Notice, Panel, Segmented, Stat } from './ui.tsx'
import { targetsFromPixmap } from '../core/optimize.ts'
import { CODE_SYSTEMS, codeOf, compareByCode, type CodeSystem, type PaletteEntry } from '../core/palette.ts'
import { buildPaletteExport, downloadText } from '../core/export.ts'
import { idealTextColor } from '../core/color.ts'
import { drawPixmap } from '../core/render.ts'
import { CandidateColorsDialog } from './CandidateColorsDialog.tsx'

export function OptimizeStep() {
  const grid = useStudio((s) => s.grid)
  const goPrev = useStudio((s) => s.goPrev)
  const goNext = useStudio((s) => s.goNext)
  const libraryPalette = useStudio((s) => s.libraryPalette)
  const includeExtended = useStudio((s) => s.includeExtended)
  const setIncludeExtended = useStudio((s) => s.setIncludeExtended)
  const config = useStudio((s) => s.optimizeConfig)
  const setConfig = useStudio((s) => s.setOptimizeConfig)
  const targetMode = useStudio((s) => s.optimizeTargetMode)
  const setTargetMode = useStudio((s) => s.setOptimizeTargetMode)
  const run = useStudio((s) => s.optimizeRun)
  const runOptimizer = useStudio((s) => s.runOptimizer)
  const stopOptimizer = useStudio((s) => s.stopOptimizer)
  const optimizedPalette = useStudio((s) => s.optimizedPalette)
  const applyOptimizedPalette = useStudio((s) => s.applyOptimizedPalette)
  const codeSystem = useStudio((s) => s.codeSystem)
  const setCodeSystem = useStudio((s) => s.setCodeSystem)

  const [copied, setCopied] = useState(false)
  const [showCandidates, setShowCandidates] = useState(false)
  const gridRef = useRef<HTMLCanvasElement>(null)

  const candidateHex = useStudio((s) => s.candidateHex)
  const candidateCount = candidateHex.length ? candidateHex.length : libraryPalette.length

  // 优化目标预览：直接来自「规范化」的网格
  const targetInfo = useMemo(() => (grid ? targetsFromPixmap(grid, { maxTargets: 1200 }) : null), [grid])

  useEffect(() => {
    if (!gridRef.current || !grid) return
    const s = Math.max(1, Math.min(6, Math.floor(260 / Math.max(grid.width, grid.height)) || 1))
    drawPixmap(gridRef.current, grid, s, false)
  }, [grid])

  const sortedResult = useMemo(
    () => [...optimizedPalette].sort((a, b) => compareByCode(a, b, codeSystem)),
    [optimizedPalette, codeSystem],
  )

  const running = run.status === 'running'

  const copyResult = async () => {
    const text = buildPaletteExport(sortedResult, codeSystem, 'code')
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 1800)
    } catch {
      useStudio.setState({ error: '浏览器拒绝了剪贴板写入，请用「导出」按钮下载' })
    }
  }

  const targetCount = targetInfo?.samples.length ?? 0
  const needed = config.k + (config.mandatory ? 2 : 0)

  if (!grid) {
    return (
      <div className="columns">
        <div className="stage-head">
          <div>
            <h1>② 优化颜色</h1>
            <p>以「规范化」产出的网格作为优化目标，从色号库里挑出最合适的 N 种颜色。</p>
          </div>
        </div>
        <Empty icon="🎯" title="还没有可以优化的目标">
          需要先在「规范化」里生成 1 像素 = 1 颗豆的网格。
          <div style={{ marginTop: 12 }}>
            <button className="btn primary" onClick={goPrev}>
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
            <h1>② 优化颜色</h1>
            <p>
              优化目标 = 规范化结果里的每一格颜色（按出现次数加权）。算法在这张图里找一组最能代表它的色号，
              结果直接决定「转拼豆图纸」用哪些豆子。
            </p>
          </div>
          <span className="grow" />
          <button className="btn ghost sm" onClick={goPrev}>
            ← 规范化
          </button>
        </div>

        <Panel
          title="优化目标"
          hint={targetMode === 'grid' ? '来自规范化结果' : '全量色谱（构建通用色板）'}
          actions={
            <Segmented
              value={targetMode}
              onChange={setTargetMode}
              options={[
                { value: 'grid', label: '规范化结果' },
                { value: 'library', label: '全量色谱' },
              ]}
            />
          }
          tight
        >
          <div className="row" style={{ gap: 14, alignItems: 'flex-start' }}>
            <div style={{ flex: '0 0 auto' }}>
              <div className="canvas-wrap" style={{ minHeight: 0, padding: 8, maxHeight: 240 }}>
                <canvas ref={gridRef} />
              </div>
            </div>
            <div style={{ flex: '1 1 260px' }}>
              <div className="stat-grid">
                <Stat k="网格" v={`${grid.width}×${grid.height}`} small />
                <Stat k="总像素" v={(grid.width * grid.height).toLocaleString()} small />
                <Stat k="唯一颜色" v={targetInfo?.uniqueColors ?? 0} small />
                <Stat k="目标色数" v={targetMode === 'grid' ? targetCount : libraryPalette.length} small />
              </div>
              <div className="divider" />
              <div className="tiny muted">
                {targetMode === 'grid' ? (
                  targetInfo?.bucket && targetInfo.bucket > 0 ? (
                    <>颜色过多，已按 {targetInfo.bucket} 级分桶合并到 {targetCount} 个目标色（权重仍按真实出现次数统计）。</>
                  ) : (
                    <>每个目标色带一个权重（它在图案里出现的次数），所以优化会优先保证大面积颜色准确。</>
                  )
                ) : (
                  <>把整本色号库自己当作目标，得到一组「通用配色」，适合先定色板再画图。</>
                )}
              </div>
            </div>
          </div>
        </Panel>

        <Panel
          title={`优化结果${sortedResult.length ? `（${sortedResult.length} 个色号）` : ''}`}
          hint={run.reason}
          actions={
            <>
              <button className="btn sm ghost" onClick={copyResult} disabled={!sortedResult.length}>
                {copied ? '已复制' : '复制色号'}
              </button>
              <button
                className="btn primary sm"
                onClick={applyOptimizedPalette}
                disabled={!sortedResult.length}
              >
                用这套颜色出图纸 →
              </button>
            </>
          }
          tight
        >
          {run.stats && (
            <div className="stat-grid" style={{ marginBottom: 12 }}>
              <Stat k="平均 ΔE" v={run.stats.avg.toFixed(2)} />
              <Stat k="加权平均 ΔE" v={run.stats.weightedAvg.toFixed(2)} />
              <Stat k="最大 ΔE" v={run.stats.max.toFixed(2)} />
              <Stat k="最小 ΔE" v={run.stats.min.toFixed(2)} />
            </div>
          )}

          {sortedResult.length ? (
            <div className="swatch-grid">
              {sortedResult.map((e) => {
                const text = idealTextColor(e.rgb)
                const mandatory = config.mandatory && ['H02', 'H07'].includes(e.codes.MARD ?? '')
                return (
                  <div
                    key={e.hex}
                    className="swatch static"
                    style={{ background: e.hex, color: text }}
                    title={`${codeOf(e, codeSystem)} · ${e.hex}`}
                  >
                    {mandatory && <span className="lock">🔒</span>}
                    <div className="code">{codeOf(e, codeSystem)}</div>
                    <div className="hex">{e.hex}</div>
                  </div>
                )
              })}
            </div>
          ) : (
            <Notice kind="info">
              还没运行优化。设好颜料预算后点「开始优化」；或者直接跳到「转拼豆图纸」用整本色号库出图。
            </Notice>
          )}

          {sortedResult.length > 0 && (
            <>
              <div className="divider" />
              <div className="row tight">
                <button
                  className="btn sm ghost"
                  onClick={() => downloadExport(sortedResult, codeSystem, 'json')}
                >
                  导出 JSON
                </button>
                <button className="btn sm ghost" onClick={() => downloadExport(sortedResult, codeSystem, 'hex')}>
                  导出 HEX 列表
                </button>
                <button className="btn sm ghost" onClick={() => downloadExport(sortedResult, codeSystem, 'code')}>
                  导出色号列表
                </button>
              </div>
            </>
          )}
        </Panel>
      </div>

      <div>
        <Panel title="优化设置">
          <Field
            label="候选色"
            value={`${candidateCount} / ${libraryPalette.length}`}
            hint="优化只会从勾选的颜色里挑；默认整本色号库都可选"
          >
            <button className="btn" style={{ width: '100%' }} onClick={() => setShowCandidates(true)}>
              选择候选色…
            </button>
          </Field>

          <div className="divider" />

          <Field label="颜料预算 K" value={`${config.k} 色`} hint={`含固定的 2 个黑白，共约 ${needed} 色`}>
            <input
              type="range"
              min={2}
              max={120}
              step={1}
              value={config.k}
              onChange={(e) => setConfig({ k: Number(e.target.value) })}
            />
          </Field>
          <Field label="退火步数">
            <input
              type="number"
              min={1000}
              max={400000}
              step={1000}
              value={config.steps}
              onChange={(e) => setConfig({ steps: Math.max(1000, Number(e.target.value) || 1000) })}
            />
          </Field>
          <Field label="提前终止耐心值" hint="连续这么多步没有更好解就提前结束">
            <input
              type="number"
              min={200}
              max={100000}
              step={100}
              value={config.patience}
              onChange={(e) => setConfig({ patience: Math.max(200, Number(e.target.value) || 200) })}
            />
          </Field>
          <Field label="优化目标">
            <Segmented
              value={config.objective}
              onChange={(v) => setConfig({ objective: v })}
              options={[
                { value: 'avg', label: '平均 ΔE' },
                { value: 'max', label: '最大 ΔE' },
              ]}
            />
          </Field>
          <Field label="随机种子">
            <input
              type="number"
              min={1}
              max={999999}
              value={config.seed}
              onChange={(e) => setConfig({ seed: Math.max(1, Number(e.target.value) || 1) })}
            />
          </Field>
          <Field label="色号体系">
            <select value={codeSystem} onChange={(e) => setCodeSystem(e.target.value as CodeSystem)}>
              {CODE_SYSTEMS.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </Field>

          <div className="divider" />

          <div style={{ display: 'grid', gap: 9 }}>
            <Check checked={config.weighted} onChange={(v) => setConfig({ weighted: v })}>
              按出现次数<b>加权</b>（推荐）
            </Check>
            <Check checked={config.mandatory} onChange={(v) => setConfig({ mandatory: v })}>
              固定包含<b>黑白</b>（MARD H02 / H07）
            </Check>
            <Check checked={config.greedyInit} onChange={(v) => setConfig({ greedyInit: v })}>
              贪心最远点<b>初始解</b>（更稳）
            </Check>
            <Check checked={config.polish} onChange={(v) => setConfig({ polish: v })}>
              退火后做<b>贪心精修</b>
            </Check>
            <Check checked={includeExtended} onChange={setIncludeExtended}>
              色号库包含<b>扩展色号</b>（M/P/Q/R/T/Y/ZG）
            </Check>
          </div>

          <div className="divider" />

          <div className="row tight">
            <button
              className={running ? 'btn danger' : 'btn primary'}
              style={{ flex: 1 }}
              onClick={() => (running ? stopOptimizer() : void runOptimizer())}
            >
              {running ? '停止优化' : '开始优化'}
            </button>
          </div>

          <div className="progress">
            <i style={{ width: `${run.progress}%` }} />
          </div>
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <span className="tiny muted">{run.status === 'idle' ? '待运行' : `${run.progress.toFixed(1)}%`}</span>
            <span className="tiny muted">
              {run.step.toLocaleString()} / {config.steps.toLocaleString()} 步
            </span>
          </div>
        </Panel>

        <Panel title="运行信息">
          <div className="stat-grid">
            <Stat k="候选色" v={run.candidates || candidateCount} small />
            <Stat k="目标色" v={run.targets || targetCount} small />
            <Stat k="当前温度" v={run.temperature ? run.temperature.toExponential(2) : '—'} small />
            <Stat k="用时" v={run.elapsedMs ? `${(run.elapsedMs / 1000).toFixed(1)}s` : '—'} small />
          </div>
          <div className="divider" />
          <div className="tiny muted">
            色号库当前可用 <b>{libraryPalette.length}</b> 色（MARD A–H{includeExtended ? ' + 扩展色号' : ''}），
            其中 <b>{candidateCount}</b> 色参与优化。
            <br />
            相同种子 + 相同设置 = 相同结果，方便复现。
          </div>
          {run.status === 'done' && (
            <>
              <div className="divider" />
              <button className="btn primary" style={{ width: '100%' }} onClick={goNext}>
                前往「转拼豆图纸」→
              </button>
            </>
          )}
        </Panel>
      </div>

      {showCandidates && <CandidateColorsDialog onClose={() => setShowCandidates(false)} />}
    </div>
  )
}

function downloadExport(
  entries: PaletteEntry[],
  system: CodeSystem,
  format: 'json' | 'hex' | 'code',
) {
  const text = buildPaletteExport(entries, system, format)
  const ext = format === 'json' ? 'json' : 'txt'
  const mime = format === 'json' ? 'application/json' : 'text/plain'
  downloadText(text, `palette-${system}.${ext}`, mime)
}
