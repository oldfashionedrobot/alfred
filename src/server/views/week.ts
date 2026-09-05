import { and, eq, isNull, ne, or } from 'drizzle-orm'
import type { WeekDay, WeekTask, WeekView } from '../../shared/types.ts'
import type { DB } from '../db.ts'
import { tasks } from '../schema.ts'
import type { TaskRow } from '../schema.ts'
import { isDone } from '../period.ts'
import { loadCurrentCompletions, placeableDates, weekDates } from './completions.ts'
import { sortTasks } from '../sort.ts'
import { today } from '../today.ts'

/**
 * The current week only, Sunday through Saturday. See "GET /api/week" in `.plan/api.md`.
 *
 * Seven day sections and nothing else. `overdue`, `unplaced` and `backlog` were
 * fields here and are gone: each was a filter over a list `GET /api/todo` now
 * returns in full, and shipping both would put the same task twice on one screen.
 * Week is the seven days; the panel is everything else.
 *
 * Daily tasks NEVER appear anywhere in this model — never placed, never overdue.
 *
 * placeable_dates is today through Saturday. It is the server telling the client
 * what the picker may offer, so the picker and the 409 on `place` cannot disagree.
 *
 * can_complete is false on past days: nothing writes to a past date.
 */
export function buildWeekView(db: DB): WeekView {
  const date = today()

  const dates = weekDates(date)
  const week_start = dates[0]!

  // `cadence != 'day'` is NULL for a one-off, so the null arm is not optional.
  const taskRows = db
    .select()
    .from(tasks)
    .where(and(eq(tasks.active, true), or(isNull(tasks.cadence), ne(tasks.cadence, 'day'))))
    .all()

  const byTask = loadCurrentCompletions(db, taskRows, date)

  const view = (task: TaskRow, can_complete: boolean): WeekTask => ({
    id: task.id,
    name: task.name,
    is_baseline: task.is_baseline,
    cadence: task.cadence,
    planned_date: task.planned_date,
    is_done: isDone(task, byTask.get(task.id) ?? [], date),
    can_complete,
  })

  const days: WeekDay[] = dates.map((d) => {
    const is_past = d < date
    return {
      date: d,
      is_today: d === date,
      is_past,
      // An overdue task still renders on the day it was originally placed.
      tasks: sortTasks(
        taskRows.filter((t) => t.planned_date === d).map((t) => view(t, !is_past)),
        null,
      ),
    }
  })

  return {
    week_start,
    week_end: dates[6]!,
    today: date,
    placeable_dates: placeableDates(date),
    days,
  }
}
