import type { ISODate } from '../shared/types.ts'

/**
 * The one place dates are formatted. Every view imports from here.
 *
 * Dates are 'YYYY-MM-DD' strings. NEVER `new Date(iso)` — that parses as UTC
 * midnight and renders as the previous day west of Greenwich. Split the string.
 */

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const
const DOW_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const
const MON_LONG = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
] as const

function parts(iso: ISODate): { y: number; m: number; d: number } {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number]
  return { y, m, d }
}

/** 0 = Sunday. Date.UTC is used only to get a weekday index, which is timezone-immune. */
export function weekday(iso: ISODate): number {
  const { y, m, d } = parts(iso)
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay()
}

/** `Saturday, 5 September` — the Day header. */
export function longDate(iso: ISODate): string {
  const { m, d } = parts(iso)
  return `${DOW_LONG[weekday(iso)]}, ${d} ${MON_LONG[m - 1]}`
}

/** `Sat 5 Sep` — day picker chips, overdue badges. */
export function shortDate(iso: ISODate): string {
  const { m, d } = parts(iso)
  return `${DOW[weekday(iso)]} ${d} ${MON[m - 1]}`
}

/** `Sat` — the day strip's buttons, where seven labels share a phone's width. */
export function weekdayShort(iso: ISODate): string {
  return DOW[weekday(iso)]!
}

/** `Sat 5` — a day column heading. */
export function dayLabel(iso: ISODate): string {
  return `${DOW[weekday(iso)]} ${parts(iso).d}`
}

/** `September 2026` */
export function monthYear(iso: ISODate): string {
  const { y, m } = parts(iso)
  return `${MON_LONG[m - 1]} ${y}`
}

/**
 * A period range, collapsed as far as it honestly can be:
 *   same day    -> `Sat 5 Sep`
 *   same month  -> `1 – 30 Sep 2026`
 *   same year   -> `Jul – Sep 2026`   (whole months)  /  `30 Aug – 5 Sep 2026`
 *   whole year  -> `2026`
 */
export function periodLabel(start: ISODate, end: ISODate): string {
  const a = parts(start)
  const b = parts(end)
  if (start === end) return shortDate(start)
  const wholeYear = a.m === 1 && a.d === 1 && b.m === 12 && b.d === 31
  if (wholeYear && a.y === b.y) return String(a.y)

  const startsMonth = a.d === 1
  const endsMonth = end === lastOfMonth(b.y, b.m)
  if (startsMonth && endsMonth && a.y === b.y) {
    return a.m === b.m ? `${MON_LONG[a.m - 1]} ${a.y}` : `${MON[a.m - 1]} – ${MON[b.m - 1]} ${a.y}`
  }
  if (a.y === b.y && a.m === b.m) return `${a.d} – ${b.d} ${MON[a.m - 1]} ${a.y}`
  if (a.y === b.y) return `${a.d} ${MON[a.m - 1]} – ${b.d} ${MON[b.m - 1]} ${a.y}`
  return `${a.d} ${MON[a.m - 1]} ${a.y} – ${b.d} ${MON[b.m - 1]} ${b.y}`
}

function lastOfMonth(y: number, m: number): ISODate {
  const d = new Date(Date.UTC(y, m, 0)).getUTCDate()
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
}
