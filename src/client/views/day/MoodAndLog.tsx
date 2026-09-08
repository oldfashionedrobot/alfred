import { useState } from 'react'
import type { DayView } from '../../../shared/types.ts'

// --- mood and log -----------------------------------------------------------
// Sits at the foot of the day, under the panels: the tasks are what the screen
// is for, and a mood belongs where the day is closed out rather than where it is
// worked. Compact anyway — a mood is one tap and a log is one line. The mood set
// is not editable here or anywhere in the app; it is a table, edited in the DB.

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

// --- task rows --------------------------------------------------------------

/** The name, and at most one piece of metadata beside it. */
