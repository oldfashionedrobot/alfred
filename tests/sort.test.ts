import { test, expect, describe } from 'bun:test'
import type { TaskRow } from '../src/server/schema.ts'
import { byCategoryName, sortTasks } from '../src/server/sort.ts'

/** What a view passes in: a task row plus the doneness it derived for it. */
type Row = TaskRow & { is_done: boolean }

function task(id: number, name: string, is_baseline = false): Row {
  // user_id is never read by sortTasks; it is here because a TaskRow has one.
  return {
    id,
    user_id: 1,
    name,
    is_baseline,
    is_done: false,
    cadence: null,
    planned_date: null,
    color: null,
    category: null,
    active: true,
  }
}

/** The same row, ticked. Doneness is derived per view, never a column. */
const ticked = (t: Row): Row => ({ ...t, is_done: true })
/** The same row, filed under a category. */
const filed = (t: Row, category: string): Row => ({ ...t, category })

const names = (tasks: Pick<TaskRow, 'name'>[]) => tasks.map((t) => t.name)
const ids = (tasks: Pick<TaskRow, 'id'>[]) => tasks.map((t) => t.id)

describe('sortTasks', () => {
  test('empty input', () => {
    expect(sortTasks([], null)).toEqual([])
    expect(sortTasks([], [1, 2, 3])).toEqual([])
  })

  test('null taskOrder: everything sorts by name', () => {
    const tasks = [task(1, 'Vacuum'), task(2, 'Bins'), task(3, 'Laundry')]
    expect(names(sortTasks(tasks, null))).toEqual(['Bins', 'Laundry', 'Vacuum'])
  })

  test('an empty taskOrder behaves like none', () => {
    const tasks = [task(1, 'Vacuum'), task(2, 'Bins')]
    expect(names(sortTasks(tasks, []))).toEqual(['Bins', 'Vacuum'])
  })

  test('baseline does not lift a task: names decide', () => {
    // It was the top band until v17. Hour dividers need live rows in their
    // stored order, and a band hoists rows past their neighbours.
    const tasks = [
      task(1, 'Aardvark'),
      task(2, 'Zebra', true), // baseline, alphabetically last
      task(3, 'Bins'),
      task(4, 'Meds', true),
    ]
    expect(names(sortTasks(tasks, null))).toEqual(['Aardvark', 'Bins', 'Meds', 'Zebra'])
  })

  test('the arrangement interleaves baseline and plain tasks freely', () => {
    const tasks = [
      task(1, 'Bins'),
      task(2, 'Meds', true),
      task(3, 'Vacuum'),
      task(4, 'Sleep', true),
    ]
    // Alternating baseline and plain, which bands used to forbid.
    expect(ids(sortTasks(tasks, [1, 4, 3, 2]))).toEqual([1, 4, 3, 2])
  })

  test('taskOrder is respected', () => {
    const tasks = [task(1, 'Aaa'), task(2, 'Bbb'), task(3, 'Ccc')]
    expect(ids(sortTasks(tasks, [3, 1, 2]))).toEqual([3, 1, 2])
    expect(ids(sortTasks(tasks, [2, 3, 1]))).toEqual([2, 3, 1])
  })

  test('unlisted items fall below listed ones and sort by name among themselves', () => {
    const tasks = [task(1, 'Zucchini'), task(2, 'Apple'), task(3, 'Mango'), task(4, 'Banana')]
    // Only 3 and 1 are arranged; 2 and 4 fall below, alphabetically.
    const out = sortTasks(tasks, [3, 1])
    expect(names(out)).toEqual(['Mango', 'Zucchini', 'Apple', 'Banana'])
  })

  test('unlistedAt puts the unlisted rows where the caller says', () => {
    // Day passes its first hour's position, so a task the arrangement does not
    // place waits above every hour instead of falling under the last one.
    const tasks = [task(1, 'Aaa'), task(2, 'Bbb'), task(3, 'Zzz new'), task(4, 'Mmm new')]
    expect(names(sortTasks(tasks, [1, 2], 1))).toEqual(['Aaa', 'Mmm new', 'Zzz new', 'Bbb'])
    expect(names(sortTasks(tasks, [1, 2], 0))).toEqual(['Mmm new', 'Zzz new', 'Aaa', 'Bbb'])
    // At the end of the list it is the default: below everything listed.
    expect(names(sortTasks(tasks, [1, 2], 2))).toEqual(names(sortTasks(tasks, [1, 2])))
  })

  test('an unlisted done task still sinks, wherever unlisted rows wait', () => {
    const tasks = [task(1, 'Aaa'), ticked(task(2, 'Bbb')), task(3, 'Ccc')]
    expect(names(sortTasks(tasks, [1, 3], 0))).toEqual(['Aaa', 'Ccc', 'Bbb'])
  })

  test('ids in taskOrder that match no passed task are ignored harmlessly', () => {
    const tasks = [task(1, 'Bins'), task(2, 'Vacuum')]
    // 99 is archived or simply not on today's list; 404 never existed.
    expect(ids(sortTasks(tasks, [99, 2, 404, 1]))).toEqual([2, 1])
    // An order made entirely of stale ids degrades to name order.
    expect(names(sortTasks(tasks, [99, 404]))).toEqual(['Bins', 'Vacuum'])
  })

  test('duplicate ids in taskOrder use the first position', () => {
    const tasks = [task(1, 'Aaa'), task(2, 'Bbb')]
    expect(ids(sortTasks(tasks, [2, 1, 2]))).toEqual([2, 1])
  })

  test('does not mutate its input', () => {
    const tasks = [task(3, 'Ccc'), task(1, 'Aaa'), task(2, 'Bbb', true)]
    const snapshot = tasks.map((t) => ({ ...t }))
    const order = [1, 3]
    const orderSnapshot = [...order]

    const out = sortTasks(tasks, order)

    expect(out).not.toBe(tasks)
    expect(tasks).toEqual(snapshot) // same objects, same positions
    expect(ids(tasks)).toEqual([3, 1, 2])
    expect(order).toEqual(orderSnapshot)
    // The returned array holds the same object references, not copies.
    expect(out.includes(tasks[0]!)).toBe(true)
  })

  test('name comparison uses localeCompare, so case and accents behave', () => {
    const tasks = [task(1, 'banana'), task(2, 'Apple'), task(3, 'cherry')]
    const expected = ['banana', 'Apple', 'cherry'].sort((a, b) => a.localeCompare(b))
    expect(names(sortTasks(tasks, null))).toEqual(expected)
  })

  test('name prefixes group naturally', () => {
    const tasks = [
      task(1, 'Dog: Feed Barney 2'),
      task(2, 'Bins out'),
      task(3, 'Dog: Feed Barney 1'),
      task(4, 'Dog: Walk'),
    ]
    expect(names(sortTasks(tasks, null))).toEqual([
      'Bins out',
      'Dog: Feed Barney 1',
      'Dog: Feed Barney 2',
      'Dog: Walk',
    ])
  })

  test('runs over any array carrying the four fields it compares', () => {
    // Views pass their own row shapes, not TaskRow — the signature is structural.
    // `is_done` is in it and NOT on TaskRow: every caller derives it.
    const rows = [
      { id: 2, name: 'Meds', category: null, is_done: false, state: 'daily' },
      { id: 1, name: 'Bins', category: null, is_done: false, state: 'planned' },
    ]
    const out = sortTasks(rows, null)
    expect(out.map((r) => r.state)).toEqual(['planned', 'daily'])
  })

  test('a done task sinks below every live one, whatever its name says', () => {
    const tasks = [
      ticked(task(1, 'Aardvark')), // alphabetically first, and finished
      task(2, 'Zebra'),
    ]
    expect(names(sortTasks(tasks, null))).toEqual(['Zebra', 'Aardvark'])
  })

  test('a done task sinks even when the arrangement puts it first', () => {
    const tasks = [ticked(task(1, 'Bins')), task(2, 'Vacuum')]
    // The arrangement is obeyed among live rows and among done ones, never
    // across the two.
    expect(ids(sortTasks(tasks, [1, 2]))).toEqual([2, 1])
  })

  test('the done band keeps its own arrangement, so tick and untick returns a task', () => {
    // A task ticked after the day was arranged keeps its slot in task_order, so
    // the position survives the round trip through the done band.
    const tasks = [ticked(task(1, 'Aaa')), ticked(task(2, 'Bbb')), task(3, 'Ccc')]
    expect(ids(sortTasks(tasks, [2, 1]))).toEqual([3, 2, 1])
  })

  test('category orders before name, and uncategorised falls last', () => {
    // Alphabetically this is Aardvark, Brush, Feed. By category it is Dog first,
    // and the loose end last however early its name sorts.
    const tasks = [
      filed(task(1, 'Aardvark admin'), 'House'),
      filed(task(2, 'Feed Barney'), 'Dog'),
      filed(task(3, 'Brush Ringo'), 'Dog'),
      task(4, 'Aaa loose end'),
    ]
    expect(names(sortTasks(tasks, null))).toEqual([
      'Brush Ringo',
      'Feed Barney',
      'Aardvark admin',
      'Aaa loose end',
    ])
  })

  test('the arrangement outranks category, which only ever breaks a tie', () => {
    const tasks = [filed(task(1, 'Zzz'), 'Zebra'), filed(task(2, 'Aaa'), 'Admin')]
    expect(ids(sortTasks(tasks, [1, 2]))).toEqual([1, 2])
  })

  test('a full Day-view shaped list: arrangement, then names', () => {
    const tasks = [
      task(10, 'Sleep', true),
      task(11, 'Meds', true),
      task(12, 'Exercise', true),
      task(20, 'Vacuum'),
      task(21, 'Bins'),
      task(22, 'Grocery run'),
    ]
    // The user arranged Meds, Sleep and Vacuum; the rest fall below, by name,
    // baseline or not.
    const out = sortTasks(tasks, [11, 10, 20])
    expect(names(out)).toEqual(['Meds', 'Sleep', 'Vacuum', 'Bins', 'Exercise', 'Grocery run'])
  })
})

describe('byCategoryName', () => {
  test('baseline decides nothing', () => {
    const vital = { name: 'Zzz vital', category: 'Zebra', is_baseline: true }
    const chore = { name: 'Aaa chore', category: 'Admin', is_baseline: false }
    expect([vital, chore].sort(byCategoryName).map((t) => t.name)).toEqual([
      'Aaa chore',
      'Zzz vital',
    ])
  })

  test('category first, uncategorised last, then name', () => {
    const rows = [
      { name: 'Aaa loose', category: null },
      { name: 'Walk', category: 'Dog' },
      { name: 'Bins', category: 'House' },
      { name: 'Brush', category: 'Dog' },
    ]
    expect(rows.sort(byCategoryName).map((t) => t.name)).toEqual([
      'Brush',
      'Walk',
      'Bins',
      'Aaa loose',
    ])
  })
})
