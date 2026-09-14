import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react'
import type { HistoryColumn, HistoryRow, ISODate } from '../../shared/types.ts'
import { command, errorText, getHistory } from '../api.ts'
import { longDate, shortDate, weekday } from '../dates.ts'
import { NoticeBar, Sheet, type Notice } from '../ui.tsx'
import './history.css'

/**
 * The Tracker — the grid. Dates down, active daily tasks across, filled cells
 * for completions, one mood column.
 *
 * Writable since v16, and only here: clicking a cell CORRECTS a day you got
 * wrong. That is a different gesture from ticking something off, and the two
 * are kept apart in the model rather than by convention — `complete` takes no
 * date and cannot be handed one, so the everyday path still lands on today
 * whatever a client tries. This is where you fix a day you missed; it is not a
 * second place to work.
 *
 * What it costs is fidelity. The grid used to record when a thing was MARKED; a
 * corrected cell is now indistinguishable from one marked on the day. That is
 * the price of being able to fix a Tuesday you forgot, and it is only ever paid
 * deliberately, by somebody coming here to change one.
 *
 * The screen is called Tracker; the component, the file, `/api/history` and
 * `HistoryView` are not. v15 renamed the label and nothing else — carrying the
 * new name through the stack would touch every browser spec and both reference
 * documents to change no behaviour.
 *
 * Dates are formatted by `../dates.ts` and nowhere else.
 */

const PAGE = 60

/**
 * One cell's identity: the pair, never the task alone.
 *
 * `@` separates them because a task id is digits and a date is `YYYY-MM-DD`, so
 * neither half can contain one and two different pairs cannot collide.
 */
const cellKey = (taskId: number, date: ISODate): string => `${taskId}@${date}`

/**
 * One row with one task's completion added or taken away — the whole of what a
 * correction changes, which is why patching can stand in for a refetch.
 *
 * `includes` guards the add because a correction and its undo can both be in
 * flight, and their replies can land in either order; only `.includes` ever
 * reads this array, but a duplicated id would ride along in the accumulated
 * rows for as long as the screen was open.
 */
