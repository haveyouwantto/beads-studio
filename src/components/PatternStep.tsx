import { useMemo, useState } from 'react'
import { useStudio } from '../store/studio.ts'
import { Check, Empty, Field, Notice, Panel, Segmented, Stat } from './ui.tsx'
import { buildHexLookup } from '../core/render.ts'
import {
  buildPatternSvg,
  clampPreviewCellSize,
  estimateSvgSize,
  MAX_EXPORT_SIDE,
  svgToPngBlob,
} from '../core/svg.ts'
import { usageCounts } from '../core/quantize.ts'
import {
  CODE_SYSTEMS,
  codeOf,
  METRIC_LABELS,
  PALETTE_SOURCE_LABELS,
  parsePaletteText,
  KIT_SIZES,
  VISIBLE_PALETTE_SOURCES,
  type CodeSystem,
  type DistanceMetric,
  type KitSize,
} from '../core/palette.ts'
import {
  buildBom,
  bomToCsv,
  buildPaletteExport,
  downloadBlob,
  downloadText,
} from '../core/export.ts'
import { idealTextColor } from '../core/color.ts'

const EXPORT_SCALES = [1, 2, 4, 8] as const

export function PatternStep({ onOpenFullscreen }: { onOpenFullscreen: () => void }) {
  const grid = useStudio((s) => s.grid)
  const result = useStudio((s) => s.result)
  const goPrev = useStudio((s) => s.goPrev)
  const palette = useStudio((s) => s.palette)
  const paletteSource = useStudio((s) => s.paletteSource)
  const setPaletteSource = useStudio((s) => s.setPaletteSource)
  const kitSize = useStudio((s) => s.kitSize)
  const setKitSize = useStudio((s) => s.setKitSize)
  const setPalette = useStudio((s) => s.setPalette)
  const includeExtended = useStudio((s) => s.includeExtended)
  const setIncludeExtended = useStudio((s) => s.setIncludeExtended)
  const quantizeOptions = useStudio((s) => s.quantizeOptions)
  const setQuantizeOptions = useStudio((s) => s.setQuantizeOptions)
  const renderOptions = useStudio((s) => s.renderOptions)
  const setRenderOptions = useStudio((s) => s.setRenderOptions)
  const codeSystem = useStudio((s) => s.codeSystem)
  const setCodeSystem = useStudio((s) => s.setCodeSystem)
  const optimizedPalette = useStudio((s) => s.optimizedPalette)
  const libraryPalette = useStudio((s) => s.libraryPalette)

  const [pasteText, setPasteText] = useState('')
  const [exportScale, setExportScale] = useState(2)
  const [busy, setBusy] = useState(false)

  // 预览尺寸：超大图纸自动降档，但预览始终是矢量的，放大不会糊
  const previewOptions = useMemo(
    () =>
      result
        ? { ...renderOptions, cellSize: clampPreviewCellSize(result, renderOptions, 1600) }
        : renderOptions,
    [result, renderOptions],
  )

  const preview = useMemo(
    () => (result ? buildPatternSvg(result, palette, previewOptions) : null),
    [result, palette, previewOptions],
  )

  const fullPattern = useMemo(
    () => (result ? buildPatternSvg(result, palette, renderOptions) : null),
    [result, palette, renderOptions],
  )

  const counts = useMemo(() => (result ? usageCounts(result, palette) : new Uint32Array(0)), [result, palette])
  const bom = useMemo(() => buildBom(palette, counts, codeSystem), [palette, counts, codeSystem])
  const totalBeads = useMemo(() => bom.reduce((a, r) => a + r.count, 0), [bom])
  const usedSet = useMemo(() => new Set(bom.map((r) => r.hex)), [bom])
  const lookup = useMemo(() => buildHexLookup(palette), [palette])

  // 侧栏只有 330px 宽，五个中文标签放不下；界面上用短名，完整名字放 title
  const PALETTE_SHORT: Partial<Record<typeof paletteSource, string>> = {
    optimized: '优化结果',
    library: '全色',
    kit: '套装',
    custom: '自定义',
  }
  // 每个来源一句话说明它是干什么的
  const PALETTE_HINT: Partial<Record<typeof paletteSource, string>> = {
    optimized: '「优化颜色」选出的方案',
    library: includeExtended ? 'MARD 完整 291 色' : 'MARD 标准 221 色',
    kit: '常见零售套装，在下面选档位',
    custom: '自己填 #RGB，一行一个',
  }

  const paletteOptions = VISIBLE_PALETTE_SOURCES.map((value) => ({
    value,
    label: PALETTE_SHORT[value] ?? PALETTE_SOURCE_LABELS[value],
    title: PALETTE_SOURCE_LABELS[value],
  }))

  const tooBig = (options: typeof renderOptions, scale: number): boolean => {
    if (!result) return false
    const size = estimateSvgSize(result, options)
    return Math.max(size.width, size.height) * scale > MAX_EXPORT_SIDE
  }

  const exportChartPng = async () => {
    if (!result || !fullPattern) return
    if (tooBig(renderOptions, exportScale)) {
      useStudio.setState({
        error: `导出尺寸会超过浏览器画布上限，请把「格子大小」或「导出倍数」调小。`,
      })
      return
    }
    setBusy(true)
    try {
      const blob = await svgToPngBlob(fullPattern.svg, fullPattern.width, fullPattern.height, exportScale)
      downloadBlob(blob, `beads-chart-${result.width}x${result.height}@${exportScale}x.png`)
    } catch (err) {
      useStudio.setState({ error: err instanceof Error ? err.message : 'PNG 导出失败' })
    } finally {
      setBusy(false)
    }
  }

  const exportChartSvg = () => {
    if (!result || !fullPattern) return
    downloadText(fullPattern.svg, `beads-chart-${result.width}x${result.height}.svg`, 'image/svg+xml')
  }

  const exportPixelPng = () => {
    if (!result) return
    const canvas = document.createElement('canvas')
    canvas.width = result.width
    canvas.height = result.height
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.putImageData(new ImageData(new Uint8ClampedArray(result.data), result.width, result.height), 0, 0)
    canvas.toBlob((blob) => {
      if (blob) downloadBlob(blob, 'beads-pixel-1x1.png')
    }, 'image/png')
  }

  if (!grid) {
    return (
      <div className="columns">
        <div className="stage-head">
          <div>
            <h1>③ 转拼豆图纸</h1>
          </div>
        </div>
        <Empty icon="grid_on" title="还没有网格">
          <div style={{ marginTop: 12 }}>
            <button className="btn waves-effect waves-light" onClick={goPrev}>
              ← 回到规范化
            </button>
          </div>
        </Empty>
      </div>
    )
  }

  // 预览为超大图纸自动降档 / 省略色号 / 退回方格，原因对用户来说只有一条：图纸太大
  const previewSimplified =
    preview && (previewOptions.cellSize < renderOptions.cellSize || preview.codesSuppressed || preview.beadSuppressed)

  return (
    <div className="columns viewer">
      <div>
        <div className="stage-head">
          <div>
            <h1>③ 转拼豆图纸</h1>
          </div>
          <span className="grow" />
          <button className="btn-flat btn-small waves-effect" onClick={goPrev}>
            ← 优化颜色
          </button>
        </div>

        <Panel
          title="拼豆图纸"
          hint={`${result?.width ?? 0} × ${result?.height ?? 0} 格 · ${bom.length} 个色号 · ${totalBeads.toLocaleString()} 颗豆`}
          actions={
            <>
              <span className="tiny muted">导出倍数</span>
              <select
                value={exportScale}
                onChange={(e) => setExportScale(Number(e.target.value))}
                style={{ width: 78 }}
              >
                {EXPORT_SCALES.map((s) => (
                  <option key={s} value={s}>
                    {s}×
                  </option>
                ))}
              </select>
              <button className="btn btn-small waves-effect waves-light" onClick={exportChartPng} disabled={busy}>
                {busy ? '导出中…' : '导出 PNG'}
              </button>
              <button className="btn-flat btn-small waves-effect" onClick={exportChartSvg}>
                导出 SVG
              </button>
            </>
          }
          tight
        >
          {preview && (
            <>
              {/* 主界面只做展示：图纸等比缩进容器，缩放/平移都到全屏里做 */}
              <div className="canvas-wrap pattern-host">
                <div className="pattern-svg" dangerouslySetInnerHTML={{ __html: preview.svg }} />
              </div>

              <div className="row" style={{ marginTop: 10, alignItems: 'center' }}>
                <button className="btn btn-small waves-effect waves-light" onClick={onOpenFullscreen}>
                  <i className="material-icons sm">fullscreen</i>
                  全屏看图
                </button>
                <button className="btn-flat btn-small waves-effect" onClick={exportPixelPng}>
                  导出 1:1 像素图
                </button>
              </div>

              {previewSimplified && (
                <div style={{ marginTop: 10 }}>
                  <Notice kind="warn">图纸太大，预览已简化以保证流畅。</Notice>
                </div>
              )}
            </>
          )}
        </Panel>

        <Panel
          title="用料清单"
          hint="按用量从多到少"
          actions={
            <>
              <button
                className="btn-flat btn-small waves-effect"
                disabled={!bom.length}
                onClick={() => downloadText(bomToCsv(bom, 'Beads Studio 用料清单'), 'beads-bom.csv', 'text/csv')}
              >
                导出 CSV
              </button>
              <button
                className="btn-flat btn-small waves-effect"
                disabled={!bom.length}
                onClick={() =>
                  downloadText(buildPaletteExport(palette, codeSystem, 'code'), `beads-codes-${codeSystem}.txt`)
                }
              >
                导出用到的色号
              </button>
            </>
          }
          tight
        >
          {bom.length ? (
            <div className="bom-wrap">
              <table className="bom">
                <thead>
                  <tr>
                    <th>色号</th>
                    <th>HEX</th>
                    <th style={{ textAlign: 'right' }}>数量</th>
                    <th style={{ textAlign: 'right' }}>占比</th>
                  </tr>
                </thead>
                <tbody>
                  {bom.map((r) => (
                    <tr key={r.hex}>
                      <td>
                        <span className="chip" style={{ background: r.hex }} />
                        <b className="mono">{r.code}</b>
                      </td>
                      <td className="mono">{r.hex}</td>
                      <td className="num">{r.count.toLocaleString()}</td>
                      <td className="num">{((r.count / Math.max(1, totalBeads)) * 100).toFixed(1)}%</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <Notice kind="warn">色板为空。</Notice>
          )}
        </Panel>
      </div>

      <div>
        <Panel title="色板来源">
          <Field label="用哪套颜色" hint={PALETTE_HINT[paletteSource]}>
            <Segmented
              value={paletteSource}
              onChange={(v) => setPaletteSource(v)}
              options={paletteOptions}
            />
          </Field>

          {paletteSource === 'kit' && (
            <Field label="套装规模">
              <Segmented
                value={String(kitSize)}
                onChange={(v) => setKitSize(Number(v) as KitSize)}
                options={KIT_SIZES.map((n) => ({ value: String(n), label: `${n}` }))}
              />
            </Field>
          )}

          {optimizedPalette.length === 0 && paletteSource !== 'optimized' && (
            <div style={{ marginBottom: 12 }}>
              <Notice kind="info">还没运行过配色优化。</Notice>
            </div>
          )}

          {paletteSource === 'optimized' && optimizedPalette.length === 0 && (
            <div style={{ marginBottom: 12 }}>
              <Notice kind="warn">
                还没有优化结果，请先到「优化颜色」运行一次。
              </Notice>
            </div>
          )}

          {paletteSource === 'library' && (
            <div style={{ marginBottom: 12 }}>
              <Check checked={includeExtended} onChange={setIncludeExtended}>
                包含扩展色号 P/Q/R/T/Y/ZG
              </Check>
            </div>
          )}

          {paletteSource === 'custom' && (
            <div style={{ marginBottom: 12 }}>
              <textarea
                rows={4}
                placeholder="一行一个，例如 #FAF4C8 或 A01"
                value={pasteText}
                onChange={(e) => setPasteText(e.target.value)}
              />
              <button
                className="btn btn-small waves-effect waves-light"
                style={{ marginTop: 8 }}
                onClick={() => {
                  const hexes = parsePaletteText(pasteText, libraryPalette, codeSystem)
                  if (!hexes.length) {
                    useStudio.setState({ error: '没有识别到有效色号' })
                    return
                  }
                  const map = new Map(libraryPalette.map((e) => [e.hex, e]))
                  setPalette(hexes.map((h) => map.get(h)).filter((e): e is NonNullable<typeof e> => Boolean(e)))
                }}
              >
                应用（{parsePaletteText(pasteText, libraryPalette, codeSystem).length} 个）
              </button>
            </div>
          )}
        </Panel>

        <Panel title="图纸样式">
          <Field label="绘制方式">
            <Segmented
              value={renderOptions.style}
              onChange={(v) => setRenderOptions({ style: v })}
              options={[
                { value: 'flat', label: '方格图纸' },
                { value: 'beads', label: '珠子预览' },
              ]}
            />
          </Field>

          <div style={{ display: 'grid', gap: 9 }}>
            <Check checked={renderOptions.codes} onChange={(v) => setRenderOptions({ codes: v })}>
              在格子上标注<b>色号</b>
            </Check>
            <Check checked={renderOptions.grid} onChange={(v) => setRenderOptions({ grid: v })}>
              绘制<b>网格线</b>（每格细线）
            </Check>
            <Check checked={renderOptions.rulers} onChange={(v) => setRenderOptions({ rulers: v })}>
              显示<b>行列标尺</b>
            </Check>
          </div>

          <div className="divider" />

          <Field
            label="粗线间隔"
            value={`每 ${renderOptions.majorEvery} 格`}
          >
            <input
              type="range"
              min={2}
              max={32}
              step={1}
              value={renderOptions.majorEvery}
              onChange={(e) => setRenderOptions({ majorEvery: Number(e.target.value) })}
            />
          </Field>

          <Field label="格子大小" value={`${renderOptions.cellSize} px`}>
            <input
              type="range"
              min={8}
              max={48}
              value={renderOptions.cellSize}
              onChange={(e) => setRenderOptions({ cellSize: Number(e.target.value) })}
            />
          </Field>

          {renderOptions.style === 'beads' && (
            <Field label="珠子间隙" value={`${renderOptions.gap} px`}>
              <input
                type="range"
                min={0}
                max={6}
                value={renderOptions.gap}
                onChange={(e) => setRenderOptions({ gap: Number(e.target.value) })}
              />
            </Field>
          )}

          <Field label="背景色">
            <input
              type="color"
              value={renderOptions.background}
              onChange={(e) => setRenderOptions({ background: e.target.value })}
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
        </Panel>

        <Panel title="量化设置">
          <Field label="颜色匹配算法">
            <select
              value={quantizeOptions.metric}
              onChange={(e) => setQuantizeOptions({ metric: e.target.value as DistanceMetric })}
            >
              {(Object.keys(METRIC_LABELS) as DistanceMetric[]).map((m) => (
                <option key={m} value={m}>
                  {METRIC_LABELS[m]}
                </option>
              ))}
            </select>
          </Field>
          <Field label="抖动">
            <Segmented
              value={quantizeOptions.dither}
              onChange={(v) => setQuantizeOptions({ dither: v })}
              options={[
                { value: 'none', label: '关闭' },
                { value: 'floyd-steinberg', label: 'Floyd–Steinberg' },
              ]}
            />
          </Field>
          <Check checked={quantizeOptions.quantize} onChange={(v) => setQuantizeOptions({ quantize: v })}>
            吸附到色板
          </Check>
        </Panel>

        <Panel title="色板用量" hint={`${bom.length} / ${palette.length} 色被用到`} tight>
          {palette.length ? (
            <div className="swatch-grid dense">
              {palette.map((e) => {
                const idx = lookup.get(e.hex)
                const count = idx === undefined ? 0 : counts[idx] ?? 0
                const used = usedSet.has(e.hex)
                return (
                  <div
                    key={e.hex}
                    className={`swatch static ${used ? '' : 'dimmed'}`}
                    style={{ background: e.hex, color: idealTextColor(e.rgb) }}
                    title={`${codeOf(e, codeSystem)} · ${e.hex} · ${count} 颗`}
                  >
                    {count > 0 && <span className="count">{count}</span>}
                    <div className="code">{codeOf(e, codeSystem) || e.hex.slice(1, 4)}</div>
                  </div>
                )
              })}
            </div>
          ) : (
            <Notice kind="warn">色板为空。</Notice>
          )}
        </Panel>

        <Panel title="图纸信息">
          <div className="stat-grid">
            <Stat k="图纸尺寸" v={`${result?.width ?? 0}×${result?.height ?? 0}`} small />
            <Stat k="总豆数" v={totalBeads.toLocaleString()} small />
            <Stat k="用到色号" v={bom.length} small />
            <Stat k="色板总量" v={palette.length} small />
          </div>
        </Panel>
      </div>
    </div>
  )
}
