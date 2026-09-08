import { test, expect, describe } from 'bun:test'
import { isISODate, type Cadence, type ISODate } from '../src/shared/types.ts'
import type { CompletionRow, TaskRow } from '../src/server/schema.ts'
import { addDays, completionForPeriod, effectiveDate, isDone, isOverdue, isUnplaced, periodEnd, periodKey, periodStart } from '../src/server/period.ts'
import { today } from '../src/server/today.ts'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let nextId = 1

function task(over: Partial<TaskRow> = {}): TaskRow {
  return {
    id: nextId++,
    // These suites test pure functions that never read it. Present because the
    // row shape requires it, and constant for the same reason.
    user_id: 1,
    name: 'a task',
    is_baseline: false,
    cadence: null,
    planned_date: null,
    color: null,
    category: null,
    active: true,
    ...over,
  }
}

function completion(task_id: number, completed_on: ISODate): CompletionRow {
  return { task_id, completed_on }
}

/** UTC weekday name, used to prove the calendar assumptions the tests rest on. */
function weekday(date: ISODate): string {
  const names = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
  return names[new Date(`${date}T00:00:00Z`).getUTCDay()]!
}

const ALL_CADENCES: (Cadence | null)[] = ['day', 'week', 'month', 'quarter', 'year', null]

// ---------------------------------------------------------------------------
// Calendar assumptions
// ---------------------------------------------------------------------------

describe('calendar assumptions the rest of the suite rests on', () => {
  test('the dates used as Sundays really are Sundays', () => {
    expect(weekday('2026-08-30')).toBe('Sunday')
    expect(weekday('2026-09-06')).toBe('Sunday')
    expect(weekday('2026-09-13')).toBe('Sunday')
    expect(weekday('2026-09-27')).toBe('Sunday')
    expect(weekday('2025-12-28')).toBe('Sunday')
    expect(weekday('2028-02-27')).toBe('Sunday')
  })

  test('the dates used as Saturdays really are Saturdays', () => {
    expect(weekday('2026-09-05')).toBe('Saturday')
    expect(weekday('2026-09-12')).toBe('Saturday')
    expect(weekday('2026-01-03')).toBe('Saturday')
    expect(weekday('2026-10-03')).toBe('Saturday')
  })

  test('the mid-week dates are the weekdays the cases name', () => {
    expect(weekday('2026-09-01')).toBe('Tuesday')
    expect(weekday('2026-09-02')).toBe('Wednesday')
    expect(weekday('2026-09-08')).toBe('Tuesday')
    expect(weekday('2026-09-09')).toBe('Wednesday')
    expect(weekday('2026-09-29')).toBe('Tuesday')
    expect(weekday('2026-10-02')).toBe('Friday')
    expect(weekday('2028-02-29')).toBe('Tuesday')
  })
})

// ---------------------------------------------------------------------------
// periodKey
// ---------------------------------------------------------------------------

