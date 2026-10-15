/**
 * Wire types — the contract between server and client.
 * The wire contract. Field names are snake_case, matching the data model;
 * there is no wire renaming anywhere.
 */

export type Cadence = 'day' | 'week' | 'month' | 'quarter' | 'year'

/** 'YYYY-MM-DD'. Dates are strings end to end — never Date, never a timestamp. */
export type ISODate = string

/**
 * How long a password has to be. The one definition of long enough.
 *
 * Shared because both sides say it: the server enforces it — on `/api/claim`,
 * on a password change, and in the CLI — and the two forms have to state the
 * same number to the person typing, or one of them is lying.
 */
export const MIN_PASSWORD = 12

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
  /**
   * Done for its current period — struck through, and sunk to the bottom of
   * the list rather than moved into a section of its own.
   */
  is_done: boolean
  /**
   * Free text, and rendered nowhere on Day — carried because the task editor
   * opens from this list as well as from the panel, and it edits the category.
   */
  category: string | null
}

/**
 * One future day of the VIEWED week, in `DayView.upcoming`.
 *
 * `tasks` is what is PLACED on that date and not already satisfied for its
 * period.
 * Daily tasks are excluded structurally rather than by a filter: one can never
 * hold a planned_date, so `planned_date === date` never matches one.
 *
 * Reuses DayTask so a single row component renders every pane. Every row here is
 * state 'planned', its effective_date equals `date` and its is_done is false —
 * a satisfied task is dropped from a pane, not struck through on one. All three
 * are carried anyway rather than splitting the type.
 */
export interface UpcomingDay {
  date: ISODate
  /** Already in render order. The client never sorts. */
  tasks: DayTask[]
}

/**
 * ONE MODEL, TWO WEEKS. `date` is today; `week_dates` is the week being looked
 * at, which since v16 need not be the same one.
 *
 * Everything anchored to TODAY stays anchored to today whatever week is on
 * screen — `date`, `tasks`, `placeable_dates`, `placement`. Only the pane fields
 * follow the paging. Letting placement follow it as well would let a weekly task
 * be placed outside its own week, and `effectiveDate` is backward-only: such a
 * task would be neither overdue, nor unplaced, nor done, and its obligation
 * would go unmet with nothing on any screen saying so.
 */
export interface DayView {
  /** Today, never the viewed week. Every write still lands here. */
  date: ISODate
  mood: string | null
  log: string | null
  /** Active moods in sort_order — the picker row. */
  moods: Mood[]
  /**
   * Everything TODAY holds, done and not, in render order — the client never
   * sorts. Done rows are last, and carry `is_done` rather than a second array.
   *
   * Rides along unrendered while a later week is viewed. One endpoint answering
   * one question is worth more than the bytes; a second endpoint for "just the
   * panes" would be two things to keep in step.
   */
  tasks: DayTask[]
  /**
   * All seven days of the VIEWED week, Sunday first. The day strip renders one
   * button each and disables those before `date`; the client never derives a
   * week.
   */
  week_dates: ISODate[]
  /**
   * Today through THIS Saturday — the picker's chips, and nothing else.
   *
   * It was the pane list too, on the grounds that one derivation cannot disagree
   * with itself. Paging forced the two apart: the panes became the viewed week's
   * days while the chips stay bounded from today. The reason that note existed
   * is still live — these two are easy to conflate — so the panes got a field of
   * their own rather than this one stretched to mean both.
   */
  placeable_dates: ISODate[]
  /** One entry per placeable cadence, bounded from today. See `Placement`. */
  placement: Placement[]
  /**
   * Every pane in the viewed week, in order: today through Saturday for this
   * week, all seven days for a later one. This week's days already gone are not
   * panes — the past belongs to the Tracker.
   */
  panes: ISODate[]
  /**
   * `panes` minus today's. Empty on a Saturday of this week, which is what makes
   * that day one pane and no special case; all seven of a later week, which has
   * no today pane at all.
   */
  upcoming: UpcomingDay[]
  /**
   * The furthest `planned_date` over this user's active tasks, or null when
   * nothing is placed anywhere.
   *
   * It bounds how far the strip pages: everything scheduled is reachable and
   * nothing beyond it is. A fixed horizon would get both wrong at once — it lets
   * you page through nothing, and it hides a task placed past the edge.
   */
  last_placed: ISODate | null
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
   * fallen out the back of that period; such a task has no
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
  /** Always 6, in TODO_GROUPS order: once, day, week, month, quarter, year. */
  groups: TodoGroup[]
  /** Today through Saturday — the picker's chips. */
  placeable_dates: ISODate[]
  /** One entry per placeable cadence. See `Placement`. */
  placement: Placement[]
  has_overdue: boolean
  /** Distinct categories in use, sorted — the editor's suggestion list. */
  categories: string[]
}

/**
 * Group order and headings. The one-off group has no period.
 *
 * It leads the six because it is where capture lands — the group you reach for
 * without having decided a cadence should not be the one at the far end of the
 * track.
 *
 * The titles are cadence adjectives rather than period phrases ('Weekly', not
 * 'This week') because they are strip buttons now and share a phone's width.
 * Nothing is lost: `periodLabel` renders the period's actual range beside the
 * group heading, and "6 – 12 Sep 2026" says more than "This week" did. 'Any
 * time' is a LABEL for `cadence: null` — the model word stays one-off.
 */
export const TODO_GROUPS: ReadonlyArray<{ cadence: Cadence | null; title: string }> = [
  { cadence: null, title: 'Any time' },
  { cadence: 'day', title: 'Daily' },
  { cadence: 'week', title: 'Weekly' },
  { cadence: 'month', title: 'Monthly' },
  { cadence: 'quarter', title: 'Quarterly' },
  { cadence: 'year', title: 'Yearly' },
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
