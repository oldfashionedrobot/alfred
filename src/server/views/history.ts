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
import { sortTasks } from '../sort.ts'
import { today } from '../today.ts'

const DEFAULT_LIMIT = 60

/**
 * See "GET /api/history" in `.plan/api.md`.
 *
 * columns: active daily tasks in sort order.
 * rows: most recent first, EVERY date in the range including days with nothing
 *   recorded — a gap is a fact the grid exists to show, so the server emits the
 *   empty row rather than making the client fill holes.
 * mood: the resolved Mood object, not a slug, and resolves RETIRED moods too —
 *   History is the one place a mood no longer in the picker must still render.
 * next_before: null when exhausted.
 */
export function buildHistoryView(
  db: DB,
  opts: { limit?: number; before?: ISODate },
): HistoryView {
  // routes.ts is the whole query-string boundary: it rejects a limit that is not
  // a positive integer and applies the only ceiling. Nothing is re-validated here.
  const limit = opts.limit ?? DEFAULT_LIMIT
  // `before` is exclusive.
  const newest = opts.before === undefined ? today() : addDays(opts.before, -1)

  const daily = db
    .select()
    .from(tasks)
    .where(and(eq(tasks.active, true), eq(tasks.cadence, 'day')))
    .all()
  const columns: HistoryColumn[] = sortTasks(daily, null).map((t) => ({
    task_id: t.id,
    name: t.name,
  }))

  // Paging stops at the earliest recorded anything; there is no history before it.
  const earliest = earliestRecord(db)
  if (earliest === null || newest < earliest) {
    return { columns, rows: [], next_before: null }
  }

  const windowStart = addDays(newest, -(limit - 1))
  const oldest = windowStart > earliest ? windowStart : earliest

  const taskIds = columns.map((c) => c.task_id)
  const doneRows = db
    .select()
    .from(completions)
    .where(
      and(between(completions.completed_on, oldest, newest), inArray(completions.task_id, taskIds)),
    )
    .all()
  const dayRows = db.select().from(days).where(between(days.date, oldest, newest)).all()
  // All moods, retired included — a past day must still render its glyph.
  const moodRows: Mood[] = db.select().from(moods).orderBy(asc(moods.sort_order)).all()

  const completedByDate = new Map<ISODate, Set<number>>()
  for (const c of doneRows) {
    const set = completedByDate.get(c.completed_on)
    if (set) set.add(c.task_id)
    else completedByDate.set(c.completed_on, new Set([c.task_id]))
  }
  const moodByDate = new Map(dayRows.filter((d) => d.mood !== null).map((d) => [d.date, d.mood!]))
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
    })
  }

  return { columns, rows, next_before: oldest > earliest ? oldest : null }
}

/** The oldest date anything was recorded on, across completions and days. */
function earliestRecord(db: DB): ISODate | null {
  const [c] = db.select({ oldest: min(completions.completed_on) }).from(completions).all()
  const [d] = db.select({ oldest: min(days.date) }).from(days).all()
  const found = [c?.oldest ?? null, d?.oldest ?? null].filter((v): v is ISODate => v !== null)
  return found.length === 0 ? null : found.reduce((a, b) => (a < b ? a : b))
}
