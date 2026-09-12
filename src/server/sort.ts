import type { TaskRow } from './schema.ts'

/**
 * The one ordering function. Runs on the server; every task array in a view
 * model arrives already ordered and the client renders it as given.
 *
 *   is_done      -> a done task sinks, whatever else is true of it
 *   is_baseline  -> bands never mix; that is what the baseline flag means
 *   taskOrder    -> the manual arrangement, where one exists
 *   category     -> uncategorised last
 *   name
 *
 * Anything not listed in taskOrder falls below everything that is.
 *
 * DONE OUTRANKS BASELINE, and not for the first time: `byBand` in
 * views/todo.ts already sinks a done baseline task below live ones, because a
 * struck-through row at the top is not what "the bare minimum to function"
 * should look like. Same argument here, so the same order.
 *
 * Called ONCE PER LIST since v15. Day's done rows sit at the bottom of the same
 * array rather than in a second one sorted separately, and `days.task_order`
 * still spans both halves — which is what makes a task you tick and untick come
 * back to where you put it.
 *
 * `is_done` is not a column: every caller derives it from the completions, so
 * the constraint asks for it separately rather than through the Pick.
 *
 * Must not mutate the input.
 */
export function sortTasks<
  T extends Pick<TaskRow, 'id' | 'name' | 'is_baseline' | 'category'> & { is_done: boolean },
>(tasks: T[], taskOrder: number[] | null): T[] {
  // Ids in taskOrder that match nothing shown today are simply never looked up
  // — the order is disposable and tolerant of stale ids.
  const position = new Map<number, number>()
  if (taskOrder) {
    for (const [i, id] of taskOrder.entries()) {
      if (!position.has(id)) position.set(id, i)
    }
  }

  return [...tasks].sort((a, b) => {
    if (a.is_done !== b.is_done) return a.is_done ? 1 : -1
    if (a.is_baseline !== b.is_baseline) return a.is_baseline ? -1 : 1

    const pa = position.get(a.id)
    const pb = position.get(b.id)
    if (pa !== undefined && pb !== undefined) return pa - pb
    // Anything unlisted falls below everything listed.
    if (pa !== undefined) return -1
    if (pb !== undefined) return 1
    // Both bands above are settled by the time we get here, so this contributes
    // only its category-then-name tail — the same tail the panel and History
    // sort by, rather than a second copy of it.
    return byBaselineCategoryName(a, b)
  })
}

/**
 * Baseline first, then category (uncategorised last), then name.
 *
 * The tie-break shared by Day's list, the To do panel and History's columns. It
 * is NOT `sortTasks` — there is no `days.task_order` here, and baseline
 * outranks category deliberately.
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
