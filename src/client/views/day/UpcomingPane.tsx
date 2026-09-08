import type { Cadence, DayTask, ISODate, UpcomingDay } from '../../../shared/types.ts'
import { dayLabel, longDate } from '../../dates.ts'
import { TaskRow } from './TaskRow.tsx'

// --- upcoming panes ---------------------------------------------------------

/**
 * One day of this week that is not today.
 *
 * Placed tasks only, and only those still outstanding — the server decides both
 * and this renders what it sent. Daily tasks are absent because one can never
 * hold a planned_date; a task already satisfied for its period is absent because
 * a done task adds no load to the day. See `.plan/changes/changes-v8.md`.
 *
 * The rows are `TaskRow` with `future` set — the same component today's pane
 * uses, which is why `UpcomingDay.tasks` is `DayTask[]` and not a narrower type.
 */
export function UpcomingPane({
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
  onEdit,
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
  onEdit: (id: number) => void
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
                onEdit={() => onEdit(task.id)}
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
