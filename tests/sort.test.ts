import { test, expect, describe } from 'bun:test'
import type { TaskRow } from '../src/server/schema.ts'
import { sortTasks } from '../src/server/sort.ts'

function task(id: number, name: string, is_baseline = false): TaskRow {
  return { id, name, is_baseline, cadence: null, planned_date: null, color: null, category: null, active: true }
}

const names = (tasks: Pick<TaskRow, 'name'>[]) => tasks.map((t) => t.name)
const ids = (tasks: Pick<TaskRow, 'id'>[]) => tasks.map((t) => t.id)

describe('sortTasks', () => {
  test('empty input', () => {
    expect(sortTasks([], null)).toEqual([])
    expect(sortTasks([], [1, 2, 3])).toEqual([])
  })

  test('null taskOrder: everything sorts by name within its band', () => {
    const tasks = [task(1, 'Vacuum'), task(2, 'Bins'), task(3, 'Laundry')]
    expect(names(sortTasks(tasks, null))).toEqual(['Bins', 'Laundry', 'Vacuum'])
  })

  test('an empty taskOrder behaves like none', () => {
    const tasks = [task(1, 'Vacuum'), task(2, 'Bins')]
    expect(names(sortTasks(tasks, []))).toEqual(['Bins', 'Vacuum'])
  })

  test('baseline is always the top band, whatever the names', () => {
    const tasks = [
      task(1, 'Aardvark'), // non-baseline, alphabetically first overall
      task(2, 'Zebra', true), // baseline, alphabetically last overall
      task(3, 'Bins'),
      task(4, 'Meds', true),
    ]
    expect(names(sortTasks(tasks, null))).toEqual(['Meds', 'Zebra', 'Aardvark', 'Bins'])
  })

  test('bands never mix, even when taskOrder interleaves them', () => {
    const tasks = [
      task(1, 'Bins'), // band 2
      task(2, 'Meds', true), // band 1
      task(3, 'Vacuum'), // band 2
      task(4, 'Sleep', true), // band 1
    ]
    // taskOrder deliberately alternates bands.
    const out = sortTasks(tasks, [1, 4, 3, 2])
    expect(ids(out)).toEqual([4, 2, 1, 3])
    // Every baseline task precedes every non-baseline one.
    const lastBaseline = out.map((t) => t.is_baseline).lastIndexOf(true)
    const firstOther = out.map((t) => t.is_baseline).indexOf(false)
    expect(lastBaseline).toBeLessThan(firstOther)
  })

  test('taskOrder is respected within a band', () => {
    const tasks = [task(1, 'Aaa'), task(2, 'Bbb'), task(3, 'Ccc')]
    expect(ids(sortTasks(tasks, [3, 1, 2]))).toEqual([3, 1, 2])
    expect(ids(sortTasks(tasks, [2, 3, 1]))).toEqual([2, 3, 1])
  })

  test('unlisted items fall below listed ones and sort by name among themselves', () => {
    const tasks = [
      task(1, 'Zucchini'),
      task(2, 'Apple'),
      task(3, 'Mango'),
      task(4, 'Banana'),
    ]
    // Only 3 and 1 are arranged; 2 and 4 fall below, alphabetically.
    const out = sortTasks(tasks, [3, 1])
    expect(names(out)).toEqual(['Mango', 'Zucchini', 'Apple', 'Banana'])
  })

  test('listed-below-unlisted holds inside each band independently', () => {
    const tasks = [
      task(1, 'Meds', true),
      task(2, 'Sleep', true),
      task(3, 'Bins'),
      task(4, 'Vacuum'),
    ]
    // Arrange one task in each band; the other in each band falls below it.
    const out = sortTasks(tasks, [2, 4])
    expect(names(out)).toEqual(['Sleep', 'Meds', 'Vacuum', 'Bins'])
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

  test('name prefixes group naturally within a band', () => {
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

  test('runs over any array with id, name and is_baseline', () => {
    // Views pass their own row shapes, not TaskRow — the signature is structural.
    const rows = [
      { id: 1, name: 'Vacuum', is_baseline: false, state: 'planned' as const },
      { id: 2, name: 'Meds', is_baseline: true, state: 'daily' as const },
    ]
    const out = sortTasks(rows, null)
    expect(out.map((r) => r.state)).toEqual(['daily', 'planned'])
  })

  test('a full Day-view shaped list: bands, arrangement, then names', () => {
    const tasks = [
      task(10, 'Sleep', true),
      task(11, 'Meds', true),
      task(12, 'Exercise', true),
      task(20, 'Vacuum'),
      task(21, 'Bins'),
      task(22, 'Grocery run'),
    ]
    // The user arranged Meds above Sleep, and Vacuum above everything else.
    const out = sortTasks(tasks, [11, 10, 20])
    expect(names(out)).toEqual(['Meds', 'Sleep', 'Exercise', 'Vacuum', 'Bins', 'Grocery run'])
  })
})