const withCompletion = (row: HistoryRow, taskId: number, done: boolean): HistoryRow => ({
  ...row,
  completed: done
    ? row.completed.includes(taskId)
      ? row.completed
      : [...row.completed, taskId]
    : row.completed.filter((id) => id !== taskId),
})

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
  /*
   * What a cell has been ASKED to be, held until the model agrees.
   *
   * Keyed by the PAIR, which is the one thing that differs from the mechanism
   * this mirrors. `Day.tsx`'s intent map is `Map<task_id, boolean>`, and that is
   * right there, where a task appears on the screen exactly once. Here the same
   * task appears on every row, so keying by task alone would mean clicking
   * Tuesday lit up Wednesday and every other day in that column.
   *
   * Predicted at all for the reason the ticks are: this is a round trip to a
   * machine that may have just woken from scale-to-zero, and a cell that does
   * not fill until the answer lands reads as a click that missed.
   */
  const [intent, setIntent] = useState<ReadonlyMap<string, boolean>>(new Map())
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

  /** A cell as the screen should draw it: the model, or what was asked of it. */
  const shownDone = (row: HistoryRow, taskId: number): boolean => {
    const want = intent.get(cellKey(taskId, row.date))
    return want === undefined ? row.completed.includes(taskId) : want
  }

  /*
   * A corrected cell patches the one row it changed and does NOT refetch. This
   * is the first place the app's data rule bends, so the reason is written down
   * rather than left to be rediscovered.
   *
   * Everywhere else the client posts a command and refetches the view wholesale.
   * The Tracker cannot, because it is the one screen that ACCUMULATES:
   * `loadEarlier` above concatenates older pages onto the rows already on
   * screen, so refetching the first page after a toggle would throw away every
   * page somebody had paged back through — correct a cell from six months ago
   * and the grid snaps back to the last sixty days, losing the place you were
   * looking at. That is a property of this screen rather than a preference.
   *
   * Patching is honest here because the write is the narrowest in the system:
   * one task, one date, a completion row that either exists or does not. There
   * is nothing else a refetch would have told us.
   *
   * No confirm, because every other tick in the app has none and a confirm on a
   * grid cell is clumsy. The cost is real and accepted: this is a dense grid of
   * past days, so a mis-click damages an older record rather than today's. What
   * stands in for the confirm is that clicking again puts it straight back.
   */
  const toggleCell = async (row: HistoryRow, taskId: number): Promise<void> => {
    // From what is on SCREEN, not from the model — the model has not caught up
    // with a click still in flight, and the person is answering the screen.
    const want = !shownDone(row, taskId)
    const key = cellKey(taskId, row.date)
    setIntent((m) => new Map(m).set(key, want))
    setNotice(null)
    try {
      await command('set_completion', { task_id: taskId, date: row.date, done: want })
      if (!alive.current) return
      // Against `prev` rather than against the row this closure captured: a
      // page of older rows may have been appended while the command was away.
      setRows((prev) =>
        prev.map((r) => (r.date === row.date ? withCompletion(r, taskId, want) : r)),
      )
    } catch (e) {
      // The write did not happen, so the prediction is a lie. It is dropped
      // below and the screen is accurate again the moment it is.
      if (alive.current) setNotice({ text: errorText(e), tone: 'error' })
    } finally {
      if (alive.current)
        setIntent((m) => {
          // A newer click owns the cell now; it will clear itself when it
          // settles. Without this a quick correct-and-undo would lose the second
          // click's prediction the moment the first one's reply arrived.
          if (m.get(key) !== want) return m
          const next = new Map(m)
          next.delete(key)
          return next
        })
    }
  }

  /* Both states keep the `.hist` root. history.css hangs the Tracker's escape
     from the 720px reading column off `.app:has(> .hist)`, so a state that
     drops the wrapper is drawn in the narrow column and the whole screen snaps
     wide the moment the grid lands. */
  if (loading)
    return (
      <div className="hist">
        <div className="state">Loading the tracker…</div>
      </div>
    )
  if (error)
    return (
      <div className="hist">
        <div className="state state--error">{error}</div>
      </div>
    )

  return (
    <div className="hist">
      <header className="hist-head">
        <h1 className="hist-head__title">Tracker</h1>
        {/* "A record, not a checklist" retired with v16, which made the cells
            writable. What replaces it has to carry both halves: the record can
            be corrected, and correcting is not working. The doing happens on To
            do, and this line is the last thing standing between a dense grid of
            checkboxes and somebody using it as a second list. */}
        <p className="hist-head__sub">
          Daily tasks, most recent first. A record you can correct, not a list to work from.
        </p>
      </header>

      {columns.length === 0 && rows.length === 0 ? (
        <p className="state">Nothing recorded yet.</p>
      ) : (
        <div className="hist-scroll" tabIndex={0} role="region" aria-label="Tracker grid">
          <table className="hist-grid">
            <thead>
              <tr>
                <th scope="col" className="hist-h hist-h--log">
                  <span className="hist-h__rot">Log</span>
                </th>
                <th scope="col" className="hist-h hist-h--date">
                  Date
                </th>
                <th scope="col" className="hist-h hist-h--mood">
                  <span className="hist-h__rot">Mood</span>
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
                    {columns.map((col) => {
                      const done = shownDone(row, col.task_id)
                      return (
                        <td
                          key={col.task_id}
                          className={done ? 'hist-cell hist-cell--on' : 'hist-cell'}
                          style={
                            done && col.color
                              ? ({ '--task-colour': col.color } as CSSProperties)
                              : undefined
                          }
                        >
                          {/* The control goes INSIDE the cell; the `td` does not
                              become it. A `td` carrying role="checkbox" stops
                              being a grid cell to a screen reader, which loses
                              the row and column position that is the only thing
                              making a cell mean anything. Same shape as the log
                              column above, and as `ui.tsx`'s Tick.

                              The name carries BOTH coordinates. A checkbox in a
                              grid named only for its task appears once per row in
                              a screen reader's list with nothing to tell the
                              copies apart, and is unreachable by voice. The long
                              date rather than the row header's short form,
                              because this one is read aloud rather than scanned.

                              The hidden "done" is the cell's VALUE as text.
                              `aria-checked` carries the state to the control
                              itself, but a cell holding nothing but a control
                              reads as empty when a row is read across — and the
                              pattern across a row is what this grid is for. */}
                          <button
                            type="button"
                            className="hist-cell__tick"
                            role="checkbox"
                            aria-checked={done}
                            aria-label={`${col.name}, ${longDate(row.date)}`}
                            onClick={() => void toggleCell(row, col.task_id)}
                          >
                            {done && <span className="sr">done</span>}
                          </button>
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
