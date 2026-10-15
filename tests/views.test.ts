import { test, expect, describe, beforeEach, afterEach } from 'bun:test'
import { closeDb, freshDb, type Harness } from './harness.ts'

import type { Cadence, ISODate } from '../src/shared/types.ts'
import { TODO_GROUPS } from '../src/shared/types.ts'
import type { TodoGroup, TodoView } from '../src/shared/types.ts'
import type { DB } from '../src/server/db.ts'
import * as schema from '../src/server/schema.ts'
import { today } from '../src/server/today.ts'
import { buildDayView } from '../src/server/views/day.ts'
import { placeableDates, placementMax, placementRanges } from '../src/server/views/completions.ts'
import { isDone } from '../src/server/period.ts'
import { buildTodoView } from '../src/server/views/todo.ts'
import { buildHistoryView } from '../src/server/views/history.ts'

/**
 * The view builders, against a real on-disk SQLite database.
 *
 * This file exists because an earlier version of this project
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
 *
 * SIX weekday guards remain, down from twelve. v16 gave `buildDayView` a week to
 * look at, so a test wanting a future pane asks for one instead of waiting for
 * the calendar to offer it. What is left is genuinely about the calendar: five
 * need a day EARLIER in this week, which forward paging cannot conjure, and one
 * IS the Saturday behaviour.
 *
 * A WORD ON WHICH DAY THIS IS. `bun test` sets TZ=UTC for determinism, while
 * the app and the Playwright suite run in the machine's local zone. So these
 * tests can be exercising a different weekday than the app on the same machine
 * — west of Greenwich, every evening — and the skip count changes with the
 * clock. That is not a fault: both are real days and the guards handle either.
 * It is worth knowing because it explains why `5 skip` appears some evenings
 * and not others, and because it means unit and browser runs can happen to
 * cover Saturday and Sunday at once.
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

/*
 * The suite's timezone, explicit and fixed.
 *
 * `today()` takes a zone now, so nothing here depends on the process's `TZ` —
 * UTC because it has no DST, so no test lands on a day that is 23 or 25 hours
 * long.
 */
const ZONE = 'UTC'

const TODAY: ISODate = today(ZONE)
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

let h: Harness
let db: DB

beforeEach(async () => {
  h = await freshDb('views')
  db = h.db
})

afterEach(() => closeDb(h))

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * The migration's `owner`, id 1 — who the app resolves to with auth off, so it
 * is who every existing test is implicitly about. `OTHER` is created per test by
 * the isolation suite.
 */
const USER = 1
const VIEWER = { id: USER, timezone: ZONE }

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
  /** Owner. Defaults to USER; the isolation suite passes a second one. */
  user_id?: number
}

