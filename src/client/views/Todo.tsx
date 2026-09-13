import { useState, type CSSProperties } from 'react'
import type { Cadence, ISODate, TodoTask, TodoView } from '../../shared/types.ts'
import { TODO_GROUPS } from '../../shared/types.ts'
import { ApiError, command } from '../api.ts'
import { periodLabel, shortDate } from '../dates.ts'
import { Confirm, DayPicker, Popover, Sheet, Tick, placementMaxFor } from '../ui.tsx'
import { TaskFields, draftIsValid, draftToPatch, type TaskDraft } from '../TaskFields.tsx'
import { TaskEditor } from '../TaskEditor.tsx'
import { GroupStrip } from './day/GroupStrip.tsx'
import { Track, usePagedTrack } from './day/PagedTrack.tsx'
import './todo.css'

/**
 * The To do panel — the complete inventory. Hosted by Day,
 * identical in both.
 *
 * The host owns fetching: it passes the model in and a refresh callback, so a
 * command fired from here refetches both the panel and its host.
 *
 * Nothing in here computes. The six groups, their period boundaries, their
 * membership, the order inside them and the placeable dates all arrive from the
 * server; this file reads fields and renders them. In particular it never works
 * out where a quarter begins, never sorts, and never touches `placeable_dates`.
 */

type Run = (
  name: string,
  body?: Record<string, unknown>,
  /** Runs once the command has settled, however it settled. */
  done?: () => void,
) => void

// --- one task -------------------------------------------------------------

function TodoRow({
  task,
  today,
  placeable,
  placeableMax,
  picking,
  onPicking,
  onEdit,
  onToggleDone,
  run,
  locked,
}: {
  task: TodoTask
  today: ISODate
  /** Straight from the server. Never computed, filtered or extended here. */
  placeable: ISODate[]
  /** Far edge of THIS task's range — it depends on its cadence. Null is unbounded. */
  placeableMax: ISODate | null
  picking: boolean
  onPicking: (open: boolean) => void
  onEdit: () => void
  /** Fires the right command AND holds the predicted box. See `Backlog`. */
  onToggleDone: () => void
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
            if (!locked) onToggleDone()
          }}
        />

        {/* Tapping the NAME opens the editor, and only here: on Day a tap is one
            you make while working, not one you make to change what a task means.
            Day reaches the same editor through a distinct button, which cannot be
            hit by accident. */}
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
              className="btn btn--small btn--quiet pop-anchor"
              /* See TaskRow: one anchor name per surface, not per task. */
              style={{ '--pop-anchor': `--pick-group-${task.id}` } as CSSProperties}
              aria-expanded={picking}
              aria-label={`${placed ? 'Move' : 'Place'} ${task.name}`}
              disabled={locked}
              onClick={() => onPicking(true)}
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

      {/* In the top layer: it neither pushes the rows below it down the panel
          nor gets clipped by anything the panel scrolls inside. */}
      {picking && canPlace && (
        <Popover anchor={`--pick-group-${task.id}`} onClose={() => onPicking(false)}>
          <DayPicker
            dates={placeable}
            max={placeableMax}
            today={today}
            selected={task.effective_date}
            disabled={locked}
            onPick={(date) => {
              // Closed here rather than left to the refetch: a menu floating over
              // the row it has just changed is a menu that looks stuck.
              onPicking(false)
              run('place', { task_id: task.id, date })
            }}
          />
        </Popover>
      )}
    </li>
  )
}

// --- the panel ------------------------------------------------------------

/**
 * Everything that is not today, as a track of six panes.
 *
 * This was two collapsed accordions — Routine drawing the five recurring groups
 * and Backlog the one-off group — which is what made the complete list of what
 * you have to do two taps away and drawn in the least prominent part of the
 * screen. It is now one section with the same paging the week above it uses:
 * a button per group, one pane at a time.
 *
 * BACKLOG NAMES THE WHOLE TRACK, and "Any time" names the one-off group inside
 * it. The word moved outward; `cadence: null` is still a one-off in the model.
 *
 * Nothing in here computes. The six groups, their period boundaries, their
 * membership, the order inside them and the placeable dates all arrive from the
 * server; this file reads fields and renders them.
 */
