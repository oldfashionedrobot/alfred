import { test, expect, describe, beforeEach, afterEach } from 'bun:test'
import { closeDb, freshDb, type Harness } from './harness.ts'
import { eq } from 'drizzle-orm'

import type { Cadence, ISODate } from '../src/shared/types.ts'
import type { DB } from '../src/server/db.ts'
import * as schema from '../src/server/schema.ts'
import { today } from '../src/server/today.ts'
import { runCommand } from '../src/server/commands.ts'
import { buildDayView } from '../src/server/views/day.ts'
import { buildTodoView } from '../src/server/views/todo.ts'
import { buildHistoryView } from '../src/server/views/history.ts'

/**
 * ONE USER MUST NEVER SEE ANOTHER'S DATA.
 *
 * This file exists because that property is otherwise unverifiable. With a
 * single user every query returns the same rows whether it filters on user_id or
 * not, so the rest of the suite cannot tell correct code from a missing `where`
 * — and the failure mode of a missing `where` is silent until the day somebody
 * else has an account.
 *
 * So: two users, both holding data, and an assertion per surface. A new view
 * builder or a new command that takes a task_id belongs here on the day it is
 * written, not on the day it leaks.
 *
 * A is the `owner` the migration creates — id 1, who the app resolves to when
 * AUTH_REQUIRED is unset, and therefore who every other test is about. B is made
 * per test.
 */

const A = 1
let B: number
const viewer = (id: number) => ({ id, timezone: ZONE })


/*
 * The suite's timezone, explicit and fixed.
 *
 * `today()` takes a zone now, so nothing here depends on the process's `TZ` —
 * which is what closes the gap `changes.md` recorded: `bun test` ran UTC while
 * the browser suite ran local, the two disagreed about what day it was, and the
 * skip count moved with the clock. UTC because it has no DST, so no test lands
 * on a day that is 23 or 25 hours long.
 */
const ZONE = 'UTC'

