import { test, expect, addDays, type App } from './fixtures.ts'
import type { Locator, Page } from '@playwright/test'
import type { TodoTask, TodoGroup, TodoView } from '../src/shared/types.ts'

/**
 * The Routine panel — the complete inventory, hosted by Day.
 *
 * Since v5 it is rendered TWICE from the one `GET /api/todo`: a panel labelled
 * **Routine** drawing the five period groups, and one labelled **Backlog**
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
 * unbounded, so a past `planned_date`
 * stays overdue on every day of the week — a weekly one would silently fall out
 * of its period and read as unplaced when the suite ran on a Sunday. The split
 * does not change that: it only means those rows are now drawn in **Backlog**,
 * while the control that clears them stays in **Routine**.
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

// One-off first since v15 — it is where capture lands, so it is the group you
// look at most.
const CADENCE_ORDER = [null, 'day', 'week', 'month', 'quarter', 'year'] as const

/*
 * The group titles, as v15 renamed them: cadence adjectives rather than period
 * phrases, because they are strip buttons now and share a phone's width. The
 * period range still renders beside the heading, so "Weekly 6 – 12 Sep 2026"
 * says what "This week" did and more.
 */
const TITLE: Record<string, string> = {
  day: 'Daily',
  week: 'Weekly',
  month: 'Monthly',
  quarter: 'Quarterly',
  year: 'Yearly',
  once: 'Any time',
}

// ---------------------------------------------------------------------------
// Date labelling oracle — mirrors src/client/dates.ts. Only Date.UTC() is used;
// never `new Date(iso)`, which the fixture warns about.
// ---------------------------------------------------------------------------

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const
const MON = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const
const MON_LONG = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
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

async function fetchTodo(app: App): Promise<TodoLite> {
  const res = await app.fetch('/api/todo')
  expect(res.status, 'GET /api/todo').toBe(200)
  return (await res.json()) as TodoLite
}

/**
 * `app.seed.task` writes rows directly and has no `category` column, so a
 * category is set the way the app sets it: through the command API the editor
 * posts to. Nothing here reaches past the contract.
 */
