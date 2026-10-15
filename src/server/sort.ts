import type { TaskRow } from './schema.ts'

/**
 * The one ordering function. Runs on the server; every task array in a view
 * model arrives already ordered and the client renders it as given.
 *
 *   is_done      -> a done task sinks, whatever else is true of it
 *   taskOrder    -> the manual arrangement, where one exists
 *   category     -> uncategorised last
 *   name
 *
 * Anything not listed in taskOrder falls below everything that is — or, when
 * the caller says where, waits at `unlistedAt` instead. Day passes the position
 * of the day's first hour, so a task the arrangement does not place sits above
 * every hour, unscheduled, rather than under the last one.
 *
 * BASELINE IS NOT HERE, as of v17. It was a band above everything else until
 * the hour dividers needed live rows to render in their stored order: a band
 * hoists rows past their stored neighbours, and a divider placed between two of
 * them could not survive that. Baseline is a mark on the row now — its colour,
 * its weight and its tint — and never a position.
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
  T extends Pick<TaskRow, 'id' | 'name' | 'category'> & { is_done: boolean },
>(tasks: T[], taskOrder: number[] | null, unlistedAt?: number): T[] {
  const at = arrangementPosition(taskOrder, unlistedAt)
  return [...tasks].sort((a, b) => {
    if (a.is_done !== b.is_done) return a.is_done ? 1 : -1
    const pa = at(a.id)
    const pb = at(b.id)
    if (pa !== pb) return pa < pb ? -1 : 1
    // Listed rows never tie, so this is the unlisted rows' order, and the same
    // category-then-name tail the panel and the Tracker sort by.
    return byCategoryName(a, b)
  })
}

/**
 * Where a task sits in an arrangement: the index of its first listing, or
 * `unlistedAt - 0.5` — between the listing before that index and the one at it
 * — when it is not listed. Infinity when no `unlistedAt` is given, so unlisted
 * rows fall below every listed one.
 *
 * Shared by `sortTasks` and Day's hour placement, which both have to agree on
 * exactly this: a divider is drawn above however many live rows sit before it.
 *
 * Ids in taskOrder that match no task are simply never looked up — the order is
 * disposable and tolerant of stale ids. A duplicated id counts at its first
 * listing.
 */
export function arrangementPosition(
  taskOrder: number[] | null,
  unlistedAt?: number,
): (id: number) => number {
  const position = new Map<number, number>()
  for (const [i, id] of (taskOrder ?? []).entries()) {
    if (!position.has(id)) position.set(id, i)
  }
  const unlisted = unlistedAt === undefined ? Infinity : unlistedAt - 0.5
  return (id) => position.get(id) ?? unlisted
}

/**
 * Category (uncategorised last), then name.
 *
 * The order of the To do panel's groups and of History's columns, and the tail
 * of `sortTasks`. It is NOT `sortTasks` — there is no `days.task_order` here.
 *
 * One implementation because two screens show the same tasks in what should be
 * the same order: a column in the grid and a row in the panel are the same
 * thing seen twice, and finding them ordered differently reads as a bug.
 */
export function byCategoryName(
  a: Pick<TaskRow, 'name' | 'category'>,
  b: Pick<TaskRow, 'name' | 'category'>,
): number {
  if (a.category !== b.category) {
    if (a.category === null) return 1
    if (b.category === null) return -1
    return a.category.localeCompare(b.category)
  }
  return a.name.localeCompare(b.name)
}
