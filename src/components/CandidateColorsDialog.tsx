import { useEffect, useMemo, useRef, useState } from 'react'
import { useStudio } from '../store/studio.ts'
import { codeOf, mardSeries, swatchHex, type PaletteEntry } from '../core/palette.ts'
import { buildPaletteExport, downloadText, parsePaletteFile, safeFileName } from '../core/export.ts'
import { formatTime } from '../core/storage.ts'
import { Swatch } from './ui.tsx'

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
  // 方案预览的圆点：h01 这类半透明豆按观感色画，和别的色板走同一套
  const swatchByHex = useMemo(() => new Map(libraryPalette.map((e) => [e.hex, swatchHex(e)])), [libraryPalette])
  const entryByHex = useMemo(() => new Map(libraryPalette.map((e) => [e.hex, e])), [libraryPalette])
  const importRef = useRef<HTMLInputElement>(null)
  const [importNote, setImportNote] = useState('')

  /** 导出一个方案：色号列表，一行一个 */
  const exportSet = (name: string, hexes: string[]) => {
    const entries = hexes.map((h) => entryByHex.get(h)).filter((e): e is PaletteEntry => Boolean(e))
    if (!entries.length) return
    downloadText(
      buildPaletteExport(entries, codeSystem, 'code'),
      `${safeFileName(name)}-色号-${codeSystem}.txt`,
    )
  }

  /** 导入：自动认 JSON / HEX 列表 / 色号列表（就是优化结果那三种导出格式） */
  const importFile = async (file: File) => {
    try {
      const hexes = parsePaletteFile(await file.text(), libraryPalette, codeSystem)
      if (!hexes.length) {
        setImportNote('没认出里面的色号或 HEX')
        return
      }
      const name = file.name.replace(/\.[^.]+$/, '').trim() || `导入的方案`
      saveCandidateSet(name, hexes)
      setImportNote(`导入 ${hexes.length} 色`)
    } catch {
      setImportNote('文件读取失败')
    }
  }

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
              {importNote && <span className="tiny muted">{importNote}</span>}
              <span style={{ flex: 1 }} />
              <button
                className="btn-flat btn-small waves-effect"
                onClick={() => importRef.current?.click()}
                title="导入色号列表 / HEX 列表 / JSON"
              >
                导入
              </button>
              <input
                ref={importRef}
                type="file"
                accept=".json,.txt,application/json,text/plain"
                hidden
                onChange={(e) => {
                  const file = e.target.files?.[0]
                  if (file) void importFile(file)
                  e.target.value = ''
                }}
              />
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
                          <Swatch key={h} size="dot" hex={swatchByHex.get(h) ?? h} title={h} />
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
                      <button className="btn-flat btn-small waves-effect" onClick={() => exportSet(s.name, s.hexes)}>
                        导出
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

                <div className="swatch-grid">
                  {entries.map((entry) => (
                    <Swatch
                      key={entry.hex}
                      hex={swatchHex(entry)}
                      code={codeOf(entry, codeSystem)}
                      title={`${codeOf(entry, codeSystem)} · ${entry.hex}`}
                      selected={selected.has(entry.hex)}
                      onClick={() => toggleOne(entry.hex)}
                    />
                  ))}
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
