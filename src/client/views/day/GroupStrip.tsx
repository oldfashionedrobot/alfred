import type { Cadence } from '../../../shared/types.ts'

// --- the group strip --------------------------------------------------------

/**
 * Previous, one button per cadence group, next.
 *
 * Modelled on `DayStrip` and deliberately not the same component: the day strip
 * marks today and disables the days already past, and neither is true here —
 * every group is always somewhere you can go. Two small components rather than
 * one with flags to switch half of itself off.
 *
 * Each group carries how many of its tasks are still to do, so the shape of the
 * backlog is readable without paging through it — which is what the panes were
 * asked for in the first place. It is a count for a label, not derived state.
 *
 * `groups` arrives as a prop rather than being imported from `TODO_GROUPS`: the
 * panes below are rendered from the same array, so button and pane are matched
 * by position in one list rather than by two modules agreeing about an order.
 */
export function GroupStrip({
  groups,
  counts,
  index,
  onGo,
  disabled,
}: {
  groups: ReadonlyArray<{ cadence: Cadence | null; title: string }>
  /** Items still to do per group, index-aligned with `groups`. */
  counts: number[]
  index: number
  onGo: (i: number) => void
  disabled: boolean
}) {
  return (
    <nav className="day-strip group-strip" aria-label="Backlog groups">
      <button
        className="day-strip__step"
        aria-label="Previous group"
        disabled={disabled || index <= 0}
        onClick={() => onGo(index - 1)}
      >
        <span aria-hidden="true">‹</span>
      </button>

      <ul className="group-strip__groups">
        {groups.map((group, i) => {
          const count = counts[i] ?? 0
          return (
            <li key={group.cadence ?? 'any'}>
              <button
                className="day-strip__day group-strip__group"
                // The count belongs in the name, not only in the badge: the badge
                // is aria-hidden, and "Weekly, 3 tasks" is the whole point of it.
                // A zero is spoken here though the badge drops it — "nothing in
                // this group" is an answer, and silence is not.
                aria-label={
                  count === 1 ? `${group.title}, 1 task` : `${group.title}, ${count} tasks`
                }
                aria-current={i === index ? 'true' : undefined}
                disabled={disabled}
                onClick={() => onGo(i)}
              >
                <span className="group-strip__title">{group.title}</span>
                {/* The slot is always rendered so the buttons stay the same
                    height; a zero is left blank rather than drawn, because a row
                    of zeroes is noise and an empty group is not news. */}
                <span className="day-strip__count" aria-hidden="true">
                  {count > 0 ? count : ''}
                </span>
              </button>
            </li>
          )
        })}
      </ul>

      <button
        className="day-strip__step"
        aria-label="Next group"
        disabled={disabled || index >= groups.length - 1}
        onClick={() => onGo(index + 1)}
      >
        <span aria-hidden="true">›</span>
      </button>
    </nav>
  )
}
