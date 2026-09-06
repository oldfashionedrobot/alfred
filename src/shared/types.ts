/**
 * Wire types — the contract between server and client.
 * Mirrors `.plan/api.md`. Field names are snake_case, matching the data model;
 * there is no wire renaming anywhere.
 */

export type Cadence = 'day' | 'week' | 'month' | 'quarter' | 'year'

/** 'YYYY-MM-DD'. Dates are strings end to end — never Date, never a timestamp. */
export type ISODate = string

export const CADENCES: readonly Cadence[] = ['day', 'week', 'month', 'quarter', 'year']

export function isCadence(v: unknown): v is Cadence {
  return typeof v === 'string' && (CADENCES as readonly string[]).includes(v)
}

/** '#rrggbb' and nothing else. */
export function isHexColor(v: unknown): v is string {
  return typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v)
}

/** 'YYYY-MM-DD' and nothing else. Rejects '2026-9-5' and '2026-13-01'. */
export function isISODate(v: unknown): v is ISODate {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false
  const [y, m, d] = v.split('-').map(Number) as [number, number, number]
  if (m < 1 || m > 12 || d < 1 || d > 31) return false
  const dt = new Date(Date.UTC(y, m - 1, d))
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d
}

// ---------------------------------------------------------------------------
// Moods
// ---------------------------------------------------------------------------

export interface Mood {
  slug: string
  emoji: string
  label: string
  sort_order: number
  active: boolean
}

// ---------------------------------------------------------------------------
// Placement
// ---------------------------------------------------------------------------

/**
 * How far ahead a task of this cadence may be placed.
 *
 * The bound is THIS WEEK UNION THE TASK'S OWN CURRENT PERIOD — not the calendar
 * week alone, and not the period alone.
 *
 * The period half is what makes a placement coherent: `planned_date` says which
 * day inside the current period you mean to do it on, so a monthly task may name
 * any day this month and a one-off, whose period is unbounded, may name any day
 * at all. Placing a recurring task OUTSIDE its period is what the union
 * forbids — `effectiveDate` is backward-only, so such a task would never be
 * overdue, never unplaced and never done, and its obligation would go unmet with
 * nothing on any screen saying so.
 *
 * The week half preserves an exception `period.ts` already documents: when the
 * current week straddles a month boundary, a monthly task may be placed on the
 * far side of it. Bounding by the period alone would have taken that away.
 */
export interface Placement {
  /** null = the one-off range. 'day' is absent: a daily task is never placed. */
  cadence: Cadence | null
  /** Today. Nothing is ever placed in the past. */
  min: ISODate
  /** The last placeable day, or null when the period is unbounded (one-off). */
  max: ISODate | null
}

// ---------------------------------------------------------------------------
// Day view
// ---------------------------------------------------------------------------

/**
 * 'daily'   — cadence 'day', implicitly on every day, never placed
 * 'planned' — effective_date is today
 * 'overdue' — effective_date in the past and not done
 */
export type DayTaskState = 'daily' | 'planned' | 'overdue'

export interface DayTask {
  id: number
  name: string
  is_baseline: boolean
  /** '#rrggbb'. Null unless the task is baseline — the server decides. */
  color: string | null
  cadence: Cadence | null
  planned_date: ISODate | null
  state: DayTaskState
  effective_date: ISODate | null
}

/**
 * One future day of this week, in `DayView.upcoming`.
 *
 * `tasks` is what is PLACED on that date and not already satisfied for its
 * period — see "Future panes show placed tasks only" in `.plan/changes-v8.md`.
 * Daily tasks are excluded structurally rather than by a filter: one can never
 * hold a planned_date, so `planned_date === date` never matches one.
 *
 * Reuses DayTask so a single row component renders every pane. Every row here is
 * state 'planned' and its effective_date equals `date`; both are carried anyway
 * rather than splitting the type.
 */
