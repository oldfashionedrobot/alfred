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
 * `panes` is `placeable_dates`, so a day's button and its pane are matched by
 * position in the one list the server derived. `index` comes from the track's
 * scroll position, so this highlights where the panes actually are.
 */
export function DayStrip({
  dates,
  today,
  panes,
  counts,
  index,
  onGo,
  disabled,
}: {
  dates: ISODate[]
  today: ISODate
  panes: ISODate[]
  /** Outstanding items per pane, index-aligned with `panes`. */
  counts: number[]
  index: number
  onGo: (i: number) => void
  disabled: boolean
}) {
  const showing = panes[index]

  return (
    <nav className="day-strip" aria-label="Days of this week">
      <button
        className="day-strip__step"
        aria-label="Previous day"
        disabled={disabled || index <= 0}
        onClick={() => onGo(index - 1)}
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
        disabled={disabled || index >= panes.length - 1}
        onClick={() => onGo(index + 1)}
      >
        <span aria-hidden="true">›</span>
      </button>
    </nav>
  )
}
