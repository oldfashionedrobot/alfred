import { and, asc, between, eq, inArray, min } from 'drizzle-orm'
import type {
  HistoryColumn,
  HistoryRow,
  HistoryView,
  ISODate,
  Mood,
} from '../../shared/types.ts'
import type { DB } from '../db.ts'
import { completions, days, moods, tasks } from '../schema.ts'
import { addDays } from '../period.ts'
import { byBaselineCategoryName } from '../sort.ts'
import { today, type Viewer } from '../today.ts'

const DEFAULT_LIMIT = 60

/**
 *
 * columns: active daily tasks in sort order.
 * rows: most recent first, EVERY date in the range including days with nothing
 *   recorded — a gap is a fact the grid exists to show, so the server emits the
 *   empty row rather than making the client fill holes.
 * mood: the resolved Mood object, not a slug, and resolves RETIRED moods too —
 *   History is the one place a mood no longer in the picker must still render.
 * next_before: null when exhausted.
 */
export async function buildHistoryView(
  db: DB,
  viewer: Viewer,
  opts: { limit?: number; before?: ISODate },
): Promise<HistoryView> {
  const userId = viewer.id
  // routes.ts is the whole query-string boundary: it rejects a limit that is not
  // a positive integer and applies the only ceiling. Nothing is re-validated here.
  const limit = opts.limit ?? DEFAULT_LIMIT
  // `before` is exclusive.
  const newest = opts.before === undefined ? today(viewer.timezone) : addDays(opts.before, -1)

  const daily = await db.select()
    .from(tasks)
    .where(and(eq(tasks.user_id, userId), eq(tasks.active, true), eq(tasks.cadence, 'day')))
    .all()
  // The same order the To do panel uses, so a task is in the same place in both.
  const columns: HistoryColumn[] = [...daily].sort(byBaselineCategoryName).map((t) => ({
    task_id: t.id,
    name: t.name,
    // Baseline only, the same rule the other views apply — so the grid's filled
    // cells match the colour that task wears everywhere else.
    color: t.is_baseline ? t.color : null,
  }))

  // Paging stops at the earliest recorded anything; there is no history before it.
  const earliest = await earliestRecord(db, userId)
  if (earliest === null || newest < earliest) {
    return { columns, rows: [], next_before: null }
  }

  const windowStart = addDays(newest, -(limit - 1))
  const oldest = windowStart > earliest ? windowStart : earliest

  const taskIds = columns.map((c) => c.task_id)
  const doneRows = await db.select()
    .from(completions)
    .where(
      and(between(completions.completed_on, oldest, newest), inArray(completions.task_id, taskIds)),
    )
    .all()
  const dayRows = await db
    .select()
    .from(days)
    .where(and(eq(days.user_id, userId), between(days.date, oldest, newest)))
    .all()
  // All moods, retired included — a past day must still render its glyph.
  const moodRows: Mood[] = await db.select().from(moods).orderBy(asc(moods.sort_order)).all()

  const completedByDate = new Map<ISODate, Set<number>>()
  for (const c of doneRows) {
    const set = completedByDate.get(c.completed_on)
    if (set) set.add(c.task_id)
    else completedByDate.set(c.completed_on, new Set([c.task_id]))
  }
  const moodByDate = new Map(dayRows.filter((d) => d.mood !== null).map((d) => [d.date, d.mood!]))
  // A log is text, not a flag: the grid shows whether one exists and opens it on
  // demand, so the row carries the entry itself rather than a boolean the client
  // would then have to fetch behind.
  const logByDate = new Map(
    dayRows.filter((d) => d.log !== null && d.log !== '').map((d) => [d.date, d.log!]),
  )
  const moodBySlug = new Map(moodRows.map((m) => [m.slug, m]))

  const rows: HistoryRow[] = []
  for (let d = newest; d >= oldest; d = addDays(d, -1)) {
    const slug = moodByDate.get(d)
    const ticked = completedByDate.get(d)
    rows.push({
      date: d,
      mood: slug === undefined ? null : (moodBySlug.get(slug) ?? null),
      // Column order, so the grid reads left to right.
      completed: ticked === undefined ? [] : taskIds.filter((id) => ticked.has(id)),
      log: logByDate.get(d) ?? null,
    })
  }

  return { columns, rows, next_before: oldest > earliest ? oldest : null }
}

/**
 * The oldest date anything was recorded on, across completions and days —
 * FOR THIS USER.
 *
 * Scoped even though it returns a date rather than content: unscoped, somebody
 * else's older record would page this user back through months of empty rows,
 * which both looks broken and says that older data exists.
 */
async function earliestRecord(db: DB, userId: number): Promise<ISODate | null> {
  const [c] = await db
    .select({ oldest: min(completions.completed_on) })
    .from(completions)
    .innerJoin(tasks, eq(tasks.id, completions.task_id))
    .where(eq(tasks.user_id, userId))
    .all()
  const [d] = await db
    .select({ oldest: min(days.date) })
    .from(days)
    .where(eq(days.user_id, userId))
    .all()
  const found = [c?.oldest ?? null, d?.oldest ?? null].filter((v): v is ISODate => v !== null)
  return found.length === 0 ? null : found.reduce((a, b) => (a < b ? a : b))
}
