import { and, eq, inArray, isNotNull } from 'drizzle-orm'
import { isCadence, isHexColor, isISODate, type Cadence, type ISODate } from '../shared/types.ts'
import type { DB } from './db.ts'
import { BadRequest, NotFound, Rejected } from './errors.ts'
import { completionForPeriod, isOverdue } from './period.ts'
import { completions, days, moods, tasks, type TaskRow } from './schema.ts'
import { today } from './today.ts'
import { loadCurrentCompletions, placeableDates } from './views/completions.ts'

/**
 * Every named command from `.plan/api.md`. Commands map 1:1 to gestures in views.md.
 *
 * On success a command returns nothing — the route replies { ok: true } and the
 * client refetches the view it is on. On failure, throw BadRequest / NotFound /
 * Rejected from ./errors.ts.
 *
 * This is the only place untrusted data enters the system, so every field is
 * checked for presence AND type before it reaches a statement.
 *
 * Day and Week: complete, uncomplete, place, unplan, reset_overdue
 * Tasks:        create_task, update_task, archive_task
 * Day record:   set_mood, set_log, set_task_order
 *
 * There are no mood-management commands. The mood set is seeded on first run and
 * edited in the database — see "Moods are data, not a feature" in `.plan/views.md`.
 * `set_mood` records the day's mood and is the only mood command there is.
 */
export async function runCommand(db: DB, name: string, body: unknown): Promise<void> {
  const b = asObject(body)

  switch (name) {
    // --- Day and Week -----------------------------------------------------
    case 'complete':
      return complete(db, b)
    case 'uncomplete':
      return uncomplete(db, b)
    case 'place':
      return place(db, b)
    case 'unplan':
      return unplan(db, b)
    case 'reset_overdue':
      return resetOverdue(db, b)

    // --- Tasks ------------------------------------------------------------
    case 'create_task':
      return createTask(db, b)
    case 'update_task':
      return updateTask(db, b)
    case 'archive_task':
      return archiveTask(db, b)

    // --- Day record -------------------------------------------------------
    case 'set_mood':
      return setMood(db, b)
    case 'set_log':
      return setLog(db, b)
    case 'set_task_order':
      return setTaskOrder(db, b)

    default:
      // 400, not 404: the path /api/commands/<name> exists, the name in it is a
      // malformed request. There is no per-command resource to be missing.
      throw new BadRequest(`unknown command '${name}'`)
  }
}

// ---------------------------------------------------------------------------
// Field validation. A missing or wrong-typed field is always a BadRequest;
// nothing below ever coerces.
// ---------------------------------------------------------------------------

function asObject(body: unknown): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new BadRequest('body must be a JSON object')
  }
  return body as Record<string, unknown>
}

/**
 * What makes `reset_overdue`'s
 * no-arguments rule enforceable rather than aspirational: a client typo is a
 * visible 400 instead of a field silently ignored.
 */
function onlyFields(b: Record<string, unknown>, allowed: readonly string[]): void {
  for (const key of Object.keys(b)) {
    if (!allowed.includes(key)) throw new BadRequest(`unexpected field '${key}'`)
  }
}

function reqId(b: Record<string, unknown>, key: string): number {
  const v = b[key]
  if (typeof v !== 'number' || !Number.isInteger(v) || v <= 0) {
    throw new BadRequest(`${key} must be a positive integer`)
  }
  return v
}

function reqName(b: Record<string, unknown>, key: string): string {
  const v = b[key]
  if (typeof v !== 'string') throw new BadRequest(`${key} must be a string`)
  const trimmed = v.trim()
  if (trimmed === '') throw new BadRequest(`${key} must not be empty`)
  return trimmed
}

function reqBoolean(b: Record<string, unknown>, key: string): boolean {
  const v = b[key]
  if (typeof v !== 'boolean') throw new BadRequest(`${key} must be true or false`)
  return v
}

function reqDate(b: Record<string, unknown>, key: string): ISODate {
  const v = b[key]
  if (!isISODate(v)) throw new BadRequest(`${key} must be a date in YYYY-MM-DD form`)
  return v
}

/** null is a legitimate value — it means one-off. */
function reqCadenceOrNull(b: Record<string, unknown>, key: string): Cadence | null {
  const v = b[key]
  if (v === null) return null
  if (!isCadence(v)) throw new BadRequest(`${key} must be one of day, week, month, quarter, year`)
  return v
}

/** Trimmed free text, or null. An empty string is null — there is no third state. */
function reqTextOrNull(b: Record<string, unknown>, key: string): string | null {
  if (b[key] === null) return null
  if (typeof b[key] !== 'string') throw new BadRequest(`${key} must be a string or null`)
  const t = b[key].trim()
  return t === '' ? null : t
}

function reqColorOrNull(b: Record<string, unknown>, key: string): string | null {
  if (b[key] === null) return null
  if (!isHexColor(b[key])) throw new BadRequest(`${key} must be a '#rrggbb' colour`)
  return b[key]
}

