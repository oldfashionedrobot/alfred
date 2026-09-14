import './day.css'
import { useEffect, useId, useRef, useState } from 'react'
import { arrayMove } from '@dnd-kit/sortable'
import { TaskEditor } from '../../TaskEditor.tsx'
import type { Cadence, DayTask, DayView, ISODate, TodoView } from '../../../shared/types.ts'
import { command, errorText, getDay, getTodo } from '../../api.ts'
import { addDays, longDate } from '../../dates.ts'
import { NoticeBar, placementMaxFor, type Notice } from '../../ui.tsx'
import Backlog from '../Todo.tsx'
import { MoodAndLog, MoodButton } from './MoodAndLog.tsx'
import { TaskRow } from './TaskRow.tsx'
import { DayStrip } from './DayStrip.tsx'
import { UpcomingPane } from './UpcomingPane.tsx'
import { CaptureSheet } from './CaptureSheet.tsx'
import { Sheet } from '../../ui.tsx'
import { DragBand } from './DragBand.tsx'
import { Track, usePagedTrack } from './PagedTrack.tsx'

/*
 * Day — the doing surface.
 *
 * Data rule: fetch the models, render them,
 * post a named command, refetch and replace wholesale. Nothing derived from a
 * model is held in state, nothing is sorted here — `view.tasks` arrives in
 * render order, one list with done sunk to the bottom. The one exception is
 * `orderIds`, the reorder edit state, which holds a locally rearranged id list
 * until the toggle closes.
 *
 * Day fetches TWO models: its own and the backlog's. `placeable_dates` rides
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
  // Names the one task section. useId because two Day instances would otherwise
  // hand a screen reader the same id twice.
  const todayHeadingId = useId()
  const [view, setView] = useState<DayView | null>(null)
  const [todo, setTodo] = useState<TodoView | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [reloads, setReloads] = useState(0)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<Notice>(null)

  const [capturing, setCapturing] = useState(false)
  /** The mood and log sheet, opened from the date heading. */
  const [moodOpen, setMoodOpen] = useState(false)
  /** Capture opened from "Add task" precheck it; the FAB does not. */
  const [captureToday, setCaptureToday] = useState(false)
  /** The row whose editor is open. Resolved at render, never held — see below. */
  const [editingId, setEditingId] = useState<number | null>(null)
  const [pickerFor, setPickerFor] = useState<number | null>(null)

  // The reorder edit state — the one locally held arrangement in the client.
  const [orderIds, setOrderIds] = useState<number[] | null>(null)

  /*
   * What the person has ASKED a row's done state to be, held until the model
   * agrees. Id → the state they asked for.
   *
   * `complete` is a round trip to a machine that may have just woken from
   * scale-to-zero, and until it answers the box does not move — which reads as a
   * tap that missed. This is the SECOND thing the client holds that it did not
   * derive from a model, `orderIds` being the first, and it is named here so it
   * stays the second. Nothing else is predicted.
   *
   * An intent rather than a set of ids in flight, because the command has to be
   * chosen from what is ON SCREEN. Reading the model instead re-sent `complete`
   * for somebody who was looking at a ticked box and meant to undo; guarding
   * against that by ignoring the second tap only moved the problem, and dropped
   * a legitimate quick undo instead.
   *
   * Only the box is predicted, not the position: the re-sort waits for the
   * refetch, or the row would leave from under the finger that tapped it.
   */
  const [intent, setIntent] = useState<ReadonlyMap<number, boolean>>(new Map())

  /*
   * The last command in flight for a row, so the next one waits for it.
   *
   * Two taps send two commands, and without this they race: the second can reach
   * the server first, so an `uncomplete` lands before the `complete` it was
   * undoing and the row ends up done when the person asked for the opposite.
   * A ref rather than state — nothing renders from it, and a re-render between
   * the two taps would otherwise lose the chain.
   */
  const inFlight = useRef(new Map<number, Promise<unknown>>())

  // The week's panes. Named rather than destructured flat, because the backlog
  // track below is a second instance of the same hook and `index` cannot mean
  // both.
  const days = usePagedTrack()

  /*
   * WHICH WEEK HAS PANES. Null is this one, which is what the server answers
   * when asked nothing.
   *
   * It is state rather than a parameter threaded at the call site because three
   * separate things depend on it and would otherwise each grow their own idea of
   * it: the fetch, the refetch after a command, and where the track lands when a
   * week arrives. `date` and `tasks` are unaffected — those are today's whatever
   * is being viewed, because the same-day rule is a rule about writes.
   */
  const [week, setWeek] = useState<ISODate | null>(null)
  /** Which pane to land on when a week's panes arrive. */
  const [landOn, setLandOn] = useState<'first' | 'last'>('first')

  useEffect(() => {
    let alive = true
    setLoadError(null)
    Promise.all([getDay(week ?? undefined), getTodo()])
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
  }, [reloads, week])

  /** Refetch both models and replace them wholesale — never merged, never patched. */
  async function refresh(): Promise<void> {
    try {
      // The week goes with it. Without this a command fired from a later pane —
      // an unplan, a move — would refetch THIS week and bounce the view home.
      const [d, t] = await Promise.all([getDay(week ?? undefined), getTodo()])
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

  /*
   * Where the track sits when a week's panes arrive.
   *
   * `usePagedTrack` reads its index back off `scrollLeft`, which is right while
   * the pane SET is stable and wrong the moment it is replaced: loading a week
   * leaves the scroller where it was, so you land mid-week on an index that
   * describes the week you just left.
   *
   * Above the early return, not beside the code it serves — a hook after a
   * conditional return is a hook React will not see on every render. Keyed on
   * the viewed week's Sunday, so it fires when the panes change and at no other
   * time.
   */
  const viewedWeek = view?.week_dates[0] ?? null
  const paneCount = view?.panes.length ?? 0
  useEffect(() => {
    if (viewedWeek === null) return
    days.goTo(landOn === 'first' ? 0 : paneCount - 1)
    // `days`, `landOn` and `paneCount` are read, not depended on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewedWeek])

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

  /*
   * Where the track sits when a week's panes arrive.
   *
   * `usePagedTrack` reads its index back off `scrollLeft`, which is right while
   * the pane SET is stable and wrong the moment it is replaced: loading a week
   * leaves the scroller wherever it was, so you land mid-week on an index that
   * describes the week you just left. Keyed on the viewed week's Sunday, so it
   * fires exactly when the panes change and not on every render.
   */
  // Past the early return, so the view exists and so does its week. The nullable
  // one above is only nullable because the hook that reads it runs before the
  // model has landed.
  const shownWeek = view.week_dates[0]!

  /** Viewing something other than the current week. */
  const laterWeek = shownWeek > view.date
  /** Something is placed beyond the week on screen. */
  const moreAhead = view.last_placed !== null && view.last_placed > view.week_dates[6]!

  /*
   * One control does days and weeks. Stepping past either end of the panes moves
   * a week rather than doing nothing — which is why the strip asks to move
   * instead of stepping an index itself.
   *
   * A swipe cannot do this: the track snaps and contains its overscroll, so a
   * gesture at the last pane simply stops. Weeks are the arrows' job, days are
   * either's. Recorded in the plan, and accepted.
   */
  const stepPane = (dir: -1 | 1) => {
    // Measured, not remembered: a click that lands mid-scroll would otherwise
    // step from the pane being left, which at a week's edge is the difference
    // between one pane back and one WEEK back.
    const next = days.indexNow() + dir
    if (next >= 0 && next < view.panes.length) {
      days.goTo(next)
      return
    }
    if (dir === 1 && moreAhead) {
      setLandOn('first')
      setWeek(addDays(shownWeek, 7))
    } else if (dir === -1 && laterWeek) {
      setLandOn('last')
      setWeek(addDays(shownWeek, -7))
    }
  }

  // Every row on the screen, today's and the days beside it, so the edit button
  // works wherever it is drawn.
  const editing =
    editingId === null
      ? null
      : ([...view.tasks, ...view.upcoming.flatMap((d) => d.tasks)].find(
          (t) => t.id === editingId,
        ) ?? null)

  /*
   * What is still to do. `view.tasks` is one list with done sunk to the bottom,
   * so the three places that still mean "what is left" — the strip's count, the
   * Reorder button, and the arrangement itself — say so rather than reading a
   * second array off the wire.
   */
  const outstanding = view.tasks.filter((t) => !t.is_done)

  const byId = new Map(outstanding.map((t) => [t.id, t]))
  // In the edit state the locally held arrangement is rendered — and only the
  // not-done rows are in it, because you arrange what you are doing. Otherwise
  // the server's order, exactly as given, done last.
  const rows: DayTask[] = orderIds
    ? orderIds.flatMap((id) => {
        const t = byId.get(id)
        return t ? [t] : []
      })
    : view.tasks

  /*
   * Where the 2px rule between the bands goes: the first non-baseline row, when
   * something baseline sits above it.
   *
   * Found once from the list rather than tested against each row's neighbour.
   * Done rows sort below every live one and carry a SECOND baseline→rest
   * transition inside their own block, so marking every transition drew the rule
   * twice — and excluding done rows to fix that removed it altogether whenever
   * every plain row happened to be ticked. The boundary is a property of the
   * list, so it is found as one.
   */
  const dividerAt = rows.some((t) => t.is_baseline) ? rows.findIndex((t) => !t.is_baseline) : -1

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

  /*
   * Move to top and send to bottom are a drag expressed as a button, so they go
   * through the same `reorderBand` a drag does — which is what keeps them inside
   * the row's own band. Bands never mix, and neither end of a band is the end of
   * the list.
   */
  const moveWithinBand = (band: 'baseline' | 'rest', id: number, to: 'top' | 'bottom') => {
    const from = bands[band].findIndex((t) => t.id === id)
    if (from < 0) return
    reorderBand(band, from, to === 'top' ? 0 : bands[band].length - 1)
  }

  const maxFor = (cadence: Cadence | null): ISODate | null =>
    placementMaxFor(view.placement, view.placeable_dates, cadence)

  const toggleDone = async (task: DayTask): Promise<void> => {
    // From what is on screen, not from the model — the model has not caught up
    // with a tap still in flight, and the person is answering the screen.
    const want = !asShown(task).is_done
    setIntent((m) => new Map(m).set(task.id, want))
    // Behind whatever is already going for this row. Commands for one task are
    // ordered; commands for different tasks are not, and do not need to be.
    const prior = inFlight.current.get(task.id) ?? Promise.resolve()
    const mine = prior.then(() => run(want ? 'complete' : 'uncomplete', { task_id: task.id }))
    inFlight.current.set(
      task.id,
      mine.catch(() => undefined),
    )
    try {
      await mine
    } finally {
      setIntent((m) => {
        // A newer tap owns the row now; it will clear itself when it settles.
        if (m.get(task.id) !== want) return m
        const next = new Map(m)
        next.delete(task.id)
        return next
      })
    }
  }

  /** A task as the screen should draw it: the model, or what was asked of it. */
  const asShown = (task: DayTask): DayTask => {
    const want = intent.get(task.id)
    return want === undefined ? task : { ...task, is_done: want }
  }

  const toggleReorder = async () => {
    if (!reordering) {
      setPickerFor(null)
      setOrderIds(outstanding.map((t) => t.id))
      return
    }
    /*
     * The saved order is the whole rendered list: the rearranged rows, then the
     * done ones after them. Sending only the not-done half would drop every done
     * task's id, and `sortTasks` positions the done band by the same
     * `task_order` — so a task ticked and then unticked would stop returning to
     * where it was. It lands at the end of the arrangement instead, which is the
     * honest reading of "the list as you last arranged it".
     *
     * Cleared only once the write has landed: clearing first threw the
     * arrangement away on failure, silently (D5).
     */
    const doneIds = view.tasks.filter((t) => t.is_done).map((t) => t.id)
    const task_ids = [...(orderIds ?? []), ...doneIds]
    if (await run('set_task_order', { task_ids })) setOrderIds(null)
  }

  return (
    <div className="day-root" aria-busy={busy}>
      {/* The mood sits on the heading rather than in the page, because it is a
          once-a-day gesture at the end of the day and the list is what the screen
          is for. The button wears the mood so moving it out of sight does not
          also hide whether today has one. */}
      <header className="day-header">
        <h1 className="day-date">{longDate(view.date)}</h1>
        <MoodButton
          mood={view.mood}
          moods={view.moods}
          disabled={busy || reordering}
          onClick={() => setMoodOpen(true)}
        />
      </header>

      {/* ALWAYS, including a Saturday — where it draws one enabled button, six
          disabled ones and two disabled arrows.

          It used to render only when `upcoming` was non-empty, which meant the
          week navigation disappeared entirely one day in seven. That was the
          deliberate "one pane, no special case" seen from the wrong end: the
          special case it avoided in this file it created on the screen, where a
          Saturday looked like breakage. `week_dates` always holds seven days and
          `DayStrip` already disables the ones without a pane, so there is
          nothing here to guard. */}
      <DayStrip
        dates={view.week_dates}
        today={view.date}
        panes={view.panes}
        // Index-aligned with `panes` rather than built as today-plus-the-rest:
        // in a later week there is no today pane to put first. Today's count is
        // what is still to do; an upcoming pane is already filtered to what is
        // outstanding on it. Counting for a label, not deriving state.
        counts={view.panes.map((d) =>
          d === view.date
            ? outstanding.length
            : (view.upcoming.find((u) => u.date === d)?.tasks.length ?? 0),
        )}
        index={days.index}
        onGo={days.goTo}
        onPrev={() => stepPane(-1)}
        onNext={() => stepPane(1)}
        canPrev={days.index > 0 || laterWeek}
        canNext={days.index < view.panes.length - 1 || moreAhead}
        disabled={busy || reordering}
      />

      {/* Today first, then one pane per day through Saturday. The scrolling,
          the snapping and the freeze during a reorder all live in `Track`. */}
      <Track
        label="This week, day by day"
        locked={reordering}
        trackRef={days.trackRef}
        onScroll={days.onScroll}
      >
        {/* Today's pane exists only in the week that contains today. Paging
            forward leaves it behind, which is what keeps "only today can be
            ticked" true without a flag anywhere. */}
        {!laterWeek && (
          <div className="pane pane--today">
            {/* Named by its own heading rather than by an aria-label that said
              something else. The two had already drifted — the section was
              "Active tasks" while the heading read "Today" — and now that done
              rows live here too, only one of those was still true. */}
            <section className="day-section" aria-labelledby={todayHeadingId}>
              <div className="day-section-bar">
                <h2 className="day-h2" id={todayHeadingId}>
                  Today
                </h2>
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
                    disabled={busy || outstanding.length === 0}
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
                        onMoveToTop={(id) => moveWithinBand(band, id, 'top')}
                        onMoveToBottom={(id) => moveWithinBand(band, id, 'bottom')}
                      />
                    ),
                  )}
                </>
              ) : (
                <ul className="day-list">
                  {rows.map((task, i) => {
                    return (
                      <TaskRow
                        key={task.id}
                        task={asShown(task)}
                        today={view.date}
                        bandStart={i === dividerAt}
                        busy={busy}
                        onComplete={() => toggleDone(task)}
                        onUncomplete={() => toggleDone(task)}
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
          </div>
        )}

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
      </Track>

      {/* Everything that is not today, as one track of six groups — the list
          above is arranged for doing, and this is the moment you ask "what else
          is there?". It was two collapsed accordions over the same model, and
          the model did not change. */}
      <Backlog
        view={todo}
        onChanged={refresh}
        onError={(e: unknown) => setNotice({ tone: 'error', text: errorText(e) })}
        busy={busy || reordering}
      />

      {moodOpen && (
        <Sheet title="Mood and log" onClose={() => setMoodOpen(false)}>
          <MoodAndLog
            view={view}
            // Frozen during a reorder: a mood tap refetches, and the id list would
            // then be reconciled against a new model by dropping rows (D7). The
            // button that opens this is frozen for the same reason.
            disabled={busy || reordering}
            onSetMood={(slug) => run('set_mood', { slug })}
            onSetLog={(text) => run('set_log', { text })}
          />
        </Sheet>
      )}

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
        it editing a stale row — the same rule the backlog track follows.

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
