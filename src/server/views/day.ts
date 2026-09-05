import { asc, eq } from 'drizzle-orm'
import type { DayTask, DayTaskState, DayView, Mood } from '../../shared/types.ts'
import type { DB } from '../db.ts'
import { days, moods, tasks } from '../schema.ts'
import { effectiveDate, isDone, isOverdue } from '../period.ts'
import { loadCurrentCompletions, placeableDates } from './completions.ts'
import { sortTasks } from '../sort.ts'
import { today } from '../today.ts'

/**
 * Everything the Day view renders. Always today — no parameters.
 * See "GET /api/day" in `.plan/api.md`.
 *
 * MEMBERSHIP IS A UNION OF FOUR INDEPENDENT RULES, never a chain of else-if.
 * An active task is a member if ANY of these holds:
 *
 *   cadence === 'day'
 *   effective_date === today
 *   isOverdue                    // effective_date in the past, not done
 *   a completion dated today     // whatever you ticked, whenever it was due
 *
 * The fourth rule is small and load-bearing, and writing the four as a chain is
 * D1 in `.plan/review-findings.md`: `isOverdue` is false once a task is done, so
 * an else-if chain drops a completed non-daily task out of `active` AND out of
 * `completed` — off the screen, with no row left to tap to untick it, and no
 * other surface able to correct it. Membership only ever grows with doneness;
 * `is_done` decides which array a member lands in, never whether it is one.
 *
 * State is labelled independently of membership, once the task is in.
 *
 * `completed` holds members where isDone is true. is_done is PERIOD-SATISFACTION
 * rather than same-day — a task placed today but satisfied earlier this period
 * lands there — but membership is the four rules above, so a task placed AND
 * completed on an earlier day is not here at all. It stays for the day it was
 * ticked; the Routine panel answers for the rest of the period.
 *
 * Both arrays sorted with sortTasks(), using today's days.task_order.
 */
export function buildDayView(db: DB): DayView {
  const date = today()

  const taskRows = db.select().from(tasks).where(eq(tasks.active, true)).all()

  const byTask = loadCurrentCompletions(db, taskRows, date)

  const active: DayTask[] = []
  const completed: DayTask[] = []

  for (const task of taskRows) {
    const own = byTask.get(task.id) ?? []
    const effective = effectiveDate(task, date)
    const overdue = isOverdue(task, own, date)

    const member =
      task.cadence === 'day' ||
      effective === date ||
      overdue ||
      own.some((c) => c.completed_on === date)
    // A date in the future is not a member: tomorrow's plan is not today's business.
    if (!member) continue

    // A daily task is never placed, so it can never be overdue — the two
    // states cannot collide. A member that is neither is planned, including one
    // that is here only because it was ticked today.
    const state: DayTaskState =
      task.cadence === 'day' ? 'daily' : overdue ? 'overdue' : 'planned'

    const view: DayTask = {
      id: task.id,
      name: task.name,
      is_baseline: task.is_baseline,
      // Baseline only. Keeping the rule here means the stored value survives a
      // task ceasing to be baseline, and the client never has to know that.
      color: task.is_baseline ? task.color : null,
      cadence: task.cadence,
      planned_date: task.planned_date,
      state,
      effective_date: effective,
    }
    if (isDone(task, own, date)) completed.push(view)
    else active.push(view)
  }

  // days rows are sparse — no row means no mood, no log and no arrangement.
  const dayRow = db.select().from(days).where(eq(days.date, date)).all()[0]
  const order = parseTaskOrder(dayRow?.task_order ?? null)

  const picker: Mood[] = db
    .select()
    .from(moods)
    .where(eq(moods.active, true))
    .orderBy(asc(moods.sort_order))
    .all()

  const sortedActive = sortTasks(active, order)

  return {
    date,
    mood: dayRow?.mood ?? null,
    log: dayRow?.log ?? null,
    moods: picker,
    active: sortedActive,
    completed: sortTasks(completed, order),
    has_overdue: sortedActive.some((t) => t.state === 'overdue'),
    // Carried here as well as on Week because the reschedule picker opens from
    // an overdue row on this screen. Day must never fetch the Week model for it.
    placeable_dates: placeableDates(date),
  }
}

/** days.task_order is stored opaquely; anything unreadable is simply no order. */
function parseTaskOrder(raw: string | null): number[] | null {
  if (raw === null) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return null
    return parsed.filter((v): v is number => typeof v === 'number')
  } catch {
    return null
  }
}
