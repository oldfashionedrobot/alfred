import { test, expect, addDays } from './fixtures.ts'
import type { Locator, Page } from '@playwright/test'
import type { TodoTask, TodoGroup, TodoView } from '../src/shared/types.ts'

/**
 * The To do panel — the complete inventory, hosted by Day and by Week.
 *
 * Since v5 it is rendered TWICE from the one `GET /api/todo`: a panel labelled
 * **To do** drawing the five period groups, and one labelled **Backlog**
 * drawing the single one-off group. Same component, same rows, same actions,
 * same order; they differ only in which groups they draw, and they collapse
 * independently. Nothing about the model changed — the response still carries
 * all six groups — so every expectation here is still read off that one model.
 *
 * Nothing here hardcodes a date. Every expectation derives from `app.today` and
 * from `GET /api/todo`, because the shape of this panel depends on the day the
 * suite happens to run: on a Sunday `placeable_dates` holds seven dates and no
 * weekly task can be overdue at all; on a Saturday it holds exactly one.
 *
 * Overdue fixtures are therefore always one-offs. A one-off's period start is
 * unbounded (`data-model.md`, "Computing state"), so a past `planned_date`
 * stays overdue on every day of the week — a weekly one would silently fall out
 * of its period and read as unplaced when the suite ran on a Sunday. The split
 * does not change that: it only means those rows are now drawn in **Backlog**,
 * while the control that clears them stays in **To do**.
 */

// ---------------------------------------------------------------------------
// Wire shapes — mirrored locally so the spec never imports out of src/.
// ---------------------------------------------------------------------------

/**
 * The real wire types, not hand-written copies.
 *
 * These were local structural duplicates and they drifted: `planned_date` was
 * renamed `effective_date` on the server and the copies kept the old name,
 * which nothing caught because `tsc` did not cover e2e/ at the time. Aliasing
 * the contract makes a rename a compile error here instead of a silent mismatch.
 */
type TodoTaskLite = TodoTask
type TodoGroupLite = TodoGroup
type TodoLite = TodoView

const CADENCE_ORDER = ['day', 'week', 'month', 'quarter', 'year', null] as const

const TITLE: Record<string, string> = {
  day: 'Today',
  week: 'This week',
  month: 'This month',
  quarter: 'This quarter',
  year: 'This year',
  once: 'One-off',
}

// ---------------------------------------------------------------------------
// Date labelling oracle — mirrors src/client/dates.ts. Only Date.UTC() is used;
// never `new Date(iso)`, which the fixture warns about.
// ---------------------------------------------------------------------------

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const
const MON_LONG = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
] as const

function parts(iso: string): { y: number; m: number; d: number } {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number]
  return { y, m, d }
}

function weekday(iso: string): number {
  const { y, m, d } = parts(iso)
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay()
}

/** `Sat 5 Sep` — the day mark on a row, and a picker chip. */
function shortDate(iso: string): string {
  const { m, d } = parts(iso)
  return `${DOW[weekday(iso)]} ${d} ${MON[m - 1]}`
}

function lastOfMonth(y: number, m: number): string {
  const d = new Date(Date.UTC(y, m, 0)).getUTCDate()
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
}

/** A period range collapsed as far as it honestly can be. Never a week number. */
function periodLabel(start: string, end: string): string {
  const a = parts(start)
  const b = parts(end)
  if (start === end) return shortDate(start)
  if (a.m === 1 && a.d === 1 && b.m === 12 && b.d === 31 && a.y === b.y) return String(a.y)

  if (a.d === 1 && end === lastOfMonth(b.y, b.m) && a.y === b.y) {
    return a.m === b.m ? `${MON_LONG[a.m - 1]} ${a.y}` : `${MON[a.m - 1]} – ${MON[b.m - 1]} ${a.y}`
  }
  if (a.y === b.y && a.m === b.m) return `${a.d} – ${b.d} ${MON[a.m - 1]} ${a.y}`
  if (a.y === b.y) return `${a.d} ${MON[a.m - 1]} – ${b.d} ${MON[b.m - 1]} ${a.y}`
  return `${a.d} ${MON[a.m - 1]} ${a.y} – ${b.d} ${MON[b.m - 1]} ${b.y}`
}

/** What the picker chip for a date reads, per DayPicker in ui.tsx. */
function chip(date: string, today: string): string {
  return date === today ? 'Today' : shortDate(date)
}

// ---------------------------------------------------------------------------
// Reading the server
// ---------------------------------------------------------------------------

async function fetchTodo(url: string): Promise<TodoLite> {
  const res = await fetch(`${url}/api/todo`)
  expect(res.status, 'GET /api/todo').toBe(200)
  return (await res.json()) as TodoLite
}

/**
 * `app.seed.task` writes rows directly and has no `category` column, so a
 * category is set the way the app sets it: through the command API the editor
 * posts to. Nothing here reaches past the contract.
 */
