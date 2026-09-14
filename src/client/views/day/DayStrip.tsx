import type { ISODate } from '../../../shared/types.ts'
import { longDate, weekdayShort } from '../../dates.ts'

// --- the day strip ----------------------------------------------------------

/**
 * Previous, one button per day of the week, next.
 *
 * Each day carries the number of things outstanding on it, so the week's shape
 * is readable without flipping through it — which is what the panes were asked
 * for in the first place. Past days have no count because they have no pane.
 *
 * ALL SEVEN days are shown so the week reads as a week, but only today onward
 * are panes — the earlier ones are rendered disabled rather than omitted, which
 * keeps the strip the same width all week and says plainly that a past day is
 * not somewhere you can go.
 *
 * `panes` is `DayView.panes` — the viewed week's panes, in order — so a day's
 * button and its pane are matched by position in the one list the server
 * derived. It stopped being `placeable_dates` in v16: paging means the panes are
 * whatever week you are on while the picker's chips stay this week's, and one
 * field could no longer mean both.
 *
 * `index` comes from the track's scroll position, so this highlights where the
 * panes actually are.
 *
 * PREV AND NEXT ARE NOT PANE STEPPING. They ask the host to move, and the host
 * decides whether that is the next pane or the next week — which is why this
 * takes `canPrev` / `canNext` rather than comparing `index` against the ends.
 * Comparing here would have hard-coded "a week is all there is" into the one
 * component that now has to page past it.
 */
export function DayStrip({
  dates,
  today,
  panes,
  counts,
  index,
  onGo,
  onPrev,
  onNext,
  canPrev,
  canNext,
  disabled,
}: {
  dates: ISODate[]
  today: ISODate
  panes: ISODate[]
  /** Outstanding items per pane, index-aligned with `panes`. */
  counts: number[]
  index: number
  onGo: (i: number) => void
  /** One step back — a pane, or the week before it. The host decides which. */
  onPrev: () => void
  onNext: () => void
  canPrev: boolean
  canNext: boolean
  disabled: boolean
}) {
  const showing = panes[index]

  return (
    <nav className="day-strip" aria-label="Days of this week">
      <button
        className="day-strip__step"
        aria-label="Previous day"
        disabled={disabled || !canPrev}
        onClick={onPrev}
      >
        <span aria-hidden="true">‹</span>
      </button>

      <ul className="day-strip__days">
        {dates.map((d) => {
          // Not a pane: it is behind today. -1 from indexOf is the whole test.
          const pane = panes.indexOf(d)
          const count = pane < 0 ? null : (counts[pane] ?? 0)
          return (
            <li key={d}>
              <button
                className="day-strip__day"
                // The count belongs in the name, not only in the badge: the badge
                // is aria-hidden, and "Tuesday, 3 tasks" is the whole point of it.
                aria-label={[
                  longDate(d),
                  d === today ? ' — today' : '',
                  count === null ? '' : count === 1 ? ', 1 task' : `, ${count} tasks`,
                ].join('')}
                aria-current={d === showing ? 'true' : undefined}
                data-today={d === today ? '' : undefined}
                disabled={disabled || pane < 0}
                onClick={() => onGo(pane)}
              >
                <span className="day-strip__dow">{weekdayShort(d)}</span>
                {/* The slot is always rendered so the buttons stay the same
                    height; a zero is left blank rather than drawn, because a row
                    of zeroes is noise and an empty day is not news. */}
                <span className="day-strip__count" aria-hidden="true">
                  {count !== null && count > 0 ? count : ''}
                </span>
              </button>
            </li>
          )
        })}
      </ul>

      <button
        className="day-strip__step"
        aria-label="Next day"
        disabled={disabled || !canNext}
        onClick={onNext}
      >
        <span aria-hidden="true">›</span>
      </button>
    </nav>
  )
}
