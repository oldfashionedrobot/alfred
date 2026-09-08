import { and, gte, inArray, or } from 'drizzle-orm'
import { CADENCES } from '../../shared/types.ts'
import type { Cadence, ISODate, Placement } from '../../shared/types.ts'
import type { DB } from '../db.ts'
import { completions } from '../schema.ts'
import type { CompletionRow, TaskRow } from '../schema.ts'
import { addDays, periodEnd, periodStart } from '../period.ts'

/** Every cadence that can hold a planned_date. 'day' cannot — it is never placed. */
const PLACEABLE_CADENCES: ReadonlyArray<Cadence | null> = ['week', 'month', 'quarter', 'year', null]

/**
 * The two things a view builder needs and must not derive twice: the dates it may
 * offer, and the current period's completions grouped by task.
 *
 * Day and Todo both ship `placeable_dates` and both read completions per task.
 * Both were duplication that produced real
 * defects — the picker and the 409 on `place` agreed only by coincidence of two
 * separate derivations, and two copies of the grouping disagreed on scope. There
 * is exactly one implementation of each here, and no builder computes a week
 * boundary inline.
 */

/**
 * The seven dates of the week containing `date`, Sunday first.
 *
 * `periodStart` owns the week boundary — it returns null only for the unbounded
 * one-off period, never for 'week'.
 *
 * Shipped as `DayView.week_dates` so the day strip can show all seven and grey
 * out the ones already past. `placeableDates` is the same week, filtered.
 */
export function weekDates(date: ISODate): ISODate[] {
  const start = periodStart(date, 'week')!
  return Array.from({ length: 7 }, (_, i) => addDays(start, i))
}

/**
 * Today through Saturday — the picker's chips, and the days Day gives a pane to.
 * On a Saturday that is one date; on a Sunday, seven.
 *
 * Since v8 this is no longer the WHOLE placeable range: `placementMax` bounds
 * what lies beyond this week, per cadence.
 */
export function placeableDates(date: ISODate): ISODate[] {
  return weekDates(date).filter((d) => d >= date)
}

/**
 * The last day a task of this cadence may be placed on, or null when its period
 * is unbounded. THIS WEEK UNION THE TASK'S OWN PERIOD — see `Placement` in
 * `shared/types.ts` for why it is a union and not either half.
 *
 * The union is a max, and it is doing real work in both directions: for a weekly
 * task `periodEnd` IS Saturday, so the two agree; for a monthly task in a week
 * that straddles into the next month, Saturday is the later of the two and the
 * straddle `period.ts` documents survives.
 */
export function placementMax(date: ISODate, cadence: Cadence | null): ISODate | null {
  const period = periodEnd(date, cadence)
  if (period === null) return null // one-off: unbounded, and coherently so
  const saturday = placeableDates(date)[placeableDates(date).length - 1]!
  return period > saturday ? period : saturday
}

/** One `Placement` per cadence a task can actually hold a date in. */
export function placementRanges(date: ISODate): Placement[] {
  return PLACEABLE_CADENCES.map((cadence) => ({
    cadence,
    min: date,
    max: placementMax(date, cadence),
  }))
}

/**
 * Every completion that could satisfy a current period, grouped by task_id, in
 * one query.
 *
 * The window is the earliest period start across all cadences — NOT simply the
 * year's, because a Sunday-start week can begin in the previous year — plus every
 * completion a one-off has ever had, since its period is unbounded.
 *
 * The returned arrays are narrowed to one task each, which is the contract
 * `isDone` and `completionForPeriod` expect: they do not filter by task_id.
 */
export async function loadCurrentCompletions(
  db: DB,
  taskRows: TaskRow[],
  date: ISODate,
): Promise<Map<number, CompletionRow[]>> {
  const oneOffIds = taskRows.filter((t) => t.cadence === null).map((t) => t.id)
  const earliest = CADENCES.map((c) => periodStart(date, c))
    .filter((s): s is ISODate => s !== null)
    .reduce((a, b) => (a < b ? a : b))

  // Bounded to THIS caller's tasks. The window below is a date range, which on
  // its own would read every user's completions in it — harmless, since the map
  // is only ever read by the caller's own task ids, but wasteful and one
  // refactor away from not being harmless.
  const allIds = taskRows.map((t) => t.id)
  if (allIds.length === 0) return new Map()

  const rows = await db
    .select()
    .from(completions)
    .where(
      and(
        inArray(completions.task_id, allIds),
        or(gte(completions.completed_on, earliest), inArray(completions.task_id, oneOffIds)),
      ),
    )
    .all()

  const byTask = new Map<number, CompletionRow[]>()
  for (const c of rows) {
    const own = byTask.get(c.task_id)
    if (own) own.push(c)
    else byTask.set(c.task_id, [c])
  }
  return byTask
}
