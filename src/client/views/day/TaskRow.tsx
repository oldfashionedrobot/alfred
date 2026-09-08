import type { CSSProperties } from 'react'
import type { ReactNode } from 'react'
import type { Cadence, DayTask, ISODate } from '../../../shared/types.ts'
import { shortDate } from '../../dates.ts'
import { DayPicker, Popover, Tick } from '../../ui.tsx'

const CADENCE_WORD: Record<Cadence, string> = {
  day: 'daily',
  week: 'weekly',
  month: 'monthly',
  quarter: 'quarterly',
  year: 'yearly',
}

export function TaskName({ task }: { task: DayTask }) {
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

export function TaskRow({
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
  onEdit,
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
  /** Opens the editor. A button, never the row: a tap here is a tap while working. */
  onEdit: () => void
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
        <button
          className="btn btn--small btn--quiet day-row__edit"
          onClick={onEdit}
          aria-label={`Edit ${task.name}`}
          disabled={busy}
        >
          Edit
        </button>
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
