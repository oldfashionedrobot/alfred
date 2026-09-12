import { useRef, useState, type ReactNode, type RefObject, type UIEvent } from 'react'

// --- the paged track --------------------------------------------------------

/*
 * The paging two strips share.
 *
 * The week's days and the backlog's cadence groups are the same gesture twice:
 * a snapping scroll container, a strip above it that steps through the panes,
 * and a highlight saying where you are. Only the MECHANICS are shared — the
 * buttons are not, because a day button marks today and disables the days
 * already past while a group button does neither, and one component with four
 * flags to switch that off is worse than two small ones.
 *
 * Lifted out of Day.tsx unchanged, comments included: each line below is
 * load-bearing for a reason that was found the hard way.
 */

/**
 * Which pane is showing, and how to get to another one.
 *
 * `index` is NOT the source of truth for the scroll position — the track is,
 * and this reads it back off `scrollLeft`. A swipe and a button press then agree
 * by construction rather than by being kept in step.
 */
export function usePagedTrack(): {
  trackRef: RefObject<HTMLDivElement | null>
  index: number
  goTo: (i: number) => void
  onScroll: (e: UIEvent<HTMLDivElement>) => void
} {
  const trackRef = useRef<HTMLDivElement>(null)
  const [index, setIndex] = useState(0)

  /**
   * The distance between two panes: their width plus the flex gap.
   *
   * Measured rather than assumed, because the gap is a CSS variable. With fewer
   * than two children there is nothing to measure and nowhere to page, so 0 is
   * the honest answer and both callers below handle it.
   */
  const paneStep = (track: HTMLDivElement): number => {
    const kids = track.children
    if (kids.length < 2) return 0
    return (kids[1] as HTMLElement).offsetLeft - (kids[0] as HTMLElement).offsetLeft
  }

  const goTo = (i: number) => {
    const track = trackRef.current
    if (!track || i < 0 || i >= track.children.length) return
    track.scrollTo({ left: i * paneStep(track), behavior: 'smooth' })
  }

  const onScroll = (e: UIEvent<HTMLDivElement>) => {
    const track = e.currentTarget
    const step = paneStep(track)
    // Dividing the scroll position by a step of 0 pins the index at NaN, which
    // clamps to the last pane and highlights the wrong button.
    if (step <= 0) return
    const i = Math.round(track.scrollLeft / step)
    setIndex(Math.min(track.children.length - 1, Math.max(0, i)))
  }

  return { trackRef, index, goTo, onScroll }
}

/**
 * The scroll container the panes sit in.
 *
 * The snap is the browser's own gesture: no library and no handler of ours. The
 * strip above drives it through `goTo` and reads its position back through
 * `onScroll`.
 *
 * It is focusable and named because it scrolls — a region reachable only by
 * swiping is a region a keyboard cannot read, and arrow keys scroll this one
 * directly once it has focus.
 */
export function Track({
  label,
  locked,
  trackRef,
  onScroll,
  children,
}: {
  /** Names the scroll region — "This week, day by day", "Backlog groups". */
  label: string
  /**
   * Freezes the scrolling outright, for a reorder. That edit state is today-only
   * so there is nowhere to swipe to, and a dnd-kit drag inside a snapping
   * scroller is the interaction that cost two wrong fixes in v4 — the scrolling
   * is removed rather than debugged.
   */
  locked?: boolean
  trackRef: RefObject<HTMLDivElement | null>
  onScroll: (e: UIEvent<HTMLDivElement>) => void
  children: ReactNode
}) {
  return (
    <div
      className="track"
      ref={trackRef}
      onScroll={onScroll}
      tabIndex={0}
      role="region"
      aria-label={label}
      data-locked={locked || undefined}
    >
      {children}
    </div>
  )
}
