import { useCallback, useEffect, useRef, useState } from 'react'
import type { HistoryColumn, HistoryRow, ISODate } from '../../shared/types.ts'
import { errorText, getHistory } from '../api.ts'
import { longDate, shortDate, weekday } from '../dates.ts'
import { NoticeBar, Sheet, type Notice } from '../ui.tsx'
import './history.css'

/**
 * History — the grid. Dates down, active daily tasks across, filled cells for
 * completions, one mood column. Read-only: nothing in the system writes to a
 * past date, so there is nothing here to edit.
 *
 * Dates are formatted by `../dates.ts` and nowhere else.
 */

const PAGE = 60

export default function History() {
  const [columns, setColumns] = useState<HistoryColumn[]>([])
  const [rows, setRows] = useState<HistoryRow[]>([])
  const [nextBefore, setNextBefore] = useState<ISODate | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<Notice>(null)
  // The row whose log is open. Held by row, not by date, so the sheet renders
  // from the model it was opened from and never re-derives it.
  const [reading, setReading] = useState<HistoryRow | null>(null)
  const alive = useRef(true)

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  useEffect(() => {
    void (async () => {
      try {
        const view = await getHistory({ limit: PAGE })
        if (!alive.current) return
        setColumns(view.columns)
        setRows(view.rows)
        setNextBefore(view.next_before)
      } catch (e) {
        if (!alive.current) return
        setError(errorText(e))
      } finally {
        if (alive.current) setLoading(false)
      }
    })()
  }, [])

  /* The one place anything accumulates across fetches: older pages are appended
     to the rows already on screen. `columns` is not touched — it is the active
     daily tasks, which cannot change between pages of the same grid, and taking
     it from an older page would be taking it from a staler read. */
  const loadEarlier = useCallback(() => {
    if (nextBefore === null || loadingMore) return
    setLoadingMore(true)
    setNotice(null)
    void (async () => {
      try {
        const view = await getHistory({ limit: PAGE, before: nextBefore })
        if (!alive.current) return
        setRows((prev) => prev.concat(view.rows))
        setNextBefore(view.next_before)
      } catch (e) {
        if (!alive.current) return
        setNotice({ text: errorText(e), tone: 'error' })
      } finally {
        if (alive.current) setLoadingMore(false)
      }
    })()
  }, [nextBefore, loadingMore])

  if (loading) return <div className="state">Loading history…</div>
  if (error) return <div className="state state--error">{error}</div>

  return (
    <div className="hist">
      <header className="hist-head">
        <h1 className="hist-head__title">History</h1>
        <p className="hist-head__sub">
          Daily tasks, most recent first. A record, not a checklist.
        </p>
      </header>

      {columns.length === 0 && rows.length === 0 ? (
        <p className="state">Nothing recorded yet.</p>
      ) : (
        <div className="hist-scroll" tabIndex={0} role="region" aria-label="History grid">
          <table className="hist-grid">
            <thead>
              <tr>
                <th scope="col" className="hist-h hist-h--date">
                  Date
                </th>
                <th scope="col" className="hist-h hist-h--mood">
                  <span className="hist-h__rot">Mood</span>
                </th>
                <th scope="col" className="hist-h hist-h--log">
                  <span className="hist-h__rot">Log</span>
                </th>
                {/* Rotated and clipped to fit, but the full name is the cell's
                    text, so it is the column's accessible name in every row. */}
                {columns.map((col) => (
                  <th key={col.task_id} scope="col" className="hist-h hist-h--task">
                    <span className="hist-h__rot">{col.name}</span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const dow = weekday(row.date)
                return (
                  <tr
                    key={row.date}
                    className={dow === 0 || dow === 6 ? 'hist-row hist-row--weekend' : 'hist-row'}
                  >
                    <th scope="row" className="hist-date">
                      {shortDate(row.date)}
                    </th>
                    <td className="hist-mood">
                      {row.mood && (
                        <span aria-label={row.mood.label} role="img">
                          {row.mood.emoji}
                        </span>
                      )}
                    </td>
                    {/* A journal entry is prose and will not fit a grid cell, so
                        the column says only whether there is one and opens it on
                        demand. A day with no entry gets nothing to click, not a
                        disabled control. */}
                    <td className="hist-log">
                      {row.log !== null && (
                        <button
                          type="button"
                          className="hist-log__open"
                          aria-label={`Read the log for ${shortDate(row.date)}`}
                          onClick={() => setReading(row)}
                        >
                          <span aria-hidden="true">✎</span>
                        </button>
                      )}
                    </td>
                    {columns.map((col) => {
                      const done = row.completed.includes(col.task_id)
                      return (
                        <td
                          key={col.task_id}
                          className={done ? 'hist-cell hist-cell--on' : 'hist-cell'}
                        >
                          {done && <span className="sr">done</span>}
                        </td>
                      )
                    })}
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {reading !== null && reading.log !== null && (
        <Sheet title={longDate(reading.date)} onClose={() => setReading(null)}>
          {reading.mood && (
            <p className="hist-read__mood">
              <span role="img" aria-label={reading.mood.label}>
                {reading.mood.emoji}
              </span>{' '}
              {reading.mood.label}
            </p>
          )}
          {/* Whitespace preserved: the entry was typed as prose and its line
              breaks are the author's. Read-only — History never writes. */}
          <p className="hist-read__log">{reading.log}</p>
        </Sheet>
      )}

      <div className="hist-foot">
        {nextBefore !== null ? (
          <button type="button" className="btn" onClick={loadEarlier} disabled={loadingMore}>
            {loadingMore ? 'Loading…' : 'Load earlier'}
          </button>
        ) : (
          rows.length > 0 && <p className="hist-end">Beginning of the record.</p>
        )}
      </div>

      <NoticeBar notice={notice} onDismiss={() => setNotice(null)} />
    </div>
  )
}
