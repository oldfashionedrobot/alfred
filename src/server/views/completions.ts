import { gte, inArray, or } from 'drizzle-orm'
import { CADENCES } from '../../shared/types.ts'
import type { ISODate } from '../../shared/types.ts'
import type { DB } from '../db.ts'
import { completions } from '../schema.ts'
import type { CompletionRow, TaskRow } from '../schema.ts'
import { addDays, periodStart } from '../period.ts'

/**
 * The two things a view builder needs and must not derive twice: the dates it may
 * offer, and the current period's completions grouped by task.
 *
 * Day and Todo both ship `placeable_dates` and both read completions per task.
 * `.plan/review-findings.md` records both as duplication that produced real
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
 * Today through Saturday — exactly what the day picker may offer, and nothing
 * else. On a Saturday that is one date; on a Sunday, seven.
 */
export function placeableDates(date: ISODate): ISODate[] {
  return weekDates(date).filter((d) => d >= date)
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

  const rows = await db
    .select()
    .from(completions)
    .where(or(gte(completions.completed_on, earliest), inArray(completions.task_id, oneOffIds)))
    .all()

  const byTask = new Map<number, CompletionRow[]>()
  for (const c of rows) {
    const own = byTask.get(c.task_id)
    if (own) own.push(c)
    else byTask.set(c.task_id, [c])
  }
  return byTask
}
