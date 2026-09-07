import { useState } from 'react'
import type { Cadence, ISODate } from '../shared/types.ts'
import { Confirm, DayPicker, Sheet } from './ui.tsx'
import { TaskFields, draftIsValid, draftToPatch, type TaskDraft } from './TaskFields.tsx'

/**
 * The task editor. Slow and deliberate, the opposite of capture.
 *
 * It opens from two places now — a name in the To do panel, and the edit button
 * on a Day row. It used to be one, and `.plan/design/views.md` said so; see
 * `.plan/changes-v10.md` for why that changed and what keeps the original
 * reasoning intact.
 *
 * Archive is the only removal; there is no delete anywhere.
 */

/** The fields the editor needs. Both `DayTask` and `TodoTask` satisfy it. */
export type EditableTask = {
  id: number
  name: string
  cadence: Cadence | null
  is_baseline: boolean
  color: string | null
  category: string | null
  /** The day shown against the row — EFFECTIVE, not `tasks.planned_date`. */
  effective_date: ISODate | null
}

export function TaskEditor({
  task,
  categories,
  locked,
  today,
  placeable,
  placeableMax,
  onClose,
  onSave,
  onArchive,
}: {
  task: EditableTask
  categories: string[]
  locked: boolean
  today: ISODate
  placeable: ISODate[]
  placeableMax: ISODate | null
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
    planned_date: task.effective_date,
  })

  /*
   * The date the sheet opened on. Placement is sent ONLY when it differs.
   *
   * That is not fussiness: the draft is seeded with `effective_date`, which is
   * not `tasks.planned_date` — a task whose date has fallen out of its period
   * reads as null here while the column still holds the old value. Sending the
   * draft back unconditionally would quietly rewrite that column on every save.
   */
  const [openedOn] = useState<ISODate | null>(task.effective_date)

  // Daily tasks are never placed; the server nulls the column on write.
  const canPlace = draft.cadence !== 'day'
  const placed = draft.planned_date !== null

  return (
    <Sheet title="Edit task" onClose={onClose}>
      <form
        className="form form--stack"
        onSubmit={(e) => {
          e.preventDefault()
          if (!draftIsValid(draft)) return
          onSave({
            id: task.id,
            ...draftToPatch(draft),
            // Omitted when untouched: `update_task` leaves out what it is not sent.
            ...(draft.planned_date !== openedOn ? { planned_date: draft.planned_date } : {}),
          })
        }}
      >
        <TaskFields draft={draft} onChange={setDraft} categories={categories} />

        {canPlace && (
          <div className="field">
            <span className="field-label">Day</span>
            <DayPicker
              dates={placeable}
              max={placeableMax}
              today={today}
              selected={draft.planned_date}
              disabled={locked}
              onPick={(date) => setDraft({ ...draft, planned_date: date })}
            />
            {placed && (
              <button
                type="button"
                className="btn btn--small btn--quiet"
                disabled={locked}
                onClick={() => setDraft({ ...draft, planned_date: null })}
              >
                Clear day
              </button>
            )}
          </div>
        )}

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
