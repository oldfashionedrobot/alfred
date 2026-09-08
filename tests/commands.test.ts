import { test, expect, describe, beforeEach, afterEach } from 'bun:test'
import { eq } from 'drizzle-orm'

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