const TODAY: ISODate = today(ZONE)
const shift = (date: ISODate, n: number): ISODate => {
  const d = new Date(`${date}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}
const YESTERDAY = shift(TODAY, -1)

let h: Harness
let db: DB

beforeEach(async () => {
  h = await freshDb('isolation')
  db = h.db
  const [other] = await db
    .insert(schema.users)
    .values({ username: 'other', password_hash: '', active: true })
    .returning({ id: schema.users.id })
  B = other!.id
})

afterEach(() => closeDb(h))

async function addTask(
  user_id: number,
  name: string,
  over: { cadence?: Cadence | null; planned_date?: ISODate | null; done_on?: ISODate[] } = {},
): Promise<number> {
  const [row] = await db
    .insert(schema.tasks)
    .values({
      user_id,
      name,
      cadence: over.cadence ?? null,
      planned_date: over.planned_date ?? null,
    })
    .returning({ id: schema.tasks.id })
  const id = row!.id
  if (over.done_on?.length) {
    await db
      .insert(schema.completions)
      .values(over.done_on.map((completed_on) => ({ task_id: id, completed_on })))
      .run()
  }
  return id
}

/** Both users, holding the same kinds of thing on the same dates. */
async function seedBoth(): Promise<{ aTask: number; bTask: number }> {
  const aTask = await addTask(A, "A's daily", { cadence: 'day' })
  const bTask = await addTask(B, "B's daily", { cadence: 'day' })
  await addTask(A, "A's placed", { cadence: 'week', planned_date: TODAY })
  await addTask(B, "B's placed", { cadence: 'week', planned_date: TODAY })
  await addTask(A, "A's backlog", { cadence: null })
  await addTask(B, "B's backlog", { cadence: null })
  return { aTask, bTask }
}

const mine = (names: string[]) => names.every((n) => n.startsWith("A's"))

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

describe('a view builder answers for one user and no other', () => {
  test('buildDayView', async () => {
    await seedBoth()
    const view = await buildDayView(db, viewer(A))
    const names = [...view.active, ...view.completed].map((t) => t.name)
    expect(names.length).toBeGreaterThan(0)
    expect(mine(names)).toBe(true)
    expect(view.upcoming.flatMap((u) => u.tasks).map((t) => t.name).every((n) => n.startsWith("A's"))).toBe(true)
  })

  test('buildTodoView — the complete inventory, and only one person’s', async () => {
    await seedBoth()
    const view = await buildTodoView(db, viewer(A))
    const names = view.groups.flatMap((g) => g.tasks).map((t) => t.name)
    // The panel is the whole inventory, so if anything leaks it leaks here.
    expect(names).toHaveLength(3)
    expect(mine(names)).toBe(true)
  })

  test('buildHistoryView — columns and filled cells', async () => {
    const { aTask, bTask } = await seedBoth()
    await db.insert(schema.completions).values([
      { task_id: aTask, completed_on: TODAY },
      { task_id: bTask, completed_on: TODAY },
    ])

    const view = await buildHistoryView(db, viewer(A), {})
    expect(view.columns.map((c) => c.name)).toEqual(["A's daily"])
    const filled = view.rows.flatMap((r) => r.completed)
    expect(filled).toEqual([aTask])
  })

  test("history does not page back through another user's older record", async () => {
    // B recorded something long ago and A did not. Unscoped, `earliestRecord`
    // would walk A back through months of empty rows — which both looks broken
    // and says that older data exists.
    const bOld = await addTask(B, "B's old daily", { cadence: 'day' })
    await db.insert(schema.completions).values({ task_id: bOld, completed_on: shift(TODAY, -300) })
    // BOTH halves of `earliestRecord`: it takes a min over completions and a min
    // over days, and either one unscoped drags A's paging back on its own. A
    // mutation test caught the days half being untested here.
    await db.insert(schema.days).values({ user_id: B, date: shift(TODAY, -280), log: 'B was here' })

    expect((await buildHistoryView(db, viewer(A), {})).rows).toEqual([])

    const aTask = await addTask(A, "A's daily", { cadence: 'day' })
    await db.insert(schema.completions).values({ task_id: aTask, completed_on: TODAY })
    const view = await buildHistoryView(db, viewer(A), {})
    expect(view.rows).toHaveLength(1)
    expect(view.next_before).toBeNull()
  })

  test('the day record — mood, log and arrangement are per user', async () => {
    await db.insert(schema.days).values([
      { user_id: A, date: TODAY, mood: 'happy', log: "A's private note" },
      { user_id: B, date: TODAY, mood: 'balanced', log: "B's private note" },
    ])

    const a = await buildDayView(db, viewer(A))
    expect(a.mood).toBe('happy')
    expect(a.log).toBe("A's private note")

    const b = await buildDayView(db, viewer(B))
    expect(b.mood).toBe('balanced')
    expect(b.log).toBe("B's private note")
  })
})

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

describe("a command cannot touch another user's task", () => {
  /** Every command that takes a task by id. Adding one means adding it here. */
  const byId: ReadonlyArray<[string, (id: number) => Record<string, unknown>]> = [
    ['complete', (id) => ({ task_id: id })],
    ['uncomplete', (id) => ({ task_id: id })],
    ['place', (id) => ({ task_id: id, date: TODAY })],
    ['unplan', (id) => ({ task_id: id })],
    ['update_task', (id) => ({ id, name: 'renamed by a stranger' })],
    ['archive_task', (id) => ({ id })],
  ]

  for (const [name, body] of byId) {
    test(`${name} is a 404, not a silent success`, async () => {
      const bTask = await addTask(B, "B's task", { cadence: 'week', planned_date: TODAY })
      await db.insert(schema.completions).values({ task_id: bTask, completed_on: TODAY })

      // 404 rather than 403: a 403 would confirm the id exists.
      await expect(runCommand(db, viewer(A), name, body(bTask))).rejects.toThrow(/no task/)

      // And nothing moved.
      const after = await db.select().from(schema.tasks).where(eq(schema.tasks.id, bTask)).get()
      expect(after!.name).toBe("B's task")
      expect(after!.planned_date).toBe(TODAY)
      expect(after!.active).toBe(true)
      const done = await db
        .select()
        .from(schema.completions)
        .where(eq(schema.completions.task_id, bTask))
        .all()
      expect(done).toHaveLength(1)
    })
  }

  test("reset_overdue clears only the caller's board", async () => {
    // The one bulk write in the system: a single UPDATE over an id list. If that
    // list is not scoped it silently unplans someone else's week.
    const aOverdue = await addTask(A, "A's overdue", { cadence: null, planned_date: YESTERDAY })
    const bOverdue = await addTask(B, "B's overdue", { cadence: null, planned_date: YESTERDAY })

    await runCommand(db, viewer(A), 'reset_overdue', {})

    const a = await db.select().from(schema.tasks).where(eq(schema.tasks.id, aOverdue)).get()
    const b = await db.select().from(schema.tasks).where(eq(schema.tasks.id, bOverdue)).get()
    expect(a!.planned_date).toBeNull()
    expect(b!.planned_date).toBe(YESTERDAY)
  })
})

describe('a command that writes without naming a task stamps the caller', () => {
  test('create_task and create_tasks', async () => {
    await runCommand(db, viewer(B), 'create_task', { name: 'made by B' })
    await runCommand(db, viewer(B), 'create_tasks', { names: ['also B', 'and B'] })

    const owners = await db.select().from(schema.tasks).all()
    expect(owners).toHaveLength(3)
    expect(owners.every((t) => t.user_id === B)).toBe(true)
    expect((await buildTodoView(db, viewer(A))).groups.flatMap((g) => g.tasks)).toEqual([])
  })

  test('set_mood, set_log and set_task_order write one row per user per day', async () => {
    const aTask = await addTask(A, "A's daily", { cadence: 'day' })
    await runCommand(db, viewer(A), 'set_mood', { slug: 'happy' })
    await runCommand(db, viewer(A), 'set_log', { text: "A's note" })
    await runCommand(db, viewer(A), 'set_task_order', { task_ids: [aTask] })

    await runCommand(db, viewer(B), 'set_mood', { slug: 'balanced' })
    await runCommand(db, viewer(B), 'set_log', { text: "B's note" })

    // Two rows on the same date rather than one overwriting the other — which is
    // what the (user_id, date) key is for.
    const rows = await db.select().from(schema.days).all()
    expect(rows).toHaveLength(2)
    expect(rows.find((r) => r.user_id === A)!.log).toBe("A's note")
    expect(rows.find((r) => r.user_id === B)!.log).toBe("B's note")
    expect(rows.find((r) => r.user_id === B)!.task_order).toBeNull()
  })

  test('completing writes a completion the other user cannot see', async () => {
    const bTask = await addTask(B, "B's daily", { cadence: 'day' })
    await runCommand(db, viewer(B), 'complete', { task_id: bTask })

    const a = await buildDayView(db, viewer(A))
    expect([...a.active, ...a.completed]).toEqual([])
    const b = await buildDayView(db, viewer(B))
    expect(b.completed.map((t) => t.name)).toEqual(["B's daily"])
  })
})
