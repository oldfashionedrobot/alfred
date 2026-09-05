import type { Cadence, ISODate } from '../shared/types.ts'
import type { CompletionRow, TaskRow } from './schema.ts'

/**
 * The single implementation of "Computing state" in `.plan/data-model.md`.
 *
 * Pure and I/O-free. Every function takes `today` as an argument rather than
 * reading the clock — that is what makes them directly testable, and the
 * month-boundary regression is just a call with today = '2026-09-29'.
 *
 * Weeks run SUNDAY to SATURDAY.
 */

// ---------------------------------------------------------------------------
// Calendar arithmetic — the only place in the codebase a date is parsed.
// Everything crossing a function boundary is a 'YYYY-MM-DD' string; the Date
// objects below never escape this module, and every one of them is UTC so a
// local offset can never shift a day.
// ---------------------------------------------------------------------------

/** 'YYYY-MM-DD' -> a UTC Date at midnight. Internal only. */
function parseUTC(date: ISODate): Date {
  const y = Number(date.slice(0, 4))
  const m = Number(date.slice(5, 7))
  const d = Number(date.slice(8, 10))
  return new Date(Date.UTC(y, m - 1, d))
}

/** A UTC Date -> 'YYYY-MM-DD'. Internal only. */
function formatUTC(d: Date): ISODate {
  const y = String(d.getUTCFullYear()).padStart(4, '0')
  const m = String(d.getUTCMonth() + 1).padStart(2, '0')
  const day = String(d.getUTCDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/** The Sunday on or before `date`. Weeks run Sunday to Saturday. */
function sundayOf(date: ISODate): ISODate {
  const d = parseUTC(date)
  d.setUTCDate(d.getUTCDate() - d.getUTCDay()) // getUTCDay(): 0 = Sunday
  return formatUTC(d)
}

/**
 * Plain calendar stepping — `n` days from `date`. Not a period boundary itself,
 * but it lives here so that parsing a date stays confined to this module.
 */
export function addDays(date: ISODate, n: number): ISODate {
  const d = parseUTC(date)
  d.setUTCDate(d.getUTCDate() + n)
  return formatUTC(d)
}

/** 1..4 — Q1 Jan-Mar, Q2 Apr-Jun, Q3 Jul-Sep, Q4 Oct-Dec. */
function quarterOf(month: number): number {
  return Math.floor((month - 1) / 3) + 1
}

/**
 *   day     -> '2026-09-05'
 *   week    -> 'W2026-08-30'   (that week's Sunday, never an ISO week number)
 *   month   -> '2026-09'
 *   quarter -> '2026-Q3'
 *   year    -> '2026'
 *   null    -> 'once'          (every date maps to the same key)
 */
export function periodKey(date: ISODate, cadence: Cadence | null): string {
  switch (cadence) {
    case 'day':
      return date
    case 'week':
      return `W${sundayOf(date)}`
    case 'month':
      return date.slice(0, 7)
    case 'quarter':
      return `${date.slice(0, 4)}-Q${quarterOf(Number(date.slice(5, 7)))}`
    case 'year':
      return date.slice(0, 4)
    case null:
      return 'once'
  }
}

/**
 *   day     -> today
 *   week    -> Sunday of this week
 *   month   -> 1st of this month
 *   quarter -> 1st of this quarter
 *   year    -> 1 Jan
 *   null    -> null  (unbounded — a one-off's date never falls out)
 */
export function periodStart(today: ISODate, cadence: Cadence | null): ISODate | null {
  switch (cadence) {
    case 'day':
      return today
    case 'week':
      return sundayOf(today)
    case 'month':
      return `${today.slice(0, 7)}-01`
    case 'quarter': {
      const firstMonth = (quarterOf(Number(today.slice(5, 7))) - 1) * 3 + 1
      return `${today.slice(0, 4)}-${String(firstMonth).padStart(2, '0')}-01`
    }
    case 'year':
      return `${today.slice(0, 4)}-01-01`
    case null:
      return null
  }
}

/**
 * The last day of the period containing `today`. Null for a one-off — unbounded.
 *
 * Exists only to label the To do panel's groups, so the client never needs to
 * know that September has thirty days.
 */
export function periodEnd(today: ISODate, cadence: Cadence | null): ISODate | null {
  switch (cadence) {
    case 'day':
      return today
    case 'week':
      return addDays(sundayOf(today), 6)
    case 'month':
      return lastOfMonth(Number(today.slice(0, 4)), Number(today.slice(5, 7)))
    case 'quarter':
      return lastOfMonth(Number(today.slice(0, 4)), quarterOf(Number(today.slice(5, 7))) * 3)
    case 'year':
      return `${today.slice(0, 4)}-12-31`
    case null:
      return null
  }
}

/** Day 0 of the next month is the last day of this one. */
function lastOfMonth(year: number, month: number): ISODate {
  return formatUTC(new Date(Date.UTC(year, month, 0)))
}

/**
 * planned_date, unless planned_date < periodStart(today, cadence); otherwise null.
 *
 * BACKWARD-ONLY BY DESIGN. It asks whether a date has fallen behind the current
 * period, never whether it sits ahead of one. A symmetric period-key comparison
 * breaks at boundaries: in the week of Sun Sep 27 - Sat Oct 3, a monthly task
 * placed Fri Oct 2 while today is Tue Sep 29 sits in the current week but a
 * different month, and would be wrongly discarded — placed, then vanished.
 */
export function effectiveDate(task: TaskRow, today: ISODate): ISODate | null {
  const planned = task.planned_date
  if (planned == null) return null
  const start = periodStart(today, task.cadence)
  // An unbounded period start (one-off) can never be fallen behind.
  if (start === null) return planned
  return planned < start ? null : planned
}

/**
 * Some completion falls in the same period as today.
 *
 * `completions` are this task's completions; the caller does the filtering
 * (every call site already has them narrowed by task_id).
 */
export function isDone(task: TaskRow, completions: CompletionRow[], today: ISODate): boolean {
  const key = periodKey(today, task.cadence)
  return completions.some((c) => periodKey(c.completed_on, task.cadence) === key)
}

/** No effective date — never placed, or placed in a period now past. Still due. */
export function isUnplaced(task: TaskRow, today: ISODate): boolean {
  return effectiveDate(task, today) === null
}

/** Not done, and effective_date is strictly before today. Means "needs a new day". */
export function isOverdue(task: TaskRow, completions: CompletionRow[], today: ISODate): boolean {
  const effective = effectiveDate(task, today)
  if (effective === null) return false
  if (effective >= today) return false
  return !isDone(task, completions, today)
}

/**
 * The completion satisfying today's period for this task, or null.
 * Used by the `uncomplete` command: unticking a weekly task on Wednesday that
 * was completed Tuesday must delete TUESDAY's row. Where several exist in the
 * period, returns the most recent.
 */
export function completionForPeriod(
  task: TaskRow,
  completions: CompletionRow[],
  today: ISODate,
): CompletionRow | null {
  const key = periodKey(today, task.cadence)
  let best: CompletionRow | null = null
  for (const c of completions) {
    if (periodKey(c.completed_on, task.cadence) !== key) continue
    if (best === null || c.completed_on > best.completed_on) best = c
  }
  return best
}
