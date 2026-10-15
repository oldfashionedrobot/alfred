import { test, expect, describe, beforeEach, afterEach } from 'bun:test'
import { eq } from 'drizzle-orm'

import type { ISODate } from '../src/shared/types.ts'
import type { DB } from '../src/server/db.ts'
import * as schema from '../src/server/schema.ts'
import { runCommand } from '../src/server/commands.ts'
import { today } from '../src/server/today.ts'
import { closeDb, freshDb, type Harness } from './harness.ts'

/**
 * Command behaviour that no view exercises.
 *
 * `views.test.ts` covers what the builders derive and `isolation.test.ts` covers
 * who may see it. This covers what a command WRITES — which had no home until
 * bulk capture learned to place, and a rule with no test is a rule that drifts.
 */

const OWNER = 1

/*
 * The suite's timezone, explicit and fixed.
 *
 * `today()` takes a zone now, so nothing here depends on the process's `TZ` —
 * UTC because it has no DST, so no test lands on a day that is 23 or 25 hours
 * long.
 */
const ZONE = 'UTC'

const TODAY = today(ZONE)
const VIEWER = { id: OWNER, timezone: ZONE }

/** `n` calendar days from `date` — written out rather than borrowed from
 *  `period.ts`, so a test cannot pass by restating the implementation. */
