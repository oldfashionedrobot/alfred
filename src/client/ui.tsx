import { useEffect, useState, type ReactNode } from 'react'
import type { ISODate } from '../shared/types.ts'
import { shortDate } from './dates.ts'

/**
 * The primitives every view shares. They live here because the first build grew
 * three button systems, two day pickers, two checkboxes and three notice bars —
 * the same widget written twice by authors who could not see each other.
 *
 * Styles are in styles.css. Nothing here is view-specific.
 */

// --- notice ---------------------------------------------------------------

export type Notice = { text: string; tone: 'info' | 'error' } | null

export function NoticeBar({ notice, onDismiss }: { notice: Notice; onDismiss: () => void }) {
  const text = notice?.text
  useEffect(() => {
    if (!text) return
    const t = setTimeout(onDismiss, 4000)
    return () => clearTimeout(t)
    // Keyed on the text alone: an inline onDismiss would restart the timer on
    // every parent render and the notice would never clear.
  }, [text]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!notice) return null
  return (
    <div className={`notice notice--${notice.tone}`} role={notice.tone === 'error' ? 'alert' : 'status'}>
      <span>{notice.text}</span>
      <button className="notice__x" onClick={onDismiss} aria-label="Dismiss">
        ✕
      </button>
    </div>
  )
}

// --- tick -----------------------------------------------------------------

export function Tick({
  done,
  disabled,
  label,
  onToggle,
}: {
  done: boolean
  disabled?: boolean
  label: string
  onToggle: () => void
}) {
  if (disabled) {
    return (
      <span className="tick tick--static">
        <span className="tick__box" data-done={done || undefined} aria-hidden="true" />
        <span className="sr">{done ? 'done' : 'not done'}</span>
      </span>
    )
  }
  return (
    <button
      className="tick"
      role="checkbox"
      aria-checked={done}
      aria-label={label}
      onClick={onToggle}
    >
      <span className="tick__box" data-done={done || undefined} aria-hidden="true" />
    </button>
  )
}

// --- day picker -----------------------------------------------------------

/**
 * Offers exactly the dates the server supplied and nothing else. It never
 * computes, filters or extends them: `place` rejects anything outside
 * placeable_dates with a 409, and the whole point of the server shipping the
 * list is that the picker and that rule cannot disagree.
 */
export function DayPicker({
  dates,
  today,
  selected,
  onPick,
  disabled,
}: {
  dates: ISODate[]
  today: ISODate
  selected: ISODate | null
  onPick: (date: ISODate) => void
  disabled?: boolean
}) {
  if (dates.length === 0) {
    return <p className="picker__empty">No days left this week.</p>
  }
  return (
    <div className="picker" role="group" aria-label="Pick a day">
      {dates.map((d) => (
        <button
          key={d}
          className="btn btn--small picker__day"
          aria-pressed={d === selected}
          disabled={disabled}
          onClick={() => onPick(d)}
        >
          {d === today ? 'Today' : shortDate(d)}
        </button>
      ))}
    </div>
  )
}

// --- inline confirm -------------------------------------------------------

/**
 * A two-step button for destructive actions. Inline rather than window.confirm:
 * native dialogs are hostile on a phone, and the confirm should name what it
 * affects, next to the thing it affects.
 */
export function Confirm({
  label,
  question,
  confirmLabel,
  onConfirm,
  disabled,
  tone = 'quiet',
}: {
  label: string
  question: string
  confirmLabel: string
  onConfirm: () => void
  disabled?: boolean
  tone?: 'quiet' | 'danger'
}) {
  const [armed, setArmed] = useState(false)
  if (!armed) {
    return (
      <button
        className={`btn btn--small btn--${tone}`}
        disabled={disabled}
        onClick={() => setArmed(true)}
      >
        {label}
      </button>
    )
  }
  return (
    <span className="confirm">
      <span className="confirm__q">{question}</span>
      <button
        className="btn btn--small btn--danger"
        disabled={disabled}
        onClick={() => {
          setArmed(false)
          onConfirm()
        }}
      >
        {confirmLabel}
      </button>
      <button className="btn btn--small btn--quiet" disabled={disabled} onClick={() => setArmed(false)}>
        Cancel
      </button>
    </span>
  )
}


// --- sheet ----------------------------------------------------------------

/** A bottom sheet. Escape and the scrim both close it. */
export function Sheet({
  title,
  onClose,
  children,
}: {
  title: string
  onClose: () => void
  children: ReactNode
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="sheet-scrim">
      {/* Not in the tab order: Escape and the Close button already cover keyboard. */}
      <button className="sheet-scrim-hit" tabIndex={-1} aria-label="Close" onClick={onClose} />
      <div className="sheet" role="dialog" aria-modal="true" aria-label={title}>
        <div className="sheet-bar">
          <h2>{title}</h2>
          <button className="btn btn--small btn--quiet" onClick={onClose}>
            Close
          </button>
        </div>
        <div className="sheet-body">{children}</div>
      </div>
    </div>
  )
}