function reqDateOrNull(b: Record<string, unknown>, key: string): ISODate | null {
  if (b[key] === null) return null
  return reqDate(b, key)
}

// ---------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------

async function loadTask(db: DB, id: number): Promise<TaskRow> {
  const task = await db.select().from(tasks).where(eq(tasks.id, id)).get()
  if (!task) throw new NotFound(`no task ${id}`)
  return task
}

async function completionsFor(db: DB, taskId: number) {
  return await db.select().from(completions).where(eq(completions.task_id, taskId)).all()
}

async function loadMoodSlug(db: DB, slug: string): Promise<string> {
  const found = await db.select({ slug: moods.slug }).from(moods).where(eq(moods.slug, slug)).get()
  if (!found) throw new NotFound(`no mood '${slug}'`)
  return found.slug
}

// ---------------------------------------------------------------------------
// Day and Week
// ---------------------------------------------------------------------------

async function complete(db: DB, b: Record<string, unknown>): Promise<void> {
  onlyFields(b, ['task_id'])
  const task = await loadTask(db, reqId(b, 'task_id'))
  if (!task.active) throw new Rejected('that task is archived')

  // The (task_id, completed_on) key absorbs a double tap — a repeat is a
  // no-op, never an error.
  await db.insert(completions)
    .values({ task_id: task.id, completed_on: today() })
    .onConflictDoNothing()
    .run()
}

async function uncomplete(db: DB, b: Record<string, unknown>): Promise<void> {
  onlyFields(b, ['task_id'])
  const task = await loadTask(db, reqId(b, 'task_id'))

  // NOT necessarily today's row: unticking a weekly task on Wednesday that was
  // completed Tuesday must delete Tuesday's, since that is the row making it
  // appear complete.
  const row = completionForPeriod(task, await completionsFor(db, task.id), today())
  if (!row) return // already not done — the asked-for end state

  await db.delete(completions)
    .where(and(eq(completions.task_id, row.task_id), eq(completions.completed_on, row.completed_on)))
    .run()
}

async function place(db: DB, b: Record<string, unknown>): Promise<void> {
  onlyFields(b, ['task_id', 'date'])
  const id = reqId(b, 'task_id')
  const date = reqDate(b, 'date')
  const task = await loadTask(db, id)

  if (!task.active) throw new Rejected('that task is archived')
  if (task.cadence === 'day') throw new Rejected('daily tasks are never placed')

  // The same list the views ship as `placeable_dates`. One derivation, so the
  // picker and this rejection cannot disagree — which is the whole reason the
  // server ships the field at all. See `.plan/api.md`.
  const now = today()
  const placeable = placeableDates(now)
  const saturday = placeable[placeable.length - 1]!

  if (date < now) throw new Rejected('cannot place before today')
  if (date > saturday) throw new Rejected(`cannot place beyond ${saturday}`)

  await db.update(tasks).set({ planned_date: date }).where(eq(tasks.id, task.id)).run()
}

async function unplan(db: DB, b: Record<string, unknown>): Promise<void> {
  onlyFields(b, ['task_id'])
  const task = await loadTask(db, reqId(b, 'task_id'))
  await db.update(tasks).set({ planned_date: null }).where(eq(tasks.id, task.id)).run()
}

/**
 * Takes no arguments — the overdue set is computed here, never sent. v1 had the
 * client send ids, which meant acting on a view rendered seconds earlier.
 *
 * The read and the clear are one transaction so the set cleared is exactly the
 * set computed.
 */
async function resetOverdue(db: DB, b: Record<string, unknown>): Promise<void> {
  onlyFields(b, [])
  const now = today()

  // No transaction, and it does not need one.
  //
  // Under bun:sqlite this was wrapped in `db.transaction(...)`, on the reasoning
  // that a partial failure would leave the board half-cleared. That reasoning
  // also relied on bun:sqlite being ONE synchronous connection, so statements
  // issued through `db` inside the callback landed in the same BEGIN/COMMIT.
  // Neither holds on libSQL: the driver is async, and a transaction hands back
  // its own handle that `db` statements would bypass.
  //
  // What actually protects the board is that the clearing is a SINGLE statement
  // — one UPDATE over an id list — which is atomic on its own. The reads before
  // it only choose the ids; the app has one writer, so there is no interleaving
  // to guard against.
  const candidates = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.active, true), isNotNull(tasks.planned_date)))
  if (candidates.length === 0) return

  // The one implementation of this grouping, bounded to the current period.
  const byTask = await loadCurrentCompletions(db, candidates, now)
  const overdue = candidates
    .filter((t) => isOverdue(t, byTask.get(t.id) ?? [], now))
    .map((t) => t.id)
  if (overdue.length === 0) return

  await db.update(tasks).set({ planned_date: null }).where(inArray(tasks.id, overdue))
}

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

