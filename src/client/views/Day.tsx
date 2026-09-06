import { useEffect, useRef, useState, type CSSProperties, type UIEvent } from 'react'
import type { ReactNode } from 'react'
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core'
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { TaskFields, draftIsValid, draftToPatch, emptyDraft, type TaskDraft } from '../TaskFields.tsx'
import './day.css'
import type { Cadence, DayTask, DayView, ISODate, TodoView, UpcomingDay } from '../../shared/types.ts'
import { CADENCES } from '../../shared/types.ts'
import { command, errorText, getDay, getTodo, logout } from '../api.ts'
import { dayLabel, longDate, shortDate, weekdayShort } from '../dates.ts'
import { Confirm, DayPicker, NoticeBar, Popover, Sheet, Tick, type Notice } from '../ui.tsx'
import Todo from './Todo.tsx'

/*
 * Day — the doing surface.
 *
 * Data rule (.plan/api.md, "Client fetching"): fetch the models, render them,
 * post a named command, refetch and replace wholesale. Nothing derived from a
 * model is held in state, nothing is sorted or filtered here — `view.active`
 * and `view.completed` arrive in render order. The one exception is `orderIds`,
 * the reorder edit state, which holds a locally rearranged id list until the
 * toggle closes.
 *
 * Day fetches TWO models: its own and the To do panel's. `placeable_dates` rides
 * on DayView exactly so that the picker and the server's 409 on `place` cannot
 * disagree (D3 in review-findings.md) — and since v8 it is also the list of PANES,
 * so the days you can swipe to and the days you can place on are one derivation.
 *
 * Since v8 this is the only task surface: Week is deleted and its seven day
 * sections are the panes of the track here. Today's pane is the whole Day view;
 * the rest show what is placed on that date and cannot be ticked. See
 * `.plan/changes-v8.md`.
 */

const CADENCE_WORD: Record<Cadence, string> = {
  day: 'daily',
  week: 'weekly',
  month: 'monthly',
  quarter: 'quarterly',
  year: 'yearly',
}

// --- shell ------------------------------------------------------------------

export default function Day() {
  const [view, setView] = useState<DayView | null>(null)
  const [todo, setTodo] = useState<TodoView | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [reloads, setReloads] = useState(0)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<Notice>(null)

  const [capturing, setCapturing] = useState(false)
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

  /**
   * The far edge for a cadence, from the server's `placement`. Falls back to the
   * last chip — this week, the rule before this change and the more restrictive
   * of the two answers — rather than to null, which would read as unbounded.
   */
  const maxFor = (cadence: Cadence | null): ISODate | null => {
    const found = view.placement.find((p) => p.cadence === cadence)
    return found ? found.max : (view.placeable_dates[view.placeable_dates.length - 1] ?? null)
  }

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
              <button
                className="btn btn--small btn--quiet"
                aria-pressed={reordering}
                onClick={toggleReorder}
                disabled={busy || view.active.length === 0}
              >
                {reordering ? 'Done reordering' : 'Reorder'}
              </button>
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
        onClick={() => setCapturing(true)}
        aria-label="Capture a new item"
        disabled={busy}
      >
        +
      </button>

      {/* Unconditional: there is always a session, because there is no way to
          run this app without one. `logout` clears the cookie and then tells the
          shell, which is the same path a 401 takes. */}
      <div className="day-signout">
        <button className="btn btn--small btn--quiet" onClick={() => void logout()}>
          Sign out
        </button>
      </div>

      <NoticeBar notice={notice} onDismiss={() => setNotice(null)} />

      {capturing && (
        <CaptureSheet
          busy={busy}
          onClose={() => setCapturing(false)}
          onCreate={async (patch) => {
            if (await run('create_task', patch, `Captured “${String(patch.name)}”.`)) {
              setCapturing(false)
            }
          }}
          onCreateMany={async (names) => {
            const said = names.length === 1 ? 'Captured 1 item.' : `Captured ${names.length} items.`
            if (await run('create_tasks', { names }, said)) setCapturing(false)
          }}
        />
      )}
    </div>
  )
}

// --- mood and log -----------------------------------------------------------
// Sits at the foot of the day, under the panels: the tasks are what the screen
// is for, and a mood belongs where the day is closed out rather than where it is
// worked. Compact anyway — a mood is one tap and a log is one line. The mood set
// is not editable here or anywhere in the app; it is a table, edited in the DB.

