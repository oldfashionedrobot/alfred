import { useId, useState, type CSSProperties } from 'react'
import type { ISODate, TodoTask, TodoView } from '../../shared/types.ts'
import { TODO_GROUPS } from '../../shared/types.ts'
import { ApiError, command } from '../api.ts'
import { periodLabel, shortDate } from '../dates.ts'
import { Confirm, DayPicker, Sheet, Tick } from '../ui.tsx'
import { TaskFields, draftIsValid, draftToPatch, type TaskDraft } from '../TaskFields.tsx'
import './todo.css'

/**
 * The To do panel — the complete inventory. Hosted by Day and by Week,
 * identical in both. See "To do" in `.plan/views.md`.
 *
 * The host owns fetching: it passes the model in and a refresh callback, so a
 * command fired from here refetches both the panel and its host.
 *
 * Nothing in here computes. The six groups, their period boundaries, their
 * membership, the order inside them and the placeable dates all arrive from the
 * server; this file reads fields and renders them. In particular it never works
 * out where a quarter begins, never sorts, and never touches `placeable_dates`.
 */

type Run = (name: string, body?: Record<string, unknown>) => void

// --- one task -------------------------------------------------------------

function TodoRow({
  task,
  today,
  placeable,
  picking,
  onPicking,
  onEdit,
  run,
  locked,
}: {
  task: TodoTask
  today: ISODate
  /** Straight from the server. Never computed, filtered or extended here. */
  placeable: ISODate[]
  picking: boolean
  onPicking: (open: boolean) => void
  onEdit: () => void
  run: Run
  locked: boolean
}) {
  // Daily tasks are never placed — they are implicitly on every day, and the
  // server answers `place` on one with a 409. Not offering it is the courtesy.
  const canPlace = task.cadence !== 'day'
  const placed = task.effective_date !== null

  return (
    <li
      className="todo-row"
      data-done={task.is_done || undefined}
      data-overdue={task.is_overdue || undefined}
      data-baseline={task.is_baseline ? '' : undefined}
      data-colour={task.color ? '' : undefined}
      style={task.color ? ({ '--task-colour': task.color } as CSSProperties) : undefined}
    >
      <div className="todo-row__main">
        <Tick
          done={task.is_done}
          label={`${task.is_done ? 'Untick' : 'Complete'} ${task.name}`}
          onToggle={() => {
            if (!locked) run(task.is_done ? 'uncomplete' : 'complete', { task_id: task.id })
          }}
        />

        {/* Tapping the name opens the editor. This panel is the ONLY place a task
            is defined — the Day list is for doing, and a tap there is a tap you
            make while working, not one you make to change what a task means. */}
        <button className="todo-row__label" onClick={onEdit} aria-label={`Edit ${task.name}`}>
          <span className="todo-row__name">{task.name}</span>
          {(placed || task.is_overdue) && (
            <span className="todo-row__marks">
              {task.effective_date !== null && (
                <span className="todo-mark todo-mark--day">{shortDate(task.effective_date)}</span>
              )}
              {task.is_overdue && <span className="todo-mark todo-mark--needs">Needs a day</span>}
            </span>
          )}
        </button>

        <span className="todo-row__actions">
          {canPlace && (
            <button
              type="button"
              className="btn btn--small btn--quiet"
              aria-expanded={picking}
              aria-label={`${placed ? 'Move' : 'Place'} ${task.name}`}
              disabled={locked}
              onClick={() => onPicking(!picking)}
            >
              {placed ? 'Move' : 'Place'}
            </button>
          )}
          {placed && (
            <button
              type="button"
              className="btn btn--small btn--quiet"
              aria-label={`Unplan ${task.name}`}
              disabled={locked}
              onClick={() => run('unplan', { task_id: task.id })}
            >
              Unplan
            </button>
          )}
        </span>
      </div>

      {picking && canPlace && (
        <div className="todo-row__pick">
          <DayPicker
            dates={placeable}
            today={today}
            selected={task.effective_date}
            disabled={locked}
            onPick={(date) => run('place', { task_id: task.id, date })}
          />
        </div>
      )}
    </li>
  )
}

