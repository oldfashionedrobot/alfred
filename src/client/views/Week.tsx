import { useCallback, useEffect, useRef, useState } from 'react'
import type { ISODate, TodoView, WeekTask, WeekView } from '../../shared/types.ts'
import { ApiError, command, errorText, getTodo, getWeek } from '../api.ts'
import { longDate, periodLabel } from '../dates.ts'
import { DayPicker, NoticeBar, Tick, type Notice } from '../ui.tsx'
import Todo from './Todo.tsx'
import './week.css'

/**
 * Week — the planning surface. Two things and nothing else: the seven days of
 * the current week, and the To do panel. See "Week" in `.plan/views.md`.
 *
 * Overdue, Unplaced and Backlog were sections here and are gone. Each was a
 * filter over a list the panel now holds in full, so keeping both would have
 * shown the same task twice on one screen. Reset to backlog went with them —
 * it lives in the panel, reachable from either host.
 *
 * The current week only: nothing places outside it and nothing writes to a past
 * date, so there is no week navigation to build. No date is computed here
 * either — the picker offers `placeable_dates` exactly as the server sent it.
 *
 * Buttons, ticks, the picker and the notice bar are the shared primitives in
 * `../ui.tsx`; date formatting is `../dates.ts`. Neither is re-implemented here.
 */

type Run = (name: string, body: Record<string, unknown>) => void

interface RowProps {
  task: WeekTask
  /** The server's list, offered as given: never computed, filtered or extended. */
  placeable: ISODate[]
  today: ISODate
  /** A past day is context, not a surface: render it, never write to it. */
  readOnly: boolean
  busy: boolean
  run: Run
}

function WeekRow({ task, placeable, today, readOnly, busy, run }: RowProps) {
  const [picking, setPicking] = useState(false)

  return (
    <li className={`week-task${task.is_done ? ' week-task--done' : ''}`}>
      <div className="week-task__row">
        {/* can_complete is the server's word and the only thing consulted here.
            It is never inferred from is_past or from which section this is. */}
        <Tick
          done={task.is_done}
          disabled={!task.can_complete}
          label={`${task.is_done ? 'Untick' : 'Complete'} ${task.name}`}
          onToggle={() => run(task.is_done ? 'uncomplete' : 'complete', { task_id: task.id })}
        />

        <span className="week-task__name">{task.name}</span>

        {!readOnly && (
          <span className="week-task__actions">
            <button
              className="btn btn--small"
              aria-expanded={picking}
              aria-label={`Reschedule ${task.name}`}
              disabled={busy}
              onClick={() => setPicking((p) => !p)}
            >
              Move
            </button>
            <button
              className="btn btn--small"
              aria-label={`Unplan ${task.name}`}
              disabled={busy}
              onClick={() => {
                setPicking(false)
                run('unplan', { task_id: task.id })
              }}
            >
              Unplan
            </button>
          </span>
        )}
      </div>

      {picking && !readOnly && (
        <DayPicker
          dates={placeable}
          today={today}
          selected={task.planned_date}
          disabled={busy}
          onPick={(date) => {
            setPicking(false)
            run('place', { task_id: task.id, date })
          }}
        />
      )}
    </li>
  )
}

export default function Week() {
  const [view, setView] = useState<WeekView | null>(null)
  const [todo, setTodo] = useState<TodoView | null>(null)
  const [loading, setLoading] = useState(true)
  const [fatal, setFatal] = useState<string | null>(null)
  const [notice, setNotice] = useState<Notice>(null)
  const [busy, setBusy] = useState(false)
  const alive = useRef(true)

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  const showError = useCallback((e: unknown) => {
    setNotice({ text: errorText(e), tone: 'error' })
  }, [])

  /**
   * Both models — Week's own and the panel's — fetched together and replaced
   * wholesale. Never merged, never patched, and the panel never reads Week's.
   */
  const load = useCallback(async (first: boolean) => {
    try {
      const [week, panel] = await Promise.all([getWeek(), getTodo()])
      if (!alive.current) return
      setView(week)
      setTodo(panel)
      setFatal(null)
    } catch (e) {
      if (!alive.current) return
      // A failed refetch is not a failed write: it must not blank a screen that
      // is still showing a valid model.
      if (first) setFatal(errorText(e))
      else setNotice({ text: errorText(e), tone: 'error' })
    } finally {
      if (alive.current && first) setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load(true)
  }, [load])

  /** What the panel calls after a command of its own. */
  const refresh = useCallback(() => load(false), [load])

  const run: Run = useCallback(
    (name, body) => {
      setNotice(null)
      setBusy(true)
      void (async () => {
        try {
          await command(name, body)
        } catch (e) {
          if (!alive.current) return
          setNotice({ text: errorText(e), tone: 'error' })
          // 409: the model refused the gesture, the write did not happen and
          // the model on screen is still accurate — nothing to refetch.
          if (e instanceof ApiError && e.rejected) {
            setBusy(false)
            return
          }
        }
        await load(false)
        if (alive.current) setBusy(false)
      })()
    },
    [load],
  )

  if (loading) return <div className="state">Loading the week…</div>
  if (!view) return <div className="state state--error">{fatal ?? 'No week to show.'}</div>

  const { placeable_dates, today } = view

  return (
    <div className="week">
      <header className="week-head">
        <h1 className="week-head__title">This week</h1>
        <p className="week-head__range">{periodLabel(view.week_start, view.week_end)}</p>
      </header>

      <div className="week-days">
        {view.days.map((day) => (
          <section
            key={day.date}
            className={[
              'week-day',
              day.is_today ? 'week-day--today' : '',
              day.is_past ? 'week-day--past' : '',
            ]
              .filter(Boolean)
              .join(' ')}
            aria-label={`${longDate(day.date)}${day.is_today ? ' (today)' : ''}${
              day.is_past ? ' (past, read-only)' : ''
            }`}
          >
            <header className="week-day__head">
              <h2 className="week-day__title">{longDate(day.date)}</h2>
              {day.is_today && <span className="week-day__flag">Today</span>}
              {day.is_past && <span className="week-day__flag week-day__flag--past">Past</span>}
            </header>
            {day.tasks.length === 0 ? (
              <p className="week-empty">—</p>
            ) : (
              <ul className="week-list">
                {day.tasks.map((task) => (
                  <WeekRow
                    key={task.id}
                    task={task}
                    placeable={placeable_dates}
                    today={today}
                    readOnly={day.is_past}
                    busy={busy}
                    run={run}
                  />
                ))}
              </ul>
            )}
          </section>
        ))}
      </div>

      {/* On this screen the panel IS the planning surface, so it opens expanded. */}
      <Todo view={todo} onChanged={refresh} onError={showError} defaultOpen={true} busy={busy} />
      <Todo kind="backlog" view={todo} onChanged={refresh} onError={showError} defaultOpen={true} busy={busy} />

      <NoticeBar notice={notice} onDismiss={() => setNotice(null)} />
    </div>
  )
}
