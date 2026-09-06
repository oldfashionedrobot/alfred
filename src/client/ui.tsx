import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
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

// --- popover --------------------------------------------------------------

/**
 * A small menu in the TOP LAYER, anchored under whatever opened it.
 *
 * The top layer is the point, not a flourish. The day picker opens from rows
 * inside `.day-track`, which is a horizontal scroll container, and from inside
 * the To do panel — an absolutely positioned dropdown would be clipped by the
 * first ancestor with `overflow` and would have to fight for a z-index besides.
 * A popover is in neither's coordinate system.
 *
 * It also stops the picker shoving the page around: opening one used to expand
 * a block inside the row and push everything below it down the screen.
 *
 * POSITION IS PROGRESSIVE. Where CSS anchor positioning is supported the menu
 * sits under its trigger and follows it on scroll, with no measuring code of our
 * own; where it is not, the popover keeps the UA's own placement — centred in
 * the viewport — which is a reasonable menu rather than a broken one. There is
 * no fallback branch to maintain and nothing reads a bounding box.
 *
 * DISMISSAL IS OURS, NOT THE PLATFORM'S — `popover="manual"`, not `"auto"`.
 * Auto light-dismisses on any pointerdown outside the element, and the browser's
 * own date-picker chrome is outside it: opening the calendar from the date field
 * and clicking through to another month dismissed the popover mid-interaction,
 * and the input committed whatever it was sitting on as it went. Clicking a
 * month arrow placed a task. Handling Escape and outside-pointerdown ourselves
 * costs a dozen lines and makes the date field usable, because an event whose
 * target is the input is inside the popover by any measure we apply.
 *
 * Only one is ever mounted — `pickerFor` is a single id — so one-at-a-time comes
 * from React rather than from the auto behaviour being given up here.
 *
 * No role and no label of its own: it is a layer, and whatever it wraps keeps
 * its own semantics. The day picker inside is still the group it always was.
 */
export function Popover({
  onClose,
  anchor,
  children,
}: {
  onClose: () => void
  /** A CSS anchor name unique to the trigger, e.g. `--pick-12`. */
  anchor: string
  children: ReactNode
}) {
  const ref = useRef<HTMLDivElement>(null)

  // Every call site passes an inline arrow, so `onClose` is a new function each
  // render. Held in a ref, the effect below can depend on nothing and run once.
  const close = useRef(onClose)
  close.current = onClose

  // Mounted only while open, so showing it is a mount effect. Rendering every
  // row's picker permanently and toggling visibility would put a hundred hidden
  // buttons in the document for a menu that is open one at a time.
  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.showPopover()

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close.current()
    }
    // Anything whose target is inside the popover keeps it open — which includes
    // the date field, and therefore the browser chrome the date field opens.
    const onDown = (e: Event) => {
      const target = e.target
      if (target instanceof Node && !el.contains(target)) close.current()
    }

    document.addEventListener('keydown', onKey)
    // Capture: a handler on the way down must not be able to swallow this.
    document.addEventListener('pointerdown', onDown, true)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('pointerdown', onDown, true)
      if (el.matches(':popover-open')) el.hidePopover()
    }
  }, [])

  return (
    <div
      ref={ref}
      popover="manual"
      className="pop"
      style={{ '--pop-anchor': anchor } as CSSProperties}
    >
      {children}
    </div>
  )
}

// --- day picker -----------------------------------------------------------

/**
 * This week as chips, plus a date field for anything further.
 *
 * It never computes, filters or extends either half. `dates` is the server's
 * `placeable_dates` — today through Saturday — and `max` is the far edge of that
 * cadence's `placement`, so the picker and the 409 from `place` cannot disagree.
 *
 * The chips stay because the common case is this week and a chip is one tap. The
 * field appears only when the cadence can actually reach past Saturday: a weekly
 * task's period IS this week, so it never grows one, while a monthly task gets
 * the rest of its month and a one-off gets no far edge at all.
 */
export function DayPicker({
  dates,
  today,
  selected,
  onPick,
  disabled,
  max = null,
}: {
  dates: ISODate[]
  today: ISODate
  selected: ISODate | null
  onPick: (date: ISODate) => void
  disabled?: boolean
  /** Far edge of the placeable range; null means unbounded (a one-off). */
  max?: ISODate | null
}) {
  const last = dates[dates.length - 1]
  const reachesPastThisWeek = max === null || (last !== undefined && max > last)

  if (dates.length === 0 && !reachesPastThisWeek) {
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

      {reachesPastThisWeek && (
        <input
          type="date"
          className="input picker__date"
          aria-label="Or a later date"
          min={today}
          // Omitted entirely when unbounded — max="" would bound it to nothing.
          {...(max !== null ? { max } : {})}
          // Held only while the choice is past the chips; a chip shows it otherwise.
          value={selected !== null && last !== undefined && selected > last ? selected : ''}
          disabled={disabled}
          onChange={(e) => {
            const picked = e.target.value
            // '' is a half-typed date in every browser. min/max constrain the
            // calendar but not the keyboard, and `place` answers an out-of-range
            // date with a 409 — so this refuses to ask rather than show an error
            // for something the field said was available.
            if (picked === '') return
            if (picked < today) return
            if (max !== null && picked > max) return
            onPick(picked)
          }}
        />
      )}
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
