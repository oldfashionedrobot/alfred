import { eq } from 'drizzle-orm'
import { TODO_GROUPS } from '../../shared/types.ts'
import type { ISODate, TodoGroup, TodoTask, TodoView } from '../../shared/types.ts'
import type { DB } from '../db.ts'
import { tasks } from '../schema.ts'
import type { CompletionRow } from '../schema.ts'
import { effectiveDate, isDone, isOverdue, periodEnd, periodStart } from '../period.ts'
import { byBaselineCategoryName } from '../sort.ts'
import { loadCurrentCompletions, placeableDates } from './completions.ts'
import { today } from '../today.ts'

/**
 * The To do panel — the complete inventory, hosted by Day and by Week and
 * identical in both. See "To do" in `.plan/views.md` and "GET /api/todo" in
 * `.plan/api.md`.
 *
 * SIX GROUPS, ALWAYS ALL SIX, ALWAYS IN CADENCE ORDER, even when empty. The
 * panel is a map of the periods as much as a list of tasks, and a month that
 * vanishes when nothing is monthly makes it a worse map. TODO_GROUPS is that
 * order; nothing here filters it.
 *
 * A group holds every active task of that cadence — placed or not, done or not.
 * Membership does not change as the week goes on; only the marks on the rows do.
 * A list that empties as you work it cannot answer "is the monthly deep clean
 * done?", which is the question this panel exists for.
 *
 * period_start / period_end are the current period's boundaries, shipped as
 * dates so the client can label a group without knowing where a quarter begins.
 * Both are null for the one-off group: its period is unbounded. There is no week
 * number in this model, deliberately — the client renders a range.
 */
export async function buildTodoView(db: DB): Promise<TodoView> {
  const date = today()

  const taskRows = await db
    .select().from(tasks).where(eq(tasks.active, true)).all()
  const byTask = await loadCurrentCompletions(db, taskRows, date)

  // The one-off group's cutoff. periodStart owns the week boundary — no builder
  // derives one inline.
  const weekStart = periodStart(date, 'week')!

  const groups: TodoGroup[] = TODO_GROUPS.map(({ cadence }) => {
    const rows = taskRows
      .filter((t) => t.cadence === cadence)
      .filter((t) => cadence !== null || keepOneOff(byTask.get(t.id) ?? [], weekStart))

    const groupTasks: TodoTask[] = rows.map((t) => {
      const own = byTask.get(t.id) ?? []
      return {
        id: t.id,
        name: t.name,
        cadence: t.cadence,
        is_baseline: t.is_baseline,
        color: t.is_baseline ? t.color : null,
        category: t.category,
        // The EFFECTIVE date, not the raw column. A weekly task placed last
        // Tuesday and viewed this Sunday has fallen out the back of its period:
        // the column still holds that date, but `data-model.md` is explicit that
        // such a task "has no day against it" — showing the stale one would
        // reintroduce the staleness effective_date exists to remove. Null here
        // also drops the row into band 3 (unplaced), which is where it belongs.
        effective_date: effectiveDate(t, date),
        is_done: isDone(t, own, date),
        is_overdue: isOverdue(t, own, date),
      }
    })

    return {
      cadence,
      period_start: periodStart(date, cadence),
      period_end: periodEnd(date, cadence),
      tasks: groupTasks.sort(byBand),
    }
  })

  const categories = [
    ...new Set(taskRows.map((t) => t.category).filter((c): c is string => c !== null && c !== '')),
  ].sort((a, b) => a.localeCompare(b))

  return {
    today: date,
    categories,
    groups,
    placeable_dates: placeableDates(date),
    has_overdue: groups.some((g) => g.tasks.some((t) => t.is_overdue)),
  }
}

/**
 * One-offs are the exception to "every active task of that cadence", because
 * they do not recur and would otherwise accumulate forever. The group holds
 * one-offs that are not done, plus those completed THIS WEEK, struck through.
 * A one-off completed earlier is finished and gone.
 *
 * A one-off's period is unbounded, so `isDone` is simply "has any completion at
 * all" — an empty array is a task still to do. `loadCurrentCompletions` reads
 * every completion a one-off ever had, so a stale one is visible here and the
 * `some` below correctly fails it.
 */
function keepOneOff(own: CompletionRow[], weekStart: ISODate): boolean {
  if (own.length === 0) return true
  return own.some((c) => c.completed_on >= weekStart)
}

/**
 * Order inside a group. Things wanting a decision rise; finished things sink.
 *
 *   band 1  ->  needs a day (overdue)
 *   band 2  ->  placed on a day
 *   band 3  ->  no day
 *   band 4  ->  done
 *
 * Band 4 wins over the others: a done task sinks whether or not it is placed.
 *
 * This is deliberately NOT `sortTasks()` and must not be folded into it. There
 * is no baseline band — baseline is a flag on daily tasks and every group is one
 * cadence — and no `days.task_order`, which belongs to Day's list, arranged for
 * doing. `.plan/review-findings.md` closes this: one function with flags would
 * be worse than two small ones.
 */
function band(t: TodoTask): number {
  if (t.is_done) return 4
  if (t.is_overdue) return 1
  return t.effective_date === null ? 3 : 2
}

function byBand(a: TodoTask, b: TodoTask): number {
  // Band first, then baseline, then name.
  //
  // Baseline sits INSIDE the band rather than above it, so a done baseline task
  // still sinks below live ones — a struck-through row at the top of the list is
  // not what "the bare minimum to function" should look like. In practice the
  // two orderings agree wherever it matters: baseline is a flag on daily tasks,
  // dailies are never placed and never overdue, so the whole Today group sits in
  // one band and baseline-within-band is baseline-at-the-top.
  if (band(a) !== band(b)) return band(a) - band(b)
  // Baseline, then category, then name — shared with History's columns so the
  // two screens cannot order the same tasks differently.
  return byBaselineCategoryName(a, b)
}
