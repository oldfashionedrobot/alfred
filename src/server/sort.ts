import type { TaskRow } from './schema.ts'

/**
 * The one ordering function. Runs on the server; every task array in a view
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
  // — the order is disposable and tolerant of stale ids.
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

/**
 * Baseline first, then category (uncategorised last), then name.
 *
 * The tie-break shared by the To do panel and History's columns. It is NOT
 * `sortTasks` — there is no `days.task_order` here, and baseline outranks
 * category deliberately.
 *
 * One implementation because two screens show the same tasks in what should be
 * the same order: a column in the grid and a row in the panel are the same
 * thing seen twice, and finding them ordered differently reads as a bug.
 */
export function byBaselineCategoryName(
  a: Pick<TaskRow, 'name' | 'is_baseline' | 'category'>,
  b: Pick<TaskRow, 'name' | 'is_baseline' | 'category'>,
): number {
  if (a.is_baseline !== b.is_baseline) return a.is_baseline ? -1 : 1
  if (a.category !== b.category) {
    if (a.category === null) return 1
    if (b.category === null) return -1
    return a.category.localeCompare(b.category)
  }
  return a.name.localeCompare(b.name)
}
