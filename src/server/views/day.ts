import { and, asc, eq } from 'drizzle-orm'
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
import {
  loadCurrentCompletions,
  placeableDates,
  placementRanges,
  weekDates,
} from './completions.ts'
import { sortTasks } from '../sort.ts'
import { today, type Viewer } from '../today.ts'

/**
 * Everything the Day view renders.
 *
 * Since v8 this also carries the rest of the week: `upcoming` holds one entry per
 * pane after today's, which the client renders as the panes you swipe through.
 * The Week view and `GET /api/week` are gone.
 *
 * `week` is ANY DATE INSIDE THE WEEK WANTED, and defaults to today's. It is a
 * READ parameter and it moves the panes and nothing else: `date` is still today,
 * `tasks` is still today's list, and `placeable_dates` and `placement` are still
 * bounded from today. v8 already settled why a read parameter is not what the
 * same-day rule guards against — "the same-day-only rule protects WRITES, and it
 * does that in commands.ts" — and v16 changes nothing about that.
 *
 * Forward only, enforced in `routes.ts`. Paging back would be a second read-only
 * way to look at a day the Tracker already shows and now lets you correct.
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
 * the D1 defect this project already shipped once: `isOverdue` is false once a
 * task is done, so an else-if chain drops a completed non-daily task off the
 * screen entirely — no row left to tap to untick it, and no other surface able
 * to correct it. Membership only ever grows with doneness; `is_done` decides how
 * a member RENDERS, never whether it is one.
 *
 * State is labelled independently of membership, once the task is in.
 *
 * is_done is PERIOD-SATISFACTION rather than same-day, so a task placed today
 * but satisfied earlier this period arrives ticked — while membership is the
 * four rules above, so a task placed AND completed on an earlier day is not here
 * at all. A completed task stays for the day it was ticked; the backlog answers
 * for the rest of the period.
 *
 * One array since v15, sorted with sortTasks() using today's days.task_order,
 * which sinks the done rows to the bottom of it.
 */
export async function buildDayView(db: DB, viewer: Viewer, week?: ISODate): Promise<DayView> {
  const userId = viewer.id
  const date = today(viewer.timezone)
  // `routes.ts` is the whole query-string boundary — it rejects a malformed date
  // and a week that starts before this one — so anything arriving here is
  // already today's week or a later one. Nothing is re-validated.
  const viewedWeek = weekDates(week ?? date)

  const taskRows = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.user_id, userId), eq(tasks.active, true)))
    .all()

  const byTask = await loadCurrentCompletions(db, taskRows, date)

  const members: DayTask[] = []

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
    const state: DayTaskState = task.cadence === 'day' ? 'daily' : overdue ? 'overdue' : 'planned'

    members.push(toDayTask(task, state, effective, isDone(task, own, date)))
  }

  // days rows are sparse — no row means no mood, no log and no arrangement.
  const [dayRow] = await db
    .select()
    .from(days)
    .where(and(eq(days.user_id, userId), eq(days.date, date)))
  const order = parseTaskOrder(dayRow?.task_order ?? null)

  const picker: Mood[] = await db
    .select()
    .from(moods)
    .where(eq(moods.active, true))
    .orderBy(asc(moods.sort_order))
    .all()

  // Every pane of the viewed week: today through Saturday for this week, all
  // seven days for a later one, because none of those has happened. The same
  // `>= date` rule `placeableDates` applies — only the week going in differs,
  // which is the whole of what paging changed.
  const panes = viewedWeek.filter((d) => d >= date)

  return {
    date,
    mood: dayRow?.mood ?? null,
    log: dayRow?.log ?? null,
    moods: picker,
    tasks: sortTasks(members, order),
    // The strip's seven weekday buttons, which label whichever week is on screen.
    week_dates: viewedWeek,
    // TODAY through Saturday, whatever week is being viewed. The reschedule
    // picker opens from an overdue row on this screen, and a date it offered
    // because you had paged to it would be a placement outside the task's own
    // period — see `Placement` for what that costs.
    placeable_dates: placeableDates(date),
    // How far past this week each cadence may reach. The chips above are the
    // week; this is what the date field beyond them is bounded by.
    placement: placementRanges(date),
    panes,
    // Today is excluded HERE rather than inside buildUpcoming, because a later
    // week holds no today pane to exclude.
    upcoming: buildUpcoming(taskRows, byTask, panes.filter((d) => d !== date)),
    last_placed: lastPlaced(taskRows),
  }
}

/**
 * The furthest day anything active is placed on, or null when nothing is.
 *
 * It bounds how far the strip will page, so an empty schedule means no `next`
 * at all — paging exists to reach work you have scheduled, not to browse an
 * empty calendar. On a Saturday with nothing ahead that still leaves one pane
 * and two dead arrows, exactly as before v16.
 *
 * Read off the rows already in hand rather than by a `max(planned_date)` query:
 * `taskRows` is this user's active tasks and nothing else, which is precisely
 * the set the bound is over.
 */
function lastPlaced(taskRows: TaskRow[]): ISODate | null {
  let best: ISODate | null = null
  for (const task of taskRows) {
    const placed = task.planned_date
    if (placed !== null && (best === null || placed > best)) best = placed
  }
  return best
}

/**
 * The future panes — whichever dates the caller hands over, in order.
 *
 * It used to take the placeable dates and `slice(1)` today off the front, which
 * is only today when the viewed week is this one. A later week has no today pane
 * to drop, so the exclusion moved to the call site and this builds what it is
 * given. Empty on a Saturday of this week, which is what makes that day one pane
 * and no special case.
 *
 * PLACED TASKS ONLY, and only those still outstanding.
 *
 * Daily tasks are excluded without a filter: one can never hold a planned_date
 * (`create_task` writes null and `update_task` clears it on a cadence change), so
 * `planned_date === d` never matches one. `buildWeekView` carried an explicit
 * `cadence != 'day'` clause; it was belt and braces and is not carried across.
 *
 * A task already satisfied for its period is DROPPED rather than struck through.
 * The panes are read for load, and a done task adds none — so `is_done` is false
 * on every row here, carried like `state` and `effective_date` are rather than
 * splitting the type.
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
  dates: ISODate[],
): UpcomingDay[] {
  return dates.map((d) => ({
    date: d,
    tasks: sortTasks(
      taskRows
        .filter((t) => t.planned_date === d && !isDone(t, byTask.get(t.id) ?? [], d))
        // effective_date is d by construction: planned_date === d, and a period
        // containing d never starts after it, so effectiveDate() cannot roll it back.
        .map((t) => toDayTask(t, 'planned', d, false)),
      // No days.task_order for a future date — only today's row exists.
      null,
    ),
  }))
}

/** The wire shape of a task row. One mapping, so every pane agrees on it. */
function toDayTask(
  task: TaskRow,
  state: DayTaskState,
  effective: ISODate | null,
  done: boolean,
): DayTask {
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
    // Decides how the row renders and where sortTasks puts it. Never whether
    // the task is on the screen at all.
    is_done: done,
    // Never drawn on Day. The editor opens from here and needs it.
    category: task.category,
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
