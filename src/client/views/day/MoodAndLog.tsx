import { useState } from 'react'
import type { DayView, Mood } from '../../../shared/types.ts'

// --- mood and log -----------------------------------------------------------
// Behind a button on the date heading since v15: a mood is a once-a-day gesture
// at the end of the day, and it was sitting permanently in the middle of a
// screen used all day long. Compact anyway — a mood is one tap and a log is one
// line. The mood set is not editable here or anywhere in the app; it is a table,
// edited in the DB.

/**
 * The button on the date heading that opens the sheet.
 *
 * It WEARS the mood rather than merely labelling the sheet, because putting the
 * glyph row behind a button would otherwise hide whether today has a mood at
 * all. The accessible name says which one: the emoji is decoration, and an emoji
 * is not a thing a screen reader should be left to interpret.
 *
 * Nothing set falls back to a ring rather than to a neutral face. Every mood in
 * the table is a face, and a blank one is indistinguishable from 😑 "balanced"
 * at this size — an empty slot is not.
 */
export function MoodButton({
  mood,
  moods,
  disabled,
  onClick,
}: {
  /** The selected slug. Resolved against `moods` here, so the caller passes the model. */
  mood: string | null
  moods: Mood[]
  /**
   * Frozen during a reorder, exactly as the controls inside the sheet are: a
   * mood tap refetches, and the locally held id list is then reconciled against
   * a new model by dropping rows (D7). Opening the sheet is the first half of
   * that gesture, so it is the first thing to freeze.
   */
  disabled: boolean
  onClick: () => void
}) {
  const selected = moods.find((m) => m.slug === mood) ?? null
  const label = `Mood and log — ${selected === null ? 'none set' : selected.label}`

  return (
    <button
      className="day-mood-btn"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
    >
      <span aria-hidden="true">{selected === null ? '○' : selected.emoji}</span>
    </button>
  )
}

export function MoodAndLog({
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