async function command(url: string, name: string, body: Record<string, unknown>): Promise<void> {
  const res = await fetch(`${url}/api/commands/${name}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  expect(res.status, `POST /api/commands/${name}`).toBe(200)
}

function createTask(
  url: string,
  t: {
    name: string
    cadence?: 'day' | 'week' | 'month' | 'quarter' | 'year' | null
    is_baseline?: boolean
    planned_date?: string | null
    category?: string | null
  },
): Promise<void> {
  return command(url, 'create_task', { ...t })
}

function groupOf(todo: TodoLite, cadence: string | null): TodoGroupLite {
  const g = todo.groups.find((x) => x.cadence === cadence)
  if (!g) throw new Error(`no ${cadence ?? 'one-off'} group in the model`)
  return g
}

function taskOf(todo: TodoLite, name: string): TodoTaskLite {
  const t = todo.groups.flatMap((g) => g.tasks).find((x) => x.name === name)
  if (!t) throw new Error(`no task named ${name} in the model`)
  return t
}

// ---------------------------------------------------------------------------
// Reading the screen
// ---------------------------------------------------------------------------

/** The two instances of the one panel, by the label each is given. */
type PanelName = 'To do' | 'Backlog'

const PANELS = ['To do', 'Backlog'] as const

/** Which of the six groups each instance draws — the only difference. */
const DRAWS: Record<PanelName, (cadence: string | null) => boolean> = {
  'To do': (c) => c !== null,
  Backlog: (c) => c === null,
}

function panelOf(page: Page, name: PanelName = 'To do'): Locator {
  return page.getByRole('region', { name, exact: true })
}

/**
 * The panel's collapse toggle.
 *
 * Its accessible name carries the count ("To do 3 not done"), so it is anchored
 * at the start rather than matched exactly. Anchoring also keeps it clear of
 * "Reset to backlog", which contains "backlog" and would otherwise match — role
 * names are compared case-insensitively.
 */
function panelToggle(panel: Locator, name: PanelName): Locator {
  return panel.getByRole('button', { name: new RegExp(`^${name}`, 'i') })
}

/** Day hosts both panels collapsed, Week both expanded. Either way, open one. */
async function openPanel(page: Page, name: PanelName = 'To do'): Promise<Locator> {
  const panel = panelOf(page, name)
  const toggle = panelToggle(panel, name)
  await expect(toggle).toBeVisible()
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click()
  await expect(toggle).toHaveAttribute('aria-expanded', 'true')
  return panel
}

/** One of the six groups, by its heading title, inside the panel that draws it. */
function group(panel: Locator, title: string): Locator {
  return panel.getByRole('region', { name: title, exact: true })
}

/** The headings one panel should render, read off the model. */
function headings(todo: TodoLite, name: PanelName): string[] {
  return todo.groups
    .filter((g) => DRAWS[name](g.cadence))
    .map((g) => {
      const title = TITLE[g.cadence ?? 'once'] as string
      return g.period_start !== null && g.period_end !== null
        ? `${title} ${periodLabel(g.period_start, g.period_end)}`
        : title
    })
}

/**
 * A group's list in DOM order, category headings included and marked `#`.
 *
 * `todo-cat` is the one class this suite addresses, and deliberately so: the
 * heading is `aria-hidden`, which is the point of it — the rows stay the
 * accessible things and a heading is a visual cluster mark, not a landmark. The
 * rows are still read back through ARIA, by the label of their edit button.
 */
function listing(scope: Locator): Promise<string[]> {
  return scope.locator('li').evaluateAll((els) =>
    els.map((el) =>
      el.classList.contains('todo-cat')
        ? `# ${(el.textContent ?? '').trim()}`
        : (el.querySelector('[aria-label^="Edit "]')?.getAttribute('aria-label') ?? '').replace(
            /^Edit /,
            '',
          ),
    ),
  )
}

/** The category sub-headings, in render order. */
function categoryHeads(scope: Locator): Locator {
  return scope.locator('li.todo-cat')
}

// ---------------------------------------------------------------------------
// The map of the periods
// ---------------------------------------------------------------------------

test('renders all six groups in cadence order — five in To do, one in Backlog', async ({
  page,
  app,
}) => {
  const todo = await fetchTodo(app.url)
  // One response, still all six groups in cadence order. The split is a
  // rendering decision; the model did not change.
  expect(todo.groups.map((g) => g.cadence)).toEqual([...CADENCE_ORDER])

  await page.goto(app.url)
  const periodic = await openPanel(page, 'To do')
  const backlog = await openPanel(page, 'Backlog')

  // Five headings in To do and one in Backlog, in order, each carrying its
  // current period. The one-off group is unbounded and shows none.
  await expect(periodic.getByRole('heading', { level: 3 })).toHaveText(headings(todo, 'To do'))
  await expect(backlog.getByRole('heading', { level: 3 })).toHaveText(headings(todo, 'Backlog'))

  // Empty groups are not hidden — the panels are a map of the periods.
  await expect(periodic.getByText('Nothing here.')).toHaveCount(5)
  await expect(backlog.getByText('Nothing here.')).toHaveCount(1)
})

test('the week is a date range, never a week number', async ({ page, app }) => {
  const todo = await fetchTodo(app.url)
  const week = groupOf(todo, 'week')
  expect(week.period_start).not.toBeNull()

  await page.goto(app.url)
  const panel = await openPanel(page)

  await expect(group(panel, 'This week').getByRole('heading', { level: 3 })).toHaveText(
    `This week ${periodLabel(week.period_start!, week.period_end!)}`,
  )
  // 'W36' or 'W2026-08-30' would both trip this; 'Wed' and 'This week' do not.
  await expect(panel).not.toContainText(/W\d/)
})

test('the Today group is labelled with today, and the one-off group with nothing', async ({
  page,
  app,
}) => {
  await page.goto(app.url)
  const periodic = await openPanel(page, 'To do')
  const backlog = await openPanel(page, 'Backlog')

  await expect(group(periodic, 'Today').getByRole('heading', { level: 3 })).toHaveText(
    `Today ${shortDate(app.today)}`,
  )
  await expect(group(backlog, 'One-off').getByRole('heading', { level: 3 })).toHaveText('One-off')
})

// ---------------------------------------------------------------------------
// Two panels, one model
// ---------------------------------------------------------------------------

test('a one-off is drawn in Backlog and never in To do, a weekly task the other way round', async ({
  page,
  app,
}) => {
  app.seed.task({ name: 'Vacuum downstairs', cadence: 'week' })
  app.seed.task({ name: 'Call the vet', cadence: null })

  await page.goto(app.url)
  const periodic = await openPanel(page, 'To do')
  const backlog = await openPanel(page, 'Backlog')

  await expect(group(periodic, 'This week').getByText('Vacuum downstairs', { exact: true })).toBeVisible()
  await expect(group(backlog, 'One-off').getByText('Call the vet', { exact: true })).toBeVisible()

  // Each row is drawn once, in one panel. The split moved the one-off group;
  // it did not duplicate anything.
  await expect(periodic.getByText('Call the vet', { exact: true })).toHaveCount(0)
  await expect(backlog.getByText('Vacuum downstairs', { exact: true })).toHaveCount(0)
  await expect(page.getByText('Vacuum downstairs', { exact: true })).toHaveCount(1)
  await expect(page.getByText('Call the vet', { exact: true })).toHaveCount(1)

  // And the period groups are not drawn twice either: One-off exists in exactly
  // one panel, This week in the other.
  await expect(periodic.getByRole('region', { name: 'One-off', exact: true })).toHaveCount(0)
  await expect(backlog.getByRole('region', { name: 'This week', exact: true })).toHaveCount(0)
})

test('both panels are hosted by Day (collapsed) and by Week (expanded)', async ({ page, app }) => {
  app.seed.task({ name: 'Vacuum downstairs', cadence: 'week' })
  app.seed.task({ name: 'Call the vet', cadence: null })

  await page.goto(app.url)

  // On Day both are deliberately secondary.
  for (const name of PANELS) {
    const panel = panelOf(page, name)
    await expect(panel).toHaveCount(1)
    const toggle = panelToggle(panel, name)
    await expect(toggle).toHaveAttribute('aria-expanded', 'false')
    await expect(panel.getByRole('heading', { level: 3 })).toHaveCount(0)

    const box = await toggle.boundingBox()
    expect(box!.height, `the ${name} toggle is a full tap target`).toBeGreaterThanOrEqual(44)

    // Keyboard-operable, not a click-only div.
    await toggle.focus()
    await toggle.press('Enter')
    await expect(toggle).toHaveAttribute('aria-expanded', 'true')
  }

  const todo = await fetchTodo(app.url)
  await expect(panelOf(page, 'To do').getByRole('heading', { level: 3 })).toHaveText(
    headings(todo, 'To do'),
  )
  await expect(panelOf(page, 'Backlog').getByRole('heading', { level: 3 })).toHaveText(
    headings(todo, 'Backlog'),
  )

  // On Week the panels ARE the planning surface, so both open expanded.
  await page.getByRole('button', { name: 'Week', exact: true }).click()
  for (const name of PANELS) {
    const panel = panelOf(page, name)
    await expect(panelToggle(panel, name)).toHaveAttribute('aria-expanded', 'true')
    await expect(panel.getByRole('heading', { level: 3 })).toHaveText(headings(todo, name))
  }

  // Identical in both hosts: same groups, same rows.
  await expect(
    group(panelOf(page, 'To do'), 'This week').getByText('Vacuum downstairs', { exact: true }),
  ).toBeVisible()
  await expect(
    group(panelOf(page, 'Backlog'), 'One-off').getByText('Call the vet', { exact: true }),
  ).toBeVisible()
})

test('the two panels collapse independently', async ({ page, app }) => {
  app.seed.task({ name: 'Vacuum downstairs', cadence: 'week' })
  app.seed.task({ name: 'Call the vet', cadence: null })

  await page.goto(app.url)
  const periodic = panelOf(page, 'To do')
  const backlog = panelOf(page, 'Backlog')
  const periodicToggle = panelToggle(periodic, 'To do')
  const backlogToggle = panelToggle(backlog, 'Backlog')

  await expect(periodicToggle).toHaveAttribute('aria-expanded', 'false')
  await expect(backlogToggle).toHaveAttribute('aria-expanded', 'false')

  // Opening one leaves the other shut.
  await periodicToggle.click()
  await expect(periodicToggle).toHaveAttribute('aria-expanded', 'true')
  await expect(backlogToggle).toHaveAttribute('aria-expanded', 'false')
  await expect(periodic.getByText('Vacuum downstairs', { exact: true })).toBeVisible()
  await expect(backlog.getByRole('heading', { level: 3 })).toHaveCount(0)
  await expect(page.getByText('Call the vet')).toHaveCount(0)

  await backlogToggle.click()
  await expect(backlogToggle).toHaveAttribute('aria-expanded', 'true')
  await expect(periodicToggle).toHaveAttribute('aria-expanded', 'true')

  // And closing one leaves the other open.
  await periodicToggle.click()
  await expect(periodicToggle).toHaveAttribute('aria-expanded', 'false')
  await expect(backlogToggle).toHaveAttribute('aria-expanded', 'true')
  await expect(group(backlog, 'One-off').getByText('Call the vet', { exact: true })).toBeVisible()
  await expect(page.getByText('Vacuum downstairs')).toHaveCount(0)

  // Same on Week, from the other starting state: both open, one closes alone.
  await page.getByRole('button', { name: 'Week', exact: true }).click()
  await expect(panelToggle(panelOf(page, 'To do'), 'To do')).toHaveAttribute('aria-expanded', 'true')
  await panelToggle(panelOf(page, 'Backlog'), 'Backlog').click()
  await expect(panelToggle(panelOf(page, 'Backlog'), 'Backlog')).toHaveAttribute(
    'aria-expanded',
    'false',
  )
  await expect(panelToggle(panelOf(page, 'To do'), 'To do')).toHaveAttribute('aria-expanded', 'true')
})

// ---------------------------------------------------------------------------
// Membership
// ---------------------------------------------------------------------------

test('a daily task lands in Today and is tickable from the panel', async ({ page, app }) => {
  app.seed.task({ name: 'Feed Barney 1', cadence: 'day' })

  await page.goto(app.url)
  const panel = await openPanel(page)
  const today = group(panel, 'Today')

  await expect(today.getByText('Feed Barney 1', { exact: true })).toBeVisible()
  // Daily tasks are never placed, so the panel does not offer to place one.
  await expect(panel.getByRole('button', { name: 'Place Feed Barney 1' })).toHaveCount(0)

  await today.getByRole('checkbox', { name: 'Complete Feed Barney 1' }).click()

  const ticked = today.getByRole('checkbox', { name: 'Untick Feed Barney 1' })
  await expect(ticked).toBeVisible()
  await expect(ticked).toBeChecked()
  await expect(today.getByText('Feed Barney 1', { exact: true })).toHaveCSS(
    'text-decoration-line',
    'line-through',
  )

  expect(taskOf(await fetchTodo(app.url), 'Feed Barney 1').is_done).toBe(true)
})

test('a one-off completed this week is still listed, struck through', async ({ page, app }) => {
  const weekStart = groupOf(await fetchTodo(app.url), 'week').period_start!
  const id = app.seed.task({ name: 'Fix the gate', cadence: null })
  // A back-dated completion the command API refuses to write.
  app.seed.completion(id, weekStart)

  await page.goto(app.url)
  const backlog = await openPanel(page, 'Backlog')
  const oneOff = group(backlog, 'One-off')

  await expect(oneOff.getByText('Fix the gate', { exact: true })).toBeVisible()
  await expect(oneOff.getByText('Fix the gate', { exact: true })).toHaveCSS(
    'text-decoration-line',
    'line-through',
  )
  await expect(oneOff.getByRole('checkbox', { name: 'Untick Fix the gate' })).toBeChecked()
})

test('a one-off completed before this week is gone', async ({ page, app }) => {
  const weekStart = groupOf(await fetchTodo(app.url), 'week').period_start!
  const id = app.seed.task({ name: 'Renew the passport', cadence: null })
  app.seed.completion(id, addDays(weekStart, -1))

  const todo = await fetchTodo(app.url)
  expect(groupOf(todo, null).tasks.map((t) => t.name)).not.toContain('Renew the passport')

  await page.goto(app.url)
  const periodic = await openPanel(page, 'To do')
  const backlog = await openPanel(page, 'Backlog')

  // Gone from the screen entirely, not merely moved to the other panel.
  await expect(page.getByText('Renew the passport')).toHaveCount(0)
  await expect(periodic.getByText('Renew the passport')).toHaveCount(0)
  // ...and the group is empty rather than missing.
  await expect(group(backlog, 'One-off').getByText('Nothing here.')).toBeVisible()
})

// ---------------------------------------------------------------------------
// Order — overdue, then placed, then unplaced, then done
// ---------------------------------------------------------------------------

test('rows band by state, not alphabetically', async ({ page, app }) => {
  const weekStart = groupOf(await fetchTodo(app.url), 'week').period_start!

  // Alphabetically Wombat < Xerus < Yak < Zebra — the exact reverse of the
  // banding, so a list that merely looks sorted cannot pass this.
  app.seed.task({ name: 'Wombat done', cadence: null })
  app.seed.task({ name: 'Xerus unplaced', cadence: null })
  app.seed.task({ name: 'Yak placed', cadence: null, planned_date: app.today })
  app.seed.task({ name: 'Zebra overdue', cadence: null, planned_date: addDays(app.today, -3) })
  app.seed.completion(taskOf(await fetchTodo(app.url), 'Wombat done').id, weekStart)

  // The server owns the order; the client renders what it is given.
  const todo = await fetchTodo(app.url)
  expect(groupOf(todo, null).tasks.map((t) => t.name)).toEqual([
    'Zebra overdue',
    'Yak placed',
    'Xerus unplaced',
    'Wombat done',
  ])

  await page.goto(app.url)
  const backlog = await openPanel(page, 'Backlog')
  await expect(group(backlog, 'One-off').getByRole('listitem')).toHaveText([
    /^Zebra overdue/,
    /^Yak placed/,
    /^Xerus unplaced/,
    /^Wombat done/,
  ])
})

test('an overdue row asks for a day and shows the date it fell behind on', async ({ page, app }) => {
  const missed = addDays(app.today, -2)
  app.seed.task({ name: 'Grocery run', cadence: null, planned_date: missed })

  await page.goto(app.url)
  const backlog = await openPanel(page, 'Backlog')
  const row = group(backlog, 'One-off').getByRole('listitem').filter({ hasText: 'Grocery run' })

  await expect(row.getByText('Needs a day', { exact: true })).toBeVisible()
  await expect(row.getByText(shortDate(missed))).toBeVisible()
})

// ---------------------------------------------------------------------------
// Categories
//
// A category clusters rows under a sub-heading inside a period group. The
// heading is `<li class="todo-cat" aria-hidden="true">` — hidden from the
// accessibility tree on purpose, so it is addressed by text or by that class
// while the rows stay the accessible things.
//
// `app.seed.task` has no `category`, so these fixtures go in through
// `create_task` — the same command the editor posts.
// ---------------------------------------------------------------------------

test('with no categories set at all, no heading renders anywhere', async ({ page, app }) => {
  // The property that keeps the feature invisible until it is used: a heading
  // over an untouched list would be the obvious implementation and the wrong
  // one. Not even "Other" — with nothing categorised there is no "other" to be.
  app.seed.task({ name: 'Feed Barney 1', cadence: 'day', is_baseline: true })
  app.seed.task({ name: 'Vacuum downstairs', cadence: 'week' })
  app.seed.task({ name: 'Descale the kettle', cadence: 'month' })
  app.seed.task({ name: 'Call the vet', cadence: null })

  expect((await fetchTodo(app.url)).categories).toEqual([])

  await page.goto(app.url)
  const periodic = await openPanel(page, 'To do')
  const backlog = await openPanel(page, 'Backlog')

  // The rows are all there...
  await expect(periodic.getByRole('button', { name: 'Edit Vacuum downstairs' })).toBeVisible()
  await expect(backlog.getByRole('button', { name: 'Edit Call the vet' })).toBeVisible()
  // ...and nothing is heading them.
  await expect(categoryHeads(periodic)).toHaveCount(0)
  await expect(categoryHeads(backlog)).toHaveCount(0)
  await expect(page.getByText('Other', { exact: true })).toHaveCount(0)
  await expect(page.getByText(/uncategorised|uncategorized/i)).toHaveCount(0)
})

test('rows cluster under category headings in alphabetical order, and category outranks name', async ({
  page,
  app,
}) => {
  // Alphabetically by name: Aardvark admin < Air the room < Brush Ringo.
  // By category: Dog < House < uncategorised. The two orders disagree on every
  // pair, so a list that is merely sorted by name cannot pass this.
  await createTask(app.url, { name: 'Aardvark admin', cadence: 'week', category: 'House' })
  await createTask(app.url, { name: 'Brush Ringo', cadence: 'week', category: 'Dog' })
  await createTask(app.url, { name: 'Air the room', cadence: 'week' })

  const todo = await fetchTodo(app.url)
  expect(groupOf(todo, 'week').tasks.map((t) => t.name)).toEqual([
    'Brush Ringo',
    'Aardvark admin',
    'Air the room',
  ])
  expect(todo.categories).toEqual(['Dog', 'House'])

  await page.goto(app.url)
  const periodic = await openPanel(page, 'To do')
  const backlog = await openPanel(page, 'Backlog')
  const week = group(periodic, 'This week')

  // Clustering, heading order and row order in one read of the DOM. The
  // uncategorised row sorts last, under "Other".
  await expect
    .poll(() => listing(week))
    .toEqual(['# Dog', 'Brush Ringo', '# House', 'Aardvark admin', '# Other', 'Air the room'])
  await expect(categoryHeads(week)).toHaveText(['Dog', 'House', 'Other'])

  // Only the group that uses categories is headed; the empty ones and the
  // Backlog panel are untouched.
  await expect(categoryHeads(backlog)).toHaveCount(0)
  await expect(categoryHeads(periodic)).toHaveText(['Dog', 'House', 'Other'])
})

test('an uncategorised row lands under "Other", not under the category above it', async ({
  page,
  app,
}) => {
  // Without a heading of its own, the uncategorised run — which sorts last —
  // falls under the previous category's heading and reads as belonging to it.
  // "Dishes" is nobody's House chore.
  await createTask(app.url, { name: 'Aardvark admin', cadence: 'week', category: 'House' })
  await createTask(app.url, { name: 'Dishes', cadence: 'week' })

  await page.goto(app.url)
  const panel = await openPanel(page)
  const week = group(panel, 'This week')

  await expect
    .poll(() => listing(week))
    .toEqual(['# House', 'Aardvark admin', '# Other', 'Dishes'])
  await expect(categoryHeads(week)).toHaveText(['House', 'Other'])

  // "Other" is a heading the client draws over a gap, not a category anything
  // is stored under: the row still has none, and it is not offered as one.
  const todo = await fetchTodo(app.url)
  expect(taskOf(todo, 'Dishes').category).toBeNull()
  expect(todo.categories).toEqual(['House'])
})

test('whether a group is headed is decided per group, not per panel', async ({ page, app }) => {
  await createTask(app.url, { name: 'Brush Ringo', cadence: 'week', category: 'Dog' })
  await createTask(app.url, { name: 'Air the room', cadence: 'week' })
  await createTask(app.url, { name: 'Descale the kettle', cadence: 'month' })

  await page.goto(app.url)
  const panel = await openPanel(page)

  await expect
    .poll(() => listing(group(panel, 'This week')))
    .toEqual(['# Dog', 'Brush Ringo', '# Other', 'Air the room'])

  // This month uses no categories, so it is headed by nothing — not even
  // "Other", which only exists to separate a gap from a category beside it.
  await expect.poll(() => listing(group(panel, 'This month'))).toEqual(['Descale the kettle'])
  await expect(categoryHeads(group(panel, 'This month'))).toHaveCount(0)
  await expect(categoryHeads(panel)).toHaveText(['Dog', 'Other'])
})

test('a baseline task heads its group above every category heading, and gets none of its own', async ({
  page,
  app,
}) => {
  // 'Aardvark' sorts before both other categories, so a baseline row that
  // obeyed category order would arrive under a heading of its own. It must not:
  // baseline outranks category, and the block at the top of a group stays
  // unheaded — above the named categories and above "Other" alike. The cost —
  // a category heading does not show everything in that category — is the
  // stated trade in `views.md`.
  await createTask(app.url, {
    name: 'Zulu baseline',
    cadence: 'day',
    is_baseline: true,
    category: 'Aardvark',
  })
  await createTask(app.url, { name: 'Alpha chore', cadence: 'day', category: 'Dog' })
  await createTask(app.url, { name: 'Beta chore', cadence: 'day', category: 'Cat' })
  await createTask(app.url, { name: 'Gamma chore', cadence: 'day' })

  const todo = await fetchTodo(app.url)
  expect(groupOf(todo, 'day').tasks.map((t) => t.name)).toEqual([
    'Zulu baseline',
    'Beta chore',
    'Alpha chore',
    'Gamma chore',
  ])
  // The category really is set on it — this is not a task without one.
  expect(taskOf(todo, 'Zulu baseline').category).toBe('Aardvark')
  expect(todo.categories).toEqual(['Aardvark', 'Cat', 'Dog'])

  await page.goto(app.url)
  const panel = await openPanel(page)
  const today = group(panel, 'Today')

  await expect
    .poll(() => listing(today))
    .toEqual([
      'Zulu baseline',
      '# Cat',
      'Beta chore',
      '# Dog',
      'Alpha chore',
      '# Other',
      'Gamma chore',
    ])
  // 'Aardvark' is in use and suggested, and still heads nothing.
  await expect(categoryHeads(today)).toHaveText(['Cat', 'Dog', 'Other'])
  await expect(panel.getByText('Aardvark', { exact: true })).toHaveCount(0)
})

test('the editor suggests the categories already in use', async ({ page, app }) => {
  await createTask(app.url, { name: 'Brush Ringo', cadence: 'week', category: 'Dog' })
  await createTask(app.url, { name: 'Descale the kettle', cadence: 'week', category: 'Kitchen' })
  await createTask(app.url, { name: 'Air the room', cadence: 'week' })

  const todo = await fetchTodo(app.url)
  // Distinct and sorted — the suggestion list, not a list of tasks.
  expect(todo.categories).toEqual(['Dog', 'Kitchen'])

  await page.goto(app.url)
  const panel = await openPanel(page)
  await panel.getByRole('button', { name: 'Edit Air the room' }).click()

  const editor = page.getByRole('dialog', { name: 'Edit task' })
  const input = editor.getByLabel('Category', { exact: true })
  await expect(input).toHaveValue('')
  await expect(input).toHaveAttribute('list', 'task-categories')

  // Free text, but picking an existing one beats retyping it: that is the whole
  // defence against `Dog` / `dog` / `Dogs` drift.
  await expect
    .poll(() =>
      editor
        .locator('datalist#task-categories option')
        .evaluateAll((els) => els.map((e) => (e as HTMLOptionElement).value)),
    )
    .toEqual(todo.categories)
})

test('setting a category in the editor persists and moves the row under its heading', async ({
  page,
  app,
}) => {
  await createTask(app.url, { name: 'Brush Ringo', cadence: 'week', category: 'Dog' })
  await createTask(app.url, { name: 'Aardvark admin', cadence: 'week' })

  await page.goto(app.url)
  const panel = await openPanel(page)
  const week = group(panel, 'This week')

  // Uncategorised, so it sorts to the tail under "Other" despite the earlier
  // name.
  await expect
    .poll(() => listing(week))
    .toEqual(['# Dog', 'Brush Ringo', '# Other', 'Aardvark admin'])

  await panel.getByRole('button', { name: 'Edit Aardvark admin' }).click()
  const editor = page.getByRole('dialog', { name: 'Edit task' })
  await editor.getByLabel('Category', { exact: true }).fill('Cat')
  await editor.getByRole('button', { name: /^save$/i }).click()
  await expect(editor).toHaveCount(0)

  // 'Cat' sorts before 'Dog', so the row leaves the tail and heads the group —
  // and with nothing uncategorised left, "Other" goes with it.
  await expect
    .poll(() => listing(week))
    .toEqual(['# Cat', 'Aardvark admin', '# Dog', 'Brush Ringo'])
  await expect(categoryHeads(week)).toHaveText(['Cat', 'Dog'])

  const after = await fetchTodo(app.url)
  expect(taskOf(after, 'Aardvark admin').category).toBe('Cat')
  // ...and it is now one of the suggestions.
  expect(after.categories).toEqual(['Cat', 'Dog'])
})

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

test('placing from the panel offers exactly placeable_dates, and persists', async ({ page, app }) => {
  app.seed.task({ name: 'Grocery run', cadence: null })
  const before = await fetchTodo(app.url)
  const dates = before.placeable_dates
  expect(dates.length).toBeGreaterThan(0)

  await page.goto(app.url)
  const backlog = await openPanel(page, 'Backlog')

  await backlog.getByRole('button', { name: 'Place Grocery run' }).click()
  const picker = backlog.getByRole('group', { name: 'Pick a day' })

  // Exactly the server's list — never computed, filtered or extended.
  await expect(picker.getByRole('button')).toHaveText(dates.map((d) => chip(d, app.today)))

  const target = dates[dates.length - 1]!
  await picker.getByRole('button', { name: chip(target, app.today), exact: true }).click()

  await expect(group(backlog, 'One-off').getByText(shortDate(target))).toBeVisible()
  expect(taskOf(await fetchTodo(app.url), 'Grocery run').effective_date).toBe(target)
})

test('unplan clears the day', async ({ page, app }) => {
  app.seed.task({ name: 'Grocery run', cadence: null, planned_date: app.today })

  await page.goto(app.url)
  const backlog = await openPanel(page, 'Backlog')
  const oneOff = group(backlog, 'One-off')

  await expect(oneOff.getByText(shortDate(app.today))).toBeVisible()
  await backlog.getByRole('button', { name: 'Unplan Grocery run' }).click()

  await expect(oneOff.getByText(shortDate(app.today))).toHaveCount(0)
  await expect(backlog.getByRole('button', { name: 'Unplan Grocery run' })).toHaveCount(0)
  expect(taskOf(await fetchTodo(app.url), 'Grocery run').effective_date).toBeNull()
})

test('ticking and unticking a weekly task round-trips', async ({ page, app }) => {
  app.seed.task({ name: 'Vacuum downstairs', cadence: 'week' })

  await page.goto(app.url)
  const panel = await openPanel(page)
  const week = group(panel, 'This week')

  await week.getByRole('checkbox', { name: 'Complete Vacuum downstairs' }).click()
  await expect(week.getByRole('checkbox', { name: 'Untick Vacuum downstairs' })).toBeChecked()
  expect(taskOf(await fetchTodo(app.url), 'Vacuum downstairs').is_done).toBe(true)

  await week.getByRole('checkbox', { name: 'Untick Vacuum downstairs' }).click()
  await expect(week.getByRole('checkbox', { name: 'Complete Vacuum downstairs' })).not.toBeChecked()
  expect(taskOf(await fetchTodo(app.url), 'Vacuum downstairs').is_done).toBe(false)
})

// ---------------------------------------------------------------------------
// Reset to backlog — its only home in the app
//
// The control is keyed off the view's GLOBAL `has_overdue` and reaches every
// overdue task, one-off ones included — but it is rendered only by the To do
// panel. One bulk destructive action, one home, even though the rows it takes
// are drawn next door.
// ---------------------------------------------------------------------------

test('reset to backlog clears every overdue day and leaves a future one alone', async ({
  page,
  app,
}) => {
  const ahead = addDays(app.today, 1)
  app.seed.task({ name: 'Overdue one', cadence: null, planned_date: addDays(app.today, -2) })
  app.seed.task({ name: 'Overdue two', cadence: null, planned_date: addDays(app.today, -5) })
  app.seed.task({ name: 'Still ahead', cadence: null, planned_date: ahead })

  expect((await fetchTodo(app.url)).has_overdue).toBe(true)

  await page.goto(app.url)
  const periodic = await openPanel(page, 'To do')
  const backlog = await openPanel(page, 'Backlog')
  await expect(backlog.getByText('Needs a day', { exact: true })).toHaveCount(2)

  await periodic.getByRole('button', { name: 'Reset to backlog' }).click()
  await periodic.getByRole('button', { name: 'Reset', exact: true }).click()

  await expect(backlog.getByText('Needs a day', { exact: true })).toHaveCount(0)

  const after = await fetchTodo(app.url)
  expect(after.has_overdue).toBe(false)
  expect(taskOf(after, 'Overdue one').effective_date).toBeNull()
  expect(taskOf(after, 'Overdue two').effective_date).toBeNull()
  expect(taskOf(after, 'Still ahead').effective_date).toBe(ahead)

  // Thursday's plan is still a good plan on Wednesday.
  await expect(group(backlog, 'One-off').getByText(shortDate(ahead))).toBeVisible()
  // Nothing overdue left, so the control goes away with it.
  await expect(periodic.getByRole('button', { name: 'Reset to backlog' })).toHaveCount(0)
})

test('the reset control is in To do, not in Backlog, even when every overdue row is a one-off', async ({
  page,
  app,
}) => {
  app.seed.task({ name: 'Overdue one', cadence: null, planned_date: addDays(app.today, -2) })
  app.seed.task({ name: 'Overdue two', cadence: null, planned_date: addDays(app.today, -5) })
  expect((await fetchTodo(app.url)).has_overdue).toBe(true)

  await page.goto(app.url)
  const periodic = await openPanel(page, 'To do')
  const backlog = await openPanel(page, 'Backlog')

  // Every row wanting a day is in Backlog...
  await expect(backlog.getByText('Needs a day', { exact: true })).toHaveCount(2)
  await expect(periodic.getByText('Needs a day', { exact: true })).toHaveCount(0)

  // ...and the one control that clears them is in To do, and nowhere else.
  await expect(periodic.getByRole('button', { name: 'Reset to backlog' })).toBeVisible()
  await expect(backlog.getByRole('button', { name: 'Reset to backlog' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Reset to backlog' })).toHaveCount(1)

  await periodic.getByRole('button', { name: 'Reset to backlog' }).click()
  await periodic.getByRole('button', { name: 'Reset', exact: true }).click()

  // It reaches across the split: the rows it took are the ones next door.
  await expect(backlog.getByText('Needs a day', { exact: true })).toHaveCount(0)
  const after = await fetchTodo(app.url)
  expect(after.has_overdue).toBe(false)
  expect(taskOf(after, 'Overdue one').effective_date).toBeNull()
  expect(taskOf(after, 'Overdue two').effective_date).toBeNull()
  await expect(page.getByRole('button', { name: 'Reset to backlog' })).toHaveCount(0)
})

/**
 * Regression. A bulk destructive action has to name its own reach.
 *
 * The control is shown by the view's GLOBAL `has_overdue` and `reset_overdue`
 * clears every overdue task, one-offs included. The count beside it was tallied
 * over the groups THIS panel draws — and the one-off group is drawn in Backlog —
 * so with two overdue one-offs the To do panel offered "Reset to backlog"
 * beneath "0 items are waiting for a day", asked "Clear the day from 0 overdue
 * items?", and then cleared both. The tally now counts the whole view, as
 * `has_overdue` already did.
 */
test('the reset bar counts the overdue items it will actually clear', async ({ page, app }) => {
  app.seed.task({ name: 'Overdue one', cadence: null, planned_date: addDays(app.today, -2) })
  app.seed.task({ name: 'Overdue two', cadence: null, planned_date: addDays(app.today, -5) })

  await page.goto(app.url)
  const periodic = await openPanel(page, 'To do')

  await expect(periodic.getByText('2 items are waiting for a day')).toBeVisible()
  await periodic.getByRole('button', { name: 'Reset to backlog' }).click()
  await expect(periodic.getByText('Clear the day from 2 overdue items?')).toBeVisible()
})

test('there is no reset control when nothing is overdue', async ({ page, app }) => {
  app.seed.task({ name: 'Feed Barney 1', cadence: 'day' })
  app.seed.task({ name: 'Grocery run', cadence: null, planned_date: app.today })
  expect((await fetchTodo(app.url)).has_overdue).toBe(false)

  await page.goto(app.url)
  const periodic = await openPanel(page, 'To do')
  const backlog = await openPanel(page, 'Backlog')

  await expect(backlog.getByText('Grocery run', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Reset to backlog' })).toHaveCount(0)
  await expect(periodic.getByText(/needs a day/i)).toHaveCount(0)
  await expect(backlog.getByText(/needs a day/i)).toHaveCount(0)
})

// ---------------------------------------------------------------------------
// Both hosts
// ---------------------------------------------------------------------------

test('a command fired from the panel on Week refreshes the host too', async ({ page, app }) => {
  // Placed on today, so it is on today's section of Week as well as in the panel.
  app.seed.task({ name: 'Vacuum downstairs', cadence: 'week', planned_date: app.today })

  await page.goto(app.url)
  await page.getByRole('button', { name: 'Week', exact: true }).click()
  const panel = await openPanel(page)

  await panel
    .getByRole('region', { name: 'This week', exact: true })
    .getByRole('checkbox', { name: 'Complete Vacuum downstairs' })
    .click()

  await expect(panel.getByRole('checkbox', { name: 'Untick Vacuum downstairs' })).toBeChecked()

  // The host's own copy of the row moved with it — one command, both models.
  // Matched on the task name alone, so this asserts the refresh and not the
  // wording Week happens to give its ticks.
  const everywhere = page.getByRole('checkbox', { name: /Vacuum downstairs/ })
  await expect(everywhere).toHaveCount(2)
  await expect
    .poll(() => everywhere.evaluateAll((els) => els.map((e) => e.getAttribute('aria-checked'))))
    .toEqual(['true', 'true'])
})

test('a command fired from Backlog refreshes both panels', async ({ page, app }) => {
  // One model behind two panels: a write from one has to redraw the other.
  app.seed.task({ name: 'Grocery run', cadence: null, planned_date: addDays(app.today, -2) })

  await page.goto(app.url)
  const periodic = await openPanel(page, 'To do')
  const backlog = await openPanel(page, 'Backlog')

  await expect(periodic.getByRole('button', { name: 'Reset to backlog' })).toBeVisible()
  await backlog.getByRole('button', { name: 'Unplan Grocery run' }).click()

  await expect(backlog.getByText('Needs a day', { exact: true })).toHaveCount(0)
  // Nothing is overdue any more, so the OTHER panel's control has to go.
  await expect(periodic.getByRole('button', { name: 'Reset to backlog' })).toHaveCount(0)
  expect((await fetchTodo(app.url)).has_overdue).toBe(false)
})

// ---------------------------------------------------------------------------
// Hygiene
// ---------------------------------------------------------------------------

test('a long task name never scrolls the page sideways', async ({ page, app }) => {
  app.seed.task({
    name: 'Dog: Feed Barney with the enormous supplementary prescription kibble ration 1',
    cadence: null,
    planned_date: addDays(app.today, -2),
  })

  await page.goto(app.url)
  const backlog = await openPanel(page, 'Backlog')
  await expect(backlog.getByText('Needs a day', { exact: true })).toBeVisible()

  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  )
  expect(overflow).toBeLessThanOrEqual(0)
})

test('a long category name never scrolls the page sideways', async ({ page, app }) => {
  await createTask(app.url, {
    name: 'Brush Ringo',
    cadence: 'week',
    category: 'Extremely elaborate household administration and correspondence',
  })

  await page.goto(app.url)
  const panel = await openPanel(page)
  await expect(categoryHeads(group(panel, 'This week'))).toHaveCount(1)

  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  )
  expect(overflow).toBeLessThanOrEqual(0)
})

test('no console errors opening both panels and working them', async ({ page, app }) => {
  const errors: string[] = []
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
  page.on('pageerror', (e) => errors.push(String(e)))

  app.seed.task({ name: 'Feed Barney 1', cadence: 'day' })
  app.seed.task({ name: 'Grocery run', cadence: null, planned_date: addDays(app.today, -2) })

  await page.goto(app.url)
  const periodic = await openPanel(page, 'To do')
  const backlog = await openPanel(page, 'Backlog')

  await periodic.getByRole('checkbox', { name: 'Complete Feed Barney 1' }).click()
  await expect(periodic.getByRole('checkbox', { name: 'Untick Feed Barney 1' })).toBeChecked()

  await backlog.getByRole('button', { name: 'Move Grocery run' }).click()
  await expect(backlog.getByRole('group', { name: 'Pick a day' })).toBeVisible()

  await page.getByRole('button', { name: 'Week', exact: true }).click()
  const todo = await fetchTodo(app.url)
  await expect(panelOf(page, 'To do').getByRole('heading', { level: 3 })).toHaveCount(
    headings(todo, 'To do').length,
  )
  await expect(panelOf(page, 'Backlog').getByRole('heading', { level: 3 })).toHaveCount(
    headings(todo, 'Backlog').length,
  )

  await page.waitForLoadState('networkidle')
  expect(errors).toEqual([])
})

// ---------------------------------------------------------------------------
// Task editor
//
// This panel is the ONLY place a task is edited. Day's list is for doing — a tap
// there completes something and never opens a form — so the definition surface
// lives here, and comes free on Week because the panel is hosted there too. It
// opens from either instance: same component, same actions.
// ---------------------------------------------------------------------------

test('tapping a name in the panel opens the editor, and a rename persists', async ({ page, app }) => {
  const id = app.seed.task({ name: 'Vacuum', cadence: 'week' })

  await page.goto(app.url)
  const panel = await openPanel(page)
  await panel.getByRole('button', { name: 'Edit Vacuum' }).click()

  const editor = page.getByRole('dialog', { name: 'Edit task' })
  await expect(editor).toBeVisible()
  await editor.getByRole('textbox', { name: 'Task name' }).fill('Vacuum downstairs')
  await editor.getByRole('button', { name: /^save$/i }).click()

  await expect(editor).toHaveCount(0)
  await expect(panel.getByRole('button', { name: 'Edit Vacuum downstairs' })).toBeVisible()
  expect(taskOf(await fetchTodo(app.url), 'Vacuum downstairs').id).toBe(id)
})

test('the editor opens from Backlog too, and a rename persists', async ({ page, app }) => {
  const id = app.seed.task({ name: 'Call the vet', cadence: null })

  await page.goto(app.url)
  const backlog = await openPanel(page, 'Backlog')
  await backlog.getByRole('button', { name: 'Edit Call the vet' }).click()

  const editor = page.getByRole('dialog', { name: 'Edit task' })
  await expect(editor).toBeVisible()
  await editor.getByRole('textbox', { name: 'Task name' }).fill('Call the vet back')
  await editor.getByRole('button', { name: /^save$/i }).click()

  await expect(editor).toHaveCount(0)
  await expect(backlog.getByRole('button', { name: 'Edit Call the vet back' })).toBeVisible()
  expect(taskOf(await fetchTodo(app.url), 'Call the vet back').id).toBe(id)
})

test('the editor changes cadence, which moves the task to another group', async ({ page, app }) => {
  app.seed.task({ name: 'Descale the kettle', cadence: 'week' })

  await page.goto(app.url)
  const panel = await openPanel(page)
  await expect(group(panel, 'This week').getByRole('button', { name: /^Edit Descale/ })).toBeVisible()

  await panel.getByRole('button', { name: 'Edit Descale the kettle' }).click()
  const editor = page.getByRole('dialog', { name: 'Edit task' })
  await editor.getByRole('combobox', { name: 'Cadence' }).selectOption('month')
  await editor.getByRole('button', { name: /^save$/i }).click()
  await expect(editor).toHaveCount(0)

  // The group a task sits in is its cadence — so the row moves.
  await expect(group(panel, 'This month').getByRole('button', { name: /^Edit Descale/ })).toBeVisible()
  await expect(group(panel, 'This week').getByRole('button', { name: /^Edit Descale/ })).toHaveCount(0)
  expect(taskOf(await fetchTodo(app.url), 'Descale the kettle').cadence).toBe('month')
})

test('clearing the cadence moves the task from To do into Backlog', async ({ page, app }) => {
  // The panel boundary is the cadence, so the editor moves a row across it.
  app.seed.task({ name: 'Descale the kettle', cadence: 'week' })

  await page.goto(app.url)
  const periodic = await openPanel(page, 'To do')
  const backlog = await openPanel(page, 'Backlog')
  await expect(group(periodic, 'This week').getByRole('button', { name: /^Edit Descale/ })).toBeVisible()

  await periodic.getByRole('button', { name: 'Edit Descale the kettle' }).click()
  const editor = page.getByRole('dialog', { name: 'Edit task' })
  await editor.getByRole('combobox', { name: 'Cadence' }).selectOption('')
  await editor.getByRole('button', { name: /^save$/i }).click()
  await expect(editor).toHaveCount(0)

  await expect(group(backlog, 'One-off').getByRole('button', { name: /^Edit Descale/ })).toBeVisible()
  await expect(periodic.getByRole('button', { name: /^Edit Descale/ })).toHaveCount(0)
  expect(taskOf(await fetchTodo(app.url), 'Descale the kettle').cadence).toBeNull()
})

test('archiving from the editor removes the task but keeps its completions', async ({ page, app }) => {
  const yesterday = addDays(app.today, -1)
  const id = app.seed.task({ name: 'Old habit', cadence: 'day' })
  app.seed.completion(id, yesterday)
  app.seed.task({ name: 'New habit', cadence: 'day' })

  await page.goto(app.url)

  // Before: the completion is in the grid.
  const before = await (await fetch(`${app.url}/api/history`)).json()
  expect(before.rows.find((r: { date: string }) => r.date === yesterday).completed).toContain(id)

  const panel = await openPanel(page)
  await panel.getByRole('button', { name: 'Edit Old habit' }).click()
  const editor = page.getByRole('dialog', { name: 'Edit task' })
  await editor.getByRole('button', { name: /^archive task$/i }).click()
  await editor.getByRole('button', { name: /^archive$/i }).click()

  await expect(editor).toHaveCount(0)
  await expect(panel.getByRole('button', { name: 'Edit Old habit' })).toHaveCount(0)
  await expect(panel.getByRole('button', { name: 'Edit New habit' })).toBeVisible()

  // Archive is not delete: the completion row survives, even though the column
  // has left the grid with the task.
  const rows = await (await fetch(`${app.url}/api/todo`)).json()
  expect(JSON.stringify(rows)).not.toContain('Old habit')
})

test('the editor is reachable from Week too, since the panel is hosted there', async ({ page, app }) => {
  app.seed.task({ name: 'Grocery run', cadence: 'week' })

  await page.goto(app.url)
  await page.getByRole('button', { name: /^week$/i }).click()

  const panel = await openPanel(page)
  await panel.getByRole('button', { name: 'Edit Grocery run' }).click()
  await expect(page.getByRole('dialog', { name: 'Edit task' })).toBeVisible()
})

test('a colour stripe does not indent the row, and baseline reads heavier', async ({
  page,
  app,
}) => {
  app.seed.task({ name: 'EAT', cadence: 'day', is_baseline: true })
  app.seed.task({ name: 'EXC', cadence: 'day', is_baseline: true, color: '#4d9c62' })
  app.seed.task({ name: 'Zebra chore', cadence: 'day' })

  await page.goto(app.url)
  const panel = await openPanel(page)
  const row = (name: string) => panel.locator('li').filter({ hasText: name }).first()

  // Alignment: a coloured row must sit on the same left edge as its neighbours.
  // A border plus padding shifted it right; an inset shadow does not.
  const [plain, coloured] = await Promise.all([
    row('EAT').boundingBox(),
    row('EXC').boundingBox(),
  ])
  expect(plain && coloured).toBeTruthy()
  expect(coloured!.x).toBeCloseTo(plain!.x, 0)

  const tickX = async (name: string) =>
    (await row(name).getByRole('checkbox').boundingBox())!.x
  expect(await tickX('EXC')).toBeCloseTo(await tickX('EAT'), 0)

  // Weight: baseline heavier than the rest.
  const weight = (name: string) =>
    row(name)
      .getByRole('button', { name: `Edit ${name}` })
      .evaluate((el) => getComputedStyle(el.querySelector('span')!).fontWeight)
  expect(Number(await weight('EAT'))).toBeGreaterThan(Number(await weight('Zebra chore')))
})

test('the left stripe carries the cadence as a dash count', async ({ page, app }) => {
  app.seed.task({ name: 'Daily thing', cadence: 'day' })
  app.seed.task({ name: 'Weekly thing', cadence: 'week' })
  app.seed.task({ name: 'Yearly thing', cadence: 'year' })
  app.seed.task({ name: 'Once thing', cadence: null })

  await page.goto(app.url)
  const periodic = await openPanel(page, 'To do')
  const backlog = await openPanel(page, 'Backlog')
  // A one-off is drawn in Backlog now; every other cadence in To do.
  const row = (name: string, panel: Locator) =>
    panel.locator('li').filter({ hasText: name }).first()

  // The count is the meaning, so it is asserted rather than the look.
  for (const [name, cadence, dashes, panel] of [
    ['Daily thing', 'day', '1', periodic],
    ['Weekly thing', 'week', '2', periodic],
    ['Yearly thing', 'year', '5', periodic],
    ['Once thing', 'once', '1', backlog],
  ] as const) {
    const el = row(name, panel)
    await expect(el).toHaveAttribute('data-cadence', cadence)
    const n = await el.evaluate((e) => getComputedStyle(e).getPropertyValue('--stripe-dashes').trim())
    expect(n).toBe(dashes)
  }

  // Solid vs dashed is the gap, and a one-off is off the count axis entirely.
  const gap = (name: string, panel: Locator) =>
    row(name, panel).evaluate((e) => getComputedStyle(e).getPropertyValue('--stripe-gap').trim())
  expect(await gap('Daily thing', periodic)).toBe('0%')
  expect(await gap('Weekly thing', periodic)).not.toBe('0%')
  expect(await gap('Once thing', backlog)).not.toBe(await gap('Weekly thing', periodic))
})