export default function Backlog({
  view,
  onChanged,
  onError,
  busy,
}: {
  /** Non-null: Day renders this only after both its models have loaded. */
  view: TodoView
  /** Refetch this AND the host view. Awaited before re-rendering. */
  onChanged: () => Promise<void>
  /** Report a command failure to the host's notice bar. */
  onError: (e: unknown) => void
  busy?: boolean
}) {
  // One picker open at a time: six of them fanned out is not a picker, it is a
  // mess.
  const [picking, setPicking] = useState<number | null>(null)
  /*
   * What the person has asked a row's done state to be. Same mechanism as the
   * day list's, because a box that behaves differently here than three inches
   * above it would be worse than the latency it hides. See Day.tsx for why it is
   * an intent rather than a set of ids in flight, and why only the box moves.
   */
  const [intent, setIntent] = useState<ReadonlyMap<number, boolean>>(new Map())
  const [editingId, setEditingId] = useState<number | null>(null)
  const [pending, setPending] = useState(false)
  // The second instance of the hook on this screen — the week's days are the
  // first. Same mechanics, different buttons.
  const groups = usePagedTrack()
  const locked = busy === true || pending

  /** A task as the screen should draw it: the model, or what was asked of it. */
  const asShown = (task: TodoTask): TodoTask => {
    const want = intent.get(task.id)
    return want === undefined ? task : { ...task, is_done: want }
  }

  const toggleDone = (task: TodoTask): void => {
    const want = !asShown(task).is_done
    setIntent((m) => new Map(m).set(task.id, want))
    run(want ? 'complete' : 'uncomplete', { task_id: task.id }, () =>
      setIntent((m) => {
        if (m.get(task.id) !== want) return m
        const next = new Map(m)
        next.delete(task.id)
        return next
      }),
    )
  }

  const run: Run = (name, body = {}, done) => {
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
          done?.()
          return
        }
      }
      setPicking(null)
      await onChanged()
      setPending(false)
      done?.()
    })()
  }

  // Resolved at render from the live model, never held. Holding the row would
  // let it go stale behind an open sheet after any refetch.
  const editing =
    editingId === null
      ? null
      : (view.groups.flatMap((g) => g.tasks).find((t) => t.id === editingId) ?? null)

  const maxFor = (cadence: Cadence | null): ISODate | null =>
    placementMaxFor(view.placement, view.placeable_dates, cadence)

  // Counting for a label, not deriving state: nothing here is held.
  const tally = (pick: (t: TodoTask) => boolean) =>
    view.groups.reduce((n, g) => n + g.tasks.filter(pick).length, 0)

  /*
   * One count per group, index-aligned with TODO_GROUPS — the strip's badges.
   * Index-aligned rather than keyed, like the day strip's, because the panes are
   * in the same order and the two must not be able to disagree.
   */
  const counts = TODO_GROUPS.map(
    (meta) =>
      view.groups.find((g) => g.cadence === meta.cadence)?.tasks.filter((t) => !t.is_done).length ??
      0,
  )

  // The reset control clears the WHOLE view, so it counts the whole view. It now
  // sits on a heading that names the whole view too, which is what this move
  // fixes: the control used to live inside Routine while counting past it, and
  // once offered to "clear the day from 0 overdue items" and then cleared two.
  const overdue = tally((t) => t.is_overdue)

  return (
    <section className="todo" aria-label="Backlog" data-busy={locked || undefined}>
      {/* The heading names the whole track, and carries the one control that
          acts on the whole track. */}
      <div className="todo__head">
        <h2 className="todo__title">Backlog</h2>
        {view.has_overdue && (
          <div className="todo__bar">
            {/* Deliberately not the row's own words: "Needs a day" is a mark on
                a task, and a summary that reads identically makes the two
                indistinguishable by voice or by search. */}
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
      </div>

      <GroupStrip
        groups={TODO_GROUPS}
        counts={counts}
        index={groups.index}
        onGo={groups.goTo}
        disabled={locked}
      />

      <Track label="Backlog groups" trackRef={groups.trackRef} onScroll={groups.onScroll}>
        {/* Always all six, always in this order, empty or not: the track is a
            map of the periods as much as a list of tasks. */}
        {TODO_GROUPS.map((meta) => {
          const group = view.groups.find((g) => g.cadence === meta.cadence)
          const tasks = group?.tasks ?? []
          const from = group?.period_start ?? null
          const to = group?.period_end ?? null
          return (
            <section
              className="pane todo-group"
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
                      task={asShown(task)}
                      today={view.today}
                      placeable={view.placeable_dates}
                      placeableMax={maxFor(task.cadence)}
                      picking={picking === task.id}
                      onPicking={(o) => setPicking(o ? task.id : null)}
                      onEdit={() => setEditingId(task.id)}
                      onToggleDone={() => toggleDone(task)}
                      run={run}
                      locked={locked}
                    />
                  ))}
                </ul>
              )}
            </section>
          )
        })}
      </Track>

      {editing !== null && (
        <TaskEditor
          task={editing}
          categories={view.categories}
          locked={locked}
          today={view.today}
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
    </section>
  )
}
