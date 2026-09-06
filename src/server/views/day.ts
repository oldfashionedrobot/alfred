import { asc, eq } from 'drizzle-orm'
import type {
  DayTask,
  DayTaskState,
  DayView,
  ISODate,
  Mood,
  UpcomingDay,
} from '../../shared/types.ts'
import type { DB } from '../db.ts'
import { days, moods, tasks } from '../schema.ts'
import type { CompletionRow, TaskRow } from '../schema.ts'
import { effectiveDate, isDone, isOverdue } from '../period.ts'
import { loadCurrentCompletions, placeableDates, weekDates } from './completions.ts'
import { sortTasks } from '../sort.ts'
import { today } from '../today.ts'

/**
 * Everything the Day view renders. Always today — no parameters.
 * See "GET /api/day" in `.plan/api.md`.
 *
 * Since v8 this also carries the rest of the week: `upcoming` holds one entry per
 * day from tomorrow through Saturday, which the client renders as the panes you
 * swipe through. The Week view and `GET /api/week` are gone — see
 * `.plan/changes-v8.md`. There is still NO date parameter and this endpoint still
 * means today; what changed is how much of the week rides along with it.
 *
 * MEMBERSHIP OF TODAY IS A UNION OF FOUR INDEPENDENT RULES, never a chain of
 * else-if. An active task is a member if ANY of these holds:
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
export async function buildDayView(db: DB): Promise<DayView> {
  const date = today()

  const taskRows = await db
    .select().from(tasks).where(eq(tasks.active, true)).all()

  const byTask = await loadCurrentCompletions(db, taskRows, date)

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
    // A date in the future is not a member of TODAY. It belongs to `upcoming`.
    if (!member) continue

    // A daily task is never placed, so it can never be overdue — the two
    // states cannot collide. A member that is neither is planned, including one
    // that is here only because it was ticked today.
    const state: DayTaskState =
      task.cadence === 'day' ? 'daily' : overdue ? 'overdue' : 'planned'

    const view = toDayTask(task, state, effective)
    if (isDone(task, own, date)) completed.push(view)
    else active.push(view)
  }

  // days rows are sparse — no row means no mood, no log and no arrangement.
  const [dayRow] = await db.select().from(days).where(eq(days.date, date))
  const order = parseTaskOrder(dayRow?.task_order ?? null)

  const picker: Mood[] = await db
    .select()
    .from(moods)
    .where(eq(moods.active, true))
    .orderBy(asc(moods.sort_order))
    .all()

  const sortedActive = sortTasks(active, order)

  // today through Saturday. Derived once and used twice: it is what the day
  // picker may offer AND which panes exist, so the two cannot disagree.
  const placeable = placeableDates(date)

  return {
    date,
    mood: dayRow?.mood ?? null,
    log: dayRow?.log ?? null,
    moods: picker,
    active: sortedActive,
    completed: sortTasks(completed, order),
    // Carried here as well because the reschedule picker opens from an overdue
    // row on this screen.
    week_dates: weekDates(date),
    placeable_dates: placeable,
    upcoming: buildUpcoming(taskRows, byTask, placeable),
  }
}

/**
 * The future panes — tomorrow through Saturday, so `placeable` minus today.
 * Empty on a Saturday, which is what makes that day one pane and no special case.
 *
 * PLACED TASKS ONLY, and only those still outstanding.
 *
 * Daily tasks are excluded without a filter: one can never hold a planned_date
 * (`create_task` writes null and `update_task` clears it on a cadence change), so
 * `planned_date === d` never matches one. `buildWeekView` carried an explicit
 * `cadence != 'day'` clause; it was belt and braces and is not carried across.
 *
 * A task already satisfied for its period is DROPPED rather than struck through.
 * The panes are read for load, and a done task adds none. See "Future panes show
 * placed tasks only" in `.plan/changes-v8.md` for why this does not become a flag
 * on DayTask.
 *
 * `isDone` is asked about THE PANE'S OWN DATE, not about today. Those differ at a
 * period boundary: a monthly task placed Thu 1 Oct and completed 15 Sep is done
 * for September, and asking with today = Tue 29 Sep would hide it from a pane
 * whose obligation is October's and unmet. This is the same trap `effectiveDate`
 * documents from the other direction.
 */
function buildUpcoming(
  taskRows: TaskRow[],
  byTask: Map<number, CompletionRow[]>,
  placeable: ISODate[],
): UpcomingDay[] {
  return placeable.slice(1).map((d) => ({
    date: d,
    tasks: sortTasks(
      taskRows
        .filter((t) => t.planned_date === d && !isDone(t, byTask.get(t.id) ?? [], d))
        // effective_date is d by construction: planned_date === d, and a period
        // containing d never starts after it, so effectiveDate() cannot roll it back.
        .map((t) => toDayTask(t, 'planned', d)),
      // No days.task_order for a future date — only today's row exists.
      null,
    ),
  }))
}

/** The wire shape of a task row. One mapping, so every pane agrees on it. */
function toDayTask(task: TaskRow, state: DayTaskState, effective: ISODate | null): DayTask {
  return {
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
