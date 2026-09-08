import './day.css'
import { useEffect, useRef, useState, type CSSProperties, type UIEvent } from 'react'
import { arrayMove } from '@dnd-kit/sortable'
import { TaskEditor } from '../../TaskEditor.tsx'
import type { Cadence, DayTask, DayView, ISODate, TodoView } from '../../../shared/types.ts'
import { command, errorText, getDay, getTodo } from '../../api.ts'
import { longDate } from '../../dates.ts'
import { NoticeBar, Tick, placementMaxFor, type Notice } from '../../ui.tsx'
import Todo from '../Todo.tsx'
import { MoodAndLog } from './MoodAndLog.tsx'
import { TaskName, TaskRow } from './TaskRow.tsx'
import { DayStrip } from './DayStrip.tsx'
import { UpcomingPane } from './UpcomingPane.tsx'
import { CaptureSheet } from './CaptureSheet.tsx'
import { DragBand } from './DragBand.tsx'

/*
 * Day — the doing surface.
 *
 * Data rule: fetch the models, render them,
 * post a named command, refetch and replace wholesale. Nothing derived from a
 * model is held in state, nothing is sorted or filtered here — `view.active`
 * and `view.completed` arrive in render order. The one exception is `orderIds`,
 * the reorder edit state, which holds a locally rearranged id list until the
 * toggle closes.
 *
 * Day fetches TWO models: its own and the To do panel's. `placeable_dates` rides
 * on DayView exactly so that the picker and the server's 409 on `place` cannot
 * disagree — and it is also the list of PANES,
 * so the days you can swipe to and the days you can place on are one derivation.
 *
 * Since v8 this is the only task surface: Week is deleted and its seven day
 * sections are the panes of the track here. Today's pane is the whole Day view;
 * the rest show what is placed on that date and cannot be ticked.
 */

// --- shell ------------------------------------------------------------------