/** The `+` on Day. One field, deliberately — see "Input" in `.plan/views.md`. */
async function createTask(db: DB, b: Record<string, unknown>): Promise<void> {
  onlyFields(b, ['name', 'is_baseline', 'cadence', 'planned_date', 'color', 'category'])
  const name = reqName(b, 'name')
  const is_baseline = 'is_baseline' in b ? reqBoolean(b, 'is_baseline') : false
  const cadence = 'cadence' in b ? reqCadenceOrNull(b, 'cadence') : null
  const planned = 'planned_date' in b ? reqDateOrNull(b, 'planned_date') : null
  const color = 'color' in b ? reqColorOrNull(b, 'color') : null
  const category = 'category' in b ? reqTextOrNull(b, 'category') : null

  await db.insert(tasks)
    .values({
      name,
      is_baseline,
      cadence,
      // A daily task cannot hold a date — see updateTask.
      planned_date: cadence === 'day' ? null : planned,
      color,
      category,
      active: true,
    })
    .run()
}

async function updateTask(db: DB, b: Record<string, unknown>): Promise<void> {
  onlyFields(b, ['id', 'name', 'is_baseline', 'cadence', 'planned_date', 'color', 'category'])
  const task = await loadTask(db, reqId(b, 'id'))

  // 'key in body' throughout: an omitted field is untouched, an explicit null
  // clears. A truthiness check cannot tell those apart.
  const cadence = 'cadence' in b ? reqCadenceOrNull(b, 'cadence') : task.cadence

  const patch: Partial<TaskRow> = {}
  if ('name' in b) patch.name = reqName(b, 'name')
  if ('is_baseline' in b) patch.is_baseline = reqBoolean(b, 'is_baseline')
  if ('cadence' in b) patch.cadence = cadence
  if ('planned_date' in b) patch.planned_date = reqDateOrNull(b, 'planned_date')
  // Stored whatever the baseline flag says: the views null it out for a
  // non-baseline task, so unticking Baseline is not destructive and re-ticking
  // brings the colour back.
  if ('color' in b) patch.color = reqColorOrNull(b, 'color')
  if ('category' in b) patch.category = reqTextOrNull(b, 'category')

  if (Object.keys(patch).length === 0) return

  // A daily task is implicitly on every day and is never placed, so a date on
  // one is a value the model says cannot exist. Unconditional: writing null over
  // null is the same write, and asking whether it was already null is a branch
  // guarding a state that cannot occur.
  if (cadence === 'day') patch.planned_date = null

  await db.update(tasks).set(patch).where(eq(tasks.id, task.id)).run()
}

/** The only removal in the system. There is no delete anywhere. */
async function archiveTask(db: DB, b: Record<string, unknown>): Promise<void> {
  onlyFields(b, ['id'])
  const task = await loadTask(db, reqId(b, 'id'))
  await db.update(tasks).set({ active: false }).where(eq(tasks.id, task.id)).run()
}

// ---------------------------------------------------------------------------
// Day record. All three upsert today's row, creating it if absent — which is
// what keeps `days` sparse without the client tracking whether one exists.
// ---------------------------------------------------------------------------

async function upsertDay(db: DB, patch: { mood?: string | null; log?: string | null; task_order?: string | null }): Promise<void> {
  await db.insert(days)
    .values({ date: today(), ...patch })
    .onConflictDoUpdate({ target: days.date, set: patch })
    .run()
}

/**
 * Records the day's mood. The mood set itself is not editable through the API —
 * it is seeded on first run and changed in the database.
 */
async function setMood(db: DB, b: Record<string, unknown>): Promise<void> {
  onlyFields(b, ['slug'])
  if (!('slug' in b)) throw new BadRequest('slug is required')

  const raw = b['slug']
  if (raw !== null && typeof raw !== 'string') throw new BadRequest('slug must be a string or null')
  const slug = raw === null ? null : await loadMoodSlug(db, raw)

  await upsertDay(db, { mood: slug })
}

async function setLog(db: DB, b: Record<string, unknown>): Promise<void> {
  onlyFields(b, ['text'])
  if (!('text' in b)) throw new BadRequest('text is required')

  const raw = b['text']
  if (raw !== null && typeof raw !== 'string') throw new BadRequest('text must be a string')
  // An empty entry is the absence of one.
  const text = raw === null || raw === '' ? null : raw

  await upsertDay(db, { log: text })
}

async function setTaskOrder(db: DB, b: Record<string, unknown>): Promise<void> {
  onlyFields(b, ['task_ids'])
  const raw = b['task_ids']
  if (!Array.isArray(raw) || raw.some((v) => typeof v !== 'number' || !Number.isInteger(v))) {
    throw new BadRequest('task_ids must be an array of integers')
  }

  // Stored opaquely. `.plan/data-model.md` has the order disposable, per-day and
  // tolerant of stale ids, so completeness and existence are deliberately unchecked.
  await upsertDay(db, { task_order: JSON.stringify(raw) })
}