describe('periodKey', () => {
  test('the period table, for 2026-09-05', () => {
    expect(periodKey('2026-09-05', 'day')).toBe('2026-09-05')
    expect(periodKey('2026-09-05', 'week')).toBe('W2026-08-30')
    expect(periodKey('2026-09-05', 'month')).toBe('2026-09')
    expect(periodKey('2026-09-05', 'quarter')).toBe('2026-Q3')
    expect(periodKey('2026-09-05', 'year')).toBe('2026')
    expect(periodKey('2026-09-05', null)).toBe('once')
  })

  test('null cadence maps every date to the same key', () => {
    for (const d of ['1999-01-01', '2026-09-05', '2031-12-31']) {
      expect(periodKey(d, null)).toBe('once')
    }
  })

  test('day key is the date itself', () => {
    expect(periodKey('2026-01-01', 'day')).toBe('2026-01-01')
    expect(periodKey('2028-02-29', 'day')).toBe('2028-02-29')
  })

  test('week key is the week Sunday, never an ISO week number', () => {
    // Sun 2026-08-30 .. Sat 2026-09-05 are one week.
    expect(periodKey('2026-08-30', 'week')).toBe('W2026-08-30')
    expect(periodKey('2026-09-01', 'week')).toBe('W2026-08-30')
    expect(periodKey('2026-09-05', 'week')).toBe('W2026-08-30')
    // Sunday starts a new one.
    expect(periodKey('2026-09-06', 'week')).toBe('W2026-09-06')
    expect(periodKey('2026-09-06', 'week')).not.toBe(periodKey('2026-09-05', 'week'))
  })

  test('Saturday is the last day of a week and Sunday the first', () => {
    // Saturday 2026-09-05 and the preceding Sunday 2026-08-30: same week.
    expect(periodKey('2026-09-05', 'week')).toBe(periodKey('2026-08-30', 'week'))
    // Saturday and the NEXT day (Sunday) are different weeks.
    expect(periodKey('2026-09-05', 'week')).not.toBe(periodKey('2026-09-06', 'week'))
    // Every one of the seven days of that week shares the key.
    const week = [
      '2026-08-30',
      '2026-08-31',
      '2026-09-01',
      '2026-09-02',
      '2026-09-03',
      '2026-09-04',
      '2026-09-05',
    ]
    for (const d of week) expect(periodKey(d, 'week')).toBe('W2026-08-30')
  })

  test('a week spanning the year boundary has one stable key for all 7 days', () => {
    // Sun 2025-12-28 .. Sat 2026-01-03.
    const week = [
      '2025-12-28',
      '2025-12-29',
      '2025-12-30',
      '2025-12-31',
      '2026-01-01',
      '2026-01-02',
      '2026-01-03',
    ]
    for (const d of week) expect(periodKey(d, 'week')).toBe('W2025-12-28')
    // ...and the following Sunday is a different week again.
    expect(periodKey('2026-01-04', 'week')).toBe('W2026-01-04')
  })

  test('month keys', () => {
    expect(periodKey('2026-01-01', 'month')).toBe('2026-01')
    expect(periodKey('2026-01-31', 'month')).toBe('2026-01')
    expect(periodKey('2026-02-01', 'month')).toBe('2026-02')
    expect(periodKey('2026-12-31', 'month')).toBe('2026-12')
  })

  test('quarter keys: Q1 Jan-Mar, Q2 Apr-Jun, Q3 Jul-Sep, Q4 Oct-Dec', () => {
    expect(periodKey('2026-01-01', 'quarter')).toBe('2026-Q1')
    expect(periodKey('2026-02-15', 'quarter')).toBe('2026-Q1')
    expect(periodKey('2026-03-31', 'quarter')).toBe('2026-Q1')
    expect(periodKey('2026-04-01', 'quarter')).toBe('2026-Q2')
    expect(periodKey('2026-06-30', 'quarter')).toBe('2026-Q2')
    expect(periodKey('2026-07-01', 'quarter')).toBe('2026-Q3')
    expect(periodKey('2026-09-30', 'quarter')).toBe('2026-Q3')
    expect(periodKey('2026-10-01', 'quarter')).toBe('2026-Q4')
    expect(periodKey('2026-12-31', 'quarter')).toBe('2026-Q4')
  })

  test('quarter boundary Mar 31 / Apr 1', () => {
    expect(periodKey('2026-03-31', 'quarter')).not.toBe(periodKey('2026-04-01', 'quarter'))
  })

  test('year keys', () => {
    expect(periodKey('2026-01-01', 'year')).toBe('2026')
    expect(periodKey('2026-12-31', 'year')).toBe('2026')
    expect(periodKey('2027-01-01', 'year')).toBe('2027')
  })

  test('leap day 2028-02-29 is handled by every cadence', () => {
    expect(periodKey('2028-02-29', 'day')).toBe('2028-02-29')
    expect(periodKey('2028-02-29', 'week')).toBe('W2028-02-27')
    expect(periodKey('2028-02-29', 'month')).toBe('2028-02')
    expect(periodKey('2028-02-29', 'quarter')).toBe('2028-Q1')
    expect(periodKey('2028-02-29', 'year')).toBe('2028')
    expect(periodKey('2028-02-29', null)).toBe('once')
    // The day after the leap day is still the same week — arithmetic crosses it.
    expect(periodKey('2028-03-01', 'week')).toBe('W2028-02-27')
  })

  test('every key returned is a string, and never a Date', () => {
    for (const cadence of ALL_CADENCES) {
      expect(typeof periodKey('2026-09-05', cadence)).toBe('string')
    }
  })
})

