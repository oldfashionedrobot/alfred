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
  has_overdue: boolean
  /** today through Saturday. Never computed on the client. */
  placeable_dates: ISODate[]
}

// ---------------------------------------------------------------------------
// Week view
// ---------------------------------------------------------------------------

export interface WeekTask {
  id: number
  name: string
  is_baseline: boolean
  cadence: Cadence | null
  planned_date: ISODate | null
  is_done: boolean
  can_complete: boolean
}

export interface WeekDay {
  date: ISODate
  is_today: boolean
  is_past: boolean
  tasks: WeekTask[]
}

export interface WeekView {
  week_start: ISODate
  week_end: ISODate
  today: ISODate
  /** Exactly what the day picker may offer: today through Saturday. */
  placeable_dates: ISODate[]
  /** Always 7, Sunday first. Overdue/unplaced/backlog live in the To do panel. */
  days: WeekDay[]
}

// ---------------------------------------------------------------------------
// To do panel — hosted by Day and by Week, identical in both
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
  placeable_dates: ISODate[]
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