// --- the panel ------------------------------------------------------------

/**
 * Which half of the model this instance draws. One component, rendered twice:
 * six groups in one column is hard to read, and nothing about the model changed
 * to split them — `GET /api/todo` still returns all six in one response.
 */
export type TodoKind = 'periodic' | 'backlog'

const KIND: Record<TodoKind, { title: string; shows: (cadence: unknown) => boolean }> = {
  periodic: { title: 'To do', shows: (c) => c !== null },
  backlog: { title: 'Backlog', shows: (c) => c === null },
}

export default function Todo({
  view,
  kind = 'periodic',
  onChanged,
  onError,
  defaultOpen,
  busy,
}: {
  view: TodoView | null
  kind?: TodoKind
  /** Refetch the panel AND the host view. Awaited before the panel re-renders. */
  onChanged: () => Promise<void>
  /** Report a command failure to the host's notice bar. */
  onError: (e: unknown) => void
  /** Day collapses it by default; Week expands it. */
  defaultOpen: boolean
  busy?: boolean
}) {
  const [open, setOpen] = useState(defaultOpen)
  // One picker open at a time: a long panel with six of them fanned out is not
  // a picker, it is a mess.
  const [picking, setPicking] = useState<number | null>(null)
  const [editingId, setEditingId] = useState<number | null>(null)
  const [pending, setPending] = useState(false)
  const bodyId = useId()
  const locked = busy === true || pending

  const run: Run = (name, body = {}) => {
    setPending(true)
    void (async () => {
      try {
        await command(name, body)
      } catch (e) {
        onError(e)
        // 409: the model refused the gesture, so the write did not happen and
        // what is on screen is still accurate. Anything else may have landed.
        if (e instanceof ApiError && e.rejected) {
          setPending(false)
          return
        }
      }
      setPicking(null)
      await onChanged()
      setPending(false)
    })()
  }

  // Resolved at render from the live model, never held. Holding the row would
  // let it go stale behind an open sheet after any refetch.
  const editing =
    view === null || editingId === null
      ? null
      : (view.groups.flatMap((g) => g.tasks).find((t) => t.id === editingId) ?? null)

  const { title, shows } = KIND[kind]
  // Which of the six groups this instance draws. Not a filter over tasks — the
  // groups themselves are split, so each panel keeps the model's own order.
  const groups = TODO_GROUPS.filter((g) => shows(g.cadence))

  // Counting for a label, not deriving state: nothing here is held.
  const tally = (pick: (t: TodoTask) => boolean, scope: 'panel' | 'view') =>
    view === null
      ? 0
      : view.groups
          .filter((g) => scope === 'view' || shows(g.cadence))
          .reduce((n, g) => n + g.tasks.filter(pick).length, 0)

  // The header count labels THIS panel, so it counts this panel's groups.
  const remaining = tally((t) => !t.is_done, 'panel')

  // The overdue count labels a command that clears the WHOLE view, so it counts
  // the whole view — as `has_overdue`, which decides whether the control shows
  // at all, already does. Counting the panel's own half instead made the To do
  // panel offer to "clear the day from 0 overdue items" and then clear two,
  // whenever every overdue task happened to be a one-off drawn in Backlog.
  const overdue = tally((t) => t.is_overdue, 'view')

  return (
    <section className="todo" aria-label={title} data-busy={locked || undefined}>
      <h2 className="todo__head">
        <button
          type="button"
          className="todo__toggle"
          aria-expanded={open}
          aria-controls={open ? bodyId : undefined}
          onClick={() => setOpen((o) => !o)}
        >
          <span className="todo__chevron" aria-hidden="true">
            ›
          </span>
          <span className="todo__title">{title}</span>
          {view !== null && (
            <span className="todo__count">
              {remaining}
              <span className="sr"> not done</span>
            </span>
          )}
        </button>
      </h2>

      {open && (
        <div className="todo__body" id={bodyId}>
          {view === null ? (
            <p className="todo__quiet">Loading…</p>
          ) : (
            <>
              {/* Reset to backlog lives here and only here — one control, both
                  hosts. It clears every overdue day at once and never touches a
                  day still ahead, so the confirm says how many it takes. */}
              {view.has_overdue && kind === 'periodic' && (
                <div className="todo__bar">
                  {/* Deliberately not the row's own words: "Needs a day" is a
                      mark on a task, and a summary that reads identically makes
                      the two indistinguishable by voice or by search. */}
                  <p className="todo__bar-text">
                    {overdue === 1
                      ? '1 item is waiting for a day'
                      : `${overdue} items are waiting for a day`}
                  </p>
                  <Confirm
                    label="Reset to backlog"
                    question={`Clear the day from ${overdue} overdue ${
                      overdue === 1 ? 'item' : 'items'
                    }?`}
                    confirmLabel="Reset"
                    disabled={locked}
                    onConfirm={() => run('reset_overdue')}
                  />
                </div>
              )}

              {/* Always all six, always in this order, empty or not: the panel is
                  a map of the periods as much as a list of tasks. */}
              {groups.map((meta) => {
                const group = view.groups.find((g) => g.cadence === meta.cadence)
                const tasks = group?.tasks ?? []
                const from = group?.period_start ?? null
                const to = group?.period_end ?? null
                return (
                  <section
                    className="todo-group"
                    key={meta.cadence ?? 'once'}
                    aria-label={meta.title}
                  >
                    <h3 className="todo-group__head">
                      <span className="todo-group__title">{meta.title}</span>{' '}
                      {/* The one-off group is unbounded and shows no period. A
                          week is a date range — there is no week number here. */}
                      {from !== null && to !== null && (
                        <span className="todo-group__period">{periodLabel(from, to)}</span>
                      )}
                    </h3>
                    {tasks.length === 0 ? (
                      <p className="todo-group__empty">Nothing here.</p>
                    ) : (
                      <ul className="todo-list">
                        {tasks.map((task) => (
                          <TodoRow
                            key={task.id}
                            task={task}
                            today={view.today}
                            placeable={view.placeable_dates}
                            picking={picking === task.id}
                            onPicking={(o) => setPicking(o ? task.id : null)}
                            onEdit={() => setEditingId(task.id)}
                            run={run}
                            locked={locked}
                          />
                        ))}
                      </ul>
                    )}
                  </section>
                )
              })}
            </>
          )}
        </div>
      )}

      {editing !== null && (
        <TaskEditor
          task={editing}
          categories={view?.categories ?? []}
          locked={locked}
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
    </section>
  )
}

// --- task editor ------------------------------------------------------------

/**
 * Slow and deliberate, the opposite of capture. Reached by tapping a name in
 * this panel, which is the only place a task is edited — see "Input" in
 * `.plan/views.md`. Archive is the only removal; there is no delete anywhere.
 */
function TaskEditor({
  task,
  categories,
  locked,
  onClose,
  onSave,
  onArchive,
}: {
  task: TodoTask
  categories: string[]
  locked: boolean
  onClose: () => void
  onSave: (patch: Record<string, unknown>) => void
  onArchive: (id: number) => void
}) {
  const [draft, setDraft] = useState<TaskDraft>({
    name: task.name,
    cadence: task.cadence ?? '',
    is_baseline: task.is_baseline,
    color: task.color,
    category: task.category ?? '',
  })

  return (
    <Sheet title="Edit task" onClose={onClose}>
      <form
        className="form form--stack"
        onSubmit={(e) => {
          e.preventDefault()
          if (!draftIsValid(draft)) return
          // planned_date is deliberately not sent: setting cadence to 'day'
          // clears it server-side, in the same transaction.
          onSave({ id: task.id, ...draftToPatch(draft) })
        }}
      >
        <TaskFields draft={draft} onChange={setDraft} categories={categories} />

        <button className="btn btn--primary" type="submit" disabled={!draftIsValid(draft) || locked}>
          Save
        </button>
      </form>

      <div className="todo-archive">
        <Confirm
          label="Archive task"
          question="Archiving retires it from every view and keeps its history. There is no delete."
          confirmLabel="Archive"
          disabled={locked}
          onConfirm={() => onArchive(task.id)}
        />
      </div>
    </Sheet>
  )
}