// ---------------------------------------------------------------------------
// periodStart
// ---------------------------------------------------------------------------

describe('periodStart', () => {
  test('the period table, for 2026-09-05', () => {
    expect(periodStart('2026-09-05', 'day')).toBe('2026-09-05')
    expect(periodStart('2026-09-05', 'week')).toBe('2026-08-30')
    expect(periodStart('2026-09-05', 'month')).toBe('2026-09-01')
    expect(periodStart('2026-09-05', 'quarter')).toBe('2026-07-01')
    expect(periodStart('2026-09-05', 'year')).toBe('2026-01-01')
    expect(periodStart('2026-09-05', null)).toBeNull()
  })

  test('week start is the Sunday on or before today', () => {
    expect(periodStart('2026-08-30', 'week')).toBe('2026-08-30') // a Sunday is its own start
    expect(periodStart('2026-09-02', 'week')).toBe('2026-08-30')
    expect(periodStart('2026-09-05', 'week')).toBe('2026-08-30') // Saturday, last day
    expect(periodStart('2026-09-06', 'week')).toBe('2026-09-06') // Sunday, new week
  })

  test('week start crosses the year boundary', () => {
    expect(periodStart('2026-01-01', 'week')).toBe('2025-12-28')
    expect(periodStart('2026-01-03', 'week')).toBe('2025-12-28')
    expect(periodStart('2026-01-04', 'week')).toBe('2026-01-04')
  })

  test('week start crosses the leap day', () => {
    expect(periodStart('2028-02-29', 'week')).toBe('2028-02-27')
    expect(periodStart('2028-03-01', 'week')).toBe('2028-02-27')
  })

  test('month start', () => {
    expect(periodStart('2026-02-28', 'month')).toBe('2026-02-01')
    expect(periodStart('2026-12-31', 'month')).toBe('2026-12-01')
    expect(periodStart('2028-02-29', 'month')).toBe('2028-02-01')
  })

  test('quarter starts and the Mar 31 / Apr 1 boundary', () => {
    expect(periodStart('2026-01-01', 'quarter')).toBe('2026-01-01')
    expect(periodStart('2026-03-31', 'quarter')).toBe('2026-01-01')
    expect(periodStart('2026-04-01', 'quarter')).toBe('2026-04-01')
    expect(periodStart('2026-06-30', 'quarter')).toBe('2026-04-01')
    expect(periodStart('2026-07-01', 'quarter')).toBe('2026-07-01')
    expect(periodStart('2026-10-01', 'quarter')).toBe('2026-10-01')
    expect(periodStart('2026-12-31', 'quarter')).toBe('2026-10-01')
  })

  test('year start', () => {
    expect(periodStart('2026-01-01', 'year')).toBe('2026-01-01')
    expect(periodStart('2026-12-31', 'year')).toBe('2026-01-01')
  })

  test('null cadence is unbounded for every date', () => {
    for (const d of ['1999-01-01', '2026-09-05', '2031-12-31']) {
      expect(periodStart(d, null)).toBeNull()
    }
  })

  test('a period start is never after today, and today is always in its own period', () => {
    for (const cadence of ALL_CADENCES) {
      for (const d of ['2026-01-01', '2026-03-31', '2026-09-05', '2026-09-06', '2028-02-29']) {
        const start = periodStart(d, cadence)
        if (start === null) continue
        expect(start <= d).toBe(true)
        expect(periodKey(start, cadence)).toBe(periodKey(d, cadence))
      }
    }
  })
})

// ---------------------------------------------------------------------------
// effectiveDate
// ---------------------------------------------------------------------------