const shift = (date: ISODate, n: number): ISODate => {
  const d = new Date(`${date}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}
const YESTERDAY = shift(TODAY, -1)
const TOMORROW = shift(TODAY, 1)

let h: Harness
let db: DB

// User 1 is `owner`, created by migration 0003 — it holds everything written
// before accounts existed, so the migrations have already put it there.
beforeEach(async () => {
  h = await freshDb('commands')
  db = h.db
})
afterEach(() => closeDb(h))

const rows = () => db.select().from(schema.tasks).all()

describe('the placement bound', () => {
  /*
   * It lived in `place` alone until v16. The other three commands that write
   * `planned_date` took any valid date, so a weekly task could be given a date
   * six months out through the editor's save and would sit there — un-overdue,
   * un-unplaced, un-done — until the day arrived. v16's paging is what would
   * finally have drawn it, on a pane its own cadence can never reach.
   *
   * Unreachable through the interface: the client bounds its picker from the
   * same `placement` the views ship. These are here so that the interface being
   * wrong is a visible error rather than a silent bad write.
   */
  const FAR = '2099-01-01'

  async function weekly() {
    const [t] = await db
      .insert(schema.tasks)
      .values({ user_id: OWNER, name: 'Weekly', cadence: 'week', active: true })
      .returning()
    return t!.id
  }

  test("update_task refuses a date outside the task's own period", async () => {
    const id = await weekly()
    expect(runCommand(db, VIEWER, 'update_task', { id, planned_date: FAR })).rejects.toThrow(
      /cannot place beyond/,
    )
  })

  test('create_task refuses one too', async () => {
    expect(
      runCommand(db, VIEWER, 'create_task', { name: 'W', cadence: 'week', planned_date: FAR }),
    ).rejects.toThrow(/cannot place beyond/)
  })

  test('create_tasks refuses a date already past', async () => {
    expect(
      runCommand(db, VIEWER, 'create_tasks', { names: ['x'], planned_date: '2020-01-01' }),
    ).rejects.toThrow(/cannot place before today/)
  })

  test('narrowing the cadence clears a date the new period cannot reach', async () => {
    /*
     * The editor always sends `cadence` and only sends `planned_date` when the
     * day chip changed, so this arrives as a cadence and no date. Bounding only
     * the date that was SENT missed it, and the row kept a date its new period
     * can never reach — un-overdue, un-unplaced, un-done.
     *
     * Cleared, not refused: nobody touched the date, so a 409 would point at a
     * field the person never edited.
     */
    await runCommand(db, VIEWER, 'create_task', {
      name: 'Drifter',
      cadence: null,
      planned_date: FAR,
    })
    const [before] = await db.select().from(schema.tasks).where(eq(schema.tasks.name, 'Drifter'))
    expect(before!.planned_date).toBe(FAR)

    await runCommand(db, VIEWER, 'update_task', { id: before!.id, cadence: 'week' })
    const [after] = await db.select().from(schema.tasks).where(eq(schema.tasks.id, before!.id))
    expect(after!.cadence).toBe('week')
    expect(after!.planned_date).toBeNull()
  })

  test('a date the new period CAN reach survives the same save', async () => {
    await runCommand(db, VIEWER, 'create_task', {
      name: 'Keeps',
      cadence: null,
      planned_date: TODAY,
    })
    const [before] = await db.select().from(schema.tasks).where(eq(schema.tasks.name, 'Keeps'))

    await runCommand(db, VIEWER, 'update_task', { id: before!.id, cadence: 'week' })
    const [after] = await db.select().from(schema.tasks).where(eq(schema.tasks.id, before!.id))
    expect(after!.planned_date).toBe(TODAY)
  })

  test('a one-off has no far edge, so a distant date is fine', async () => {
    await runCommand(db, VIEWER, 'create_task', { name: 'Once', cadence: null, planned_date: FAR })
    const [row] = await db.select().from(schema.tasks).where(eq(schema.tasks.name, 'Once'))
    expect(row!.planned_date).toBe(FAR)
  })

  test('the bound follows the cadence a save MOVES a task to', async () => {
    // Placed legitimately as a one-off, then made weekly in the same breath as
    // keeping the date: the bound is the new cadence's, not the old one's.
    await runCommand(db, VIEWER, 'create_task', { name: 'Moves', cadence: null, planned_date: FAR })
    const [row] = await db.select().from(schema.tasks).where(eq(schema.tasks.name, 'Moves'))
    expect(
      runCommand(db, VIEWER, 'update_task', { id: row!.id, cadence: 'week', planned_date: FAR }),
    ).rejects.toThrow(/cannot place beyond/)
  })

  test('today is always inside it, for every cadence', async () => {
    for (const cadence of ['week', 'month', 'quarter', 'year', null] as const) {
      await runCommand(db, VIEWER, 'create_task', {
        name: `ok-${String(cadence)}`,
        cadence,
        planned_date: TODAY,
      })
    }
    const rows = await db.select().from(schema.tasks)
    expect(rows.filter((r) => r.planned_date === TODAY)).toHaveLength(5)
  })
})

describe('set_completion and an archived task', () => {
  /*
   * This command does the work of two, and the two disagree on purpose:
   * `complete` and `place` refuse an archived task, `uncomplete` allows it. So
   * does this — refusing to fill a cell, allowing one to be emptied. The grid
   * draws only ACTIVE dailies, so a completion written against an archived task
   * would land on a column nothing renders.
   */
  async function archivedDaily() {
    const [t] = await db
      .insert(schema.tasks)
      .values({ user_id: OWNER, name: 'Gone', cadence: 'day', active: false })
      .returning()
    return t!.id
  }

  test('filling a cell is refused', async () => {
    const id = await archivedDaily()
    expect(
      runCommand(db, VIEWER, 'set_completion', { task_id: id, date: TODAY, done: true }),
    ).rejects.toThrow(/archived/)
  })

  test('emptying one is allowed, so a stray record can still be cleaned up', async () => {
    const id = await archivedDaily()
    await db.insert(schema.completions).values({ task_id: id, completed_on: TODAY })
    await runCommand(db, VIEWER, 'set_completion', { task_id: id, date: TODAY, done: false })
    const rows = await db
      .select()
      .from(schema.completions)
      .where(eq(schema.completions.task_id, id))
    expect(rows).toHaveLength(0)
  })
})

describe('complete', () => {
  /*
   * The (task_id, completed_on) primary key absorbs a repeat, so completing
   * twice on one date writes one row and raises nothing.
   *
   * It lived only in a browser test until v15, asserted through a double-tap —
   * which stopped exercising it the moment the tick started predicting, because
   * the second tap became an `uncomplete`. The guarantee is the server's, so it
   * is tested against the server.
   */
  test('completing twice on one date writes one row', async () => {
    const [task] = await db
      .insert(schema.tasks)
      .values({ user_id: OWNER, name: 'Twice', cadence: 'day', active: true })
      .returning()

    await runCommand(db, VIEWER, 'complete', { task_id: task!.id })
    await runCommand(db, VIEWER, 'complete', { task_id: task!.id })

    const rows = await db
      .select()
      .from(schema.completions)
      .where(eq(schema.completions.task_id, task!.id))
    expect(rows).toHaveLength(1)
    expect(rows[0]!.completed_on).toBe(TODAY)
  })
})

describe('set_completion', () => {
  /*
   * The only command in the system that accepts a date, so this block is mostly
   * about the bounds. The gesture itself is one row: present, or not.
   */

  const ticks = (id: number) =>
    db.select().from(schema.completions).where(eq(schema.completions.task_id, id)).all()

  async function addTask(over: Partial<typeof schema.tasks.$inferInsert> = {}): Promise<number> {
    const [row] = await db
      .insert(schema.tasks)
      .values({ user_id: OWNER, name: 'Feed Barney', cadence: 'day', active: true, ...over })
      .returning({ id: schema.tasks.id })
    return row!.id
  }

  test('writes a row at the named date rather than at today', async () => {
    const id = await addTask()
    await runCommand(db, VIEWER, 'set_completion', { task_id: id, date: YESTERDAY, done: true })

    expect((await ticks(id)).map((c) => c.completed_on)).toEqual([YESTERDAY])
    // The mood, the log and the arrangement live in `days` and are not part of
    // this gesture — correcting a cell must not conjure a day record.
    expect(await db.select().from(schema.days).all()).toEqual([])
  })

  test('a repeat is a no-op, exactly as completing twice is', async () => {
    const id = await addTask()
    await runCommand(db, VIEWER, 'set_completion', { task_id: id, date: YESTERDAY, done: true })
    await runCommand(db, VIEWER, 'set_completion', { task_id: id, date: YESTERDAY, done: true })
    expect(await ticks(id)).toHaveLength(1)
  })

  test('done: false deletes the named row and leaves the rest', async () => {
    const id = await addTask()
    await db.insert(schema.completions).values([
      { task_id: id, completed_on: YESTERDAY },
      { task_id: id, completed_on: TODAY },
    ])

    await runCommand(db, VIEWER, 'set_completion', { task_id: id, date: YESTERDAY, done: false })
    // The CELL, not the period. `uncomplete` deletes whichever row satisfies the
    // current period; this deletes the one the cell sits on and nothing else.
    expect((await ticks(id)).map((c) => c.completed_on)).toEqual([TODAY])
  })

  test('refuses a task that is not daily', async () => {
    const id = await addTask({ cadence: 'week', planned_date: TODAY })
    // A weekly task satisfied once covers seven cells, so a dated completion on
    // one would stop meaning one thing per cell.
    await expect(
      runCommand(db, VIEWER, 'set_completion', { task_id: id, date: YESTERDAY, done: true }),
    ).rejects.toThrow(/daily/)
    expect(await ticks(id)).toEqual([])
  })

  test('refuses a day that has not happened', async () => {
    const id = await addTask()
    await expect(
      runCommand(db, VIEWER, 'set_completion', { task_id: id, date: TOMORROW, done: true }),
    ).rejects.toThrow(/has not happened/)
    expect(await ticks(id)).toEqual([])
  })

  test("refuses another user's task, as a 404", async () => {
    const [other] = await db
      .insert(schema.users)
      .values({ username: 'other', password_hash: '', active: true })
      .returning({ id: schema.users.id })
    const id = await addTask({ user_id: other!.id })

    // 404 rather than 403, like every command: a 403 would confirm the id exists.
    await expect(
      runCommand(db, VIEWER, 'set_completion', { task_id: id, date: YESTERDAY, done: true }),
    ).rejects.toThrow(/no task/)
    expect(await ticks(id)).toEqual([])
  })

  test('complete and uncomplete still cannot be handed a date', async () => {
    const id = await addTask()
    // THE STRUCTURAL HALF of the same-day rule. `onlyFields(b, ['task_id'])` is
    // what makes the everyday tick unable to name a day whatever a client tries,
    // and it is the reason set_completion is a separate command rather than a
    // parameter on this one. If this ever passes, the rule is gone.
    await expect(
      runCommand(db, VIEWER, 'complete', { task_id: id, date: YESTERDAY }),
    ).rejects.toThrow(/unexpected field/)
    await expect(
      runCommand(db, VIEWER, 'uncomplete', { task_id: id, date: YESTERDAY }),
    ).rejects.toThrow(/unexpected field/)
    expect(await ticks(id)).toEqual([])
  })
})

describe('create_tasks', () => {
  test('places every name on the given date', async () => {
    await runCommand(db, VIEWER, 'create_tasks', {
      names: ['bins', 'washing', 'bread'],
      planned_date: TODAY,
    })
    const made = await rows()
    expect(made).toHaveLength(3)
    // The gesture is "these three things, today" — not "one of them, today".
    expect(made.every((t) => t.planned_date === TODAY)).toBe(true)
    expect(made.every((t) => t.cadence === null)).toBe(true)
  })

  test('leaves them unplaced when no date is given', async () => {
    await runCommand(db, VIEWER, 'create_tasks', { names: ['bins', 'washing'] })
    const made = await rows()
    expect(made).toHaveLength(2)
    expect(made.every((t) => t.planned_date === null)).toBe(true)
  })

  test('still collapses repeats within the batch when placing', async () => {
    await runCommand(db, VIEWER, 'create_tasks', {
      names: ['bins', 'bins', ' bins '],
      planned_date: TODAY,
    })
    // One paste that lists a thing twice meant it once — placement must not
    // reintroduce the duplicate it deliberately drops.
    expect(await rows()).toHaveLength(1)
  })

  test('refuses a date it was not offered as a field', async () => {
    await expect(
      runCommand(db, VIEWER, 'create_tasks', { names: ['bins'], when: TODAY }),
    ).rejects.toThrow()
  })
})

describe('create_task', () => {
  test('a daily task cannot hold a date, whatever it is sent', async () => {
    await runCommand(db, VIEWER, 'create_task', {
      name: 'meds',
      cadence: 'day',
      planned_date: TODAY,
    })
    const [made] = await rows()
    // Daily tasks are on every day; a column saying otherwise would be a lie the
    // views would then have to work around.
    expect(made!.planned_date).toBeNull()
  })

  test('any other cadence keeps the date it was given', async () => {
    await runCommand(db, VIEWER, 'create_task', {
      name: 'deep clean',
      cadence: 'month',
      planned_date: TODAY,
    })
    const [made] = await rows()
    expect(made!.planned_date).toBe(TODAY)
  })
})

describe('update_task placement', () => {
  test('an omitted planned_date leaves the stored day alone', async () => {
    await runCommand(db, VIEWER, 'create_task', { name: 'bins', planned_date: TODAY })
    await runCommand(db, VIEWER, 'update_task', { id: 1, name: 'the bins' })
    const [t] = await rows()
    // The editor sends placement only when it changed; this is what makes that
    // safe rather than a silent rewrite on every save.
    expect(t!.name).toBe('the bins')
    expect(t!.planned_date).toBe(TODAY)
  })

  test('an explicit null clears it', async () => {
    await runCommand(db, VIEWER, 'create_task', { name: 'bins', planned_date: TODAY })
    await runCommand(db, VIEWER, 'update_task', { id: 1, planned_date: null })
    const [t] = await db.select().from(schema.tasks).where(eq(schema.tasks.id, 1))
    expect(t!.planned_date).toBeNull()
  })
})
