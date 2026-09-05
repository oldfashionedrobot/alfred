import type { TaskRow } from './schema.ts'

/**
 * `sort()` from `.plan/views.md`. Runs on the server; every task array in a view
 * model arrives already ordered and the client renders it as given.
 *
 *   band 1 -> is_baseline
 *   band 2 -> everything else
 *   within a band -> taskOrder position if listed, else name, alphabetical
 *
 * Anything not listed in taskOrder falls below everything that is.
 * BANDS NEVER MIX — that is what the baseline flag means.
 *
 * Run independently over the active and completed arrays, so completed items
 * keep their arrangement inside their own section rather than being flattened.
 * Must not mutate the input.
 */
export function sortTasks<T extends Pick<TaskRow, 'id' | 'name' | 'is_baseline'>>(
  tasks: T[],
  taskOrder: number[] | null,
): T[] {
  // Ids in taskOrder that match nothing shown today are simply never looked up
  // — `.plan/data-model.md` has the order disposable and tolerant of stale ids.
  const position = new Map<number, number>()
  if (taskOrder) {
    for (const [i, id] of taskOrder.entries()) {
      if (!position.has(id)) position.set(id, i)
    }
  }

  const band = (t: T): number => (t.is_baseline ? 0 : 1)

  return [...tasks].sort((a, b) => {
    const bandDiff = band(a) - band(b)
    if (bandDiff !== 0) return bandDiff

    const pa = position.get(a.id)
    const pb = position.get(b.id)
    if (pa !== undefined && pb !== undefined) return pa - pb
    // Anything unlisted falls below everything listed.
    if (pa !== undefined) return -1
    if (pb !== undefined) return 1
    return a.name.localeCompare(b.name)
  })
}