describe('effectiveDate', () => {
  test('a null planned_date yields null for every cadence', () => {
    for (const cadence of ALL_CADENCES) {
      expect(effectiveDate(task({ cadence, planned_date: null }), '2026-09-05')).toBeNull()
    }
  })

  test('today itself always holds', () => {
    for (const cadence of ALL_CADENCES) {
      const t = task({ cadence, planned_date: '2026-09-05' })
      expect(effectiveDate(t, '2026-09-05')).toBe('2026-09-05')
    }
  })

  /**
   * THE REGRESSION CASE:
   *
   *   "in the week of Sun Sep 27 - Sat Oct 3, a monthly task placed on Fri Oct 2
   *    while today is Tue Sep 29 sits inside the current week but in a different
   *    month, and would be wrongly discarded — placed, then vanished."
   *
   * effectiveDate is BACKWARD-ONLY. Oct 2 is not before Sep 1 (this month's
   * start), so it holds and the task stays PLANNED, sitting in Friday's list.
   * A symmetric period-key comparison would return null here. It must not.
   */
  test('REGRESSION: monthly task planned 2026-10-02, today 2026-09-29, stays planned', () => {
    const t = task({ cadence: 'month', planned_date: '2026-10-02' })
    expect(effectiveDate(t, '2026-09-29')).toBe('2026-10-02')
    expect(isUnplaced(t, '2026-09-29')).toBe(false)
    expect(isOverdue(t, [], '2026-09-29')).toBe(false) // ahead of today, not overdue
    // Not a coincidence of the month cadence — the same forward date holds for
    // every cadence, because the check never looks forward.
    for (const cadence of ALL_CADENCES) {
      expect(effectiveDate(task({ cadence, planned_date: '2026-10-02' }), '2026-09-29')).toBe(
        '2026-10-02',
      )
    }
  })

  test('a date before the period start falls out', () => {
    // Weekly, planned last week.
    expect(
      effectiveDate(task({ cadence: 'week', planned_date: '2026-09-01' }), '2026-09-06'),
    ).toBeNull()
    // Monthly, planned last month.
    expect(
      effectiveDate(task({ cadence: 'month', planned_date: '2026-08-31' }), '2026-09-01'),
    ).toBeNull()
    // Quarterly, planned last quarter.
    expect(
      effectiveDate(task({ cadence: 'quarter', planned_date: '2026-03-31' }), '2026-04-01'),
    ).toBeNull()
    // Yearly, planned last year.
    expect(
      effectiveDate(task({ cadence: 'year', planned_date: '2025-12-31' }), '2026-01-01'),
    ).toBeNull()
    // Daily, planned yesterday — dailies are never placed, but the maths is the same.
    expect(
      effectiveDate(task({ cadence: 'day', planned_date: '2026-09-04' }), '2026-09-05'),
    ).toBeNull()
  })

  test('a date inside the current period holds', () => {
    expect(effectiveDate(task({ cadence: 'week', planned_date: '2026-09-01' }), '2026-09-02')).toBe(
      '2026-09-01',
    )
    expect(effectiveDate(task({ cadence: 'month', planned_date: '2026-09-01' }), '2026-09-29')).toBe(
      '2026-09-01',
    )
    expect(
      effectiveDate(task({ cadence: 'quarter', planned_date: '2026-07-01' }), '2026-09-29'),
    ).toBe('2026-07-01')
    expect(effectiveDate(task({ cadence: 'year', planned_date: '2026-01-01' }), '2026-09-29')).toBe(
      '2026-01-01',
    )
  })

  test('a one-off has an unbounded period start, so its date never falls out', () => {
    const t = task({ cadence: null, planned_date: '2019-03-04' })
    expect(effectiveDate(t, '2026-09-05')).toBe('2019-03-04')
    expect(effectiveDate(t, '2031-12-31')).toBe('2019-03-04')
    expect(isUnplaced(t, '2026-09-05')).toBe(false)
    expect(isOverdue(t, [], '2026-09-05')).toBe(true) // still overdue indefinitely
  })

  test('a daily task is never placed, so its effective date is always null', () => {
    const t = task({ cadence: 'day', planned_date: null })
    expect(effectiveDate(t, '2026-09-05')).toBeNull()
    expect(isUnplaced(t, '2026-09-05')).toBe(true)
    expect(isOverdue(t, [], '2026-09-05')).toBe(false) // never overdue: nothing to catch up
  })

  test('returns a string or null, never a Date', () => {
    const out = effectiveDate(task({ cadence: 'week', planned_date: '2026-09-01' }), '2026-09-02')
    expect(typeof out).toBe('string')
    expect((out as unknown) instanceof Date).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// The behaviour table, row by row
// ---------------------------------------------------------------------------

describe('the behaviour table for derived state', () => {
  test('row 1 — weekly task placed Tuesday, today Wednesday: effective date holds, overdue', () => {
    // Tue 2026-09-01 and Wed 2026-09-02 are in the week starting Sun 2026-08-30.
    const t = task({ cadence: 'week', planned_date: '2026-09-01' })
    expect(effectiveDate(t, '2026-09-02')).toBe('2026-09-01')
    expect(isUnplaced(t, '2026-09-02')).toBe(false)
    expect(isOverdue(t, [], '2026-09-02')).toBe(true) // wants a new day this week
  })

  test('row 2 — same task, today the following Sunday: unplaced, no debt carried', () => {
    const t = task({ cadence: 'week', planned_date: '2026-09-01' })
    expect(effectiveDate(t, '2026-09-06')).toBeNull() // before this week's start
    expect(isUnplaced(t, '2026-09-06')).toBe(true) // due and unplaced
    expect(isOverdue(t, [], '2026-09-06')).toBe(false) // no debt carried
  })

  test('row 3 — one-off placed Tuesday, today the following Sunday: still overdue', () => {
    const t = task({ cadence: null, planned_date: '2026-09-01' })
    expect(periodStart('2026-09-06', null)).toBeNull() // unbounded
    expect(effectiveDate(t, '2026-09-06')).toBe('2026-09-01')
    expect(isUnplaced(t, '2026-09-06')).toBe(false)
    expect(isOverdue(t, [], '2026-09-06')).toBe(true)
  })

  test('row 4 — daily task: never placed, so effective date is always null', () => {
    const t = task({ cadence: 'day', is_baseline: true })
    for (const d of ['2026-09-05', '2026-09-06', '2027-01-01']) {
      expect(effectiveDate(t, d)).toBeNull()
      expect(isUnplaced(t, d)).toBe(true)
      expect(isOverdue(t, [], d)).toBe(false)
    }
  })

  test('row 5 — monthly task placed Oct 2, today Sep 29: planned, sits in Friday list', () => {
    const t = task({ cadence: 'month', planned_date: '2026-10-02' })
    expect(effectiveDate(t, '2026-09-29')).toBe('2026-10-02')
    expect(isUnplaced(t, '2026-09-29')).toBe(false)
    expect(isOverdue(t, [], '2026-09-29')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Week boundary, in detail
// ---------------------------------------------------------------------------

describe('week boundary', () => {
  test('a weekly task planned Tuesday survives Wednesday through Saturday', () => {
    const t = task({ cadence: 'week', planned_date: '2026-09-01' })
    for (const d of ['2026-09-02', '2026-09-03', '2026-09-04', '2026-09-05']) {
      expect(effectiveDate(t, d)).toBe('2026-09-01')
      expect(isOverdue(t, [], d)).toBe(true)
    }
    // Saturday is the last day it holds; Sunday it is gone.
    expect(effectiveDate(t, '2026-09-05')).toBe('2026-09-01')
    expect(effectiveDate(t, '2026-09-06')).toBeNull()
  })

  test('rollover is a read: state is correct after going dark for weeks', () => {
    const t = task({ cadence: 'week', planned_date: '2026-09-01' })
    // Nothing has cleared planned_date — the row is untouched.
    expect(t.planned_date).toBe('2026-09-01')
    expect(effectiveDate(t, '2026-09-27')).toBeNull()
    expect(isUnplaced(t, '2026-09-27')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// isDone
// ---------------------------------------------------------------------------

describe('isDone', () => {
  test('no completions is never done', () => {
    for (const cadence of ALL_CADENCES) {
      expect(isDone(task({ cadence }), [], '2026-09-05')).toBe(false)
    }
  })

  test('daily: only today satisfies the period', () => {
    const t = task({ cadence: 'day' })
    expect(isDone(t, [completion(t.id, '2026-09-05')], '2026-09-05')).toBe(true)
    expect(isDone(t, [completion(t.id, '2026-09-04')], '2026-09-05')).toBe(false)
  })

  test('weekly: a Tuesday completion counts all week, and not the next one', () => {
    const t = task({ cadence: 'week' })
    const done = [completion(t.id, '2026-09-01')]
    expect(isDone(t, done, '2026-09-02')).toBe(true) // Wednesday
    expect(isDone(t, done, '2026-09-05')).toBe(true) // Saturday, same week
    expect(isDone(t, done, '2026-09-06')).toBe(false) // Sunday, new week
    expect(isDone(t, done, '2026-08-30')).toBe(true) // the week's Sunday
  })

  test('monthly / quarterly / yearly period satisfaction', () => {
    const m = task({ cadence: 'month' })
    expect(isDone(m, [completion(m.id, '2026-09-01')], '2026-09-30')).toBe(true)
    expect(isDone(m, [completion(m.id, '2026-08-31')], '2026-09-01')).toBe(false)

    const q = task({ cadence: 'quarter' })
    expect(isDone(q, [completion(q.id, '2026-07-01')], '2026-09-30')).toBe(true)
    expect(isDone(q, [completion(q.id, '2026-06-30')], '2026-07-01')).toBe(false)

    const y = task({ cadence: 'year' })
    expect(isDone(y, [completion(y.id, '2026-01-01')], '2026-12-31')).toBe(true)
    expect(isDone(y, [completion(y.id, '2025-12-31')], '2026-01-01')).toBe(false)
  })

  test('a one-off is done forever once completed — every date is the same period', () => {
    const t = task({ cadence: null, planned_date: '2026-09-01' })
    const done = [completion(t.id, '2026-09-01')]
    expect(isDone(t, done, '2026-09-01')).toBe(true)
    expect(isDone(t, done, '2031-12-31')).toBe(true)
    // ...and so it is never overdue again, though its date still holds.
    expect(effectiveDate(t, '2031-12-31')).toBe('2026-09-01')
    expect(isOverdue(t, done, '2031-12-31')).toBe(false)
  })

  test('any one matching completion is enough', () => {
    const t = task({ cadence: 'week' })
    const done = [
      completion(t.id, '2026-07-04'),
      completion(t.id, '2026-09-03'), // the one in this week
      completion(t.id, '2026-08-12'),
    ]
    expect(isDone(t, done, '2026-09-05')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// isUnplaced / isOverdue across cadences
// ---------------------------------------------------------------------------

describe('isUnplaced and isOverdue across cadences', () => {
  test('isUnplaced is exactly "effective date is null"', () => {
    for (const cadence of ALL_CADENCES) {
      for (const planned of [null, '2020-01-01', '2026-09-05', '2026-12-25']) {
        const t = task({ cadence, planned_date: planned })
        expect(isUnplaced(t, '2026-09-05')).toBe(effectiveDate(t, '2026-09-05') === null)
      }
    }
  })

  test('a task placed today is planned, not overdue', () => {
    for (const cadence of ALL_CADENCES) {
      const t = task({ cadence, planned_date: '2026-09-05' })
      expect(isOverdue(t, [], '2026-09-05')).toBe(false) // strictly before, not on
      expect(isUnplaced(t, '2026-09-05')).toBe(false)
    }
  })

  test('a completed task in the current period is never overdue', () => {
    const t = task({ cadence: 'week', planned_date: '2026-09-01' })
    expect(isOverdue(t, [], '2026-09-02')).toBe(true)
    expect(isOverdue(t, [completion(t.id, '2026-09-02')], '2026-09-02')).toBe(false)
    // A completion in a PAST period does not rescue it.
    expect(isOverdue(t, [completion(t.id, '2026-08-25')], '2026-09-02')).toBe(true)
  })

  test('an unplaced task is never overdue, whatever its history', () => {
    const t = task({ cadence: 'week', planned_date: null })
    expect(isOverdue(t, [], '2026-09-05')).toBe(false)
    expect(isOverdue(t, [completion(t.id, '2026-01-01')], '2026-09-05')).toBe(false)
  })

  test('overdue and unplaced are mutually exclusive', () => {
    for (const cadence of ALL_CADENCES) {
      for (const planned of [null, '2020-01-01', '2026-09-04', '2026-09-05', '2026-09-30']) {
        const t = task({ cadence, planned_date: planned })
        const overdue = isOverdue(t, [], '2026-09-05')
        const unplaced = isUnplaced(t, '2026-09-05')
        expect(overdue && unplaced).toBe(false)
      }
    }
  })

  test('a monthly task placed earlier this month and not done is overdue', () => {
    const t = task({ cadence: 'month', planned_date: '2026-09-02' })
    expect(isOverdue(t, [], '2026-09-29')).toBe(true)
    // Next month it has fallen out of the period instead.
    expect(isOverdue(t, [], '2026-10-01')).toBe(false)
    expect(isUnplaced(t, '2026-10-01')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// completionForPeriod
// ---------------------------------------------------------------------------

describe('completionForPeriod', () => {
  test('null when nothing falls in the period', () => {
    const t = task({ cadence: 'week' })
    expect(completionForPeriod(t, [], '2026-09-02')).toBeNull()
    expect(completionForPeriod(t, [completion(t.id, '2026-08-25')], '2026-09-02')).toBeNull()
  })

  test('unticking a weekly task on Wednesday names TUESDAYs row', () => {
    const t = task({ cadence: 'week' })
    const found = completionForPeriod(t, [completion(t.id, '2026-09-01')], '2026-09-02')
    expect(found?.completed_on).toBe('2026-09-01')
    expect(found?.task_id).toBe(t.id)
  })

  test('picks the most recent when several exist in the period', () => {
    const t = task({ cadence: 'week' })
    const done = [
      completion(t.id, '2026-08-31'),
      completion(t.id, '2026-09-03'),
      completion(t.id, '2026-09-01'),
      completion(t.id, '2026-08-25'), // previous week — ignored
    ]
    expect(completionForPeriod(t, done, '2026-09-05')?.completed_on).toBe('2026-09-03')
  })

  test('ignores completions outside the period entirely', () => {
    const t = task({ cadence: 'month' })
    const done = [
      completion(t.id, '2026-10-31'), // next month, later date but wrong period
      completion(t.id, '2026-09-04'),
      completion(t.id, '2026-08-31'),
    ]
    expect(completionForPeriod(t, done, '2026-09-05')?.completed_on).toBe('2026-09-04')
  })

  test('a one-off resolves any completion, and the latest of several', () => {
    const t = task({ cadence: null })
    const done = [completion(t.id, '2019-01-01'), completion(t.id, '2021-06-06')]
    expect(completionForPeriod(t, done, '2026-09-05')?.completed_on).toBe('2021-06-06')
  })

  test('a daily task resolves only todays row', () => {
    const t = task({ cadence: 'day' })
    const done = [completion(t.id, '2026-09-04'), completion(t.id, '2026-09-05')]
    expect(completionForPeriod(t, done, '2026-09-05')?.completed_on).toBe('2026-09-05')
    expect(completionForPeriod(t, [completion(t.id, '2026-09-04')], '2026-09-05')).toBeNull()
  })

  test('agrees with isDone: a row exists exactly when the task is done', () => {
    const t = task({ cadence: 'quarter' })
    for (const done of [
      [],
      [completion(t.id, '2026-06-30')],
      [completion(t.id, '2026-07-01')],
      [completion(t.id, '2026-09-30'), completion(t.id, '2026-10-01')],
    ]) {
      expect(completionForPeriod(t, done, '2026-09-05') !== null).toBe(
        isDone(t, done, '2026-09-05'),
      )
    }
  })
})

// ---------------------------------------------------------------------------
// today() — the one clock read. Only its shape can be asserted.
// ---------------------------------------------------------------------------

describe('today', () => {
  test('returns a well-formed local YYYY-MM-DD string, never a Date', () => {
    const t = today('UTC')
    expect(typeof t).toBe('string')
    expect(isISODate(t)).toBe(true)
    const now = new Date()
    const local = `${String(now.getFullYear()).padStart(4, '0')}-${String(
      now.getMonth() + 1,
    ).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
    expect(t).toBe(local)
  })

  test('feeds the period functions without further parsing', () => {
    const t = today('UTC')
    expect(periodStart(t, 'week')! <= t).toBe(true)
    expect(periodKey(periodStart(t, 'month')!, 'month')).toBe(periodKey(t, 'month'))
  })
})

// ---------------------------------------------------------------------------
// periodEnd — labels the To do panel's groups
// ---------------------------------------------------------------------------

describe('periodEnd', () => {
  test('day is itself', () => {
    expect(periodEnd('2026-09-05', 'day')).toBe('2026-09-05')
  })

  test('week ends on Saturday, and start..end is exactly 7 days', () => {
    // 2026-08-30 is a Sunday, 2026-09-05 the Saturday that closes that week.
    expect(periodEnd('2026-09-05', 'week')).toBe('2026-09-05')
    expect(periodEnd('2026-08-30', 'week')).toBe('2026-09-05')
    expect(periodEnd('2026-09-06', 'week')).toBe('2026-09-12')
    for (const d of ['2026-08-30', '2026-09-02', '2026-09-05']) {
      const start = periodStart(d, 'week')!
      expect(periodEnd(d, 'week')).toBe(addDays(start, 6))
    }
  })

  test('month ends on the real last day, including short and leap months', () => {
    expect(periodEnd('2026-09-05', 'month')).toBe('2026-09-30')
    expect(periodEnd('2026-01-01', 'month')).toBe('2026-01-31')
    expect(periodEnd('2026-02-14', 'month')).toBe('2026-02-28')
    expect(periodEnd('2028-02-14', 'month')).toBe('2028-02-29') // leap
    expect(periodEnd('2026-12-31', 'month')).toBe('2026-12-31')
  })

  test('quarter ends on the last day of its third month', () => {
    expect(periodEnd('2026-01-01', 'quarter')).toBe('2026-03-31')
    expect(periodEnd('2026-04-30', 'quarter')).toBe('2026-06-30')
    expect(periodEnd('2026-09-05', 'quarter')).toBe('2026-09-30')
    expect(periodEnd('2026-10-01', 'quarter')).toBe('2026-12-31')
  })

  test('year ends 31 Dec', () => {
    expect(periodEnd('2026-09-05', 'year')).toBe('2026-12-31')
    expect(periodEnd('2028-02-29', 'year')).toBe('2028-12-31')
  })

  test('a one-off is unbounded in both directions', () => {
    expect(periodEnd('2026-09-05', null)).toBeNull()
    expect(periodStart('2026-09-05', null)).toBeNull()
  })

  test('end is never before start, and today always falls inside the period', () => {
    const dates = ['2026-01-01', '2026-02-28', '2026-03-31', '2026-08-30', '2026-09-05', '2026-12-31']
    for (const d of dates) {
      for (const c of ['day', 'week', 'month', 'quarter', 'year'] as const) {
        const start = periodStart(d, c)!
        const end = periodEnd(d, c)!
        expect(start <= end).toBe(true)
        expect(start <= d && d <= end).toBe(true)
      }
    }
  })
})

// ---------------------------------------------------------------------------
// today(), against a zone
// ---------------------------------------------------------------------------

/**
 * The regression test that did not exist when the container ran UTC and started
 * calling 8pm Monday "Tuesday". It was awkward to write while the zone came from
 * the process; with the zone as an argument it is a pure function of an instant.
 */
describe('today(zone)', () => {
  test('two zones can disagree about the date, and that is the point', () => {
    // 02:35 UTC on the 8th is 22:35 on the 7th in New York — the exact hour that
    // made the deployed app a day ahead of the household.
    const instant = new Date('2026-09-08T02:35:00Z')
    expect(today('UTC', instant)).toBe('2026-09-08')
    expect(today('America/New_York', instant)).toBe('2026-09-07')
  })

  test('the far side of the date line is a day ahead of UTC', () => {
    const instant = new Date('2026-09-07T12:00:00Z')
    expect(today('UTC', instant)).toBe('2026-09-07')
    expect(today('Pacific/Kiritimati', instant)).toBe('2026-09-08')
  })

  test('it still reads the clock when given no instant', () => {
    expect(today('UTC')).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })
})