/** Inserts a task (and any completions) and returns its id. */
async function addTask(spec: TaskSpec): Promise<number> {
  const [row] = await db
    .insert(schema.tasks)
    .values({
      user_id: spec.user_id ?? USER,
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
    await db
      .insert(schema.completions)
      .values(spec.done_on.map((completed_on) => ({ task_id: id, completed_on })))
      .run()
  }
  return id
}

async function setDay(
  date: ISODate,
  fields: { mood?: string; log?: string; task_order?: number[]; user_id?: number },
): Promise<void> {
  await db
    .insert(schema.days)
    .values({
      user_id: fields.user_id ?? USER,
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
  test('the derived week runs Sunday to Saturday and contains today', async () => {
    expect(dow(SUNDAY)).toBe(0)
    expect(dow(SATURDAY)).toBe(6)
    expect(SUNDAY <= TODAY && TODAY <= SATURDAY).toBe(true)
  })

  test('placeable dates run today through Saturday: 7 on a Sunday, 1 on a Saturday', async () => {
    expect(PLACEABLE[0]).toBe(TODAY)
    expect(PLACEABLE[PLACEABLE.length - 1]).toBe(SATURDAY)
    expect(PLACEABLE.length).toBe(7 - dow(TODAY))
  })
})

// ---------------------------------------------------------------------------
// Day
// ---------------------------------------------------------------------------

describe('buildDayView', () => {
  test('a row carries its category, which Day draws nowhere', async () => {
    await addTask({ name: 'Bins', cadence: 'week', planned_date: TODAY, category: 'Chores' })
    await addTask({ name: 'Stretch', cadence: 'day' })

    const view = await buildDayView(db, VIEWER)
    const bins = view.tasks.find((t) => t.name === 'Bins')
    const stretch = view.tasks.find((t) => t.name === 'Stretch')

    // Nothing on Day renders a category. It is carried because the editor opens
    // from this list as well as from the panel, and the editor edits it — a row
    // that arrived without it would open a form that silently cleared the field.
    expect(bins?.category).toBe('Chores')
    expect(stretch?.category).toBeNull()
  })

  test('D1 REGRESSION — completing an overdue one-off keeps it on the screen', async () => {
    // The defect: membership was a chain of `else if` on isOverdue, which is
    // false once a task is done. Ticking an overdue task dropped it off the
    // screen entirely — no row left to tap to untick, and no other surface able
    // to correct it (the Tracker is read-only).
    // A one-off's period start is unbounded, so this reproduces on any weekday.
    const id = await addTask({
      name: 'Call the vet',
      cadence: null,
      planned_date: shift(TODAY, -3),
      done_on: [TODAY],
    })

    const view = await buildDayView(db, VIEWER)

    expect(ids(view.tasks)).toContain(id)

    const row = view.tasks.find((t) => t.id === id)!
    expect(row.is_done).toBe(true)
    // State is laboured independently of membership; isOverdue is false once
    // done, so a completed overdue task is labelled 'planned'.
    expect(['overdue', 'planned']).toContain(row.state)
  })

  test.skipIf(NO_EARLIER_DAY)(
    'D1 REGRESSION — completing an overdue WEEKLY task keeps it on the screen',
    async () => {
      const past = EARLIER_THIS_WEEK!
      const id = await addTask({
        name: 'Vacuum',
        cadence: 'week',
        planned_date: past,
        done_on: [TODAY],
      })

      const view = await buildDayView(db, VIEWER)

      expect(ids(view.tasks)).toContain(id)
      const row = view.tasks.find((t) => t.id === id)!
      expect(row.is_done).toBe(true)
      expect(['overdue', 'planned']).toContain(row.state)
    },
  )

  test('an overdue task not yet done is on the list and marked overdue', async () => {
    const id = await addTask({
      name: 'Call the vet',
      cadence: null,
      planned_date: shift(TODAY, -3),
    })

    const view = await buildDayView(db, VIEWER)

    expect(ids(view.tasks)).toContain(id)
    expect(view.tasks.find((t) => t.id === id)!.state).toBe('overdue')
  })

  test('a daily task is on the list either way — ticking marks it, not moves it', async () => {
    await addTask({ name: 'Meds', cadence: 'day' })
    await addTask({ name: 'Sleep', cadence: 'day', done_on: [TODAY] })

    const view = await buildDayView(db, VIEWER)

    expect(names(view.tasks)).toEqual(['Meds', 'Sleep'])
    expect(view.tasks.map((t) => t.is_done)).toEqual([false, true])
    // Doneness is a mark, not a state: both rows are still daily.
    expect(view.tasks.map((t) => t.state)).toEqual(['daily', 'daily'])
  })

  test.skipIf(NO_EARLIER_DAY)(
    'a weekly task placed today but completed earlier this week arrives ticked',
    async () => {
      // is_done is PERIOD-SATISFACTION, not same-day: this week's vacuuming is
      // done, whatever day it was ticked.
      const id = await addTask({
        name: 'Vacuum',
        cadence: 'week',
        planned_date: TODAY,
        done_on: [EARLIER_THIS_WEEK!],
      })

      const view = await buildDayView(db, VIEWER)

      const row = view.tasks.find((t) => t.id === id)!
      expect(row.is_done).toBe(true)
      expect(row.state).toBe('planned')
    },
  )

  test.skipIf(NO_EARLIER_DAY)(
    'a weekly task placed AND completed on an earlier day of this week is not a member at all',
    async () => {
      // Neither planned today, nor overdue (it is done), nor ticked today.
      // A completed task stays on Day for the day you ticked it, and
      // no longer — the To do panel answers for the rest of the period.
      const past = EARLIER_THIS_WEEK!
      await addTask({ name: 'Vacuum', cadence: 'week', planned_date: past, done_on: [past] })

      const view = await buildDayView(db, VIEWER)

      expect(view.tasks).toEqual([])
    },
  )

  test('a task placed on a future date is not a member — tomorrow is not today', async () => {
    await addTask({ name: 'Grocery run', cadence: 'week', planned_date: TOMORROW })
    await addTask({ name: 'Book a table', cadence: null, planned_date: TOMORROW })

    const view = await buildDayView(db, VIEWER)

    expect(view.tasks).toEqual([])
  })

  test('an unplaced period task is not a member — it lives in the backlog only', async () => {
    await addTask({ name: 'Grocery run', cadence: 'week' })

    const view = await buildDayView(db, VIEWER)

    expect(view.tasks).toEqual([])
  })

  test('archived tasks appear in no view', async () => {
    await addTask({ name: 'Gone daily', cadence: 'day', active: false })
    await addTask({
      name: 'Gone overdue',
      cadence: null,
      planned_date: shift(TODAY, -3),
      active: false,
    })
    await addTask({ name: 'Gone placed', cadence: 'week', planned_date: TODAY, active: false })
    await addTask({ name: 'Gone ticked', cadence: 'day', active: false, done_on: [TODAY] })

    const day = await buildDayView(db, VIEWER)
    expect(day.tasks).toEqual([])

    expect(day.upcoming.flatMap((u) => u.tasks)).toEqual([])

    const todo = await buildTodoView(db, VIEWER)
    expect(todo.groups.flatMap((g) => g.tasks)).toEqual([])
    expect(todo.has_overdue).toBe(false)

    expect((await buildHistoryView(db, VIEWER, {})).columns).toEqual([])
  })

  test('baseline is the top band and names are alphabetical within a band', async () => {
    await addTask({ name: 'Apple', cadence: 'day' })
    await addTask({ name: 'Banana', cadence: 'day' })
    await addTask({ name: 'Zebra', cadence: 'day', is_baseline: true })

    expect(names((await buildDayView(db, VIEWER)).tasks)).toEqual(['Zebra', 'Apple', 'Banana'])
  })

  test('days.task_order is respected, and never moves a task across the baseline band', async () => {
    const apple = await addTask({ name: 'Apple', cadence: 'day' })
    const banana = await addTask({ name: 'Banana', cadence: 'day' })
    await addTask({ name: 'Zebra', cadence: 'day', is_baseline: true })
    // Zebra is listed last but is baseline, so it still leads.
    await setDay(TODAY, { task_order: [banana, apple] })

    expect(names((await buildDayView(db, VIEWER)).tasks)).toEqual(['Zebra', 'Banana', 'Apple'])
  })

  test('done rows sink to the bottom of the one list, baseline included', async () => {
    await addTask({ name: 'Apple', cadence: 'day', done_on: [TODAY] })
    await addTask({ name: 'Banana', cadence: 'day' })
    await addTask({ name: 'Zebra', cadence: 'day', is_baseline: true, done_on: [TODAY] })

    const view = await buildDayView(db, VIEWER)
    // Zebra is baseline and would lead the list, but it is ticked: done outranks
    // baseline, and baseline then leads inside the done band.
    expect(names(view.tasks)).toEqual(['Banana', 'Zebra', 'Apple'])
    expect(view.tasks.map((t) => t.is_done)).toEqual([false, true, true])
  })

  test('the arrangement covers the done rows too, so tick and untick returns a task', async () => {
    const apple = await addTask({ name: 'Apple', cadence: 'day' })
    const banana = await addTask({ name: 'Banana', cadence: 'day', done_on: [TODAY] })
    const cherry = await addTask({ name: 'Cherry', cadence: 'day', done_on: [TODAY] })
    // The client saves the whole rendered list — the live rows it dragged, then
    // the done ones after them. Both halves are read back here.
    await setDay(TODAY, { task_order: [apple, cherry, banana] })

    const view = await buildDayView(db, VIEWER)
    expect(names(view.tasks)).toEqual(['Apple', 'Cherry', 'Banana'])
  })

  test('mood, log and the picker come off the sparse days row', async () => {
    const bare = await buildDayView(db, VIEWER)
    expect(bare.date).toBe(TODAY)
    expect(bare.mood).toBeNull()
    expect(bare.log).toBeNull()
    // Active moods only, in sort_order — the retired one is not in the picker.
    expect(bare.moods.map((m) => m.slug)).toEqual(['balanced', 'happy'])

    await setDay(TODAY, { mood: 'happy', log: 'a good one' })
    const view = await buildDayView(db, VIEWER)
    expect(view.mood).toBe('happy')
    expect(view.log).toBe('a good one')
  })

  test('placeable_dates is today through Saturday, so Day never fetches the Week model', async () => {
    expect((await buildDayView(db, VIEWER)).placeable_dates).toEqual(PLACEABLE)
  })
})

// ---------------------------------------------------------------------------
// Placement — how far ahead each cadence may be placed
//
// `placementMax` is pure, so these use FIXED dates rather than today(). That is
// the exception this file otherwise forbids, and it is the point: the union rule
// only shows its teeth on a week that straddles a month boundary, which cannot
// be reached by deriving from an arbitrary today.
// ---------------------------------------------------------------------------

describe('placementMax', () => {
  // Tue 8 Sep 2026. Its week is Sun 6 Sep – Sat 12 Sep, wholly inside September.
  const MIDMONTH: ISODate = '2026-09-08'
  // Tue 29 Sep 2026. Its week is Sun 27 Sep – Sat 3 OCT: it straddles.
  const STRADDLE: ISODate = '2026-09-29'

  test('a weekly task may be placed to Saturday and no further', () => {
    // Its period IS the week, so the two halves of the union agree exactly.
    expect(placementMax(MIDMONTH, 'week')).toBe('2026-09-12')
    expect(placementMax(STRADDLE, 'week')).toBe('2026-10-03')
  })

  test('a monthly task gets the rest of its month', () => {
    expect(placementMax(MIDMONTH, 'month')).toBe('2026-09-30')
  })

  test('a quarterly task gets the rest of its quarter', () => {
    expect(placementMax(MIDMONTH, 'quarter')).toBe('2026-09-30')
  })

  test('a yearly task gets the rest of its year', () => {
    expect(placementMax(MIDMONTH, 'year')).toBe('2026-12-31')
    expect(placementMax(STRADDLE, 'year')).toBe('2026-12-31')
  })

  test('a one-off has no far edge at all', () => {
    // Its period is unbounded, so there is nothing to fall out of.
    expect(placementMax(MIDMONTH, null)).toBeNull()
    expect(placementMax(STRADDLE, null)).toBeNull()
  })

  test('the week half wins where it reaches past the period', () => {
    // THE REASON THIS IS A UNION. In the week of Sun 27 Sep – Sat 3 Oct, a
    // monthly task may still be placed on 2 October: `period.ts` documents that
    // exact case as why rollover is backward-only, and bounding by the period
    // alone (30 September) would have taken it away.
    expect(placementMax(STRADDLE, 'month')).toBe('2026-10-03')
    expect(placementMax(STRADDLE, 'quarter')).toBe('2026-10-03')
  })

  test('the max is never before the last day the picker offers a chip for', () => {
    for (const day of ['2026-09-06', '2026-09-08', '2026-09-29', '2026-10-03', '2026-12-31']) {
      const saturday = placeableDates(day).at(-1)!
      for (const cadence of ['week', 'month', 'quarter', 'year'] as const) {
        const max = placementMax(day, cadence)!
        expect(max >= saturday, `${cadence} on ${day}: ${max} vs ${saturday}`).toBe(true)
      }
    }
  })
})

describe('the placement ranges the views ship', () => {
  test('one entry per placeable cadence, and never one for day', () => {
    const ranges = placementRanges(TODAY)
    expect(ranges.map((r) => r.cadence)).toEqual(['week', 'month', 'quarter', 'year', null])
    // A daily task is never placed, so it has no range to offer.
    expect(ranges.some((r) => r.cadence === 'day')).toBe(false)
  })

  test('every range starts today, and matches placementMax', () => {
    for (const r of placementRanges(TODAY)) {
      expect(r.min).toBe(TODAY)
      expect(r.max).toBe(placementMax(TODAY, r.cadence))
    }
  })

  test('Day and Todo ship the same ranges', async () => {
    // Two screens, one picker, one rule. They come from one derivation, so this
    // asserts the plumbing rather than the arithmetic.
    const [day, todo] = [await buildDayView(db, VIEWER), await buildTodoView(db, VIEWER)]
    expect(day.placement).toEqual(todo.placement)
    expect(day.placement).toEqual(placementRanges(TODAY))
  })
})

// ---------------------------------------------------------------------------
// Upcoming — the future panes, which replaced the Week view in v8
// ---------------------------------------------------------------------------

/** On a Saturday there is no later day in this week at all. */
const NO_FUTURE_DAY = dow(TODAY) === 6

/**
 * NEXT week's seven days, and one in the middle of it.
 *
 * These are what let most of the block below stop caring what day it is. Before
 * v16 a future pane had to be found inside THIS week, which a Saturday does not
 * have — so eight tests were gated on the weekday and skipped one run in seven.
 * `buildDayView` now takes the week to look at, so a future pane is asked for
 * rather than waited for.
 */
const NEXT_WEEK: ISODate[] = Array.from({ length: 7 }, (_, i) => shift(SUNDAY, 7 + i))
const LATER_DAY: ISODate = NEXT_WEEK[3]!

/**
 * The first of next month — always after today, so always a pane of its own
 * week. It is what proves doneness is asked about the pane's period rather than
 * today's, and it needs no gate: every date has a next month.
 */
const FIRST_OF_NEXT_MONTH: ISODate = (() => {
  const year = Number(TODAY.slice(0, 4))
  const month = Number(TODAY.slice(5, 7))
  return month === 12 ? `${year + 1}-01-01` : `${year}-${String(month + 1).padStart(2, '0')}-01`
})()

/**
 * The rule `buildUpcoming` turns on: doneness is asked about THE PANE'S OWN
 * DATE, not about today.
 *
 * Its integration test below now runs on every day of the year, because the week
 * is a parameter. This still pins the distinction on fixed dates, which is worth
 * keeping: it names the September/October pair the rule was written for, where
 * the integration test only names whatever month follows the one it runs in.
 */
describe('doneness at a period boundary', () => {
  const monthly = {
    id: 1,
    user_id: USER,
    name: 'Change the filter',
    is_baseline: false,
    cadence: 'month' as const,
    planned_date: '2026-10-01',
    color: null,
    category: null,
    active: true,
  }
  const doneInSeptember = [{ task_id: 1, completed_on: '2026-09-15' }]

  test('a monthly task done in September is not done for an October pane', () => {
    // Today is Tue 29 Sep; the pane is Thu 1 Oct, inside the same WEEK and a
    // different MONTH. The two questions give opposite answers.
    expect(isDone(monthly, doneInSeptember, '2026-09-29')).toBe(true)
    expect(isDone(monthly, doneInSeptember, '2026-10-01')).toBe(false)
  })

  test('so asking about today would hide an obligation that is unmet', () => {
    // If buildUpcoming passed `today` here, October's pane would filter the task
    // out as already done — and October's turn would never be asked for.
    const asToday = isDone(monthly, doneInSeptember, '2026-09-29')
    const asPane = isDone(monthly, doneInSeptember, '2026-10-01')
    expect(asToday).not.toBe(asPane)
  })
})

describe('DayView.upcoming', () => {
  test('one entry per day from tomorrow through Saturday', async () => {
    const view = await buildDayView(db, VIEWER)
    expect(view.upcoming.map((u) => u.date)).toEqual(PLACEABLE.slice(1))
  })

  test('this week, the panes and the day picker still coincide', async () => {
    // They came from ONE derivation until v16, so they could not drift apart.
    // Paging separated them — the panes follow the viewed week, the chips stay
    // bounded from today — and on this week they must still agree, or the button
    // you press and the pane you land on have parted company.
    const view = await buildDayView(db, VIEWER)
    expect(view.panes).toEqual(view.placeable_dates)
    expect([view.date, ...view.upcoming.map((u) => u.date)]).toEqual(view.panes)
  })

  test.skipIf(!NO_FUTURE_DAY)('is empty on a Saturday', async () => {
    expect((await buildDayView(db, VIEWER)).upcoming).toEqual([])
  })

  test('a task placed on a future day is on that day, and not on today', async () => {
    await addTask({ name: 'Grocery run', cadence: null, planned_date: LATER_DAY })

    const view = await buildDayView(db, VIEWER, LATER_DAY)
    const pane = view.upcoming.find((u) => u.date === LATER_DAY)!
    expect(pane.tasks.map((t) => t.name)).toEqual(['Grocery run'])
    // Next week's plan is not today's business, whichever week is on screen.
    expect(view.tasks).toEqual([])
  })

  test('a future row is planned, and dated the pane it is on', async () => {
    await addTask({ name: 'Grocery run', cadence: null, planned_date: LATER_DAY })

    const view = await buildDayView(db, VIEWER, LATER_DAY)
    const [task] = view.upcoming.find((u) => u.date === LATER_DAY)!.tasks
    expect(task!.state).toBe('planned')
    expect(task!.effective_date).toBe(LATER_DAY)
    expect(task!.planned_date).toBe(LATER_DAY)
  })

  test('daily tasks never appear on a future pane', async () => {
    await addTask({ name: 'Feed Barney', cadence: 'day' })
    await addTask({ name: 'Take pills', cadence: 'day', is_baseline: true })

    const view = await buildDayView(db, VIEWER)
    // Not by a filter: a daily task can never hold a planned_date, so no pane
    // can match one. Asserted anyway, because that is the load-bearing bit.
    expect(view.upcoming.flatMap((u) => u.tasks)).toEqual([])
    expect(view.tasks.map((t) => t.name).sort()).toEqual(['Feed Barney', 'Take pills'])
  })

  test('a task with no day appears on no pane', async () => {
    await addTask({ name: 'Call the vet', cadence: null })
    expect((await buildDayView(db, VIEWER)).upcoming.flatMap((u) => u.tasks)).toEqual([])
  })

  test.skipIf(NO_EARLIER_DAY)('a task placed earlier this week appears on no pane', async () => {
    await addTask({ name: 'Call the vet', cadence: null, planned_date: EARLIER_THIS_WEEK! })
    // It is overdue, so it is on TODAY's pane — the panes start at today and a
    // past day is not one of them.
    const view = await buildDayView(db, VIEWER)
    expect(view.upcoming.flatMap((u) => u.tasks)).toEqual([])
    expect(view.tasks.map((t) => t.state)).toEqual(['overdue'])
  })

  test('a task already satisfied for its period is dropped, not struck through', async () => {
    // Placed next week, ticked today: a one-off's period is unbounded, so the
    // obligation is met and the pane carries no load. The row is simply absent
    // rather than present and struck through — the panes are read for load.
    await addTask({ name: 'Grocery run', cadence: null, planned_date: LATER_DAY, done_on: [TODAY] })

    const view = await buildDayView(db, VIEWER, LATER_DAY)
    expect(view.upcoming.flatMap((u) => u.tasks)).toEqual([])
  })

  test("doneness is asked about the pane period, not today's", async () => {
    // A monthly task placed in NEXT month and completed in THIS one. It is done
    // for today's period and NOT for the pane's, so it must still be shown:
    // asking with today's date would hide an obligation that is unmet.
    await addTask({
      name: 'Change the filter',
      cadence: 'month',
      planned_date: FIRST_OF_NEXT_MONTH,
      done_on: [TODAY],
    })

    const view = await buildDayView(db, VIEWER, FIRST_OF_NEXT_MONTH)
    const pane = view.upcoming.find((u) => u.date === FIRST_OF_NEXT_MONTH)!
    expect(pane.tasks.map((t) => t.name)).toEqual(['Change the filter'])
  })

  test('a pane is sorted baseline first, then by name', async () => {
    await addTask({ name: 'Zebra', cadence: null, planned_date: LATER_DAY })
    await addTask({ name: 'Apple', cadence: null, planned_date: LATER_DAY })
    await addTask({ name: 'Middle', cadence: null, planned_date: LATER_DAY, is_baseline: true })

    const view = await buildDayView(db, VIEWER, LATER_DAY)
    const pane = view.upcoming.find((u) => u.date === LATER_DAY)!
    expect(pane.tasks.map((t) => t.name)).toEqual(['Middle', 'Apple', 'Zebra'])
  })

  test('colour is carried on a future row, baseline only', async () => {
    await addTask({
      name: 'Painted',
      cadence: null,
      planned_date: LATER_DAY,
      is_baseline: true,
      color: '#aabbcc',
    })
    await addTask({
      name: 'Unpainted',
      cadence: null,
      planned_date: LATER_DAY,
      color: '#ddeeff',
    })

    const view = await buildDayView(db, VIEWER, LATER_DAY)
    const pane = view.upcoming.find((u) => u.date === LATER_DAY)!
    expect(pane.tasks.map((t) => [t.name, t.color])).toEqual([
      ['Painted', '#aabbcc'],
      ['Unpainted', null],
    ])
  })
})

// ---------------------------------------------------------------------------
// The viewed week — and the fields that must NOT follow it
// ---------------------------------------------------------------------------

describe('buildDayView for a later week', () => {
  test("date and tasks stay today's, whatever week is on screen", async () => {
    await addTask({ name: 'Meds', cadence: 'day' })
    await addTask({ name: 'Grocery run', cadence: null, planned_date: LATER_DAY })

    const view = await buildDayView(db, VIEWER, LATER_DAY)
    // Paging is a READ and moves the panes only. Every write still lands on
    // today, so the model still has to say which day that is and what is on it.
    expect(view.date).toBe(TODAY)
    expect(names(view.tasks)).toEqual(['Meds'])
  })

  test('week_dates is the viewed week, and every one of its days is a pane', async () => {
    const view = await buildDayView(db, VIEWER, LATER_DAY)
    expect(view.week_dates).toEqual(NEXT_WEEK)
    // No day of a later week has happened, so none is dropped — unlike this
    // week, where the panes start at today and the past belongs to the Tracker.
    expect(view.panes).toEqual(NEXT_WEEK)
    // And none of them is today, so `upcoming` is the whole of it.
    expect(view.upcoming.map((u) => u.date)).toEqual(NEXT_WEEK)
  })

  test('any date inside a week names that week', async () => {
    expect((await buildDayView(db, VIEWER, NEXT_WEEK[0]!)).week_dates).toEqual(NEXT_WEEK)
    expect((await buildDayView(db, VIEWER, NEXT_WEEK[6]!)).week_dates).toEqual(NEXT_WEEK)
  })

  test('naming this week is the same as naming none', async () => {
    await addTask({ name: 'Grocery run', cadence: null, planned_date: TODAY })
    expect(await buildDayView(db, VIEWER, TODAY)).toEqual(await buildDayView(db, VIEWER))
    expect(await buildDayView(db, VIEWER, SATURDAY)).toEqual(await buildDayView(db, VIEWER))
  })

  test('THE TRAP — placement does not follow the paging', async () => {
    // If it did, a weekly task could be placed outside its own week. And
    // `effectiveDate` is backward-only, so such a task would be neither overdue,
    // nor unplaced, nor done: its obligation would go unmet every period with
    // nothing on any screen saying so. Ten weeks out changes neither field.
    const far = await buildDayView(db, VIEWER, shift(SUNDAY, 70))
    expect(far.placeable_dates).toEqual(PLACEABLE)
    expect(far.placement).toEqual(placementRanges(TODAY))
  })
})

describe('DayView.last_placed', () => {
  test('is the furthest planned date there is', async () => {
    await addTask({ name: 'Soon', cadence: null, planned_date: TODAY })
    await addTask({ name: 'Later', cadence: null, planned_date: LATER_DAY })
    await addTask({ name: 'Never', cadence: 'day' })

    expect((await buildDayView(db, VIEWER)).last_placed).toBe(LATER_DAY)
  })

  test('is null when nothing is placed at all', async () => {
    await addTask({ name: 'Meds', cadence: 'day' })
    await addTask({ name: 'Someday', cadence: null })

    // Which is what leaves a Saturday one pane and two dead arrows, exactly as
    // before v16: paging reaches work you have scheduled, and there is none.
    expect((await buildDayView(db, VIEWER)).last_placed).toBeNull()
  })

  test('ignores archived tasks', async () => {
    await addTask({ name: 'Live', cadence: null, planned_date: TODAY })
    await addTask({ name: 'Gone', cadence: null, planned_date: LATER_DAY, active: false })

    // An archived task is on no screen, so counting it would offer a page
    // forward into a week with nothing in it and no way back to knowing why.
    expect((await buildDayView(db, VIEWER)).last_placed).toBe(TODAY)
  })
})

// ---------------------------------------------------------------------------
// To do
// ---------------------------------------------------------------------------

const GROUP_ORDER: ReadonlyArray<Cadence | null> = TODO_GROUPS.map((g) => g.cadence)

describe('TODO_GROUPS', () => {
  test('one-off leads the six, and the titles are cadence adjectives', () => {
    // One constant drives the server's group order AND the strip's buttons, so
    // both halves are pinned here. 'Any time' is a LABEL: the model word for
    // `cadence: null` is still one-off.
    expect(TODO_GROUPS.map((g) => [g.cadence, g.title])).toEqual([
      [null, 'Any time'],
      ['day', 'Daily'],
      ['week', 'Weekly'],
      ['month', 'Monthly'],
      ['quarter', 'Quarterly'],
      ['year', 'Yearly'],
    ])
  })
})

describe('buildTodoView', () => {
  test('always six groups in TODO_GROUPS order, even when the database is empty', async () => {
    const view = await buildTodoView(db, VIEWER)

    expect(view.groups.length).toBe(6)
    // One-off leads the six since v15: it is where capture lands, so it is not
    // the group at the far end of the track.
    expect(view.groups.map((g) => g.cadence)).toEqual([
      null,
      'day',
      'week',
      'month',
      'quarter',
      'year',
    ])
    expect(view.groups.map((g) => g.cadence)).toEqual([...GROUP_ORDER])
    expect(view.groups.every((g) => g.tasks.length === 0)).toBe(true)
    expect(view.today).toBe(TODAY)
    expect(view.has_overdue).toBe(false)
  })

  test('six groups still, once every cadence has a task', async () => {
    for (const cadence of GROUP_ORDER) await addTask({ name: `A ${cadence}`, cadence })

    const view = await buildTodoView(db, VIEWER)
    expect(view.groups.map((g) => g.cadence)).toEqual([...GROUP_ORDER])
    expect(view.groups.every((g) => g.tasks.length === 1)).toBe(true)
    expect(view.groups.every((g) => g.tasks[0]!.cadence === g.cadence)).toBe(true)
  })

  test('period_start and period_end are the current period, and null for one-offs', async () => {
    const y = Number(TODAY.slice(0, 4))
    const m = Number(TODAY.slice(5, 7))
    const q1 = Math.floor((m - 1) / 3) * 3 + 1 // first month of this quarter

    const expected: Record<string, [ISODate | null, ISODate | null]> = {
      day: [TODAY, TODAY],
      week: [SUNDAY, SATURDAY],
      month: [`${TODAY.slice(0, 7)}-01`, lastDayOfMonth(y, m)],
      quarter: [`${y}-${String(q1).padStart(2, '0')}-01`, lastDayOfMonth(y, q1 + 2)],
      year: [`${y}-01-01`, `${y}-12-31`],
      once: [null, null],
    }

    for (const g of (await buildTodoView(db, VIEWER)).groups) {
      const [start, end] = expected[g.cadence ?? 'once']!
      expect([g.cadence, g.period_start]).toEqual([g.cadence, start])
      expect([g.cadence, g.period_end]).toEqual([g.cadence, end])
    }
  })

  test('a group holds every active task of its cadence — placed or not, done or not', async () => {
    // Membership does not change as the week goes on; only the marks do.
    await addTask({ name: 'Unplaced', cadence: 'week' })
    await addTask({ name: 'Placed', cadence: 'week', planned_date: TODAY })
    await addTask({ name: 'Done', cadence: 'week', done_on: [SUNDAY] })
    await addTask({
      name: 'Placed and done',
      cadence: 'week',
      planned_date: TODAY,
      done_on: [TODAY],
    })

    const week = groupFor(await buildTodoView(db, VIEWER), 'week')
    expect(await names(week.tasks).sort()).toEqual([
      'Done',
      'Placed',
      'Placed and done',
      'Unplaced',
    ])
  })

  test('marks: is_done, is_overdue and effective_date ride on the row', async () => {
    await addTask({ name: 'Overdue', cadence: null, planned_date: shift(TODAY, -3) })
    await addTask({ name: 'Struck', cadence: 'month', done_on: [TODAY] })
    await addTask({ name: 'Placed', cadence: 'month', planned_date: TODAY })

    const view = await buildTodoView(db, VIEWER)

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

  test('is_done is read against the task OWN cadence, not the day', async () => {
    // A monthly ticked earlier this month is done; a weekly ticked last week is not.
    await addTask({ name: 'Monthly', cadence: 'month', done_on: [`${TODAY.slice(0, 7)}-01`] })
    await addTask({ name: 'Weekly', cadence: 'week', done_on: [shift(SUNDAY, -1)] })

    const view = await buildTodoView(db, VIEWER)
    expect(groupFor(view, 'month').tasks[0]!.is_done).toBe(true)
    expect(groupFor(view, 'week').tasks[0]!.is_done).toBe(false)
  })

  test('a one-off completed THIS week is present and struck through', async () => {
    await addTask({ name: 'Fix the gate', cadence: null, done_on: [SUNDAY] })

    const once = groupFor(await buildTodoView(db, VIEWER), null)
    expect(await names(once.tasks)).toEqual(['Fix the gate'])
    expect(once.tasks[0]!.is_done).toBe(true)
  })

  test('a one-off completed BEFORE this week is gone entirely', async () => {
    await addTask({ name: 'Fix the gate', cadence: null, done_on: [shift(SUNDAY, -1)] })
    await addTask({ name: 'Call the vet', cadence: null })

    const view = await buildTodoView(db, VIEWER)
    expect(await names(groupFor(view, null).tasks)).toEqual(['Call the vet'])
    // And it is gone from the whole model, not merely from its group.
    expect(await names(view.groups.flatMap((g) => g.tasks))).not.toContain('Fix the gate')
  })

  test('a RECURRING task completed before this period is never dropped — only one-offs are', async () => {
    await addTask({ name: 'Vacuum', cadence: 'week', done_on: [shift(SUNDAY, -1)] })

    const week = groupFor(await buildTodoView(db, VIEWER), 'week')
    expect(await names(week.tasks)).toEqual(['Vacuum'])
    expect(week.tasks[0]!.is_done).toBe(false)
  })

  test('order: overdue, then placed, then unplaced, then done — never alphabetical', async () => {
    // Every band is seeded with the name that alphabetical order would put in
    // the opposite position, so a sort that ignores the bands cannot pass.
    await addTask({ name: 'Zebra', cadence: null, planned_date: shift(TODAY, -3) }) // band 1 overdue
    await addTask({ name: 'Yak', cadence: null, planned_date: TODAY }) // band 2 placed
    await addTask({ name: 'Xray', cadence: null }) // band 3 no day
    await addTask({ name: 'Apple', cadence: null, done_on: [TODAY] }) // band 4 done
    await addTask({ name: 'Bison', cadence: null, planned_date: TODAY, done_on: [TODAY] }) // band 4 done

    const once = groupFor(await buildTodoView(db, VIEWER), null)
    expect(await names(once.tasks)).toEqual(['Zebra', 'Yak', 'Xray', 'Apple', 'Bison'])
  })

  test('a done task sinks below an unplaced one, and below a placed one', async () => {
    // Band 4 wins over the others: done sinks whether or not it has a day.
    await addTask({ name: 'Apple', cadence: 'week', done_on: [TODAY] })
    await addTask({ name: 'Beetle', cadence: 'week', planned_date: TODAY, done_on: [TODAY] })
    await addTask({ name: 'Zebra', cadence: 'week' })
    await addTask({ name: 'Yak', cadence: 'week', planned_date: TODAY })

    expect(await names(groupFor(await buildTodoView(db, VIEWER), 'week').tasks)).toEqual([
      'Yak', // placed
      'Zebra', // no day
      'Apple', // done
      'Beetle', // done
    ])
  })

  test('names are alphabetical within a band', async () => {
    await addTask({ name: 'Zebra', cadence: 'year' })
    await addTask({ name: 'Apple', cadence: 'year' })
    await addTask({ name: 'Mongoose', cadence: 'year' })

    expect(await names(groupFor(await buildTodoView(db, VIEWER), 'year').tasks)).toEqual([
      'Apple',
      'Mongoose',
      'Zebra',
    ])
  })

  test('daily tasks are in the panel even though they are never in Week', async () => {
    await addTask({ name: 'Meds', cadence: 'day', done_on: [TODAY] })
    await addTask({ name: 'Sleep', cadence: 'day' })

    const day = groupFor(await buildTodoView(db, VIEWER), 'day')
    expect(await names(day.tasks)).toEqual(['Sleep', 'Meds']) // not done, then done
    expect(day.tasks[1]!.is_done).toBe(true)
  })

  test('has_overdue is true when ANY group holds an overdue task', async () => {
    expect((await buildTodoView(db, VIEWER)).has_overdue).toBe(false)

    // A one-off's period start is unbounded, which is what makes it overdue on
    // every calendar date — including 1 January, where no recurring cadence can
    // be: yesterday is behind the year, quarter and month period starts, so
    // effective_date is null and there is no debt to carry. v15 moved this group
    // to the FRONT of the six, so the recurring case below is now the one that
    // proves has_overdue scans past the first group.
    await addTask({ name: 'Call the vet', cadence: null, planned_date: shift(TODAY, -1) })
    const view = await buildTodoView(db, VIEWER)
    expect(view.has_overdue).toBe(true)
    expect(groupFor(view, null).tasks[0]!.is_overdue).toBe(true)
  })

  test.skipIf(NO_EARLIER_DAY)('has_overdue picks up a RECURRING task too', async () => {
    await addTask({ name: 'Vacuum', cadence: 'week', planned_date: EARLIER_THIS_WEEK! })

    const view = await buildTodoView(db, VIEWER)
    expect(view.has_overdue).toBe(true)
    expect(groupFor(view, 'week').tasks[0]!.is_overdue).toBe(true)
  })

  test('placeable_dates matches Day exactly', async () => {
    const todo = await buildTodoView(db, VIEWER)
    expect(todo.placeable_dates).toEqual(PLACEABLE)
    expect(todo.placeable_dates).toEqual((await buildDayView(db, VIEWER)).placeable_dates)
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
  test('columns are ACTIVE DAILY tasks only, in sort order', async () => {
    await addTask({ name: 'Zebra', cadence: 'day', is_baseline: true })
    await addTask({ name: 'Apple', cadence: 'day' })
    await addTask({ name: 'Weekly', cadence: 'week' })
    await addTask({ name: 'One-off', cadence: null })
    await addTask({ name: 'Archived', cadence: 'day', active: false })

    expect((await buildHistoryView(db, VIEWER, {})).columns.map((c) => c.name)).toEqual([
      'Zebra',
      'Apple',
    ])
  })

  test('every date in range gets a row, including days with nothing recorded', async () => {
    const id = await addTask({ name: 'Meds', cadence: 'day', done_on: [TODAY, shift(TODAY, -3)] })

    const view = await buildHistoryView(db, VIEWER, {})

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

  test('a mood is resolved to the object, retired moods included', async () => {
    await addTask({ name: 'Meds', cadence: 'day', done_on: [shift(TODAY, -1)] })
    await setDay(TODAY, { mood: 'retired' })

    const view = await buildHistoryView(db, VIEWER, {})
    expect(view.rows[0]!.mood?.slug).toBe('retired')
    expect(view.rows[0]!.mood?.emoji).toBe('👻')
    expect(view.rows[0]!.mood?.active).toBe(false)
    expect(view.rows[1]!.mood).toBeNull()
  })

  test('limit pages backwards and next_before is null only when exhausted', async () => {
    await addTask({ name: 'Meds', cadence: 'day', done_on: [TODAY, shift(TODAY, -4)] })

    const first = await buildHistoryView(db, VIEWER, { limit: 2 })
    expect(first.rows.map((r) => r.date)).toEqual([TODAY, shift(TODAY, -1)])
    expect(first.next_before).toBe(shift(TODAY, -1))

    // `before` is exclusive.
    const second = await buildHistoryView(db, VIEWER, { limit: 10, before: first.next_before! })
    expect(second.rows.map((r) => r.date)).toEqual([
      shift(TODAY, -2),
      shift(TODAY, -3),
      shift(TODAY, -4),
    ])
    expect(second.next_before).toBeNull()
  })

  test('an empty database has columns but no rows', async () => {
    await addTask({ name: 'Meds', cadence: 'day' })

    const view = await buildHistoryView(db, VIEWER, {})
    expect(view.columns.length).toBe(1)
    expect(view.rows).toEqual([])
    expect(view.next_before).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// A rolled-over placement shows no day, and sits in the unplaced band.
// "A date that has fallen out the back of its period is simply
// not there." Rollover is a read — nothing ever clears planned_date — so the
// raw column still holds last period's date and must not be rendered.
// ---------------------------------------------------------------------------

describe('todo — rolled-over placements', () => {
  test('a weekly task placed in a past week shows no day and is not overdue', async () => {
    const lastWeek = shift(SUNDAY, -5) // firmly inside the previous week
    const id = await addTask({ name: 'Vacuum', cadence: 'week', planned_date: lastWeek })

    const row = groupFor(await buildTodoView(db, VIEWER), 'week').tasks.find((x) => x.id === id)!

    // The column still holds it — rollover never writes.
    const stored = (await db.select().from(schema.tasks)).find((t) => t.id === id)!
    expect(stored.planned_date).toBe(lastWeek)

    // The panel does not.
    expect(row.effective_date).toBeNull()
    expect(row.is_overdue).toBe(false)
    expect(row.is_done).toBe(false)
  })

  test('a one-off placed long ago keeps its day, because its period is unbounded', async () => {
    const longAgo = shift(TODAY, -40)
    const id = await addTask({ name: 'Call vet', cadence: null, planned_date: longAgo })
    const row = groupFor(await buildTodoView(db, VIEWER), null).tasks.find((x) => x.id === id)!
    expect(row.effective_date).toBe(longAgo)
    expect(row.is_overdue).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Category — ordering inside a To do group.
// The full rule is: band → baseline → category (uncategorised last) → name.
// ---------------------------------------------------------------------------

describe('todo — categories', () => {
  const names = async (cadence: Cadence | null) =>
    groupFor(await buildTodoView(db, VIEWER), cadence).tasks.map((t) => t.name)

  test('category outranks name, so a category groups against the alphabet', async () => {
    // Alphabetically this is Aardvark, Brush, Feed. By category it is Dog first.
    await addTask({ name: 'Aardvark admin', cadence: 'day', category: 'House' })
    await addTask({ name: 'Feed Barney 1', cadence: 'day', category: 'Dog' })
    await addTask({ name: 'Brush Ringo', cadence: 'day', category: 'Dog' })

    expect(await names('day')).toEqual(['Brush Ringo', 'Feed Barney 1', 'Aardvark admin'])
  })

  test('uncategorised sorts last, whatever its name', async () => {
    await addTask({ name: 'Aaa loose end', cadence: 'day' })
    await addTask({ name: 'Zzz filed', cadence: 'day', category: 'House' })

    expect(await names('day')).toEqual(['Zzz filed', 'Aaa loose end'])
  })

  test('baseline outranks category: it leads the group, above every heading', async () => {
    // The baseline task is in a category that would otherwise sort LAST, and has
    // a name that would otherwise sort last too — so only the flag can lift it.
    await addTask({ name: 'Zzz vital', cadence: 'day', is_baseline: true, category: 'Zebra' })
    await addTask({ name: 'Aaa chore', cadence: 'day', category: 'Admin' })

    expect(await names('day')).toEqual(['Zzz vital', 'Aaa chore'])
  })

  test('done still sinks, below every category', async () => {
    await addTask({ name: 'Aaa done', cadence: 'day', category: 'Admin', done_on: [TODAY] })
    await addTask({ name: 'Zzz pending', cadence: 'day', category: 'Zebra' })

    expect(await names('day')).toEqual(['Zzz pending', 'Aaa done'])
  })

  test('categories in use are distinct, sorted, and exclude the uncategorised', async () => {
    await addTask({ name: 'a', cadence: 'day', category: 'House' })
    await addTask({ name: 'b', cadence: 'day', category: 'Dog' })
    await addTask({ name: 'c', cadence: 'week', category: 'Dog' })
    await addTask({ name: 'd', cadence: 'day' })

    expect((await buildTodoView(db, VIEWER)).categories).toEqual(['Dog', 'House'])
  })

  test('an archived task contributes no category', async () => {
    await addTask({ name: 'gone', cadence: 'day', category: 'Ghost', active: false })
    await addTask({ name: 'here', cadence: 'day', category: 'House' })

    expect((await buildTodoView(db, VIEWER)).categories).toEqual(['House'])
  })

  test('exact matching means Dog and dog are two categories', async () => {
    // A known and accepted cost of free text — pinned so it is a decision
    // rather than a surprise.
    await addTask({ name: 'a', cadence: 'day', category: 'Dog' })
    await addTask({ name: 'b', cadence: 'day', category: 'dog' })

    expect((await buildTodoView(db, VIEWER)).categories).toHaveLength(2)
  })
})

// ---------------------------------------------------------------------------
// History — columns in the same order as the To do panel, and the day's log.
// ---------------------------------------------------------------------------

describe('history — columns and log', () => {
  test('columns order by baseline, then category, then name — as the panel does', async () => {
    // Alphabetically: Aardvark < Brush < Dishes < Zzz. By the real rule the
    // baseline task leads despite its name, then Dog, then House, then none.
    await addTask({ name: 'Zzz vital', cadence: 'day', is_baseline: true, category: 'Zebra' })
    await addTask({ name: 'Aardvark chore', cadence: 'day', category: 'House' })
    await addTask({ name: 'Brush Ringo', cadence: 'day', category: 'Dog' })
    await addTask({ name: 'Dishes', cadence: 'day' })

    const names = (await buildHistoryView(db, VIEWER, {})).columns.map((c) => c.name)
    expect(names).toEqual(['Zzz vital', 'Brush Ringo', 'Aardvark chore', 'Dishes'])

    // And the panel agrees — one comparator, so they cannot drift apart.
    const panel = groupFor(await buildTodoView(db, VIEWER), 'day').tasks.map((t) => t.name)
    expect(panel).toEqual(names)
  })

  test("a row carries that day's log, and null when there is none", async () => {
    await addTask({ name: 'MED', cadence: 'day' })
    await setDay(TODAY, { log: 'Long day.\nThe gate is fixed.' })

    const rows = (await buildHistoryView(db, VIEWER, {})).rows
    const todayRow = rows.find((r) => r.date === TODAY)!
    expect(todayRow.log).toBe('Long day.\nThe gate is fixed.')
    for (const r of rows.filter((r) => r.date !== TODAY)) expect(r.log).toBeNull()
  })

  test('an empty log reads as no log, not as an empty entry', async () => {
    await addTask({ name: 'MED', cadence: 'day' })
    await setDay(TODAY, { log: '' })

    expect(
      (await buildHistoryView(db, VIEWER, {})).rows.find((r) => r.date === TODAY)!.log,
    ).toBeNull()
  })
})

describe('history — column colour', () => {
  test('a baseline column carries its colour; a non-baseline one never does', async () => {
    await addTask({ name: 'MED', cadence: 'day', is_baseline: true, color: '#c2410c' })
    // Same colour stored, but not baseline — the view must not ship it.
    await addTask({ name: 'Zebra', cadence: 'day', is_baseline: false, color: '#c2410c' })
    await addTask({ name: 'Plain', cadence: 'day', is_baseline: true })

    const cols = (await buildHistoryView(db, VIEWER, {})).columns
    const by = (n: string) => cols.find((c) => c.name === n)!
    expect(by('MED').color).toBe('#c2410c')
    expect(by('Zebra').color).toBeNull()
    expect(by('Plain').color).toBeNull()
  })
})