async function command(app: App, name: string, body: Record<string, unknown>): Promise<void> {
  const res = await app.fetch(`/api/commands/${name}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  expect(res.status, `POST /api/commands/${name}`).toBe(200)
}

function createTask(
  app: App,
  t: {
    name: string
    cadence?: 'day' | 'week' | 'month' | 'quarter' | 'year' | null
    is_baseline?: boolean
    planned_date?: string | null
    category?: string | null
    /** '#rrggbb'. Only rendered when the task is baseline. */
    color?: string | null
  },
): Promise<void> {
  return command(app, 'create_task', { ...t })
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
/*
 * ONE section since v15, called Backlog, holding a track of six cadence panes.
 *
 * It was two collapsed accordions — Routine drawing the five recurring groups
 * and Backlog the one-off group — so the helpers below used to take which panel
 * they meant and had to open it first. There is nothing to open now: every pane
 * is rendered, and the strip pages between them.
 */
function panelOf(page: Page): Locator {
  return page.getByRole('region', { name: 'Backlog', exact: true })
}

/** The strip of six group buttons above the track. */
const groupStrip = (page: Page): Locator => page.getByRole('navigation', { name: 'Backlog groups' })

/*
 * Every pane is rendered, so there is nothing to open — this just hands back the
 * one section. It keeps its name and its shape so the tests below read the same
 * as they did, and stays async because every call site awaits it.
 */
async function openPanel(page: Page): Promise<Locator> {
  const panel = panelOf(page)
  await expect(panel).toBeVisible()
  return panel
}

/** One of the six groups, by its heading title. */
function group(panel: Locator, title: string): Locator {
  return panel.getByRole('region', { name: title, exact: true })
}

/** All six headings the track should render, read off the model. */
function headings(todo: TodoLite): string[] {
  return todo.groups.map((g) => {
    const title = TITLE[g.cadence ?? 'once'] as string
    return g.period_start !== null && g.period_end !== null
      ? `${title} ${periodLabel(g.period_start, g.period_end)}`
      : title
  })
}

/**
 * A group's rows in DOM order, read back through ARIA by the label of each
 * row's edit button.
 *
 * Categories are a SORT KEY only — they render nothing — so this is the whole
 * of what a group shows, and row order is the only evidence that category
 * ordering works at all.
 */
function listing(scope: Locator): Promise<string[]> {
  return scope
    .locator('li')
    .evaluateAll((els) =>
      els.map((el) =>
        (el.querySelector('[aria-label^="Edit "]')?.getAttribute('aria-label') ?? '').replace(
          /^Edit /,
          '',
        ),
      ),
    )
}

// ---------------------------------------------------------------------------
// The map of the periods
// ---------------------------------------------------------------------------

test('renders all six groups in cadence order, one-off first', async ({ page, app }) => {
  const todo = await fetchTodo(app)
  // One response, all six groups. v15 put the one-off group FIRST — it is where
  // capture lands — which is a change to TODO_GROUPS, not to the model.
  expect(todo.groups.map((g) => g.cadence)).toEqual([...CADENCE_ORDER])

  await page.goto(app.url)
  const panel = await openPanel(page)

  // Six headings, in order, each carrying its current period. The one-off group
  // is unbounded and shows none.
  await expect(panel.getByRole('heading', { level: 3 })).toHaveText(headings(todo))

  // Empty groups are not hidden — the track is a map of the periods.
  await expect(panel.getByText('Nothing here.')).toHaveCount(6)
})

test('the week is a date range, never a week number', async ({ page, app }) => {
  const todo = await fetchTodo(app)
  const week = groupOf(todo, 'week')
  expect(week.period_start).not.toBeNull()

  await page.goto(app.url)
  const panel = await openPanel(page)

  await expect(group(panel, 'Weekly').getByRole('heading', { level: 3 })).toHaveText(
    `Weekly ${periodLabel(week.period_start!, week.period_end!)}`,
  )
  // 'W36' or 'W2026-08-30' would both trip this; 'Wed' and 'Weekly' do not.
  await expect(panel).not.toContainText(/W\d/)
})

test('the Daily group is labelled with today, and Any time with nothing', async ({ page, app }) => {
  await page.goto(app.url)
  const periodic = await openPanel(page)
  const backlog = await openPanel(page)

  await expect(group(periodic, 'Daily').getByRole('heading', { level: 3 })).toHaveText(
    `Daily ${shortDate(app.today)}`,
  )
  await expect(group(backlog, 'Any time').getByRole('heading', { level: 3 })).toHaveText('Any time')
})

// ---------------------------------------------------------------------------
// Two panels, one model
// ---------------------------------------------------------------------------

test('each task is drawn once, in the group its cadence names', async ({ page, app }) => {
  app.seed.task({ name: 'Vacuum downstairs', cadence: 'week' })
  app.seed.task({ name: 'Call the vet', cadence: null })

  await page.goto(app.url)
  const panel = await openPanel(page)

  await expect(group(panel, 'Weekly').getByText('Vacuum downstairs', { exact: true })).toBeVisible()
  await expect(group(panel, 'Any time').getByText('Call the vet', { exact: true })).toBeVisible()

  // Once each, and in the right pane. Six panes in one track rather than six
  // split across two panels did not duplicate anything.
  await expect(group(panel, 'Weekly').getByText('Call the vet', { exact: true })).toHaveCount(0)
  await expect(
    group(panel, 'Any time').getByText('Vacuum downstairs', { exact: true }),
  ).toHaveCount(0)
  await expect(panel.getByText('Vacuum downstairs', { exact: true })).toHaveCount(1)
  await expect(panel.getByText('Call the vet', { exact: true })).toHaveCount(1)

  // And no group is drawn twice: each cadence has exactly one pane in the track.
  await expect(panel.getByRole('region', { name: 'Any time', exact: true })).toHaveCount(1)
  await expect(panel.getByRole('region', { name: 'Weekly', exact: true })).toHaveCount(1)
})

/*
 * These two replace "both panels are hosted by Day, collapsed" and "the two
 * panels collapse independently". Neither premise survives v15 — there is one
 * section and nothing folds — but what they were really guarding does: that the
 * track is secondary to today's list, that its controls are real tap targets and
 * keyboard-operable, and that each group holds what its cadence names.
 */
test('the backlog is hosted by Day as one track of six groups', async ({ page, app }) => {
  app.seed.task({ name: 'Vacuum downstairs', cadence: 'week' })
  app.seed.task({ name: 'Call the vet', cadence: null })

  await page.goto(app.url)
  await expect(panelOf(page)).toHaveCount(1)

  const todo = await fetchTodo(app)
  await expect(panelOf(page).getByRole('heading', { level: 3 })).toHaveText(headings(todo))

  // Each group holds what its cadence names, and nothing else.
  await expect(
    group(panelOf(page), 'Weekly').getByText('Vacuum downstairs', { exact: true }),
  ).toBeVisible()
  await expect(
    group(panelOf(page), 'Any time').getByText('Call the vet', { exact: true }),
  ).toBeVisible()
  await expect(group(panelOf(page), 'Any time').getByText('Vacuum downstairs')).toHaveCount(0)
})

/*
 * The strip is a ROW, and this asserts the layout rather than the roles.
 *
 * Its CSS was missing entirely when the track first landed, and the whole
 * browser suite stayed green: every other assertion here addresses roles and
 * accessible names, which a `<ul>` falling back to UA defaults still satisfies.
 * What it does not satisfy is being usable — six bulleted buttons stacked
 * vertically, 306px tall and indented 40px. A height bound is the cheapest thing
 * that can tell the difference.
 */
test('the group strip is a single row, not a stacked list', async ({ page, app }) => {
  app.seed.task({ name: 'Vacuum downstairs', cadence: 'quarter' })

  await page.goto(app.url)
  const strip = groupStrip(page)
  await expect(strip).toBeVisible()

  const box = await strip.boundingBox()
  // One row of 44px targets plus padding. Stacked, it is six times this.
  expect(box!.height, 'the strip is one row').toBeLessThan(100)

  const buttons = strip.getByRole('list').getByRole('button')
  const boxes = await buttons.evaluateAll((els) =>
    els.map((e) => {
      const r = e.getBoundingClientRect()
      return { top: Math.round(r.top), height: Math.round(r.height) }
    }),
  )
  // All six share a top edge, which is what "a row" means — and there have to be
  // six, or one button trivially satisfies both this and the height loop below.
  expect(boxes).toHaveLength(6)
  expect(new Set(boxes.map((b) => b.top)).size).toBe(1)
  // And each is still a full tap target — the fix must not shrink them to fit.
  for (const b of boxes) expect(b.height).toBeGreaterThanOrEqual(44)

  // The longest label fits rather than being clipped at this width.
  const clipped = await strip.getByRole('button', { name: /^Quarterly/ }).evaluate((e) => {
    const t = e.querySelector('.group-strip__title') as HTMLElement
    return t.scrollWidth > t.clientWidth + 1
  })
  expect(clipped, 'Quarterly fits without clipping').toBe(false)
})

test('the group strip pages the track, and is a real control', async ({ page, app }) => {
  app.seed.task({ name: 'Vacuum downstairs', cadence: 'week' })

  await page.goto(app.url)
  const buttons = groupStrip(page).getByRole('list').getByRole('button')
  await expect(buttons).toHaveCount(6)

  // The count rides in the accessible NAME, not only in the badge — the badge is
  // aria-hidden, and "Weekly, 1 task" is the point of it.
  await expect(buttons.nth(2)).toHaveAccessibleName(/^Weekly, 1 task/)

  const box = await buttons.nth(2).boundingBox()
  expect(box!.height, 'a group button is a full tap target').toBeGreaterThanOrEqual(44)

  // Keyboard-operable, not a click-only div — and it moves the track.
  await buttons.nth(2).focus()
  await buttons.nth(2).press('Enter')
  await expect(buttons.nth(2)).toHaveAttribute('aria-current', 'true')
  await expect(group(panelOf(page), 'Weekly')).toBeInViewport({ ratio: 0.5 })
})

// ---------------------------------------------------------------------------
// Membership
// ---------------------------------------------------------------------------

test('a daily task lands in Daily and is tickable from the track', async ({ page, app }) => {
  app.seed.task({ name: 'Feed Barney 1', cadence: 'day' })

  await page.goto(app.url)
  const panel = await openPanel(page)
  const today = group(panel, 'Daily')

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

  expect(taskOf(await fetchTodo(app), 'Feed Barney 1').is_done).toBe(true)
})

test('a one-off completed this week is still listed, struck through', async ({ page, app }) => {
  const weekStart = groupOf(await fetchTodo(app), 'week').period_start!
  const id = app.seed.task({ name: 'Fix the gate', cadence: null })
  // A back-dated completion the command API refuses to write.
  app.seed.completion(id, weekStart)

  await page.goto(app.url)
  const backlog = await openPanel(page)
  const oneOff = group(backlog, 'Any time')

  await expect(oneOff.getByText('Fix the gate', { exact: true })).toBeVisible()
  await expect(oneOff.getByText('Fix the gate', { exact: true })).toHaveCSS(
    'text-decoration-line',
    'line-through',
  )
  await expect(oneOff.getByRole('checkbox', { name: 'Untick Fix the gate' })).toBeChecked()
})

test('a one-off completed before this week is gone', async ({ page, app }) => {
  const weekStart = groupOf(await fetchTodo(app), 'week').period_start!
  const id = app.seed.task({ name: 'Renew the passport', cadence: null })
  app.seed.completion(id, addDays(weekStart, -1))

  const todo = await fetchTodo(app)
  expect(groupOf(todo, null).tasks.map((t) => t.name)).not.toContain('Renew the passport')

  await page.goto(app.url)
  const periodic = await openPanel(page)
  const backlog = await openPanel(page)

  // Gone from the screen entirely, not merely moved to the other panel.
  await expect(page.getByText('Renew the passport')).toHaveCount(0)
  await expect(periodic.getByText('Renew the passport')).toHaveCount(0)
  // ...and the group is empty rather than missing.
  await expect(group(backlog, 'Any time').getByText('Nothing here.')).toBeVisible()
})

// ---------------------------------------------------------------------------
// Order — overdue, then placed, then unplaced, then done
// ---------------------------------------------------------------------------

test('rows band by state, not alphabetically', async ({ page, app }) => {
  const weekStart = groupOf(await fetchTodo(app), 'week').period_start!

  // Alphabetically Wombat < Xerus < Yak < Zebra — the exact reverse of the
  // banding, so a list that merely looks sorted cannot pass this.
  app.seed.task({ name: 'Wombat done', cadence: null })
  app.seed.task({ name: 'Xerus unplaced', cadence: null })
  app.seed.task({ name: 'Yak placed', cadence: null, planned_date: app.today })
  app.seed.task({ name: 'Zebra overdue', cadence: null, planned_date: addDays(app.today, -3) })
  app.seed.completion(taskOf(await fetchTodo(app), 'Wombat done').id, weekStart)

  // The server owns the order; the client renders what it is given.
  const todo = await fetchTodo(app)
  expect(groupOf(todo, null).tasks.map((t) => t.name)).toEqual([
    'Zebra overdue',
    'Yak placed',
    'Xerus unplaced',
    'Wombat done',
  ])

  await page.goto(app.url)
  const backlog = await openPanel(page)
  await expect(group(backlog, 'Any time').getByRole('listitem')).toHaveText([
    /^Zebra overdue/,
    /^Yak placed/,
    /^Xerus unplaced/,
    /^Wombat done/,
  ])
})

test('an overdue row asks for a day and shows the date it fell behind on', async ({
  page,
  app,
}) => {
  const missed = addDays(app.today, -2)
  app.seed.task({ name: 'Grocery run', cadence: null, planned_date: missed })

  await page.goto(app.url)
  const backlog = await openPanel(page)
  const row = group(backlog, 'Any time').getByRole('listitem').filter({ hasText: 'Grocery run' })

  await expect(row.getByText('Needs a day', { exact: true })).toBeVisible()
  await expect(row.getByText(shortDate(missed))).toBeVisible()
})

// ---------------------------------------------------------------------------
// Categories
//
// A category is a SORT KEY and nothing else — it renders no heading, no chip
// and no label. So every test here asserts ROW ORDER, which is the only place
// the category is observable on screen.
//
// `app.seed.task` has no `category`, so these fixtures go in through
// `create_task` — the same command the editor posts.
// ---------------------------------------------------------------------------

/**
 * Categories render nothing at all. They were briefly drawn as sub-headings;
 * the headings repeated once per band — a category appeared again over the
 * completed rows — and they said what the group heading above them already
 * said. A category is data for sorting, not a label.
 */
test('a category renders no heading, chip or label anywhere', async ({ page, app }) => {
  await createTask(app, { name: 'Brush Ringo', cadence: 'week', category: 'Dog' })
  await createTask(app, { name: 'Aardvark admin', cadence: 'week', category: 'House' })
  await createTask(app, { name: 'Air the room', cadence: 'week' })

  expect((await fetchTodo(app)).categories).toEqual(['Dog', 'House'])

  await page.goto(app.url)
  const periodic = await openPanel(page)

  // The rows are all there...
  await expect(periodic.getByRole('button', { name: 'Edit Brush Ringo' })).toBeVisible()
  // ...and the category names appear nowhere on the screen.
  await expect(page.getByText('Dog', { exact: true })).toHaveCount(0)
  await expect(page.getByText('House', { exact: true })).toHaveCount(0)
  await expect(page.getByText('Other', { exact: true })).toHaveCount(0)
  await expect(page.getByText(/uncategorised|uncategorized/i)).toHaveCount(0)
  await expect(page.locator('li.todo-cat')).toHaveCount(0)
})

test('rows order by category, and category outranks name', async ({ page, app }) => {
  // Alphabetically by name: Aardvark admin < Air the room < Brush Ringo.
  // By category: Dog < House < uncategorised. The two orders disagree on every
  // pair, so a list merely sorted by name cannot pass this.
  await createTask(app, { name: 'Aardvark admin', cadence: 'week', category: 'House' })
  await createTask(app, { name: 'Brush Ringo', cadence: 'week', category: 'Dog' })
  await createTask(app, { name: 'Air the room', cadence: 'week' })

  const todo = await fetchTodo(app)
  expect(groupOf(todo, 'week').tasks.map((t) => t.name)).toEqual([
    'Brush Ringo',
    'Aardvark admin',
    'Air the room',
  ])

  await page.goto(app.url)
  const periodic = await openPanel(page)

  // Row order is the only place the category is observable on screen.
  await expect
    .poll(() => listing(group(periodic, 'Weekly')))
    .toEqual(['Brush Ringo', 'Aardvark admin', 'Air the room'])
})

test('uncategorised rows sort last, whatever their name', async ({ page, app }) => {
  await createTask(app, { name: 'Aardvark admin', cadence: 'week', category: 'House' })
  await createTask(app, { name: 'Dishes', cadence: 'week' })

  await page.goto(app.url)
  const periodic = await openPanel(page)

  // "Dishes" sorts after "Aardvark admin" despite A < D, because having no
  // category puts it last.
  await expect.poll(() => listing(group(periodic, 'Weekly'))).toEqual(['Aardvark admin', 'Dishes'])

  // And it really has no category — it is last by the rule, not by an empty
  // string that happens to sort late.
  const todo = await fetchTodo(app)
  expect(groupOf(todo, 'week').tasks.find((t) => t.name === 'Dishes')!.category).toBeNull()
  expect(todo.categories).toEqual(['House'])
})

test('a baseline task sorts above every category', async ({ page, app }) => {
  // The baseline task carries a category that would sort LAST and a name that
  // would sort last too, so only the flag can lift it.
  await createTask(app, {
    name: 'Zzz vital',
    cadence: 'day',
    is_baseline: true,
    category: 'Zebra',
  })
  await createTask(app, { name: 'Aardvark admin', cadence: 'day', category: 'Admin' })
  await createTask(app, { name: 'Dishes', cadence: 'day' })

  await page.goto(app.url)
  const periodic = await openPanel(page)

  await expect
    .poll(() => listing(group(periodic, 'Daily')))
    .toEqual(['Zzz vital', 'Aardvark admin', 'Dishes'])
})

test('the editor suggests the categories already in use', async ({ page, app }) => {
  await createTask(app, { name: 'Brush Ringo', cadence: 'week', category: 'Dog' })
  await createTask(app, { name: 'Descale the kettle', cadence: 'week', category: 'Kitchen' })
  await createTask(app, { name: 'Air the room', cadence: 'week' })

  const todo = await fetchTodo(app)
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

test('setting a category in the editor persists and reorders the row', async ({ page, app }) => {
  await createTask(app, { name: 'Zebra chore', cadence: 'week', category: 'Admin' })
  await createTask(app, { name: 'Aardvark admin', cadence: 'week' })

  await page.goto(app.url)
  const periodic = await openPanel(page)
  const week = group(periodic, 'Weekly')

  // Uncategorised sorts last, so the alphabet loses to start with.
  await expect.poll(() => listing(week)).toEqual(['Zebra chore', 'Aardvark admin'])

  await periodic.getByRole('button', { name: 'Edit Aardvark admin' }).click()
  const editor = page.getByRole('dialog', { name: 'Edit task' })
  // A combobox, not a textbox: `list=` on an input gives it that implicit role.
  await editor.getByRole('combobox', { name: 'Category' }).fill('Admin')
  await editor.getByRole('button', { name: /^save$/i }).click()
  await expect(editor).toHaveCount(0)

  // Now both are in Admin, so the alphabet decides and the row moves up.
  await expect.poll(() => listing(week)).toEqual(['Aardvark admin', 'Zebra chore'])
  const todo = await fetchTodo(app)
  expect(groupOf(todo, 'week').tasks.find((t) => t.name === 'Aardvark admin')!.category).toBe(
    'Admin',
  )
})

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

test('placing from the panel offers exactly placeable_dates, and persists', async ({
  page,
  app,
}) => {
  app.seed.task({ name: 'Grocery run', cadence: null })
  const before = await fetchTodo(app)
  const dates = before.placeable_dates
  expect(dates.length).toBeGreaterThan(0)

  await page.goto(app.url)
  const backlog = await openPanel(page)

  await backlog.getByRole('button', { name: 'Place Grocery run' }).click()
  const picker = backlog.getByRole('group', { name: 'Pick a day' })

  // Exactly the server's list — never computed, filtered or extended.
  await expect(picker.getByRole('button')).toHaveText(dates.map((d) => chip(d, app.today)))

  const target = dates[dates.length - 1]!
  await picker.getByRole('button', { name: chip(target, app.today), exact: true }).click()

  await expect(group(backlog, 'Any time').getByText(shortDate(target))).toBeVisible()
  expect(taskOf(await fetchTodo(app), 'Grocery run').effective_date).toBe(target)
})

test('unplan clears the day', async ({ page, app }) => {
  app.seed.task({ name: 'Grocery run', cadence: null, planned_date: app.today })

  await page.goto(app.url)
  const backlog = await openPanel(page)
  const oneOff = group(backlog, 'Any time')

  await expect(oneOff.getByText(shortDate(app.today))).toBeVisible()
  await backlog.getByRole('button', { name: 'Unplan Grocery run' }).click()

  await expect(oneOff.getByText(shortDate(app.today))).toHaveCount(0)
  await expect(backlog.getByRole('button', { name: 'Unplan Grocery run' })).toHaveCount(0)
  expect(taskOf(await fetchTodo(app), 'Grocery run').effective_date).toBeNull()
})

test('ticking and unticking a weekly task round-trips', async ({ page, app }) => {
  app.seed.task({ name: 'Vacuum downstairs', cadence: 'week' })

  await page.goto(app.url)
  const panel = await openPanel(page)
  const week = group(panel, 'Weekly')

  await week.getByRole('checkbox', { name: 'Complete Vacuum downstairs' }).click()
  await expect(week.getByRole('checkbox', { name: 'Untick Vacuum downstairs' })).toBeChecked()
  expect(taskOf(await fetchTodo(app), 'Vacuum downstairs').is_done).toBe(true)

  await week.getByRole('checkbox', { name: 'Untick Vacuum downstairs' }).click()
  await expect(week.getByRole('checkbox', { name: 'Complete Vacuum downstairs' })).not.toBeChecked()
  expect(taskOf(await fetchTodo(app), 'Vacuum downstairs').is_done).toBe(false)
})

// ---------------------------------------------------------------------------
// Reset to backlog — its only home in the app
//
// The control is keyed off the view's GLOBAL `has_overdue` and reaches every
// overdue task, one-off ones included — but it is rendered only by the Routine
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

  expect((await fetchTodo(app)).has_overdue).toBe(true)

  await page.goto(app.url)
  const periodic = await openPanel(page)
  const backlog = await openPanel(page)
  await expect(backlog.getByText('Needs a day', { exact: true })).toHaveCount(2)

  await periodic.getByRole('button', { name: 'Reset to backlog' }).click()
  await periodic.getByRole('button', { name: 'Reset', exact: true }).click()

  await expect(backlog.getByText('Needs a day', { exact: true })).toHaveCount(0)

  const after = await fetchTodo(app)
  expect(after.has_overdue).toBe(false)
  expect(taskOf(after, 'Overdue one').effective_date).toBeNull()
  expect(taskOf(after, 'Overdue two').effective_date).toBeNull()
  expect(taskOf(after, 'Still ahead').effective_date).toBe(ahead)

  // Thursday's plan is still a good plan on Wednesday.
  await expect(group(backlog, 'Any time').getByText(shortDate(ahead))).toBeVisible()
  // Nothing overdue left, so the control goes away with it.
  await expect(periodic.getByRole('button', { name: 'Reset to backlog' })).toHaveCount(0)
})

/*
 * This used to assert the control was in Routine and not in Backlog, on a count
 * that spanned both — the arrangement that once made it offer to clear 0 items
 * and then clear two. v15 put it on the heading that names the whole track, so
 * scope and label finally agree and the test says the simpler thing: one
 * control, and it reaches every group.
 */
test('one reset control clears every overdue day, wherever the rows are', async ({ page, app }) => {
  app.seed.task({ name: 'Overdue one', cadence: null, planned_date: addDays(app.today, -2) })
  app.seed.task({ name: 'Overdue two', cadence: null, planned_date: addDays(app.today, -5) })
  expect((await fetchTodo(app)).has_overdue).toBe(true)

  await page.goto(app.url)
  const panel = await openPanel(page)

  // Both rows wanting a day are one-offs, so both are in Any time...
  await expect(group(panel, 'Any time').getByText('Needs a day', { exact: true })).toHaveCount(2)

  // ...and the one control that clears them is on the heading, once.
  await expect(page.getByRole('button', { name: 'Reset to backlog' })).toHaveCount(1)

  await panel.getByRole('button', { name: 'Reset to backlog' }).click()
  await panel.getByRole('button', { name: 'Reset', exact: true }).click()

  // It reaches every group, not just the one showing.
  await expect(panel.getByText('Needs a day', { exact: true })).toHaveCount(0)
  const after = await fetchTodo(app)
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
 * so with two overdue one-offs the Routine panel offered "Reset to backlog"
 * beneath "0 items are waiting for a day", asked "Clear the day from 0 overdue
 * items?", and then cleared both. The tally now counts the whole view, as
 * `has_overdue` already did.
 */
test('the reset bar counts the overdue items it will actually clear', async ({ page, app }) => {
  app.seed.task({ name: 'Overdue one', cadence: null, planned_date: addDays(app.today, -2) })
  app.seed.task({ name: 'Overdue two', cadence: null, planned_date: addDays(app.today, -5) })

  await page.goto(app.url)
  const periodic = await openPanel(page)

  await expect(periodic.getByText('2 items are waiting for a day')).toBeVisible()
  await periodic.getByRole('button', { name: 'Reset to backlog' }).click()
  await expect(periodic.getByText('Clear the day from 2 overdue items?')).toBeVisible()
})

test('there is no reset control when nothing is overdue', async ({ page, app }) => {
  app.seed.task({ name: 'Feed Barney 1', cadence: 'day' })
  app.seed.task({ name: 'Grocery run', cadence: null, planned_date: app.today })
  expect((await fetchTodo(app)).has_overdue).toBe(false)

  await page.goto(app.url)
  const periodic = await openPanel(page)
  const backlog = await openPanel(page)

  await expect(backlog.getByText('Grocery run', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Reset to backlog' })).toHaveCount(0)
  await expect(periodic.getByText(/needs a day/i)).toHaveCount(0)
  await expect(backlog.getByText(/needs a day/i)).toHaveCount(0)
})

// ---------------------------------------------------------------------------
// The panel and its host
// ---------------------------------------------------------------------------

test('a command fired from the panel refreshes the host too', async ({ page, app }) => {
  // Placed on today, so it is on today's pane as well as in the panel.
  app.seed.task({ name: 'Vacuum downstairs', cadence: 'week', planned_date: app.today })

  await page.goto(app.url)
  const panel = await openPanel(page)

  await panel
    .getByRole('region', { name: 'Weekly', exact: true })
    .getByRole('checkbox', { name: 'Complete Vacuum downstairs' })
    .click()

  await expect(panel.getByRole('checkbox', { name: 'Untick Vacuum downstairs' })).toBeChecked()

  // The host's own copy of the row moved with it — one command, both models.
  // Matched on the task name alone, so this asserts the refresh and not the
  // wording either surface happens to give its ticks.
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
  const periodic = await openPanel(page)
  const backlog = await openPanel(page)

  await expect(periodic.getByRole('button', { name: 'Reset to backlog' })).toBeVisible()
  await backlog.getByRole('button', { name: 'Unplan Grocery run' }).click()

  await expect(backlog.getByText('Needs a day', { exact: true })).toHaveCount(0)
  // Nothing is overdue any more, so the OTHER panel's control has to go.
  await expect(periodic.getByRole('button', { name: 'Reset to backlog' })).toHaveCount(0)
  expect((await fetchTodo(app)).has_overdue).toBe(false)
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
  const backlog = await openPanel(page)
  await expect(backlog.getByText('Needs a day', { exact: true })).toBeVisible()

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
  const periodic = await openPanel(page)
  const backlog = await openPanel(page)

  await periodic.getByRole('checkbox', { name: 'Complete Feed Barney 1' }).click()
  await expect(periodic.getByRole('checkbox', { name: 'Untick Feed Barney 1' })).toBeChecked()

  await backlog.getByRole('button', { name: 'Move Grocery run' }).click()
  await expect(backlog.getByRole('group', { name: 'Pick a day' })).toBeVisible()

  const todo = await fetchTodo(app)
  await expect(panelOf(page).getByRole('heading', { level: 3 })).toHaveCount(headings(todo).length)
  await expect(panelOf(page).getByRole('heading', { level: 3 })).toHaveCount(headings(todo).length)

  await page.waitForLoadState('networkidle')
  expect(errors).toEqual([])
})

// ---------------------------------------------------------------------------
// Task editor
//
// This panel is the ONLY place a task is edited. Day's list is for doing — a tap
// there completes something and never opens a form — so the definition surface
// lives here. Both panels open the same editor: same component, same actions.
// ---------------------------------------------------------------------------

test('tapping a name in the panel opens the editor, and a rename persists', async ({
  page,
  app,
}) => {
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
  expect(taskOf(await fetchTodo(app), 'Vacuum downstairs').id).toBe(id)
})

test('the editor opens from Backlog too, and a rename persists', async ({ page, app }) => {
  const id = app.seed.task({ name: 'Call the vet', cadence: null })

  await page.goto(app.url)
  const backlog = await openPanel(page)
  await backlog.getByRole('button', { name: 'Edit Call the vet' }).click()

  const editor = page.getByRole('dialog', { name: 'Edit task' })
  await expect(editor).toBeVisible()
  await editor.getByRole('textbox', { name: 'Task name' }).fill('Call the vet back')
  await editor.getByRole('button', { name: /^save$/i }).click()

  await expect(editor).toHaveCount(0)
  await expect(backlog.getByRole('button', { name: 'Edit Call the vet back' })).toBeVisible()
  expect(taskOf(await fetchTodo(app), 'Call the vet back').id).toBe(id)
})

test('the editor changes cadence, which moves the task to another group', async ({ page, app }) => {
  app.seed.task({ name: 'Descale the kettle', cadence: 'week' })

  await page.goto(app.url)
  const panel = await openPanel(page)
  await expect(group(panel, 'Weekly').getByRole('button', { name: /^Edit Descale/ })).toBeVisible()

  await panel.getByRole('button', { name: 'Edit Descale the kettle' }).click()
  const editor = page.getByRole('dialog', { name: 'Edit task' })
  await editor.getByRole('combobox', { name: 'Cadence' }).selectOption('month')
  await editor.getByRole('button', { name: /^save$/i }).click()
  await expect(editor).toHaveCount(0)

  // The group a task sits in is its cadence — so the row moves.
  await expect(group(panel, 'Monthly').getByRole('button', { name: /^Edit Descale/ })).toBeVisible()
  await expect(group(panel, 'Weekly').getByRole('button', { name: /^Edit Descale/ })).toHaveCount(0)
  expect(taskOf(await fetchTodo(app), 'Descale the kettle').cadence).toBe('month')
})

test('clearing the cadence moves the task into the Any time group', async ({ page, app }) => {
  // A group is a cadence, so the editor moves a row between them.
  app.seed.task({ name: 'Descale the kettle', cadence: 'week' })

  await page.goto(app.url)
  const panel = await openPanel(page)
  await expect(group(panel, 'Weekly').getByRole('button', { name: /^Edit Descale/ })).toBeVisible()

  await panel.getByRole('button', { name: 'Edit Descale the kettle' }).click()
  const editor = page.getByRole('dialog', { name: 'Edit task' })
  await editor.getByRole('combobox', { name: 'Cadence' }).selectOption('')
  await editor.getByRole('button', { name: /^save$/i }).click()
  await expect(editor).toHaveCount(0)

  await expect(
    group(panel, 'Any time').getByRole('button', { name: /^Edit Descale/ }),
  ).toBeVisible()
  await expect(group(panel, 'Weekly').getByRole('button', { name: /^Edit Descale/ })).toHaveCount(0)
  expect(taskOf(await fetchTodo(app), 'Descale the kettle').cadence).toBeNull()
})

test('archiving from the editor removes the task but keeps its completions', async ({
  page,
  app,
}) => {
  const yesterday = addDays(app.today, -1)
  const id = app.seed.task({ name: 'Old habit', cadence: 'day' })
  app.seed.completion(id, yesterday)
  app.seed.task({ name: 'New habit', cadence: 'day' })

  await page.goto(app.url)

  // Before: the completion is in the grid.
  const before = await (await app.fetch('/api/history')).json()
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
  const rows = await (await app.fetch('/api/todo')).json()
  expect(JSON.stringify(rows)).not.toContain('Old habit')
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
  const [plain, coloured] = await Promise.all([row('EAT').boundingBox(), row('EXC').boundingBox()])
  expect(plain && coloured).toBeTruthy()
  expect(coloured!.x).toBeCloseTo(plain!.x, 0)

  const tickX = async (name: string) => (await row(name).getByRole('checkbox').boundingBox())!.x
  expect(await tickX('EXC')).toBeCloseTo(await tickX('EAT'), 0)

  // Weight: baseline heavier than the rest.
  const weight = (name: string) =>
    row(name)
      .getByRole('button', { name: `Edit ${name}` })
      .evaluate((el) => getComputedStyle(el.querySelector('span')!).fontWeight)
  expect(Number(await weight('EAT'))).toBeGreaterThan(Number(await weight('Zebra chore')))
})

/**
 * Every row has a plain solid stripe on its left edge. It carries only WHOSE
 * row it is — border grey by default, the overdue colour when a task needs a
 * new day, a baseline task's colour when it has one.
 *
 * It no longer encodes the cadence as a dash count. Asserted here so that the
 * removal is deliberate: a pattern you have to count is not something a list
 * you scan should ask of you, and the group headings already say the cadence
 * in words.
 */
test('the row stripe is plain, and carries no cadence pattern', async ({ page, app }) => {
  await createTask(app, { name: 'Weekly thing', cadence: 'week' })
  await createTask(app, { name: 'Daily thing', cadence: 'day' })

  await page.goto(app.url)
  const panel = await openPanel(page)

  const read = (name: string) =>
    panel
      .locator('li')
      .filter({ hasText: name })
      .first()
      .evaluate((el) => {
        const cs = getComputedStyle(el)
        return {
          image: cs.backgroundImage,
          size: cs.backgroundSize,
          repeat: cs.backgroundRepeat,
          stripe: cs.getPropertyValue('--stripe-colour').trim(),
          cadenceAttr: el.getAttribute('data-cadence'),
        }
      })

  const weekly = await read('Weekly thing')
  const daily = await read('Daily thing')

  // The hook the pattern keyed off is gone entirely, not merely unstyled.
  expect(weekly.cadenceAttr).toBeNull()
  expect(daily.cadenceAttr).toBeNull()

  // A single 3px band, not a repeating tile.
  expect(weekly.size).toBe('3px 100%')
  expect(weekly.repeat).toBe('no-repeat')

  // Cadence changes nothing about it.
  expect(weekly.image).toBe(daily.image)
  expect(weekly.stripe).toBe(daily.stripe)
})

/**
 * A completed baseline task keeps its colour, in the tick and in its name.
 *
 * It reads as done from the strike-through and the filled box; dimming the name
 * as well threw the colour away at exactly the moment the list is longest and
 * the grouping cue is most useful.
 */
test('a completed baseline task keeps its colour in the tick and the name', async ({
  page,
  app,
}) => {
  await createTask(app, {
    name: 'MED',
    cadence: 'day',
    is_baseline: true,
    color: '#c2410c',
  })

  await page.goto(app.url)
  const panel = await openPanel(page)
  const row = panel.locator('li').filter({ hasText: 'MED' }).first()

  await row.getByRole('checkbox').click()
  await expect(row.getByRole('checkbox', { name: /^Untick/ })).toBeVisible()

  const painted = await row.evaluate((el) => {
    const name = el.querySelector('.todo-row__name')!
    return {
      box: getComputedStyle(el.querySelector('.tick__box')!).backgroundColor,
      name: getComputedStyle(name).color,
      strike: getComputedStyle(name).textDecorationLine,
    }
  })

  expect(painted.box).toBe('rgb(194, 65, 12)')
  expect(painted.name).toBe('rgb(194, 65, 12)')
  // Still legibly done — the colour is in addition to the strike, not instead.
  expect(painted.strike).toContain('line-through')
})

// ===========================================================================
// How far ahead a task may be placed
//
// The rule is THIS WEEK UNION THE TASK'S OWN CURRENT PERIOD. The picker offers
// this week as chips either way; a cadence whose period outruns Saturday also
// gets a date field, and a weekly task — whose period IS the week — does not.
// ===========================================================================

/** POST place directly, for the cases the picker is meant to make unreachable. */
async function placeVia(app: App, taskId: number, date: string): Promise<number> {
  const res = await app.fetch('/api/commands/place', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ task_id: taskId, date }),
  })
  return res.status
}

const laterField = (panel: Locator) => panel.getByLabel('Or a later date')

test('a weekly task is placeable inside its week and nowhere else', async ({ page, app }) => {
  const id = app.seed.task({ name: 'Vacuum downstairs', cadence: 'week' })
  const todo = await fetchTodo(app)
  const saturday = todo.placeable_dates[todo.placeable_dates.length - 1]!

  await page.goto(app.url)
  const panel = await openPanel(page)
  await panel.getByRole('button', { name: 'Place Vacuum downstairs' }).click()
  await expect(panel.getByRole('group', { name: 'Pick a day' })).toBeVisible()

  // Its period IS the week, so the chips are the whole range and no field opens.
  await expect(laterField(panel)).toHaveCount(0)

  // And the server says the same to a client that asks anyway.
  expect(await placeVia(app, id, addDays(saturday, 1))).toBe(409)
  expect(await placeVia(app, id, saturday)).toBe(200)
})

test('a monthly task reaches the end of its month', async ({ page, app }) => {
  app.seed.task({ name: 'Descale the kettle', cadence: 'month' })
  const todo = await fetchTodo(app)
  const range = todo.placement.find((p) => p.cadence === 'month')!

  await page.goto(app.url)
  const panel = await openPanel(page)
  await panel.getByRole('button', { name: 'Place Descale the kettle' }).click()

  // The chips are still this week; the field is what reaches past it.
  await expect(laterField(panel)).toHaveAttribute('min', todo.today)
  await expect(laterField(panel)).toHaveAttribute('max', range.max!)
  expect(range.max! >= todo.placeable_dates[todo.placeable_dates.length - 1]!).toBe(true)
})

test('a one-off has no far edge, and can be placed months out', async ({ page, app }) => {
  const id = app.seed.task({ name: 'Renew the passport', cadence: null })
  const todo = await fetchTodo(app)
  expect(todo.placement.find((p) => p.cadence === null)!.max).toBeNull()

  await page.goto(app.url)
  const panel = await openPanel(page)
  await panel.getByRole('button', { name: 'Place Renew the passport' }).click()

  // Unbounded, so the field carries no max attribute at all.
  await expect(laterField(panel)).toHaveAttribute('min', todo.today)
  await expect(laterField(panel)).not.toHaveAttribute('max', /./)

  const far = addDays(todo.today, 120)
  await laterField(panel).fill(far)

  // It lands, and the row shows the date — which is why none of this needed a
  // new surface: the panel already displays the day against a placed task.
  await expect
    .poll(() => fetchTodo(app).then((t) => taskOf(t, 'Renew the passport').effective_date))
    .toBe(far)
  expect(await placeVia(app, id, addDays(todo.today, 900))).toBe(200)
})

test('a placement beyond the period is refused, not silently swallowed', async ({ app }) => {
  const weekly = app.seed.task({ name: 'Vacuum downstairs', cadence: 'week' })
  const monthly = app.seed.task({ name: 'Descale the kettle', cadence: 'month' })
  const todo = await fetchTodo(app)
  const monthMax = todo.placement.find((p) => p.cadence === 'month')!.max!

  // The far side of each cadence's own edge. A recurring task placed past its
  // period would be neither overdue nor unplaced nor done — its obligation would
  // go unmet with nothing on any screen saying so, which is what the bound stops.
  expect(await placeVia(app, monthly, addDays(monthMax, 1))).toBe(409)
  expect(await placeVia(app, monthly, monthMax)).toBe(200)
  expect(await placeVia(app, weekly, addDays(todo.today, -1))).toBe(409)
})

test('the date field refuses a date outside the range it advertises', async ({ page, app }) => {
  const id = app.seed.task({ name: 'Descale the kettle', cadence: 'month' })
  const todo = await fetchTodo(app)
  const max = todo.placement.find((p) => p.cadence === 'month')!.max!

  await page.goto(app.url)
  const panel = await openPanel(page)
  await panel.getByRole('button', { name: 'Place Descale the kettle' }).click()

  // min/max constrain the calendar, not the keyboard. A typed date past the end
  // of the month is refused here rather than sent and answered with a 409.
  await laterField(panel).fill(addDays(max, 1))
  await expect(laterField(panel)).toBeVisible()
  expect(taskOf(await fetchTodo(app), 'Descale the kettle').effective_date).toBeNull()

  // The last day it does advertise goes through.
  await laterField(panel).fill(max)
  await expect
    .poll(() => fetchTodo(app).then((t) => taskOf(t, 'Descale the kettle').effective_date))
    .toBe(max)
  expect(id).toBeGreaterThan(0)
})

test('using the date field does not dismiss the picker', async ({ page, app }) => {
  app.seed.task({ name: 'Descale the kettle', cadence: 'month' })

  await page.goto(app.url)
  const panel = await openPanel(page)
  await panel.getByRole('button', { name: 'Place Descale the kettle' }).click()
  await expect(panel.getByRole('group', { name: 'Pick a day' })).toBeVisible()

  // The popover is `manual`: dismissal is ours, and anything whose target is
  // inside it keeps it open. Under `auto` the browser's own calendar chrome
  // counted as a click outside, which dismissed the picker mid-interaction and
  // committed whatever date it was sitting on — clicking a month arrow placed
  // the task. Focusing and clicking the field must be inert.
  await laterField(panel).click()
  await laterField(panel).focus()
  await expect(panel.getByRole('group', { name: 'Pick a day' })).toBeVisible()
  await expect(laterField(panel)).toBeFocused()
})
