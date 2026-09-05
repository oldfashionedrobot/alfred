import { useEffect, useState, type CSSProperties } from 'react'
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
import type { Cadence, DayTask, DayView, ISODate, TodoView } from '../../shared/types.ts'
import { CADENCES } from '../../shared/types.ts'
import { command, errorText, getDay, getTodo } from '../api.ts'
import { longDate, shortDate } from '../dates.ts'
import { Confirm, DayPicker, NoticeBar, Sheet, Tick, type Notice } from '../ui.tsx'
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
 * Day fetches TWO models: its own and the To do panel's. It never fetches
 * WeekView: `placeable_dates` rides on DayView exactly so that the picker and
 * the server's 409 on `place` cannot disagree (D3 in review-findings.md).
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
                  pickerOpen={pickerFor === task.id}
                  onTogglePicker={() =>
                    setPickerFor((cur) => (cur === task.id ? null : task.id))
                  }
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

      {/* Collapsed here: the list above is arranged for doing, and the panel is
          for the moment you ask "what else is there?" */}
      <Todo
        view={todo}
        onChanged={refresh}
        onError={(e: unknown) => setNotice({ tone: 'error', text: errorText(e) })}
        defaultOpen={false}
        busy={busy || reordering}
      />
      <Todo kind="backlog"
        view={todo}
        onChanged={refresh}
        onError={(e: unknown) => setNotice({ tone: 'error', text: errorText(e) })}
        defaultOpen={false}
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
    ) : task.cadence && task.cadence !== 'day' ? (
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
  pickerOpen,
  onTogglePicker,
  onPlace,
}: {
  task: DayTask
  today: ISODate
  bandStart: boolean
  busy: boolean
  onComplete: () => void
  onUnplan: () => void
  placeable: ISODate[]
  pickerOpen: boolean
  onTogglePicker: () => void
  onPlace: (date: ISODate) => void
}) {
  const overdue = task.state === 'overdue'
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
        <Tick done={false} label={`Complete ${task.name}`} onToggle={onComplete} />
        <TaskName task={task} />
      </div>

      {/* Overdue asks for a decision, in the same flat list: complete it above,
          or one of these two. */}
      {overdue && (
        <div className="day-row-actions">
          <button
            className="btn btn--small"
            onClick={onTogglePicker}
            aria-expanded={pickerOpen}
            disabled={busy}
          >
            Give it a day
          </button>
          <button className="btn btn--small" onClick={onUnplan} disabled={busy}>
            Unplan
          </button>
        </div>
      )}

      {overdue && pickerOpen && (
        <div className="day-row-picker">
          <DayPicker
            dates={placeable}
            today={today}
            selected={task.planned_date}
            onPick={onPlace}
            disabled={busy}
          />
        </div>
      )}
    </li>
  )
}

// --- sheet shell ------------------------------------------------------------

// --- capture ----------------------------------------------------------------
// One field, nothing else. Deliberately not extensible: a form on the fast path
// is a form you stop bothering with.

function CaptureSheet({
  busy,
  onClose,
  onCreate,
}: {
  busy: boolean
  onClose: () => void
  onCreate: (patch: Record<string, unknown>) => void
}) {
  const [draft, setDraft] = useState<TaskDraft>(emptyDraft())

  return (
    <Sheet title="Capture" onClose={onClose}>
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
