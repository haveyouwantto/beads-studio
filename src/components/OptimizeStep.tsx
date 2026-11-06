import { useEffect, useMemo, useRef, useState } from 'react'
import { tabNameOf, useStudio } from '../store/studio.ts'
import { Check, Empty, Field, Notice, Panel, Segmented, Stat, Swatch } from './ui.tsx'
import { targetsFromPixmap, COLOR_SPACES, DISTANCES, type OptimizeConfig, type OptimizeStats } from '../core/optimize.ts'
import type { Pixmap } from '../core/types.ts'
import { CODE_SYSTEMS, codeOf, compareByCode, swatchHex, type CodeSystem, type PaletteEntry } from '../core/palette.ts'
import { buildPaletteExport, downloadText, safeFileName } from '../core/export.ts'
import { drawPixmap } from '../core/render.ts'
import { CandidateColorsDialog } from './CandidateColorsDialog.tsx'
import { STAGE_META } from './stages.ts'
import { SWEEP_AXES, sweepVariants } from '../core/sweep.ts'

export function OptimizeStep() {
  const grid = useStudio((s) => s.grid)
  const goPrev = useStudio((s) => s.goPrev)
  const goNext = useStudio((s) => s.goNext)
  const setStage = useStudio((s) => s.setStage)
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
  const sweep = useStudio((s) => s.sweep)
  const runSweep = useStudio((s) => s.runSweep)
  const stopSweep = useStudio((s) => s.stopSweep)
  const pickSweepResult = useStudio((s) => s.pickSweepResult)
  const setSweepAxis = useStudio((s) => s.setSweepAxis)

  const [copied, setCopied] = useState(false)
  const [showCandidates, setShowCandidates] = useState(false)
  const gridRef = useRef<HTMLCanvasElement>(null)

  const candidateHex = useStudio((s) => s.candidateHex)
  const candidateCount = candidateHex.length ? candidateHex.length : libraryPalette.length
  const candidateSets = useStudio((s) => s.candidateSets)
  const projectName = useStudio(tabNameOf)

  // 优化目标信息
  const targetInfo = useMemo(() => (grid ? targetsFromPixmap(grid) : null), [grid])

  useEffect(() => {
    if (!gridRef.current || !grid) return
    const s = Math.max(1, Math.min(6, Math.floor(260 / Math.max(grid.width, grid.height)) || 1))
    drawPixmap(gridRef.current, grid, s, false)
  }, [grid])

  // 统计一律是 Lab ΔE76，与匹配用的度量无关，两套方案可直接比较
  const deltaLabel = 'ΔE '

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

  if (!grid) {
    return (
      <div className="columns">
        <div className="stage-head">
          <div>
            <h1>
              <i className="material-icons">{STAGE_META.optimize.icon}</i>
              {STAGE_META.optimize.label}
            </h1>
          </div>
        </div>
        <Empty icon="palette" title="还没有可优化的网格">
          <div style={{ marginTop: 12 }}>
            <button className="btn waves-effect waves-light" onClick={() => setStage('regularize')}>
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
              <i className="material-icons">{STAGE_META.optimize.icon}</i>
              {STAGE_META.optimize.label}
            </h1>
          </div>
          <span className="grow" />
          <button className="btn-flat btn-small waves-effect" onClick={goPrev}>
            <i className="material-icons sm">arrow_back</i>
            编辑
          </button>
        </div>

        <Panel
          title="优化目标"
          hint={targetMode === 'grid' ? '来自规范化结果' : '全量色谱'}
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
            </div>
          </div>
        </Panel>

        <Panel
          title={sortedResult.length ? `优化结果 · ${sortedResult.length} 色` : '优化结果'}
          hint={run.reason}
          actions={
            <>
              <button className="btn-flat btn-small waves-effect" onClick={copyResult} disabled={!sortedResult.length}>
                {copied ? '已复制' : '复制色号'}
              </button>
              <button
                className="btn btn-small waves-effect waves-light"
                onClick={applyOptimizedPalette}
                disabled={!sortedResult.length}
              >
                用这套颜色出图纸
                <i className="material-icons sm">arrow_forward</i>
              </button>
            </>
          }
          tight
        >
          {run.stats && (
            <div className="stat-grid" style={{ marginBottom: 12 }}>
              <Stat k={deltaLabel + '平均'} v={run.stats.avg.toFixed(2)} />
              <Stat k={deltaLabel + '加权平均'} v={run.stats.weightedAvg.toFixed(2)} />
              <Stat k={deltaLabel + '最大'} v={run.stats.max.toFixed(2)} />
              <Stat k={deltaLabel + '最小'} v={run.stats.min.toFixed(2)} />
              {run.stats.p95 !== undefined && (
                <Stat k={deltaLabel + 'p95'} v={run.stats.p95.toFixed(2)} />
              )}
              {run.stats.hotRatio !== undefined && (
                <Stat
                  k={`${deltaLabel}>8 面积占比`}
                  v={(run.stats.hotRatio * 100).toFixed(1) + '%'}
                />
              )}
            </div>
          )}

          {sortedResult.length ? (
            <div className="swatch-grid">
              {sortedResult.map((e) => {
                const mandatory = config.mandatory && ['H02', 'H07'].includes(e.codes.MARD ?? '')
                return (
                  <Swatch
                    key={e.hex}
                    hex={swatchHex(e)}
                    code={codeOf(e, codeSystem)}
                    hexLabel={e.hex}
                    lock={mandatory}
                    title={`${codeOf(e, codeSystem)} · ${e.hex}`}
                  />
                )
              })}
            </div>
          ) : (
            <Notice kind="info">
              还没运行优化。
            </Notice>
          )}

          {sortedResult.length > 0 && (
            <>
              <div className="divider" />
              <div className="row tight">
                <button
                  className="btn-flat btn-small waves-effect"
                  onClick={() => downloadExport(sortedResult, codeSystem, 'json', projectName)}
                >
                  导出 JSON
                </button>
                <button
                  className="btn-flat btn-small waves-effect"
                  onClick={() => downloadExport(sortedResult, codeSystem, 'hex', projectName)}
                >
                  导出 HEX 列表
                </button>
                <button
                  className="btn-flat btn-small waves-effect"
                  onClick={() => downloadExport(sortedResult, codeSystem, 'code', projectName)}
                >
                  导出色号列表
                </button>
              </div>
            </>
          )}
        </Panel>

        <Panel
          title="多方案对比"
          hint={
            sweep.status === 'running'
              ? `第 ${Math.min(sweep.index + 1, sweep.total)} / ${sweep.total} 套 · ${sweep.progress.toFixed(0)}%`
              : sweep.results.length
                ? `${sweep.results.length} 张成品 · 用时 ${(sweep.elapsedMs / 1000).toFixed(1)}s`
                : '同一条图，几种参数各出一张，挑顺眼的'
          }
          actions={
            <Segmented
              value={sweep.axis}
              onChange={setSweepAxis}
              options={SWEEP_AXES.map((a) => ({ value: a.value, label: a.label }))}
            />
          }
          tight
        >
          <button
            className="btn waves-effect waves-light"
            style={{ width: '100%' }}
            onClick={() => (sweep.status === 'running' ? stopSweep() : void runSweep())}
          >
            {sweep.status === 'running'
              ? '停止对比'
              : `同时跑 ${sweepVariants(sweep.axis, config).length} 套方案`}
          </button>
          <div className="tiny muted" style={{ marginTop: 6 }}>
            {SWEEP_AXES.find((a) => a.value === sweep.axis)?.hint}
          </div>

          {sweep.status === 'running' && (
            <div className="progress" style={{ marginTop: 8 }}>
              <i style={{ width: `${sweep.progress}%` }} />
            </div>
          )}

          {sweep.results.length > 0 && (
            <>
              <div className="divider" />
              <div className="sweep-grid">
                {sweep.results.map((r) => (
                  <SweepCard
                    key={r.id}
                    result={r}
                    picked={sweep.pickedId === r.id}
                    onPick={() => pickSweepResult(r.id)}
                  />
                ))}
              </div>
              <div className="row tight" style={{ marginTop: 12, justifyContent: 'space-between' }}>
                <span className="tiny muted">
                  {sweep.pickedId
                    ? `已选「${sweep.results.find((r) => r.id === sweep.pickedId)?.label}」`
                    : '点击选择方案'}
                </span>
                <button
                  className="btn btn-small waves-effect waves-light"
                  disabled={!sweep.pickedId}
                  onClick={() => sweep.pickedId && pickSweepResult(sweep.pickedId, true)}
                >
                  用这张出图纸
                  <i className="material-icons sm">arrow_forward</i>
                </button>
              </div>
            </>
          )}
        </Panel>
      </div>

      <div>
        <Panel title="优化设置">
          {/* 运行放最前面：改完参数不用滚到面板底部（样式和其他高亮按钮一致） */}
          <button
            className="btn waves-effect waves-light"
            style={{ width: '100%' }}
            onClick={() => (running ? stopOptimizer() : void runOptimizer())}
          >
            {running ? '停止优化' : '开始优化'}
          </button>

          <div className="progress">
            <i style={{ width: `${run.progress}%` }} />
          </div>
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <span className="tiny muted">{run.status === 'idle' ? '待运行' : `${run.progress.toFixed(1)}%`}</span>
            <span className="tiny muted">{run.status === 'running' ? '计算中…' : ''}</span>
          </div>

          <div className="divider" />

          <Field
            label="候选色"
            value={`${candidateCount} / ${libraryPalette.length}`}
          >
            <button className="btn waves-effect waves-light" style={{ width: '100%' }} onClick={() => setShowCandidates(true)}>
              选择候选色…
            </button>
            {candidateSets.length > 0 && (
              <select
                value=""
                style={{ marginTop: 8 }}
                onChange={(e) => {
                  if (e.target.value) useStudio.getState().applyCandidateSet(e.target.value)
                }}
              >
                <option value="">套用方案…</option>
                {candidateSets.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name} · {s.hexes.length} 色
                  </option>
                ))}
              </select>
            )}
          </Field>

          <div className="divider" />

          <Field
            label="颜料预算 K"
            value={config.kMode === 'auto' ? `上限 ${config.k} 色` : `${config.k} 色`}
            hint={
              config.kMode === 'auto'
                ? run.budget
                  ? `自动选定 ${run.budget} 色`
                  : '自动寻找 ΔE 收益拐点'
                : undefined
            }
          >
            <Segmented
              value={config.kMode}
              onChange={(v) => setConfig({ kMode: v })}
              options={[
                { value: 'fixed', label: '固定数量' },
                { value: 'auto', label: '自动挑最少' },
              ]}
            />
            <input
              type="range"
              min={2}
              max={120}
              step={1}
              value={config.k}
              onChange={(e) => setConfig({ k: Number(e.target.value) })}
            />
          </Field>
          <Field
            label="聚类空间"
            hint={COLOR_SPACES.find((s) => s.value === config.clusterSpace)?.hint}
          >
            <select
              value={config.clusterSpace}
              onChange={(e) => setConfig({ clusterSpace: e.target.value as OptimizeConfig['clusterSpace'] })}
            >
              {COLOR_SPACES.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="聚类半径" hint="半径内的颜色整球同豆：0 = 逐色独立匹配（最像但会花）">
            <input
              type="range"
              min={0}
              max={20}
              step={0.5}
              value={config.clusterRadius}
              onChange={(e) => setConfig({ clusterRadius: Number(e.target.value) })}
            />
          </Field>
          <Field label="匹配空间" hint="簇均色 → 豆的选豆距离在这算（实验室终审：Lab 欧氏）">
            <select
              value={config.colorSpace}
              onChange={(e) => setConfig({ colorSpace: e.target.value as OptimizeConfig['colorSpace'] })}
            >
              {COLOR_SPACES.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="匹配距离" hint={DISTANCES.find((d) => d.value === config.distance)?.hint}>
            <select
              value={config.distance}
              onChange={(e) => setConfig({ distance: e.target.value as OptimizeConfig['distance'] })}
            >
              {DISTANCES.map((d) => (
                <option key={d.value} value={d.value}>
                  {d.label}
                </option>
              ))}
            </select>
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
            <Check checked={config.mandatory} onChange={(v) => setConfig({ mandatory: v })}>
              固定包含<b>黑白</b>（不占预算）
            </Check>
            <Check checked={includeExtended} onChange={setIncludeExtended}>
              包含<b>扩展色号</b>
            </Check>
          </div>

        </Panel>

        <Panel title="运行信息">
          <div className="stat-grid">
            <Stat k="候选色" v={run.candidates || candidateCount} small />
            <Stat k="目标色" v={run.targets || targetCount} small />
            <Stat k="实际色数" v={run.budget ? `${run.budget} 色` : '—'} small />
            <Stat k="用时" v={run.elapsedMs ? `${(run.elapsedMs / 1000).toFixed(1)}s` : '—'} small />
          </div>
          {run.status === 'done' && (
            <>
              <div className="divider" />
              <button className="btn waves-effect waves-light" style={{ width: '100%' }} onClick={goNext}>
                前往「转拼豆图纸」
                <i className="material-icons sm">arrow_forward</i>
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
  projectName: string,
) {
  const text = buildPaletteExport(entries, system, format)
  const ext = format === 'json' ? 'json' : 'txt'
  const mime = format === 'json' ? 'application/json' : 'text/plain'
  downloadText(text, `${safeFileName(projectName)}-色板-${system}.${ext}`, mime)
}

  /** 
   * 对比卡片组件：预览成品与核心量化指标。
   */
  function SweepCard({
    result,
    picked,
    onPick,
  }: {
    result: { id: string; label: string; hint: string; budget: number; loss: number; stats: OptimizeStats; preview: Pixmap | null; entries: PaletteEntry[] }
    picked: boolean
    onPick: () => void
  }) {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const canvas = ref.current
    const img = result.preview
    if (!canvas || !img) return
    // 按容器宽度绘制图片
    const cssWidth = canvas.parentElement?.clientWidth ?? 160
    const dpr = typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1
    const scale = Math.max(1, Math.ceil((cssWidth * dpr) / Math.max(img.width, img.height)))
    drawPixmap(canvas, img, Math.min(scale, 8), false)
  }, [result.preview])

  return (
    <button type="button" className={`sweep-card${picked ? ' on' : ''}`} onClick={onPick} title={result.hint}>
      {result.preview ? (
        <canvas ref={ref} />
      ) : (
        <div className="sweep-strip">
          {result.entries.slice(0, 10).map((e) => (
            <i key={e.hex} style={{ background: e.hex }} />
          ))}
        </div>
      )}
      <div className="sweep-name">
        <b>{result.label}</b>
        {picked && <i className="material-icons sm">check</i>}
      </div>
      {/* 拆成几个不换行的词：窄卡片上整句会被拆得很难看 */}
      <div className="sweep-meta tiny muted">
        <span>{result.budget} 色</span>
        <span>ΔE {result.stats.weightedAvg.toFixed(2)}</span>
        {result.loss > 0.005 && <span>层次损失 {result.loss.toFixed(2)}</span>}
      </div>
      <div className="sweep-hint tiny muted">{result.hint}</div>
    </button>
  )
}