export interface UpcomingDay {
  date: ISODate
  /** Already in render order. The client never sorts. */
  tasks: DayTask[]
}

export interface DayView {
  date: ISODate
  mood: string | null
  log: string | null
  /** Active moods in sort_order — the picker row. */
  moods: Mood[]
  /** Already in render order. The client never sorts. */
  active: DayTask[]
  /** Period-satisfied, sorted independently. */
  completed: DayTask[]
  /**
   * All seven days of this week, Sunday first. The day strip renders one button
   * each and disables those before `date`; the client never derives a week.
   */
  week_dates: ISODate[]
  /**
   * Today through Saturday — the picker's chips, and the days that have panes.
   * One derivation for both, so they cannot disagree. NOT the whole placeable
   * range any more: `placement` bounds what lies beyond this week.
   */
  placeable_dates: ISODate[]
  /** One entry per placeable cadence. See `Placement`. */
  placement: Placement[]
  /**
   * Tomorrow through Saturday — `placeable_dates` minus today. Empty on a
   * Saturday, which is what makes that day one pane and no special case.
   */
  upcoming: UpcomingDay[]
}

// ---------------------------------------------------------------------------
// To do panel — hosted by Day. Week hosted it too until v8 merged the two.
// ---------------------------------------------------------------------------

export interface TodoTask {
  id: number
  name: string
  cadence: Cadence | null
  /** Carried for the task editor, which opens from this panel. */
  is_baseline: boolean
  /** '#rrggbb'. Null unless the task is baseline — the server decides. */
  color: string | null
  /**
   * The day shown against the row — the EFFECTIVE date, not `tasks.planned_date`.
   * Rollover is a read, so the column still holds last period's date after it has
   * fallen out the back of that period; `data-model.md` says such a task has no
   * day against it. Null also puts the row in the unplaced band.
   */
  effective_date: ISODate | null
  /** Done for its current period — struck through. */
  is_done: boolean
  /** Placed on a date now past and not done — "needs a day". */
  is_overdue: boolean
  /** Free text. Clusters rows inside a period group; null sorts last, unheaded. */
  category: string | null
}

export interface TodoGroup {
  /** null = the one-off group. */
  cadence: Cadence | null
  /** Current period boundaries; null only for the one-off group. */
  period_start: ISODate | null
  period_end: ISODate | null
  tasks: TodoTask[]
}

export interface TodoView {
  today: ISODate
  /** Always 6, in cadence order: day, week, month, quarter, year, once. */
  groups: TodoGroup[]
  /** Today through Saturday — the picker's chips. */
  placeable_dates: ISODate[]
  /** One entry per placeable cadence. See `Placement`. */
  placement: Placement[]
  has_overdue: boolean
  /** Distinct categories in use, sorted — the editor's suggestion list. */
  categories: string[]
}

/** Group order and headings. The one-off group has no period. */
export const TODO_GROUPS: ReadonlyArray<{ cadence: Cadence | null; title: string }> = [
  { cadence: 'day', title: 'Today' },
  { cadence: 'week', title: 'This week' },
  { cadence: 'month', title: 'This month' },
  { cadence: 'quarter', title: 'This quarter' },
  { cadence: 'year', title: 'This year' },
  { cadence: null, title: 'One-off' },
]

// ---------------------------------------------------------------------------
// History view
// ---------------------------------------------------------------------------

export interface HistoryColumn {
  task_id: number
  name: string
  /** '#rrggbb'. Null unless the task is baseline — the server decides. */
  color: string | null
}

export interface HistoryRow {
  date: ISODate
  /** Resolved, including retired moods. */
  mood: Mood | null
  completed: number[]
  /** That day's journal entry, if one was written. */
  log: string | null
}

export interface HistoryView {
  columns: HistoryColumn[]
  /** Most recent date first. Every date in range, including empty days. */
  rows: HistoryRow[]
  next_before: ISODate | null
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

export interface CommandOk {
  ok: true
}

export interface ApiError {
  error: string
}
