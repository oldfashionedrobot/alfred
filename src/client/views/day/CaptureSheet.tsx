import { useState } from 'react'
import {

  TaskFields,
  draftIsValid,
  draftToPatch,
  emptyDraft,
  type TaskDraft,
} from '../../TaskFields.tsx'
import type { Cadence, ISODate } from '../../../shared/types.ts'
import { Sheet } from '../../ui.tsx'
// --- capture ----------------------------------------------------------------
// One field, nothing else. Deliberately not extensible: a form on the fast path
// is a form you stop bothering with.

/**
 * One task per line: trimmed, blanks dropped, repeats within the paste collapsed.
 *
 * The same parse `create_tasks` runs on the server, so the count on the button is
 * the number that will actually be created rather than the number of lines typed.
 */
export function parseNames(text: string): string[] {
  return [...new Set(text.split('\n').map((l) => l.trim()).filter((l) => l !== ''))]
}

export function CaptureSheet({
  busy,
  today,
  defaultPlaceToday,
  onClose,
  onCreate,
  onCreateMany,
}: {
  busy: boolean
  today: ISODate
  /** Prechecked when capture was opened by "Add task" from today's list. */
  defaultPlaceToday: boolean
  onClose: () => void
  onCreate: (patch: Record<string, unknown>) => void
  onCreateMany: (names: string[], plannedDate: ISODate | null) => void
}) {
  const [many, setMany] = useState(false)
  const [draft, setDraft] = useState<TaskDraft>(emptyDraft())
  const [lines, setLines] = useState('')

  /*
   * One box for both modes, held here rather than in `TaskFields`, because Many
   * has no draft to put it in — it is a textarea and a count. Keeping it above
   * the mode forms also means switching One/Many does not lose the choice.
   */
  const [placeToday, setPlaceToday] = useState(defaultPlaceToday)

  const names = parseNames(lines)
  // Daily tasks are never placed; the server nulls the column on write.
  const dailyOne = !many && draft.cadence === 'day'
  const placing = placeToday && !dailyOne

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

      <label className="check capture-today">
        <input
          type="checkbox"
          checked={placing}
          disabled={busy || dailyOne}
          onChange={(e) => setPlaceToday(e.target.checked)}
        />
        <span>
          Place today
          {dailyOne && <em> — a daily task is already on every day</em>}
        </span>
      </label>

      {many ? (
        <>
          <form
            className="form form--stack"
            onSubmit={(e) => {
              e.preventDefault()
              if (names.length > 0) onCreateMany(names, placing ? today : null)
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
            {placing
              ? 'They all land on today’s list. Give them a cadence afterwards, in the Routine panel.'
              : 'They all go to the backlog with no date. Give them a cadence or a day afterwards, in the Routine or Backlog panel.'}
          </p>
        </>
      ) : (
        <>
          <form
            className="form form--stack"
            onSubmit={(e) => {
              e.preventDefault()
              if (draftIsValid(draft)) {
                onCreate({ ...draftToPatch(draft), planned_date: placing ? today : null })
              }
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
            {placing
              ? 'It lands on today’s list.'
              : 'A name alone goes to the backlog with no date — it won’t appear on today’s list.'}
          </p>
        </>
      )}
    </Sheet>
  )
}

// --- task editor ------------------------------------------------------------
// Slow and deliberate. Archive is the only removal in the system.
