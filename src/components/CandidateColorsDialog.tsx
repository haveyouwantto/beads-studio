import { useEffect, useMemo, useState } from 'react'
import { useStudio } from '../store/studio.ts'
import { codeOf, mardSeries, type PaletteEntry } from '../core/palette.ts'
import { idealTextColor } from '../core/color.ts'
import { formatTime } from '../core/storage.ts'

/**
 * 候选色选择弹窗。
 *
 * 配色优化不必把整本色号库都当成候选：按 MARD 系列（A/B/C/D/E/F/G/H…）分组，
 * 逐个颜色勾选，或者整组一键开关。没勾过任何颜色时 = 全部参与。
 *
 * 勾选结果存在 candidateHex 里（空数组表示全库参与）。
 */
export function CandidateColorsDialog({ onClose }: { onClose: () => void }) {
  const libraryPalette = useStudio((s) => s.libraryPalette)
  const candidateHex = useStudio((s) => s.candidateHex)
  const setCandidateHex = useStudio((s) => s.setCandidateHex)
  const candidateSets = useStudio((s) => s.candidateSets)
  const saveCandidateSet = useStudio((s) => s.saveCandidateSet)
  const deleteCandidateSet = useStudio((s) => s.deleteCandidateSet)
  const includeExtended = useStudio((s) => s.includeExtended)
  const codeSystem = useStudio((s) => s.codeSystem)

  // 本地草稿：点「应用」才写回 store，取消则不变
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(candidateHex.length ? candidateHex : libraryPalette.map((e) => e.hex)),
  )
  const [setName, setSetName] = useState('')

  const groups = useMemo(() => {
    const map = new Map<string, PaletteEntry[]>()
    for (const entry of libraryPalette) {
      const series = mardSeries(entry.codes.MARD ?? '') || '其他'
      const list = map.get(series)
      if (list) list.push(entry)
      else map.set(series, [entry])
    }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  }, [libraryPalette])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const selectedCount = selected.size
  const total = libraryPalette.length

  const toggleOne = (hex: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(hex)) next.delete(hex)
      else next.add(hex)
      return next
    })
  }

  const setSeries = (series: string, on: boolean) => {
    const target = groups.find(([name]) => name === series)?.[1] ?? []
    setSelected((prev) => {
      const next = new Set(prev)
      for (const e of target) {
        if (on) next.add(e.hex)
        else next.delete(e.hex)
      }
      return next
    })
  }

  return (
    <div className="modal-overlay open" onClick={onClose}>
      <div className="modal open modal-wide" onClick={(e) => e.stopPropagation()}>
        <header className="modal-head">
          <div>
            <h2>选择候选色</h2>
            <p className="tiny muted">
              已选 <b>{selectedCount}</b> / {total} 色
              {includeExtended ? ' · 含扩展色号' : ' · MARD A–M'}
            </p>
          </div>
          <span style={{ flex: 1 }} />
          <button className="btn-flat btn-small waves-effect" onClick={() => setSelected(new Set(libraryPalette.map((e) => e.hex)))}>
            全选
          </button>
          <button className="btn-flat btn-small waves-effect" onClick={() => setSelected(new Set())}>
            全不选
          </button>
          <button
            className="btn-flat btn-small waves-effect"
            onClick={() =>
              setSelected((prev) => {
                const next = new Set<string>()
                for (const e of libraryPalette) if (!prev.has(e.hex)) next.add(e.hex)
                return next
              })
            }
          >
            反选
          </button>
        </header>

        <div className="modal-content modal-body">
          {/* 多套候选色方案：存本地，换项目也能直接套用 */}
          <section className="set-block">
            <header className="series-head">
              <b className="series-name">方案</b>
              <span style={{ flex: 1 }} />
              <input
                className="set-name"
                type="text"
                placeholder="方案名"
                value={setName}
                onChange={(e) => setSetName(e.target.value)}
              />
              <button
                className="btn btn-small waves-effect waves-light"
                disabled={selectedCount === 0}
                onClick={() => {
                  saveCandidateSet(setName, [...selected])
                  setSetName('')
                }}
              >
                存为方案
              </button>
            </header>

            {candidateSets.length === 0 ? (
              <div className="tiny muted set-empty">把当前勾选存成方案，下次一键套用。</div>
            ) : (
              <ul className="set-list">
                {candidateSets.map((s) => (
                  <li key={s.id} className="set-item">
                    <div className="set-meta">
                      <div className="set-title">
                        {s.name}
                        <span className="tiny muted">
                          {' '}
                          {s.hexes.length} 色 · {formatTime(s.savedAt)}
                        </span>
                      </div>
                      {/* 让方案自己说明包含哪些颜色 */}
                      <div className="set-chips">
                        {s.hexes.slice(0, 24).map((h) => (
                          <i key={h} className="chip" style={{ background: h }} title={h} />
                        ))}
                        {s.hexes.length > 24 && <span className="tiny muted">+{s.hexes.length - 24}</span>}
                      </div>
                    </div>
                    <div className="row tight">
                      <button
                        className="btn-flat btn-small waves-effect"
                        onClick={() => setSelected(new Set(s.hexes.filter((h) => libraryPalette.some((e) => e.hex === h))))}
                      >
                        载入
                      </button>
                      <button
                        className="btn-flat btn-small waves-effect danger"
                        onClick={() => deleteCandidateSet(s.id)}
                      >
                        删除
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
          <div className="divider" />

          {groups.map(([series, entries]) => {
            const on = entries.filter((e) => selected.has(e.hex)).length
            return (
              <section key={series} className="series-block">
                <header className="series-head">
                  <b className="series-name">{series}</b>
                  <span className="tiny muted">
                    {on} / {entries.length}
                  </span>
                  <span style={{ flex: 1 }} />
                  <button className="btn-flat btn-small waves-effect" onClick={() => setSeries(series, true)}>
                    全选
                  </button>
                  <button className="btn-flat btn-small waves-effect" onClick={() => setSeries(series, false)}>
                    清空
                  </button>
                </header>

                <div className="candidate-grid">
                  {entries.map((entry) => {
                    const active = selected.has(entry.hex)
                    return (
                      <button
                        key={entry.hex}
                        type="button"
                        className={active ? 'candidate on' : 'candidate'}
                        style={{ background: entry.hex, color: idealTextColor(entry.rgb) }}
                        onClick={() => toggleOne(entry.hex)}
                        title={`${codeOf(entry, codeSystem)} · ${entry.hex}`}
                      >
                        <span className="candidate-check">{active ? '✓' : ''}</span>
                        <span className="candidate-code">{codeOf(entry, codeSystem)}</span>
                      </button>
                    )
                  })}
                </div>
              </section>
            )
          })}
        </div>

        <footer className="modal-foot">
          <span className="tiny muted">候选色越多，优化越慢</span>
          <span style={{ flex: 1 }} />
          <button className="btn-flat waves-effect" onClick={onClose}>
            取消
          </button>
          <button
            className="btn waves-effect waves-light"
            disabled={selectedCount === 0}
            onClick={() => {
              const all = selectedCount === total
              // 全选等价于「不筛选」，存空数组，之后新增色号也会自动纳入
              setCandidateHex(all ? [] : [...selected])
              onClose()
            }}
          >
            应用（{selectedCount} 色）
          </button>
        </footer>
      </div>
    </div>
  )
}
