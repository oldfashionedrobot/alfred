import { test, expect, describe, beforeEach, afterEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { migrate } from 'drizzle-orm/bun-sqlite/migrator'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { Cadence, ISODate } from '../src/shared/types.ts'
import { TODO_GROUPS } from '../src/shared/types.ts'
import type { TodoGroup, TodoView } from '../src/shared/types.ts'
import type { DB } from '../src/server/db.ts'
import * as schema from '../src/server/schema.ts'
import { today } from '../src/server/today.ts'
import { buildDayView } from '../src/server/views/day.ts'
import { buildWeekView } from '../src/server/views/week.ts'
import { buildTodoView } from '../src/server/views/todo.ts'
import { buildHistoryView } from '../src/server/views/history.ts'

/**
 * The view builders, against a real on-disk SQLite database.
 *
 * `.plan/review-findings.md` records why this file exists: `tech-stack.md` used
 * to claim the period logic was "the only part of the system that needs tests",
 * and that was wrong by exactly one layer. `period.ts` was correct; D1 and D2 —
 * both defects that made a task untickable and unrecoverable through the
 * interface — were here, in the builders that compose those primitives.
 *
 * Two rules this suite holds itself to:
 *
 *   1. EVERY date is derived from `today()`. Nothing is hardcoded, so the suite
 *      passes on any day of the week.
 *   2. The calendar arithmetic in the assertions is written out independently of
 *      `period.ts`, so a test cannot pass by restating the implementation.
 *
 * Weeks run Sunday to Saturday, which the guards below take seriously: on a
 * Saturday there is exactly one placeable date, on a Sunday seven, and on a
 * Sunday "an earlier day of this week" does not exist at all.
 */

// ---------------------------------------------------------------------------
// Calendar helpers — deliberately NOT period.ts
// ---------------------------------------------------------------------------

/** UTC weekday index of a 'YYYY-MM-DD' string. 0 = Sunday, 6 = Saturday. */
function dow(date: ISODate): number {
  return new Date(`${date}T00:00:00Z`).getUTCDay()
}

/** `n` calendar days from `date`. */
function shift(date: ISODate, n: number): ISODate {
  const d = new Date(`${date}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

function lastDayOfMonth(year: number, month: number): ISODate {
  return new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10)
}

const TODAY: ISODate = today()
const SUNDAY: ISODate = shift(TODAY, -dow(TODAY))
const SATURDAY: ISODate = shift(SUNDAY, 6)

/** today through Saturday, inclusive — 1 date on a Saturday, 7 on a Sunday. */
const PLACEABLE: ISODate[] = Array.from({ length: 7 - dow(TODAY) }, (_, i) => shift(TODAY, i))

/** An earlier day of the CURRENT week, or null on a Sunday when there is none. */
const EARLIER_THIS_WEEK: ISODate | null = dow(TODAY) > 0 ? shift(TODAY, -1) : null
const NO_EARLIER_DAY = EARLIER_THIS_WEEK === null

/** Tomorrow. On a Saturday that is next week — which the picker would not offer,
 *  but "a future date is not a member" is the same rule either way. */
const TOMORROW: ISODate = shift(TODAY, 1)

// ---------------------------------------------------------------------------
// Harness — a temp on-disk database per test, migrated the way db.ts does
// ---------------------------------------------------------------------------

const MIGRATIONS = join(import.meta.dir, '..', 'drizzle')

let dir: string
let sqlite: Database
let db: DB

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'alfred-views-'))
  sqlite = new Database(join(dir, 'alfred.db'), { create: true })
  sqlite.exec('PRAGMA journal_mode = WAL;')
  sqlite.exec('PRAGMA foreign_keys = ON;')
  db = drizzle(sqlite, { schema })
  migrate(db, { migrationsFolder: MIGRATIONS })
  // days.mood is an FK, so the picker has to exist before a day can point at one.
  db.insert(schema.moods)
    .values([
      { slug: 'balanced', emoji: '😑', label: 'balanced', sort_order: 0, active: true },
      { slug: 'happy', emoji: '😊', label: 'happy', sort_order: 1, active: true },
      { slug: 'retired', emoji: '👻', label: 'retired', sort_order: 2, active: false },
    ])
    .run()
})

afterEach(() => {
  sqlite.close()
  rmSync(dir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

interface TaskSpec {
  name: string
  cadence?: Cadence | null
  planned_date?: ISODate | null
  is_baseline?: boolean
  color?: string | null
  category?: string | null
  active?: boolean
  /** Completion rows to write for this task. */
  done_on?: ISODate[]
}

/** Inserts a task (and any completions) and returns its id. */
function addTask(spec: TaskSpec): number {
  const [row] = db
    .insert(schema.tasks)
    .values({
      name: spec.name,
      cadence: spec.cadence ?? null,
      planned_date: spec.planned_date ?? null,
      is_baseline: spec.is_baseline ?? false,
      color: spec.color ?? null,
      category: spec.category ?? null,
      active: spec.active ?? true,
    })
    .returning({ id: schema.tasks.id })
    .all()
  const id = row!.id
  if (spec.done_on?.length) {
    db.insert(schema.completions)
      .values(spec.done_on.map((completed_on) => ({ task_id: id, completed_on })))
      .run()
  }
  return id
}

function setDay(date: ISODate, fields: { mood?: string; log?: string; task_order?: number[] }): void {
  db.insert(schema.days)
    .values({
      date,
      mood: fields.mood ?? null,
      log: fields.log ?? null,
      task_order: fields.task_order === undefined ? null : JSON.stringify(fields.task_order),
    })
    .run()
}

const names = (ts: ReadonlyArray<{ name: string }>): string[] => ts.map((t) => t.name)
const ids = (ts: ReadonlyArray<{ id: number }>): number[] => ts.map((t) => t.id)

// ---------------------------------------------------------------------------
// Calendar assumptions the rest of the suite rests on
// ---------------------------------------------------------------------------

describe('calendar assumptions', () => {
  test('the derived week runs Sunday to Saturday and contains today', () => {
    expect(dow(SUNDAY)).toBe(0)
    expect(dow(SATURDAY)).toBe(6)
    expect(SUNDAY <= TODAY && TODAY <= SATURDAY).toBe(true)
  })

  test('placeable dates run today through Saturday: 7 on a Sunday, 1 on a Saturday', () => {
    expect(PLACEABLE[0]).toBe(TODAY)
    expect(PLACEABLE[PLACEABLE.length - 1]).toBe(SATURDAY)
    expect(PLACEABLE.length).toBe(7 - dow(TODAY))
  })
})

// ---------------------------------------------------------------------------
// Day
// ---------------------------------------------------------------------------

describe('buildDayView', () => {
  test('D1 REGRESSION — completing an overdue one-off keeps it on the screen', () => {
    // The defect: membership was a chain of `else if` on isOverdue, which is
    // false once a task is done. Ticking an overdue task dropped it out of
    // BOTH arrays — off the screen, with no row left to tap to untick, and no
    // other surface able to correct it (Week's past days are read-only).
    // A one-off's period start is unbounded, so this reproduces on any weekday.
    const id = addTask({
      name: 'Call the vet',
      cadence: null,
      planned_date: shift(TODAY, -3),
      done_on: [TODAY],
    })

    const view = buildDayView(db)
    const members = view.active.concat(view.completed)

    expect(ids(members)).toContain(id)
    expect(ids(view.completed)).toContain(id)
    expect(ids(view.active)).not.toContain(id)

    const row = view.completed.find((t) => t.id === id)!
    // State is laboured independently of membership; isOverdue is false once
    // done, so a completed overdue task is labelled 'planned'.
    expect(['overdue', 'planned']).toContain(row.state)
  })

  test.skipIf(NO_EARLIER_DAY)(
    'D1 REGRESSION — completing an overdue WEEKLY task keeps it on the screen',
    () => {
      const past = EARLIER_THIS_WEEK!
      const id = addTask({ name: 'Vacuum', cadence: 'week', planned_date: past, done_on: [TODAY] })

      const view = buildDayView(db)

      expect(ids(view.active.concat(view.completed))).toContain(id)
      expect(ids(view.completed)).toContain(id)
      expect(['overdue', 'planned']).toContain(view.completed.find((t) => t.id === id)!.state)
    },
  )

  test('an overdue task not yet done is active, marked overdue, and sets has_overdue', () => {
    const id = addTask({ name: 'Call the vet', cadence: null, planned_date: shift(TODAY, -3) })

    const view = buildDayView(db)

    expect(ids(view.active)).toContain(id)
    expect(view.active.find((t) => t.id === id)!.state).toBe('overdue')
    expect(view.has_overdue).toBe(true)
  })

  test('a daily task is active when not completed and completed when it is', () => {
    addTask({ name: 'Meds', cadence: 'day' })
    addTask({ name: 'Sleep', cadence: 'day', done_on: [TODAY] })

    const view = buildDayView(db)

    expect(names(view.active)).toEqual(['Meds'])
    expect(names(view.completed)).toEqual(['Sleep'])
    expect(view.active[0]!.state).toBe('daily')
    expect(view.completed[0]!.state).toBe('daily')
    expect(view.has_overdue).toBe(false)
  })

  test.skipIf(NO_EARLIER_DAY)(
    'a weekly task placed today but completed earlier this week is completed, not active',
    () => {
      // is_done is PERIOD-SATISFACTION, not same-day: this week's vacuuming is
      // done, whatever day it was ticked.
      const id = addTask({
        name: 'Vacuum',
        cadence: 'week',
        planned_date: TODAY,
        done_on: [EARLIER_THIS_WEEK!],
      })

      const view = buildDayView(db)

      expect(ids(view.completed)).toContain(id)
      expect(ids(view.active)).not.toContain(id)
      expect(view.completed.find((t) => t.id === id)!.state).toBe('planned')
    },
  )

  test.skipIf(NO_EARLIER_DAY)(
    'a weekly task placed AND completed on an earlier day of this week is not a member at all',
    () => {
      // Neither planned today, nor overdue (it is done), nor ticked today.
      // views.md: a completed task stays on Day for the day you ticked it, and
      // no longer — the To do panel answers for the rest of the period.
      const past = EARLIER_THIS_WEEK!
      addTask({ name: 'Vacuum', cadence: 'week', planned_date: past, done_on: [past] })

      const view = buildDayView(db)

      expect(view.active).toEqual([])
      expect(view.completed).toEqual([])
    },
  )

  test('a task placed on a future date is not a member — tomorrow is not today', () => {
    addTask({ name: 'Grocery run', cadence: 'week', planned_date: TOMORROW })
    addTask({ name: 'Book a table', cadence: null, planned_date: TOMORROW })

    const view = buildDayView(db)

    expect(view.active.concat(view.completed)).toEqual([])
  })

  test('an unplaced period task is not a member — it lives in the panel only', () => {
    addTask({ name: 'Grocery run', cadence: 'week' })

    const view = buildDayView(db)

    expect(view.active.concat(view.completed)).toEqual([])
  })

  test('archived tasks appear in no view', () => {
    addTask({ name: 'Gone daily', cadence: 'day', active: false })
    addTask({ name: 'Gone overdue', cadence: null, planned_date: shift(TODAY, -3), active: false })
    addTask({ name: 'Gone placed', cadence: 'week', planned_date: TODAY, active: false })
    addTask({ name: 'Gone ticked', cadence: 'day', active: false, done_on: [TODAY] })

    const day = buildDayView(db)
    expect(day.active.concat(day.completed)).toEqual([])
    expect(day.has_overdue).toBe(false)

    const week = buildWeekView(db)
    expect(week.days.flatMap((d) => d.tasks)).toEqual([])

    const todo = buildTodoView(db)
    expect(todo.groups.flatMap((g) => g.tasks)).toEqual([])
    expect(todo.has_overdue).toBe(false)

    expect(buildHistoryView(db, {}).columns).toEqual([])
  })

  test('baseline is the top band and names are alphabetical within a band', () => {
    addTask({ name: 'Apple', cadence: 'day' })
    addTask({ name: 'Banana', cadence: 'day' })
    addTask({ name: 'Zebra', cadence: 'day', is_baseline: true })

    expect(names(buildDayView(db).active)).toEqual(['Zebra', 'Apple', 'Banana'])
  })

  test("days.task_order is respected, and never moves a task across the baseline band", () => {
    const apple = addTask({ name: 'Apple', cadence: 'day' })
    const banana = addTask({ name: 'Banana', cadence: 'day' })
    addTask({ name: 'Zebra', cadence: 'day', is_baseline: true })
    // Zebra is listed last but is baseline, so it still leads.
    setDay(TODAY, { task_order: [banana, apple] })

    expect(names(buildDayView(db).active)).toEqual(['Zebra', 'Banana', 'Apple'])
  })

  test('active and completed are sorted independently', () => {
    addTask({ name: 'Apple', cadence: 'day', done_on: [TODAY] })
    addTask({ name: 'Banana', cadence: 'day' })
    addTask({ name: 'Zebra', cadence: 'day', is_baseline: true, done_on: [TODAY] })

    const view = buildDayView(db)
    expect(names(view.active)).toEqual(['Banana'])
    expect(names(view.completed)).toEqual(['Zebra', 'Apple'])
  })

  test('mood, log and the picker come off the sparse days row', () => {
    const bare = buildDayView(db)
    expect(bare.date).toBe(TODAY)
    expect(bare.mood).toBeNull()
    expect(bare.log).toBeNull()
    // Active moods only, in sort_order — the retired one is not in the picker.
    expect(bare.moods.map((m) => m.slug)).toEqual(['balanced', 'happy'])

    setDay(TODAY, { mood: 'happy', log: 'a good one' })
    const view = buildDayView(db)
    expect(view.mood).toBe('happy')
    expect(view.log).toBe('a good one')
  })

  test('placeable_dates is today through Saturday, so Day never fetches the Week model', () => {
    expect(buildDayView(db).placeable_dates).toEqual(PLACEABLE)
  })
})

// ---------------------------------------------------------------------------
// Week
// ---------------------------------------------------------------------------

describe('buildWeekView', () => {
  test('exactly seven days, Sunday first, Saturday last', () => {
    const view = buildWeekView(db)

    expect(view.days.length).toBe(7)
    expect(view.week_start).toBe(SUNDAY)
    expect(view.week_end).toBe(SATURDAY)
    expect(view.today).toBe(TODAY)
    expect(view.days.map((d) => d.date)).toEqual(
      Array.from({ length: 7 }, (_, i) => shift(SUNDAY, i)),
    )
    expect(view.days.filter((d) => d.is_today).map((d) => d.date)).toEqual([TODAY])
    expect(view.days.filter((d) => d.is_past).length).toBe(dow(TODAY))
  })

  test('placeable_dates is today through Saturday', () => {
    expect(buildWeekView(db).placeable_dates).toEqual(PLACEABLE)
  })

  test('daily tasks never appear anywhere in the model', () => {
    addTask({ name: 'Meds', cadence: 'day' })
    addTask({ name: 'Baseline', cadence: 'day', is_baseline: true, done_on: [TODAY] })

    expect(buildWeekView(db).days.flatMap((d) => d.tasks)).toEqual([])
  })

  test('a task placed on a day appears on that day and nowhere else', () => {
    addTask({ name: 'Grocery run', cadence: 'week', planned_date: SATURDAY })

    const view = buildWeekView(db)
    const saturday = view.days.find((d) => d.date === SATURDAY)!

    expect(names(saturday.tasks)).toEqual(['Grocery run'])
    expect(view.days.filter((d) => d.tasks.length > 0).length).toBe(1)
  })

  test('an unplaced task is on no day — the panel holds it', () => {
    addTask({ name: 'Grocery run', cadence: 'week' })
    addTask({ name: 'Fix the gate', cadence: null })

    expect(buildWeekView(db).days.flatMap((d) => d.tasks)).toEqual([])
  })

  test('can_complete is false on past days and true from today on', () => {
    for (const d of Array.from({ length: 7 }, (_, i) => shift(SUNDAY, i))) {
      addTask({ name: `Task ${d}`, cadence: 'week', planned_date: d })
    }

    for (const day of buildWeekView(db).days) {
      expect(day.tasks.length).toBe(1)
      expect(day.tasks[0]!.can_complete).toBe(!day.is_past)
      expect(day.is_past).toBe(day.date < TODAY)
    }
  })

  test.skipIf(NO_EARLIER_DAY)(
    'a completed task still renders on the day it was placed, struck through',
    () => {
      // D2's sibling: doneness marks a row, it never removes one.
      const past = EARLIER_THIS_WEEK!
      addTask({ name: 'Vacuum', cadence: 'week', planned_date: past, done_on: [TODAY] })

      const day = buildWeekView(db).days.find((d) => d.date === past)!
      expect(names(day.tasks)).toEqual(['Vacuum'])
      expect(day.tasks[0]!.is_done).toBe(true)
      expect(day.tasks[0]!.can_complete).toBe(false)
    },
  )

  test('is_done is period satisfaction, not same-day', () => {
    addTask({ name: 'Vacuum', cadence: 'week', planned_date: SATURDAY, done_on: [SUNDAY] })

    const saturday = buildWeekView(db).days.find((d) => d.date === SATURDAY)!
    expect(saturday.tasks[0]!.is_done).toBe(true)
  })

  test('overdue, unplaced and backlog are gone — they moved to the To do panel', () => {
    addTask({ name: 'Grocery run', cadence: 'week' })
    addTask({ name: 'Fix the gate', cadence: null, planned_date: shift(TODAY, -3) })

    const view: object = buildWeekView(db)

    expect(Object.keys(view).sort()).toEqual(
      ['days', 'placeable_dates', 'today', 'week_end', 'week_start'].sort(),
    )
  })
})

// ---------------------------------------------------------------------------
// To do
// ---------------------------------------------------------------------------

const GROUP_ORDER: ReadonlyArray<Cadence | null> = TODO_GROUPS.map((g) => g.cadence)

describe('buildTodoView', () => {
  test('always exactly six groups in cadence order, even when the database is empty', () => {
    const view = buildTodoView(db)

    expect(view.groups.length).toBe(6)
    expect(view.groups.map((g) => g.cadence)).toEqual([
      'day',
      'week',
      'month',
      'quarter',
      'year',
      null,
    ])
    expect(view.groups.map((g) => g.cadence)).toEqual([...GROUP_ORDER])
    expect(view.groups.every((g) => g.tasks.length === 0)).toBe(true)
    expect(view.today).toBe(TODAY)
    expect(view.has_overdue).toBe(false)
  })

  test('six groups still, once every cadence has a task', () => {
    for (const cadence of GROUP_ORDER) addTask({ name: `A ${cadence}`, cadence })

    const view = buildTodoView(db)
    expect(view.groups.map((g) => g.cadence)).toEqual([...GROUP_ORDER])
    expect(view.groups.every((g) => g.tasks.length === 1)).toBe(true)
    expect(view.groups.every((g) => g.tasks[0]!.cadence === g.cadence)).toBe(true)
  })

  test('period_start and period_end are the current period, and null for one-offs', () => {
    const y = Number(TODAY.slice(0, 4))
    const m = Number(TODAY.slice(5, 7))
    const q1 = Math.floor((m - 1) / 3) * 3 + 1 // first month of this quarter

    const expected: Record<string, [ISODate | null, ISODate | null]> = {
      day: [TODAY, TODAY],
      week: [SUNDAY, SATURDAY],
      month: [`${TODAY.slice(0, 7)}-01`, lastDayOfMonth(y, m)],
      quarter: [
        `${y}-${String(q1).padStart(2, '0')}-01`,
        lastDayOfMonth(y, q1 + 2),
      ],
      year: [`${y}-01-01`, `${y}-12-31`],
      once: [null, null],
    }

    for (const g of buildTodoView(db).groups) {
      const [start, end] = expected[g.cadence ?? 'once']!
      expect([g.cadence, g.period_start]).toEqual([g.cadence, start])
      expect([g.cadence, g.period_end]).toEqual([g.cadence, end])
    }
  })

  test('a group holds every active task of its cadence — placed or not, done or not', () => {
    // Membership does not change as the week goes on; only the marks do.
    addTask({ name: 'Unplaced', cadence: 'week' })
    addTask({ name: 'Placed', cadence: 'week', planned_date: TODAY })
    addTask({ name: 'Done', cadence: 'week', done_on: [SUNDAY] })
    addTask({ name: 'Placed and done', cadence: 'week', planned_date: TODAY, done_on: [TODAY] })

    const week = groupFor(buildTodoView(db), 'week')
    expect(names(week.tasks).sort()).toEqual(['Done', 'Placed', 'Placed and done', 'Unplaced'])
  })

  test('marks: is_done, is_overdue and effective_date ride on the row', () => {
    addTask({ name: 'Overdue', cadence: null, planned_date: shift(TODAY, -3) })
    addTask({ name: 'Struck', cadence: 'month', done_on: [TODAY] })
    addTask({ name: 'Placed', cadence: 'month', planned_date: TODAY })

    const view = buildTodoView(db)

    const overdue = groupFor(view, null).tasks[0]!
    expect(overdue.is_overdue).toBe(true)
    expect(overdue.is_done).toBe(false)
    expect(overdue.effective_date).toBe(shift(TODAY, -3))
    expect(view.has_overdue).toBe(true)

    const month = groupFor(view, 'month')
    expect(month.tasks.find((t) => t.name === 'Struck')!.is_done).toBe(true)
    expect(month.tasks.find((t) => t.name === 'Struck')!.effective_date).toBeNull()
    expect(month.tasks.find((t) => t.name === 'Placed')!.is_done).toBe(false)
  })

  test('is_done is read against the task OWN cadence, not the day', () => {
    // A monthly ticked earlier this month is done; a weekly ticked last week is not.
    addTask({ name: 'Monthly', cadence: 'month', done_on: [`${TODAY.slice(0, 7)}-01`] })
    addTask({ name: 'Weekly', cadence: 'week', done_on: [shift(SUNDAY, -1)] })

    const view = buildTodoView(db)
    expect(groupFor(view, 'month').tasks[0]!.is_done).toBe(true)
    expect(groupFor(view, 'week').tasks[0]!.is_done).toBe(false)
  })

  test('a one-off completed THIS week is present and struck through', () => {
    addTask({ name: 'Fix the gate', cadence: null, done_on: [SUNDAY] })

    const once = groupFor(buildTodoView(db), null)
    expect(names(once.tasks)).toEqual(['Fix the gate'])
    expect(once.tasks[0]!.is_done).toBe(true)
  })

  test('a one-off completed BEFORE this week is gone entirely', () => {
    addTask({ name: 'Fix the gate', cadence: null, done_on: [shift(SUNDAY, -1)] })
    addTask({ name: 'Call the vet', cadence: null })

    const view = buildTodoView(db)
    expect(names(groupFor(view, null).tasks)).toEqual(['Call the vet'])
    // And it is gone from the whole model, not merely from its group.
    expect(names(view.groups.flatMap((g) => g.tasks))).not.toContain('Fix the gate')
  })

  test('a RECURRING task completed before this period is never dropped — only one-offs are', () => {
    addTask({ name: 'Vacuum', cadence: 'week', done_on: [shift(SUNDAY, -1)] })

    const week = groupFor(buildTodoView(db), 'week')
    expect(names(week.tasks)).toEqual(['Vacuum'])
    expect(week.tasks[0]!.is_done).toBe(false)
  })

  test('order: overdue, then placed, then unplaced, then done — never alphabetical', () => {
    // Every band is seeded with the name that alphabetical order would put in
    // the opposite position, so a sort that ignores the bands cannot pass.
    addTask({ name: 'Zebra', cadence: null, planned_date: shift(TODAY, -3) }) // band 1 overdue
    addTask({ name: 'Yak', cadence: null, planned_date: TODAY }) // band 2 placed
    addTask({ name: 'Xray', cadence: null }) // band 3 no day
    addTask({ name: 'Apple', cadence: null, done_on: [TODAY] }) // band 4 done
    addTask({ name: 'Bison', cadence: null, planned_date: TODAY, done_on: [TODAY] }) // band 4 done

    const once = groupFor(buildTodoView(db), null)
    expect(names(once.tasks)).toEqual(['Zebra', 'Yak', 'Xray', 'Apple', 'Bison'])
  })

  test('a done task sinks below an unplaced one, and below a placed one', () => {
    // Band 4 wins over the others: done sinks whether or not it has a day.
    addTask({ name: 'Apple', cadence: 'week', done_on: [TODAY] })
    addTask({ name: 'Beetle', cadence: 'week', planned_date: TODAY, done_on: [TODAY] })
    addTask({ name: 'Zebra', cadence: 'week' })
    addTask({ name: 'Yak', cadence: 'week', planned_date: TODAY })

    expect(names(groupFor(buildTodoView(db), 'week').tasks)).toEqual([
      'Yak', // placed
      'Zebra', // no day
      'Apple', // done
      'Beetle', // done
    ])
  })

  test('names are alphabetical within a band', () => {
    addTask({ name: 'Zebra', cadence: 'year' })
    addTask({ name: 'Apple', cadence: 'year' })
    addTask({ name: 'Mongoose', cadence: 'year' })

    expect(names(groupFor(buildTodoView(db), 'year').tasks)).toEqual(['Apple', 'Mongoose', 'Zebra'])
  })

  test('daily tasks are in the panel even though they are never in Week', () => {
    addTask({ name: 'Meds', cadence: 'day', done_on: [TODAY] })
    addTask({ name: 'Sleep', cadence: 'day' })

    const day = groupFor(buildTodoView(db), 'day')
    expect(names(day.tasks)).toEqual(['Sleep', 'Meds']) // not done, then done
    expect(day.tasks[1]!.is_done).toBe(true)
  })

  test('has_overdue is true when ANY group holds an overdue task', () => {
    expect(buildTodoView(db).has_overdue).toBe(false)

    // The one-off group is the LAST of the six, so this also proves has_overdue
    // scans past the first. A one-off's period start is unbounded, which is what
    // makes it overdue on every calendar date — including 1 January, where no
    // recurring cadence can be: yesterday is behind the year, quarter and month
    // period starts, so effective_date is null and there is no debt to carry.
    addTask({ name: 'Call the vet', cadence: null, planned_date: shift(TODAY, -1) })
    const view = buildTodoView(db)
    expect(view.has_overdue).toBe(true)
    expect(groupFor(view, null).tasks[0]!.is_overdue).toBe(true)
  })

  test.skipIf(NO_EARLIER_DAY)('has_overdue picks up a RECURRING task too', () => {
    addTask({ name: 'Vacuum', cadence: 'week', planned_date: EARLIER_THIS_WEEK! })

    const view = buildTodoView(db)
    expect(view.has_overdue).toBe(true)
    expect(groupFor(view, 'week').tasks[0]!.is_overdue).toBe(true)
  })

  test('placeable_dates matches Day and Week exactly', () => {
    const todo = buildTodoView(db)
    expect(todo.placeable_dates).toEqual(PLACEABLE)
    expect(todo.placeable_dates).toEqual(buildDayView(db).placeable_dates)
    expect(todo.placeable_dates).toEqual(buildWeekView(db).placeable_dates)
  })
})

function groupFor(view: TodoView, cadence: Cadence | null): TodoGroup {
  const g = view.groups.find((x) => x.cadence === cadence)
  expect(g).toBeDefined()
  return g!
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

describe('buildHistoryView', () => {
  test('columns are ACTIVE DAILY tasks only, in sort order', () => {
    addTask({ name: 'Zebra', cadence: 'day', is_baseline: true })
    addTask({ name: 'Apple', cadence: 'day' })
    addTask({ name: 'Weekly', cadence: 'week' })
    addTask({ name: 'One-off', cadence: null })
    addTask({ name: 'Archived', cadence: 'day', active: false })

    expect(buildHistoryView(db, {}).columns.map((c) => c.name)).toEqual(['Zebra', 'Apple'])
  })

  test('every date in range gets a row, including days with nothing recorded', () => {
    const id = addTask({ name: 'Meds', cadence: 'day', done_on: [TODAY, shift(TODAY, -3)] })

    const view = buildHistoryView(db, {})

    expect(view.rows.map((r) => r.date)).toEqual([
      TODAY,
      shift(TODAY, -1),
      shift(TODAY, -2),
      shift(TODAY, -3),
    ])
    // The gap is the point: two empty rows between the two completions.
    expect(view.rows.map((r) => r.completed)).toEqual([[id], [], [], [id]])
    expect(view.next_before).toBeNull()
  })

  test('a mood is resolved to the object, retired moods included', () => {
    addTask({ name: 'Meds', cadence: 'day', done_on: [shift(TODAY, -1)] })
    setDay(TODAY, { mood: 'retired' })

    const view = buildHistoryView(db, {})
    expect(view.rows[0]!.mood?.slug).toBe('retired')
    expect(view.rows[0]!.mood?.emoji).toBe('👻')
    expect(view.rows[0]!.mood?.active).toBe(false)
    expect(view.rows[1]!.mood).toBeNull()
  })

  test('limit pages backwards and next_before is null only when exhausted', () => {
    addTask({ name: 'Meds', cadence: 'day', done_on: [TODAY, shift(TODAY, -4)] })

    const first = buildHistoryView(db, { limit: 2 })
    expect(first.rows.map((r) => r.date)).toEqual([TODAY, shift(TODAY, -1)])
    expect(first.next_before).toBe(shift(TODAY, -1))

    // `before` is exclusive.
    const second = buildHistoryView(db, { limit: 10, before: first.next_before! })
    expect(second.rows.map((r) => r.date)).toEqual([
      shift(TODAY, -2),
      shift(TODAY, -3),
      shift(TODAY, -4),
    ])
    expect(second.next_before).toBeNull()
  })

  test('an empty database has columns but no rows', () => {
    addTask({ name: 'Meds', cadence: 'day' })

    const view = buildHistoryView(db, {})
    expect(view.columns.length).toBe(1)
    expect(view.rows).toEqual([])
    expect(view.next_before).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// A rolled-over placement shows no day, and sits in the unplaced band.
// data-model.md: "A date that has fallen out the back of its period is simply
// not there." Rollover is a read — nothing ever clears planned_date — so the
// raw column still holds last period's date and must not be rendered.
// ---------------------------------------------------------------------------

describe('todo — rolled-over placements', () => {
  test('a weekly task placed in a past week shows no day and is not overdue', () => {
    const lastWeek = shift(SUNDAY, -5) // firmly inside the previous week
    const id = addTask({ name: 'Vacuum', cadence: 'week', planned_date: lastWeek })

    const row = groupFor(buildTodoView(db), 'week').tasks.find((x) => x.id === id)!

    // The column still holds it — rollover never writes.
    const stored = db.select().from(schema.tasks).all().find((t) => t.id === id)!
    expect(stored.planned_date).toBe(lastWeek)

    // The panel does not.
    expect(row.effective_date).toBeNull()
    expect(row.is_overdue).toBe(false)
    expect(row.is_done).toBe(false)
  })

  test('a one-off placed long ago keeps its day, because its period is unbounded', () => {
    const longAgo = shift(TODAY, -40)
    const id = addTask({ name: 'Call vet', cadence: null, planned_date: longAgo })
    const row = groupFor(buildTodoView(db), null).tasks.find((x) => x.id === id)!
    expect(row.effective_date).toBe(longAgo)
    expect(row.is_overdue).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Category — ordering inside a To do group.
// The full rule is: band → baseline → category (uncategorised last) → name.
// ---------------------------------------------------------------------------

describe('todo — categories', () => {
  const names = (cadence: Cadence | null) =>
    groupFor(buildTodoView(db), cadence).tasks.map((t) => t.name)

  test('category outranks name, so a category groups against the alphabet', () => {
    // Alphabetically this is Aardvark, Brush, Feed. By category it is Dog first.
    addTask({ name: 'Aardvark admin', cadence: 'day', category: 'House' })
    addTask({ name: 'Feed Barney 1', cadence: 'day', category: 'Dog' })
    addTask({ name: 'Brush Ringo', cadence: 'day', category: 'Dog' })

    expect(names('day')).toEqual(['Brush Ringo', 'Feed Barney 1', 'Aardvark admin'])
  })

  test('uncategorised sorts last, whatever its name', () => {
    addTask({ name: 'Aaa loose end', cadence: 'day' })
    addTask({ name: 'Zzz filed', cadence: 'day', category: 'House' })

    expect(names('day')).toEqual(['Zzz filed', 'Aaa loose end'])
  })

  test('baseline outranks category: it leads the group, above every heading', () => {
    // The baseline task is in a category that would otherwise sort LAST, and has
    // a name that would otherwise sort last too — so only the flag can lift it.
    addTask({ name: 'Zzz vital', cadence: 'day', is_baseline: true, category: 'Zebra' })
    addTask({ name: 'Aaa chore', cadence: 'day', category: 'Admin' })

    expect(names('day')).toEqual(['Zzz vital', 'Aaa chore'])
  })

  test('done still sinks, below every category', () => {
    addTask({ name: 'Aaa done', cadence: 'day', category: 'Admin', done_on: [TODAY] })
    addTask({ name: 'Zzz pending', cadence: 'day', category: 'Zebra' })

    expect(names('day')).toEqual(['Zzz pending', 'Aaa done'])
  })

  test('categories in use are distinct, sorted, and exclude the uncategorised', () => {
    addTask({ name: 'a', cadence: 'day', category: 'House' })
    addTask({ name: 'b', cadence: 'day', category: 'Dog' })
    addTask({ name: 'c', cadence: 'week', category: 'Dog' })
    addTask({ name: 'd', cadence: 'day' })

    expect(buildTodoView(db).categories).toEqual(['Dog', 'House'])
  })

  test('an archived task contributes no category', () => {
    addTask({ name: 'gone', cadence: 'day', category: 'Ghost', active: false })
    addTask({ name: 'here', cadence: 'day', category: 'House' })

    expect(buildTodoView(db).categories).toEqual(['House'])
  })

  test('exact matching means Dog and dog are two categories', () => {
    // A known and accepted cost of free text — pinned so it is a decision
    // rather than a surprise. `data-model.md` says so explicitly.
    addTask({ name: 'a', cadence: 'day', category: 'Dog' })
    addTask({ name: 'b', cadence: 'day', category: 'dog' })

    expect(buildTodoView(db).categories).toHaveLength(2)
  })
})

// ---------------------------------------------------------------------------
// History — columns in the same order as the To do panel, and the day's log.
// ---------------------------------------------------------------------------

describe('history — columns and log', () => {
  test('columns order by baseline, then category, then name — as the panel does', () => {
    // Alphabetically: Aardvark < Brush < Dishes < Zzz. By the real rule the
    // baseline task leads despite its name, then Dog, then House, then none.
    addTask({ name: 'Zzz vital', cadence: 'day', is_baseline: true, category: 'Zebra' })
    addTask({ name: 'Aardvark chore', cadence: 'day', category: 'House' })
    addTask({ name: 'Brush Ringo', cadence: 'day', category: 'Dog' })
    addTask({ name: 'Dishes', cadence: 'day' })

    const names = buildHistoryView(db, {}).columns.map((c) => c.name)
    expect(names).toEqual(['Zzz vital', 'Brush Ringo', 'Aardvark chore', 'Dishes'])

    // And the panel agrees — one comparator, so they cannot drift apart.
    const panel = groupFor(buildTodoView(db), 'day').tasks.map((t) => t.name)
    expect(panel).toEqual(names)
  })

  test('a row carries that day\'s log, and null when there is none', () => {
    addTask({ name: 'MED', cadence: 'day' })
    setDay(TODAY, { log: 'Long day.\nThe gate is fixed.' })

    const rows = buildHistoryView(db, {}).rows
    const todayRow = rows.find((r) => r.date === TODAY)!
    expect(todayRow.log).toBe('Long day.\nThe gate is fixed.')
    for (const r of rows.filter((r) => r.date !== TODAY)) expect(r.log).toBeNull()
  })

  test('an empty log reads as no log, not as an empty entry', () => {
    addTask({ name: 'MED', cadence: 'day' })
    setDay(TODAY, { log: '' })

    expect(buildHistoryView(db, {}).rows.find((r) => r.date === TODAY)!.log).toBeNull()
  })
})

describe('history — column colour', () => {
  test('a baseline column carries its colour; a non-baseline one never does', () => {
    addTask({ name: 'MED', cadence: 'day', is_baseline: true, color: '#c2410c' })
    // Same colour stored, but not baseline — the view must not ship it.
    addTask({ name: 'Zebra', cadence: 'day', is_baseline: false, color: '#c2410c' })
    addTask({ name: 'Plain', cadence: 'day', is_baseline: true })

    const cols = buildHistoryView(db, {}).columns
    const by = (n: string) => cols.find((c) => c.name === n)!
    expect(by('MED').color).toBe('#c2410c')
    expect(by('Zebra').color).toBeNull()
    expect(by('Plain').color).toBeNull()
  })
})