function MoodAndLog({
  view,
  disabled,
  onSetMood,
  onSetLog,
}: {
  view: DayView
  disabled: boolean
  onSetMood: (slug: string | null) => void
  onSetLog: (text: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState('')
  const log = view.log ?? ''

  function save() {
    setOpen(false)
    if (draft !== log) onSetLog(draft)
  }

  return (
    <section className="day-mood" aria-label="Mood and log">
      <div className="day-mood-glyphs" role="group" aria-label="Mood">
        {view.moods.map((m) => {
          const selected = view.mood === m.slug
          return (
            <button
              key={m.slug}
              className={`day-glyph${selected ? ' day-glyph--on' : ''}`}
              aria-pressed={selected}
              aria-label={selected ? `${m.label} — tap to clear` : m.label}
              title={m.label}
              disabled={disabled}
              onClick={() => onSetMood(selected ? null : m.slug)}
            >
              <span aria-hidden="true">{m.emoji}</span>
            </button>
          )
        })}
      </div>

      {open ? (
        <div className="day-log-edit">
          <textarea
            className="day-log-input"
            autoFocus
            rows={3}
            value={draft}
            placeholder="Anything worth remembering about today…"
            aria-label="Log for today"
            onChange={(e) => setDraft(e.target.value)}
            onBlur={save}
          />
          <button
            className="btn btn--small btn--quiet"
            // mousedown default is what blurs the textarea; preventing it lets
            // the click land, and blur-save then never double-fires.
            onMouseDown={(e) => e.preventDefault()}
            onClick={save}
          >
            Save
          </button>
        </div>
      ) : (
        <button
          className={`day-log-collapsed${log ? '' : ' day-log-collapsed--empty'}`}
          disabled={disabled}
          onClick={() => {
            setDraft(log)
            setOpen(true)
          }}
          aria-label={log ? 'Edit today’s log' : 'Add a log for today'}
        >
          {log || 'Log…'}
        </button>
      )}
    </section>
  )
}

// --- task rows --------------------------------------------------------------

/** The name, and at most one piece of metadata beside it. */
function TaskName({ task }: { task: DayTask }) {
  const meta: ReactNode =
    task.state === 'overdue' && task.effective_date ? (
      <span className="day-badge">needs a day · {shortDate(task.effective_date)}</span>
    ) : task.cadence ? (
      // Daily included: without it a daily task and a one-off read identically,
      // and those are the two ends of the model.
      CADENCE_WORD[task.cadence]
    ) : null

  return (
    <span className="day-name">
      <span className="day-name-text">{task.name}</span>
      {/* Rendered only when there is something in it, rather than always and
          hidden with a :empty rule. */}
      {meta !== null && <span className="day-meta">{meta}</span>}
    </span>
  )
}

function TaskRow({
  task,
  today,
  bandStart,
  busy,
  onComplete,
  onUnplan,
  placeable,
  placeableMax,
  pickerOpen,
  onOpenPicker,
  onClosePicker,
  onPlace,
  future = false,
}: {
  task: DayTask
  today: ISODate
  bandStart: boolean
  busy: boolean
  onComplete: () => void
  onUnplan: () => void
  placeable: ISODate[]
  /** Far edge of this task's placeable range; null is unbounded (a one-off). */
  placeableMax: ISODate | null
  pickerOpen: boolean
  /**
   * OPENS, never toggles. The popover light-dismisses on any pointerdown
   * outside itself — the trigger included — so a toggling handler would race
   * its own dismissal and land on whichever won.
   */
  onOpenPicker: () => void
  onClosePicker: () => void
  onPlace: (date: ISODate) => void
  /** On a future pane. Nothing writes to a date that is not today. */
  future?: boolean
}) {
  const overdue = task.state === 'overdue'
  // Overdue and future ask the SAME question — which day does this belong on? —
  // so they share the picker and the Unplan beside it. Only the verb differs:
  // an overdue task has lost its day, a future one merely has a different one.
  const asksForADay = overdue || future
  // Baseline colour, when one is set. The server already nulls it for anything
  // that is not baseline, so there is no condition to re-check here.
  const colour = task.color
  const cls = [
    'day-row',
    task.is_baseline ? 'day-row--baseline' : '',
    bandStart ? 'day-row--band-start' : '',
    overdue ? 'day-row--overdue' : '',
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <li
      className={cls}
      data-overdue={overdue ? '' : undefined}
      data-colour={colour ? '' : undefined}
      style={colour ? ({ '--task-colour': colour } as CSSProperties) : undefined}
    >
      <div className="day-row-main">
        {/* Disabled on a future pane, where `Tick` renders a static box with no
            checkbox role at all — so it is not merely unclickable, it is not a
            control. Same shape, no affordance. */}
        <Tick
          done={false}
          disabled={future}
          label={`Complete ${task.name}`}
          onToggle={onComplete}
        />
        <TaskName task={task} />
      </div>

      {/* Overdue asks for a decision, in the same flat list: complete it above,
          or one of these two. A future row offers the same two, minus the urgency. */}
      {asksForADay && (
        <div className="day-row-actions">
          <button
            className="btn btn--small pop-anchor"
            style={{ '--pop-anchor': `--pick-${task.id}` } as CSSProperties}
            onClick={onOpenPicker}
            aria-expanded={pickerOpen}
            aria-label={overdue ? `Give it a day — ${task.name}` : `Move ${task.name}`}
            disabled={busy}
          >
            {overdue ? 'Give it a day' : 'Move'}
          </button>
          <button
            className="btn btn--small"
            onClick={onUnplan}
            aria-label={`Unplan ${task.name}`}
            disabled={busy}
          >
            Unplan
          </button>
        </div>
      )}

      {/* In the top layer, so it neither pushes the row's neighbours down nor
          gets clipped by the pane's horizontal scroll box. */}
      {asksForADay && pickerOpen && (
        <Popover anchor={`--pick-${task.id}`} onClose={onClosePicker}>
          <DayPicker
            dates={placeable}
            max={placeableMax}
            today={today}
            selected={task.planned_date}
            onPick={onPlace}
            disabled={busy}
          />
        </Popover>
      )}
    </li>
  )
}

// --- the day strip ----------------------------------------------------------

/**
 * Previous, one button per day of the week, next.
 *
 * Each day carries the number of things outstanding on it, so the week's shape
 * is readable without flipping through it — which is what the panes were asked
 * for in the first place. Past days have no count because they have no pane.
 *
 * ALL SEVEN days are shown so the week reads as a week, but only today onward
 * are panes — the earlier ones are rendered disabled rather than omitted, which
 * keeps the strip the same width all week and says plainly that a past day is
 * not somewhere you can go.
 *
 * `panes` is `placeable_dates`, so a day's button and its pane are matched by
 * position in the one list the server derived. `index` comes from the track's
 * scroll position, so this highlights where the panes actually are.
 */
function DayStrip({
  dates,
  today,
  panes,
  counts,
  index,
  onGo,
  disabled,
}: {
  dates: ISODate[]
  today: ISODate
  panes: ISODate[]
  /** Outstanding items per pane, index-aligned with `panes`. */
  counts: number[]
  index: number
  onGo: (i: number) => void
  disabled: boolean
}) {
  const showing = panes[index]

  return (
    <nav className="day-strip" aria-label="Days of this week">
      <button
        className="day-strip__step"
        aria-label="Previous day"
        disabled={disabled || index <= 0}
        onClick={() => onGo(index - 1)}
      >
        <span aria-hidden="true">‹</span>
      </button>

      <ul className="day-strip__days">
        {dates.map((d) => {
          // Not a pane: it is behind today. -1 from indexOf is the whole test.
          const pane = panes.indexOf(d)
          const count = pane < 0 ? null : (counts[pane] ?? 0)
          return (
            <li key={d}>
              <button
                className="day-strip__day"
                // The count belongs in the name, not only in the badge: the badge
                // is aria-hidden, and "Tuesday, 3 tasks" is the whole point of it.
                aria-label={[
                  longDate(d),
                  d === today ? ' — today' : '',
                  count === null ? '' : count === 1 ? ', 1 task' : `, ${count} tasks`,
                ].join('')}
                aria-current={d === showing ? 'true' : undefined}
                data-today={d === today ? '' : undefined}
                disabled={disabled || pane < 0}
                onClick={() => onGo(pane)}
              >
                <span className="day-strip__dow">{weekdayShort(d)}</span>
                {/* The slot is always rendered so the buttons stay the same
                    height; a zero is left blank rather than drawn, because a row
                    of zeroes is noise and an empty day is not news. */}
                <span className="day-strip__count" aria-hidden="true">
                  {count !== null && count > 0 ? count : ''}
                </span>
              </button>
            </li>
          )
        })}
      </ul>

      <button
        className="day-strip__step"
        aria-label="Next day"
        disabled={disabled || index >= panes.length - 1}
        onClick={() => onGo(index + 1)}
      >
        <span aria-hidden="true">›</span>
      </button>
    </nav>
  )
}

// --- upcoming panes ---------------------------------------------------------

/**
 * One day of this week that is not today.
 *
 * Placed tasks only, and only those still outstanding — the server decides both
 * and this renders what it sent. Daily tasks are absent because one can never
 * hold a planned_date; a task already satisfied for its period is absent because
 * a done task adds no load to the day. See `.plan/changes-v8.md`.
 *
 * The rows are `TaskRow` with `future` set — the same component today's pane
 * uses, which is why `UpcomingDay.tasks` is `DayTask[]` and not a narrower type.
 */
function UpcomingPane({
  day,
  today,
  placeable,
  placeableMax,
  busy,
  pickerFor,
  onOpenPicker,
  onClosePicker,
  onPlace,
  onUnplan,
}: {
  day: UpcomingDay
  today: ISODate
  placeable: ISODate[]
  /** Looked up per row: the range depends on the task's cadence, not the pane. */
  placeableMax: (cadence: Cadence | null) => ISODate | null
  busy: boolean
  pickerFor: number | null
  onOpenPicker: (id: number) => void
  onClosePicker: () => void
  onPlace: (id: number, date: ISODate) => void
  onUnplan: (id: number) => void
}) {
  return (
    <div className="day-pane">
      <section className="day-section" aria-label={longDate(day.date)}>
        <div className="day-section-bar">
          <h2 className="day-h2">{dayLabel(day.date)}</h2>
        </div>

        {day.tasks.length === 0 ? (
          <p className="day-empty">Nothing placed.</p>
        ) : (
          <ul className="day-list">
            {day.tasks.map((task) => (
              <TaskRow
                key={task.id}
                task={task}
                today={today}
                bandStart={false}
                busy={busy}
                future
                // Unreachable: a future pane's tick is not a control.
                onComplete={() => undefined}
                onUnplan={() => onUnplan(task.id)}
                placeable={placeable}
                placeableMax={placeableMax(task.cadence)}
                pickerOpen={pickerFor === task.id}
                onOpenPicker={() => onOpenPicker(task.id)}
                onClosePicker={onClosePicker}
                onPlace={(date) => onPlace(task.id, date)}
              />
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}

// --- sheet shell ------------------------------------------------------------

// --- capture ----------------------------------------------------------------
// One field, nothing else. Deliberately not extensible: a form on the fast path
// is a form you stop bothering with.

/**
 * One task per line: trimmed, blanks dropped, repeats within the paste collapsed.
 *
 * The same parse `create_tasks` runs on the server, so the count on the button is
 * the number that will actually be created rather than the number of lines typed.
 */
function parseNames(text: string): string[] {
  return [...new Set(text.split('\n').map((l) => l.trim()).filter((l) => l !== ''))]
}

function CaptureSheet({
  busy,
  onClose,
  onCreate,
  onCreateMany,
}: {
  busy: boolean
  onClose: () => void
  onCreate: (patch: Record<string, unknown>) => void
  onCreateMany: (names: string[]) => void
}) {
  const [many, setMany] = useState(false)
  const [draft, setDraft] = useState<TaskDraft>(emptyDraft())
  const [lines, setLines] = useState('')

  const names = parseNames(lines)

  return (
    <Sheet title="Capture" onClose={onClose}>
      {/* Getting a list out of your head is a different activity from defining a
          task. One stays the fast path; Many is for emptying your pockets. */}
      <div className="capture-mode" role="group" aria-label="How many">
        <button
          type="button"
          className="capture-mode__btn"
          aria-pressed={!many}
          onClick={() => setMany(false)}
        >
          One
        </button>
        <button
          type="button"
          className="capture-mode__btn"
          aria-pressed={many}
          onClick={() => setMany(true)}
        >
          Many
        </button>
      </div>

      {many ? (
        <>
          <form
            className="form form--stack"
            onSubmit={(e) => {
              e.preventDefault()
              if (names.length > 0) onCreateMany(names)
            }}
          >
            {/* No More section. Cadence, category, baseline and colour are
                per-task judgements, and one answer applied to eight pasted lines
                would be wrong more often than right. */}
            <label className="field">
              <span className="field-label">Names</span>
              <textarea
                className="input capture-lines"
                rows={7}
                autoFocus
                value={lines}
                aria-label="One task per line"
                placeholder={'Milk\nBin day\nRing the dentist'}
                onChange={(e) => setLines(e.target.value)}
              />
            </label>

            <button className="btn btn--primary" type="submit" disabled={names.length === 0 || busy}>
              {names.length === 0
                ? 'Add'
                : names.length === 1
                  ? 'Add 1 task'
                  : `Add ${names.length} tasks`}
            </button>
          </form>
          <p className="hint">
            They all go to the backlog with no date. Give them a cadence or a day
            afterwards, in the Routine or Backlog panel.
          </p>
        </>
      ) : (
        <>
          <form
            className="form form--stack"
            onSubmit={(e) => {
              e.preventDefault()
              if (draftIsValid(draft)) onCreate(draftToPatch(draft))
            }}
          >
            {/* Name is the fast path; everything else is behind a disclosure that
                costs nothing closed. See "Input" in `.plan/views.md`. */}
            <TaskFields draft={draft} onChange={setDraft} collapseExtras autoFocusName />

            <button className="btn btn--primary" type="submit" disabled={!draftIsValid(draft) || busy}>
              Add
            </button>
          </form>
          <p className="hint">
            A name alone goes to the backlog with no date — it won’t appear on today’s list.
          </p>
        </>
      )}
    </Sheet>
  )
}

// --- task editor ------------------------------------------------------------
// Slow and deliberate. Archive is the only removal in the system.

// --- drag reordering --------------------------------------------------------

/**
 * One band of the active list, made draggable.
 *
 * Each band gets its OWN DndContext, which is how "bands never mix" is enforced:
 * a baseline task and a non-baseline one are never in the same drag context, so
 * crossing the boundary is not a move that can be expressed rather than a move
 * that has to be rejected. `views.md` calls the band boundary the meaning of the
 * baseline flag; this makes it structural.
 *
 * The whole row is the handle. In this mode nothing else on a row is
 * interactive — no tick, no name button — so there is nothing for a drag to be
 * confused with, and no separate grip to aim at on a phone.
 */
function DragBand({
  tasks,
  onReorder,
}: {
  tasks: DayTask[]
  onReorder: (from: number, to: number) => void
}) {
  const sensors = useSensors(
    // A short distance before a drag starts, so a tap or a scroll on a dense
    // list is not read as the beginning of a drag.
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )

  const ids = tasks.map((t) => t.id)

  const onDragEnd = (e: DragEndEvent) => {
    const { active, over } = e
    if (!over || active.id === over.id) return
    const from = ids.indexOf(Number(active.id))
    const to = ids.indexOf(Number(over.id))
    if (from < 0 || to < 0) return
    onReorder(from, to)
  }

  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
      <SortableContext items={ids} strategy={verticalListSortingStrategy}>
        <ul className="day-list day-list--reorder">
          {tasks.map((task) => (
            <DragRow key={task.id} task={task} />
          ))}
        </ul>
      </SortableContext>
    </DndContext>
  )
}

function DragRow({ task }: { task: DayTask }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: task.id,
  })

  return (
    <li
      ref={setNodeRef}
      className="day-row day-row--reordering"
      data-dragging={isDragging || undefined}
      data-colour={task.color ? '' : undefined}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        ...(task.color ? ({ '--task-colour': task.color } as CSSProperties) : {}),
      }}
      {...attributes}
      {...listeners}
    >
      <div className="day-row-main">
        <span className="day-row-grip" aria-hidden="true">
          ≡
        </span>
        <span className="day-name">
          <span className="day-name-text">{task.name}</span>
        </span>
      </div>
    </li>
  )
}