export default function Day() {
  const [view, setView] = useState<DayView | null>(null)
  const [todo, setTodo] = useState<TodoView | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [reloads, setReloads] = useState(0)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<Notice>(null)

  const [capturing, setCapturing] = useState(false)
  /** Capture opened from "Add task" precheck it; the FAB does not. */
  const [captureToday, setCaptureToday] = useState(false)
  /** The row whose editor is open. Resolved at render, never held — see below. */
  const [editingId, setEditingId] = useState<number | null>(null)
  const [pickerFor, setPickerFor] = useState<number | null>(null)

  // The reorder edit state — the one locally held arrangement in the client.
  const [orderIds, setOrderIds] = useState<number[] | null>(null)

  // Which pane is showing. NOT the source of truth for the scroll position —
  // the track is, and this is read back off it. A swipe and a button press then
  // agree by construction rather than by being kept in step.
  const trackRef = useRef<HTMLDivElement>(null)
  const [paneIndex, setPaneIndex] = useState(0)

  /** The distance between two panes: their width plus the flex gap. */
  const paneStep = (track: HTMLDivElement): number => {
    const kids = track.children
    if (kids.length < 2) return 0
    return (kids[1] as HTMLElement).offsetLeft - (kids[0] as HTMLElement).offsetLeft
  }

  const goTo = (i: number) => {
    const track = trackRef.current
    if (!track || i < 0 || i >= track.children.length) return
    track.scrollTo({ left: i * paneStep(track), behavior: 'smooth' })
  }

  const onTrackScroll = (e: UIEvent<HTMLDivElement>) => {
    const track = e.currentTarget
    const step = paneStep(track)
    if (step <= 0) return
    const i = Math.round(track.scrollLeft / step)
    setPaneIndex(Math.min(track.children.length - 1, Math.max(0, i)))
  }

  useEffect(() => {
    let alive = true
    setLoadError(null)
    Promise.all([getDay(), getTodo()])
      .then(([d, t]) => {
        if (!alive) return
        setView(d)
        setTodo(t)
      })
      .catch((e: unknown) => {
        if (alive) setLoadError(errorText(e))
      })
    return () => {
      alive = false
    }
  }, [reloads])

  /** Refetch both models and replace them wholesale — never merged, never patched. */
  async function refresh(): Promise<void> {
    try {
      const [d, t] = await Promise.all([getDay(), getTodo()])
      setView(d)
      setTodo(t)
    } catch (e: unknown) {
      // Only the refetch failed. The write it followed did happen, and saying
      // otherwise would send the user to redo it.
      setNotice({ tone: 'error', text: `Saved, but the screen is out of date. ${errorText(e)}` })
    }
  }

  async function run(
    name: string,
    body: Record<string, unknown> = {},
    okText?: string,
  ): Promise<boolean> {
    setBusy(true)
    setNotice(null)
    try {
      try {
        await command(name, body)
      } catch (e: unknown) {
        // The write did not happen. A 409 in particular means the model refused
        // the gesture and the screen is still accurate, so nothing is refetched.
        setNotice({ tone: 'error', text: errorText(e) })
        return false
      }
      // Two catches, deliberately: past this line the write HAS happened, and a
      // failed refetch must never be reported as a failed command.
      if (okText) setNotice({ tone: 'info', text: okText })
      await refresh()
      return true
    } finally {
      setBusy(false)
    }
  }

  if (!view || !todo) {
    if (loadError) {
      return (
        <div className="state state--error">
          <p>Could not load today. {loadError}</p>
          <button className="btn" onClick={() => setReloads((n) => n + 1)}>
            Try again
          </button>
        </div>
      )
    }
    return <div className="state">Loading today…</div>
  }

  const reordering = orderIds !== null

  // Every row on the screen, today's and the days beside it, so the edit button
  // works wherever it is drawn.
  const editing =
    editingId === null
      ? null
      : ([...view.active, ...view.completed, ...view.upcoming.flatMap((d) => d.tasks)].find(
          (t) => t.id === editingId,
        ) ?? null)
  const byId = new Map(view.active.map((t) => [t.id, t]))
  // In the edit state the locally held arrangement is rendered; otherwise the
  // server's order, exactly as given.
  const rows: DayTask[] = orderIds
    ? orderIds.flatMap((id) => {
        const t = byId.get(id)
        return t ? [t] : []
      })
    : view.active

  // Bands never mix. Rather than guarding a drag that crosses them, each band
  // is its own drag context — crossing is not something that can be expressed.
  const bands = {
    baseline: rows.filter((t) => t.is_baseline),
    rest: rows.filter((t) => !t.is_baseline),
  }

  const reorderBand = (band: 'baseline' | 'rest', from: number, to: number) => {
    const moved = arrayMove(bands[band], from, to).map((t) => t.id)
    const other = bands[band === 'baseline' ? 'rest' : 'baseline'].map((t) => t.id)
    setOrderIds(band === 'baseline' ? [...moved, ...other] : [...other, ...moved])
  }

  const maxFor = (cadence: Cadence | null): ISODate | null =>
    placementMaxFor(view.placement, view.placeable_dates, cadence)

  const toggleReorder = async () => {
    if (!reordering) {
      setPickerFor(null)
      setOrderIds(view.active.map((t) => t.id))
      return
    }
    // Cleared only once the write has landed: clearing first threw the
    // arrangement away on failure, silently (D5).
    if (await run('set_task_order', { task_ids: orderIds ?? [] })) setOrderIds(null)
  }

  return (
    <div className="day-root" aria-busy={busy}>
      <header className="day-header">
        <h1 className="day-date">{longDate(view.date)}</h1>
      </header>

      {/* The week, as panes: today first, then one per day through Saturday.
          A snapping scroll container — the browser's own gesture, no library and
          no handler of ours. The strip above drives it and reads back from it.

          data-locked freezes it during a reorder: that edit state is today-only,
          so there is nowhere to swipe to, and a dnd-kit context inside a snapping
          scroller is the interaction that cost two wrong fixes in v4. */}
      {/* Only when there is somewhere to go. On a Saturday there is one pane and
          the screen is exactly what it was before v8. */}
      {view.upcoming.length > 0 && (
        <DayStrip
          dates={view.week_dates}
          today={view.date}
          panes={view.placeable_dates}
          // Index-aligned with placeable_dates, like the panes themselves: today
          // is what is still to do, and an upcoming pane is already filtered to
          // what is outstanding on it.
          counts={[view.active.length, ...view.upcoming.map((u) => u.tasks.length)]}
          index={paneIndex}
          onGo={goTo}
          disabled={busy || reordering}
        />
      )}

      <div
        className="day-track"
        ref={trackRef}
        onScroll={onTrackScroll}
        tabIndex={0}
        role="region"
        aria-label="This week, day by day"
        data-locked={reordering || undefined}
      >
        <div className="day-pane day-pane--today">
          <section className="day-section" aria-label="Active tasks">
            <div className="day-section-bar">
              <h2 className="day-h2">Today</h2>
              {/* The short path to "something I am doing today": capture, with
                  the day already chosen. The FAB beside it captures to the
                  backlog, which is the other half of the same gesture. */}
              <div className="day-section-actions">
                <button
                  className="btn btn--small btn--quiet"
                  onClick={() => {
                    setCaptureToday(true)
                    setCapturing(true)
                  }}
                  disabled={busy || reordering}
                >
                  Add task
                </button>
                <button
                  className="btn btn--small btn--quiet"
                  aria-pressed={reordering}
                  onClick={toggleReorder}
                  disabled={busy || view.active.length === 0}
                >
                  {reordering ? 'Done reordering' : 'Reorder'}
                </button>
              </div>
            </div>

            {rows.length === 0 ? (
              <p className="day-empty">Nothing on today's list.</p>
            ) : reordering ? (
              <>
                <p className="day-hint">Drag to rearrange. Baseline tasks stay above the rest.</p>
                {(['baseline', 'rest'] as const).map((band) =>
                  bands[band].length === 0 ? null : (
                    <DragBand
                      key={band}
                      tasks={bands[band]}
                      onReorder={(from, to) => reorderBand(band, from, to)}
                    />
                  ),
                )}
              </>
            ) : (
              <ul className="day-list">
                {rows.map((task, i) => {
                  const prev = i > 0 ? rows[i - 1] : undefined
                  return (
                    <TaskRow
                      key={task.id}
                      task={task}
                      today={view.date}
                      bandStart={prev !== undefined && prev.is_baseline && !task.is_baseline}
                      busy={busy}
                      onComplete={() => run('complete', { task_id: task.id })}
                      onUnplan={() => run('unplan', { task_id: task.id })}
                      placeable={view.placeable_dates}
                      placeableMax={maxFor(task.cadence)}
                      onEdit={() => setEditingId(task.id)}
                      pickerOpen={pickerFor === task.id}
                      onOpenPicker={() => setPickerFor(task.id)}
                      onClosePicker={() => setPickerFor(null)}
                      onPlace={async (date) => {
                        if (await run('place', { task_id: task.id, date })) setPickerFor(null)
                      }}
                    />
                  )
                })}
              </ul>
            )}
          </section>

          {/* Period-satisfied, not "done today": a weekly task ticked on Tuesday
              belongs here all week, and a task placed today can arrive here already
              satisfied by an earlier completion in the same period. */}
          {view.completed.length > 0 && (
            <section className="day-section" aria-label="Completed tasks">
              <h2 className="day-h2">Completed</h2>
              <ul className="day-list">
                {view.completed.map((task) => (
                  <li
                    key={task.id}
                    className="day-row day-row--done"
                    data-colour={task.color ? '' : undefined}
                    style={task.color ? ({ '--task-colour': task.color } as CSSProperties) : undefined}
                  >
                    <div className="day-row-main">
                      <Tick
                        done
                        label={`Untick ${task.name}`}
                        onToggle={() => run('uncomplete', { task_id: task.id })}
                      />
                      <TaskName task={task} />
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>

        {/* Placed tasks only, and only those still outstanding — a done task adds
            no load to Thursday. Dailies are absent because one can never hold a
            planned_date. The server decides all of this; this maps what it sent. */}
        {view.upcoming.map((day) => (
          <UpcomingPane
            key={day.date}
            day={day}
            today={view.date}
            placeable={view.placeable_dates}
            placeableMax={maxFor}
            busy={busy}
            pickerFor={pickerFor}
            onOpenPicker={(id) => setPickerFor(id)}
            onClosePicker={() => setPickerFor(null)}
            onUnplan={(id) => run('unplan', { task_id: id })}
            onEdit={(id) => setEditingId(id)}
            onPlace={async (id, date) => {
              if (await run('place', { task_id: id, date })) setPickerFor(null)
            }}
          />
        ))}
      </div>

      {/* Collapsed here: the list above is arranged for doing, and the panel is
          for the moment you ask "what else is there?" */}
      <Todo
        view={todo}
        onChanged={refresh}
        onError={(e: unknown) => setNotice({ tone: 'error', text: errorText(e) })}
        busy={busy || reordering}
      />
      <Todo kind="backlog"
        view={todo}
        onChanged={refresh}
        onError={(e: unknown) => setNotice({ tone: 'error', text: errorText(e) })}
        busy={busy || reordering}
      />

      <MoodAndLog
        view={view}
        // Frozen during a reorder: a mood tap refetches, and the id list would
        // then be reconciled against a new model by dropping rows (D7).
        disabled={busy || reordering}
        onSetMood={(slug) => run('set_mood', { slug })}
        onSetLog={(text) => run('set_log', { text })}
      />

      <button
        className="day-fab"
        onClick={() => {
          setCaptureToday(false)
          setCapturing(true)
        }}
        aria-label="Capture a new item"
        disabled={busy}
      >
        +
      </button>

      <NoticeBar notice={notice} onDismiss={() => setNotice(null)} />

      {capturing && (
        <CaptureSheet
          busy={busy}
          today={view.date}
          defaultPlaceToday={captureToday}
          onClose={() => setCapturing(false)}
          onCreate={async (patch) => {
            if (await run('create_task', patch, `Captured “${String(patch.name)}”.`)) {
              setCapturing(false)
            }
          }}
          onCreateMany={async (names, plannedDate) => {
            const said = names.length === 1 ? 'Captured 1 item.' : `Captured ${names.length} items.`
            if (await run('create_tasks', { names, planned_date: plannedDate }, said)) {
              setCapturing(false)
            }
          }}
        />
      )}

      {/*
        The editor, opened from a row's edit button. Resolved from the live model
        at render rather than held, so a refetch behind an open sheet cannot leave
        it editing a stale row — the same rule the To do panel follows.

        A distinct button rather than the row: a tap on Day is a tap you make
        while working, so a name is not an edit target here.
      */}
      {editing !== null && (
        <TaskEditor
          task={editing}
          categories={todo?.categories ?? []}
          locked={busy || reordering}
          today={view.date}
          placeable={view.placeable_dates}
          placeableMax={maxFor(editing.cadence)}
          onClose={() => setEditingId(null)}
          onSave={(patch) => {
            setEditingId(null)
            run('update_task', patch)
          }}
          onArchive={(id) => {
            setEditingId(null)
            run('archive_task', { id })
          }}
        />
      )}
    </div>
  )
}
