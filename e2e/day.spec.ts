import { execFileSync } from 'node:child_process'
import type { Page } from '@playwright/test'
import type { DayView, HistoryView, TodoTask, TodoView } from '../src/shared/types.ts'
import { test, expect, addDays, type App } from './fixtures.ts'

/**
 * Day — the doing surface. Today only, no date navigation anywhere.
 *
 * Every date in here is derived from `app.today`, so the suite passes on any
 * weekday. Where a fact is only observable server-side it is cross-checked
 * against the API the UI itself talks to.
 *
 * Two things Day used to own are asserted elsewhere now: reset-to-backlog lives
 * in the To do panel and is that suite's business, and the mood set is not
 * editable in the app at all.
 */

// --- reading the server -----------------------------------------------------

async function dayView(app: App): Promise<DayView> {
  const r = await fetch(`${app.url}/api/day`)
  expect(r.ok).toBe(true)
  return (await r.json()) as DayView
}

/** The panel Day hosts. Used to assert where a task LANDED, not how it renders. */
async function todoView(app: App): Promise<TodoView> {
  const r = await fetch(`${app.url}/api/todo`)
  expect(r.ok).toBe(true)
  return (await r.json()) as TodoView
}

function inventory(v: TodoView, name: string): TodoTask | undefined {
  return v.groups.flatMap((g) => g.tasks).find((t) => t.name === name)
}

async function historyView(app: App): Promise<HistoryView> {
  const r = await fetch(`${app.url}/api/history`)
  expect(r.ok).toBe(true)
  return (await r.json()) as HistoryView
}

/**
 * A read-only peek at the test's own SQLite file, for the two facts no endpoint
 * can express: the completions of an ARCHIVED task (GET /api/history lists
 * active daily tasks only) and the planned_date of a task placed beyond the
 * current week (GET /api/week only spans Sunday–Saturday). Never used where an
 * API answer exists.
 */
const PEEK = `
const { Database } = require('bun:sqlite')
const [, path, sql, params] = process.argv
const db = new Database(path, { readonly: true })
console.log(JSON.stringify(db.query(sql).all(...JSON.parse(params))))
`

function peek(app: App, sql: string, params: (string | number)[]): Record<string, unknown>[] {
  const dbPath = (app.seed as unknown as { dbPath: string }).dbPath
  const out = execFileSync('bun', ['-e', PEEK, dbPath, sql, JSON.stringify(params)], {
    encoding: 'utf8',
  })
  return JSON.parse(out.trim() || '[]') as Record<string, unknown>[]
}

function plannedDate(app: App, id: number): string | null {
  const rows = peek(app, 'SELECT planned_date AS d FROM tasks WHERE id = ?', [id])
  expect(rows).toHaveLength(1)
  return (rows[0]!.d as string | null) ?? null
}

// --- reading the screen -----------------------------------------------------
// Rows are identified by the accessible name of their tick ("Complete X" in the
// active list, "Untick X" once done) — the same string a screen reader announces.
// Class names are never used.
//
// The name itself is plain text here: since v3 nothing on a Day row opens a form,
// and the task editor lives in the To do panel. See e2e/todo.spec.ts.

function activeRegion(page: Page) {
  return page.getByRole('region', { name: 'Active tasks' })
}

function completedRegion(page: Page) {
  return page.getByRole('region', { name: 'Completed tasks' })
}

function namesIn(page: Page, region: 'Active tasks' | 'Completed tasks') {
  return page
    .getByRole('region', { name: region })
    .getByRole('checkbox')
    .evaluateAll((els) =>
      els.map((e) => (e.getAttribute('aria-label') ?? '').replace(/^(Complete|Untick) /, '')),
    )
}

const activeNames = (page: Page) => namesIn(page, 'Active tasks')
const completedNames = (page: Page) => namesIn(page, 'Completed tasks')

/**
 * Row order while the reorder edit state is open.
 *
 * Rows are addressed by `aria-roledescription="sortable"` — dnd-kit replaces the
 * list-item role with `button` on a draggable row, so `getByRole('listitem')`
 * matches nothing here. This is an ARIA attribute, not a class name: it is what
 * a screen reader announces the row as.
 */
function sortableRows(page: Page) {
  return activeRegion(page).locator('[aria-roledescription="sortable"]')
}

function reorderNames(page: Page) {
  return sortableRows(page).evaluateAll((els) =>
    els.map((e) => (e.textContent ?? '').replace('≡', '').trim()),
  )
}

/**
 * Counts keydown listeners added to the document from now on.
 *
 * dnd-kit's KeyboardSensor adds its listener inside a `setTimeout` queued when
 * the lift starts, so `aria-pressed="true"` — which React commits in the same
 * task as the Space keypress — is NOT proof that the arrow about to be sent
 * will be received. An arrow sent into that window is dropped in silence: no
 * transform, no announcement, no error, and the drop then commits an order that
 * never changed. It fails as "the drag did nothing", which reads as a product
 * bug and is not one.
 *
 * The counter is DOM-level rather than a reach into the library: it asks
 * whether the page is listening for the keys this helper is about to press.
 */
async function watchKeydownListeners(page: Page) {
  await page.evaluate(() => {
    const doc = document as unknown as {
      __keydowns?: number
      __keydownProbe?: boolean
      addEventListener: (type: string, listener: unknown, options?: unknown) => void
    }
    doc.__keydowns = 0
    if (doc.__keydownProbe) return
    doc.__keydownProbe = true
    const base = EventTarget.prototype.addEventListener as unknown as (
      this: Document,
      type: string,
      listener: unknown,
      options?: unknown,
    ) => void
    doc.addEventListener = (type, listener, options) => {
      if (type === 'keydown') doc.__keydowns = (doc.__keydowns ?? 0) + 1
      base.call(document, type, listener, options)
    }
  })
}

/**
 * Reorder with the keyboard. dnd-kit's KeyboardSensor is the accessible path
 * through exactly the same code a pointer drag runs — Space lifts, an arrow
 * moves, Space drops — so this drives the real thing rather than a shortcut
 * around it. A synthesised pointer drag is also covered, once, below.
 */
async function dragWithKeyboard(
  page: Page,
  name: string,
  key: 'ArrowUp' | 'ArrowDown',
  { expectMove = true }: { expectMove?: boolean } = {},
) {
  const row = sortableRows(page).filter({ hasText: name })
  await watchKeydownListeners(page)
  await row.focus()

  // Every step waits on a signal, never a sleep. Firing the three keys back to
  // back races both the lift and the move, and the drop then commits an order
  // that never changed — which fails as "the drag did nothing" and looks like a
  // product bug rather than a test bug.
  await page.keyboard.press('Space')
  await expect(row).toHaveAttribute('aria-pressed', 'true')
  // ...and the lift is only half the signal: wait until the sensor is actually
  // listening, or the arrow below lands on the floor. This matters just as much
  // when no move is expected — an arrow that was never received would pass a
  // "it did not move" assertion without proving anything at all.
  await expect
    .poll(() => page.evaluate(() => (document as unknown as { __keydowns?: number }).__keydowns ?? 0))
    .toBeGreaterThan(0)

  await page.keyboard.press(key)
  // dnd-kit previews a drag with CSS transforms — the DOM order does NOT change
  // until the drop — so the signal that the arrow landed is the lifted row
  // acquiring a non-identity transform. Waiting on row ORDER here can never
  // succeed, and waiting on nothing at all lets the arrow and the drop land in
  // one frame, which silently commits an unchanged order.
  if (expectMove) {
    await expect
      .poll(() => row.evaluate((el) => getComputedStyle(el).transform))
      .not.toMatch(/^(none|matrix\(1, 0, 0, 1, 0, 0\))$/)
  }

  await page.keyboard.press('Space')
  await expect(row).not.toHaveAttribute('aria-pressed', 'true')
}

/** The <li> for one task, for the controls that live on the row. */
function row(page: Page, name: string) {
  return page
    .getByRole('listitem')
    .filter({ has: page.getByRole('checkbox', { name: new RegExp(`^(Complete|Untick) ${escapeRe(name)}$`) }) })
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

const tick = (page: Page, name: string) => page.getByRole('checkbox', { name: `Complete ${name}` })
const untick = (page: Page, name: string) => page.getByRole('checkbox', { name: `Untick ${name}` })

/**
 * The panels Day hosts. Since v5 there are two — one component rendered twice,
 * "To do" drawing the five period groups and "Backlog" the one-off group. Both
 * are collapsed here, so their rows are absent until opened, and each collapses
 * on its own. What is inside them is e2e/todo.spec.ts's business.
 */
type PanelName = 'To do' | 'Backlog'
const panel = (page: Page, name: PanelName = 'To do') =>
  page.getByRole('region', { name, exact: true })
/** Anchored at the start: the toggle's name carries a count ("To do 2 not done"). */
const panelToggle = (page: Page, name: PanelName = 'To do') =>
  panel(page, name).getByRole('button', { name: new RegExp(`^${name}`, 'i') })

/** The reschedule picker on one overdue row. Its days come from view.placeable_dates. */
const picker = (page: Page, name: string) =>
  row(page, name).getByRole('group', { name: 'Pick a day' })

/** The Sunday on or before `iso`. Weeks run Sunday to Saturday. */
function weekStartOf(iso: string): string {
  return addDays(iso, -new Date(`${iso}T00:00:00Z`).getUTCDay())
}

/**
 * Seed args for a task that is overdue on EVERY weekday.
 *
 * A weekly task's date falls out of its period at the week boundary, so a
 * weekly overdue item only exists once the week has a day behind it — on a
 * Sunday there is no such day and weekly overdue cannot exist at all. A
 * one-off's period is unbounded, so any past date is overdue forever. The
 * helper picks whichever the calendar allows; the overdue behaviour under test
 * is identical either way.
 */
function overdueSeed(
  today: string,
  name: string,
  daysBack = 1,
): { name: string; cadence: 'week' | null; planned_date: string } {
  const start = weekStartOf(today)
  return start < today
    ? { name, cadence: 'week', planned_date: start }
    : { name, cadence: null, planned_date: addDays(today, -daysBack) }
}

// ---------------------------------------------------------------------------
// Rendering and ordering
// ---------------------------------------------------------------------------

test('baseline tasks render above non-baseline ones', async ({ page, app }) => {
  // Named so the alphabet would invert this if the band were not doing the work.
  app.seed.task({ name: 'Zebra baseline', cadence: 'day', is_baseline: true })
  app.seed.task({ name: 'Yak baseline', cadence: 'day', is_baseline: true })
  app.seed.task({ name: 'Apple ordinary', cadence: 'day' })
  app.seed.task({ name: 'Banana ordinary', cadence: 'day' })

  await page.goto(app.url)

  await expect
    .poll(() => activeNames(page))
    .toEqual(['Yak baseline', 'Zebra baseline', 'Apple ordinary', 'Banana ordinary'])
})

test('within a band tasks are alphabetical by default', async ({ page, app }) => {
  // Seeded in an order that is neither alphabetical nor its reverse.
  app.seed.task({ name: 'Mop the floor', cadence: 'day' })
  app.seed.task({ name: 'Air the room', cadence: 'day' })
  app.seed.task({ name: 'Zip the bag', cadence: 'day' })
  app.seed.task({ name: 'Call the vet', cadence: 'day' })

  await page.goto(app.url)

  await expect
    .poll(() => activeNames(page))
    .toEqual(['Air the room', 'Call the vet', 'Mop the floor', 'Zip the bag'])
})

test("days.task_order overrides alphabetical order and cannot cross the baseline band", async ({
  page,
  app,
}) => {
  const aBase = app.seed.task({ name: 'A baseline', cadence: 'day', is_baseline: true })
  const bBase = app.seed.task({ name: 'B baseline', cadence: 'day', is_baseline: true })
  const cPlain = app.seed.task({ name: 'C ordinary', cadence: 'day' })
  const dPlain = app.seed.task({ name: 'D ordinary', cadence: 'day' })

  // Asks for the two non-baseline tasks first, and for B before A inside the
  // baseline band. The band must win; the within-band request must be honoured.
  app.seed.day(app.today, { task_order: [dPlain, cPlain, bBase, aBase] })

  await page.goto(app.url)

  await expect
    .poll(() => activeNames(page))
    .toEqual(['B baseline', 'A baseline', 'D ordinary', 'C ordinary'])
})

test('dailies and today’s placements appear; a future placement does not', async ({ page, app }) => {
  app.seed.task({ name: 'Feed the dog', cadence: 'day' })
  app.seed.task({ name: 'Grocery run', cadence: 'week', planned_date: app.today })
  app.seed.task({ name: 'Wash the car', cadence: 'week', planned_date: addDays(app.today, 1) })

  await page.goto(app.url)

  await expect.poll(() => activeNames(page)).toEqual(['Feed the dog', 'Grocery run'])
  await expect(activeRegion(page).getByRole('checkbox', { name: 'Complete Wash the car' })).toHaveCount(0)
})

/**
 * D6. A captured item can hold a URL, and a flex child with no `min-width: 0`
 * refuses to shrink below it — the row widens and the whole page scrolls
 * sideways. At 390px there is nowhere for that to hide.
 */
test('a long unbroken name never scrolls the page sideways', async ({ page, app }) => {
  app.seed.task({
    name: 'Order https://www.example.com/catalogue/replacement-part-XJ4400-11930-A/checkout',
    cadence: 'day',
  })

  await page.goto(app.url)
  await expect(activeRegion(page).getByRole('checkbox', { name: /^Complete Order / })).toBeVisible()

  const overflow = await page.evaluate(() => {
    const el = document.scrollingElement!
    return el.scrollWidth - el.clientWidth
  })
  expect(overflow).toBeLessThanOrEqual(0)
})

/**
 * D3. Day fetches its own model and the panel's, and never the Week model — not
 * on load, and not to fill the reschedule picker, which is where it used to.
 */
test('Day fetches its own model and the panel’s, and never the Week model', async ({
  page,
  app,
}) => {
  app.seed.task(overdueSeed(app.today, 'Fix the fence', 2))

  const paths: string[] = []
  page.on('request', (r) => paths.push(new URL(r.url()).pathname))

  await page.goto(app.url)
  await expect.poll(() => activeNames(page)).toEqual(['Fix the fence'])

  await row(page, 'Fix the fence').getByRole('button', { name: /give it a day/i }).click()
  await expect(picker(page, 'Fix the fence').getByRole('button').first()).toBeVisible()

  expect(paths).toContain('/api/day')
  expect(paths).toContain('/api/todo')
  expect(paths.filter((p) => p === '/api/week')).toEqual([])
})

test('an archived task never appears', async ({ page, app }) => {
  app.seed.task({ name: 'Still here', cadence: 'day' })
  app.seed.task({ name: 'Retired task', cadence: 'day', active: false })
  app.seed.task({ name: 'Retired placement', cadence: 'week', planned_date: app.today, active: false })

  await page.goto(app.url)

  await expect.poll(() => activeNames(page)).toEqual(['Still here'])
  await expect(page.getByText('Retired task')).toHaveCount(0)
  await expect(page.getByText('Retired placement')).toHaveCount(0)
})

// ---------------------------------------------------------------------------
// Completion
// ---------------------------------------------------------------------------

test('ticking a task completes it against today', async ({ page, app }) => {
  const id = app.seed.task({ name: 'Take the meds', cadence: 'day' })
  app.seed.task({ name: 'Stay put', cadence: 'day' })

  await page.goto(app.url)
  await tick(page, 'Take the meds').click()

  await expect(untick(page, 'Take the meds')).toBeVisible()
  await expect.poll(() => completedNames(page)).toEqual(['Take the meds'])
  await expect.poll(() => activeNames(page)).toEqual(['Stay put'])

  // The completion exists and is dated TODAY — history's newest row is today.
  const history = await historyView(app)
  expect(history.rows[0]!.date).toBe(app.today)
  expect(history.rows[0]!.completed).toContain(id)

  const day = await dayView(app)
  expect(day.completed.map((t) => t.id)).toEqual([id])
})

test('tapping a completed item unticks it and returns it to the active list', async ({
  page,
  app,
}) => {
  const id = app.seed.task({ name: 'Wash up', cadence: 'day' })

  await page.goto(app.url)
  await tick(page, 'Wash up').click()
  await expect(untick(page, 'Wash up')).toBeVisible()

  await untick(page, 'Wash up').click()

  await expect(tick(page, 'Wash up')).toBeVisible()
  await expect(completedRegion(page)).toHaveCount(0)
  await expect.poll(() => activeNames(page)).toEqual(['Wash up'])

  await expect
    .poll(async () => (await historyView(app)).rows[0]?.completed ?? [])
    .not.toContain(id)
})

test('double-tapping complete is idempotent', async ({ page, app }) => {
  const id = app.seed.task({ name: 'Twice tapped', cadence: 'day' })

  await page.goto(app.url)
  await tick(page, 'Twice tapped').dblclick()

  await expect(untick(page, 'Twice tapped')).toBeVisible()
  // No error surfaced — the notice bar renders role="alert" for failures.
  await expect(page.getByRole('alert')).toHaveCount(0)

  await expect.poll(() => completedNames(page)).toEqual(['Twice tapped'])

  // Exactly one completion row: one date carries it, and (task_id, completed_on)
  // is the primary key, so that date cannot carry it twice.
  const history = await historyView(app)
  expect(history.rows.filter((r) => r.completed.includes(id))).toHaveLength(1)
  expect(peek(app, 'SELECT * FROM completions WHERE task_id = ?', [id])).toHaveLength(1)
})

test('a weekly task completed earlier this week loads as completed, not active', async ({
  page,
  app,
}) => {
  // "Done" means the PERIOD is satisfied, not that it happened today. On a
  // Sunday the week has no earlier day, so the completion lands on the week
  // start, which is today — the load-time placement is still the thing asserted.
  const earlier = weekStartOf(app.today)
  const id = app.seed.task({ name: 'Hoover the stairs', cadence: 'week', planned_date: app.today })
  app.seed.completion(id, earlier)
  app.seed.task({ name: 'Ordinary daily', cadence: 'day' })

  await page.goto(app.url)

  await expect.poll(() => completedNames(page)).toEqual(['Hoover the stairs'])
  await expect.poll(() => activeNames(page)).toEqual(['Ordinary daily'])

  const day = await dayView(app)
  expect(day.completed.map((t) => t.id)).toEqual([id])
  expect(day.active.map((t) => t.id)).not.toContain(id)
})

// ---------------------------------------------------------------------------
// Overdue
// ---------------------------------------------------------------------------

test('an overdue task sits in the same flat list, marked, offering a day or an unplan', async ({
  page,
  app,
}) => {
  app.seed.task({ name: 'Aardvark daily', cadence: 'day' })
  app.seed.task(overdueSeed(app.today, 'Change the sheets', 3))

  await page.goto(app.url)

  // Same list as the daily task — not a separate screen or section.
  await expect.poll(() => activeNames(page)).toEqual(['Aardvark daily', 'Change the sheets'])

  const overdueRow = row(page, 'Change the sheets')
  await expect(overdueRow.getByText(/needs a day/i)).toBeVisible()
  await expect(overdueRow.getByRole('button', { name: /give it a day/i })).toBeVisible()
  await expect(overdueRow.getByRole('button', { name: /^unplan$/i })).toBeVisible()

  // The daily task is not marked.
  await expect(row(page, 'Aardvark daily').getByText(/needs a day/i)).toHaveCount(0)

  const day = await dayView(app)
  expect(day.has_overdue).toBe(true)
  expect(day.active.find((t) => t.name === 'Change the sheets')!.state).toBe('overdue')
})

test('unplanning an overdue task clears its date and drops it from Day', async ({ page, app }) => {
  const id = app.seed.task(overdueSeed(app.today, 'Descale the kettle', 2))
  app.seed.task({ name: 'Keep me', cadence: 'day' })

  await page.goto(app.url)
  await row(page, 'Descale the kettle').getByRole('button', { name: /^unplan$/i }).click()

  await expect(page.getByRole('checkbox', { name: /Descale the kettle$/ })).toHaveCount(0)
  await expect.poll(() => activeNames(page)).toEqual(['Keep me'])

  const day = await dayView(app)
  expect(day.has_overdue).toBe(false)
  expect(day.active.map((t) => t.name)).not.toContain('Descale the kettle')

  // Cleared, not deleted. It is off every day's list and still in the inventory,
  // which is the whole reason the panel exists.
  expect(plannedDate(app, id)).toBeNull()
  const landed = inventory(await todoView(app), 'Descale the kettle')
  expect(landed).toBeDefined()
  expect(landed!.id).toBe(id)
  expect(landed!.effective_date).toBeNull()
  expect(landed!.is_overdue).toBe(false)
})

test('completing an overdue task clears the overdue state', async ({ page, app }) => {
  const id = app.seed.task(overdueSeed(app.today, 'Book the MOT', 4))

  await page.goto(app.url)
  await tick(page, 'Book the MOT').click()

  await expect(page.getByText(/needs a day/i)).toHaveCount(0)

  const day = await dayView(app)
  expect(day.has_overdue).toBe(false)
  // The completion is written against TODAY, never the day it was planned for.
  expect(peek(app, 'SELECT completed_on AS d FROM completions WHERE task_id = ?', [id])).toEqual([
    { d: app.today },
  ])
})

/**
 * D1, the regression this suite exists for. Membership is a union of four
 * independent rules, and the fourth — "a completion dated today" — is what keeps
 * a just-ticked overdue task on the screen. Written as a chain of else-if it
 * matches nothing once done (not daily, not dated today, and `is_done` makes
 * `is_overdue` false) and drops out of `active` AND `completed` — no row left to
 * tap, and Week cannot correct it either because past days are read-only.
 */
test('completing an overdue task moves it into the Completed section', async ({
  page,
  app,
}) => {
  const id = app.seed.task(overdueSeed(app.today, 'Book the MOT', 4))

  await page.goto(app.url)
  await tick(page, 'Book the MOT').click()
  await expect(page.getByText(/needs a day/i)).toHaveCount(0)

  const day = await dayView(app)
  expect(day.completed.map((t) => t.id)).toEqual([id])
  await expect.poll(() => completedNames(page)).toEqual(['Book the MOT'])

  // And it can be taken back, like anything else in the Completed section.
  await untick(page, 'Book the MOT').click()
  await expect(tick(page, 'Book the MOT')).toBeVisible()
})

test('rescheduling an overdue task onto today resolves it', async ({ page, app }) => {
  const id = app.seed.task(overdueSeed(app.today, 'Ring the plumber', 5))

  await page.goto(app.url)
  await row(page, 'Ring the plumber').getByRole('button', { name: /give it a day/i }).click()

  // placeable_dates always starts at today, whatever the weekday.
  await picker(page, 'Ring the plumber').getByRole('button').filter({ hasText: /^Today$/ }).click()

  await expect(page.getByText(/needs a day/i)).toHaveCount(0)
  await expect.poll(() => activeNames(page)).toEqual(['Ring the plumber'])

  const day = await dayView(app)
  expect(day.has_overdue).toBe(false)
  expect(day.active.find((t) => t.id === id)!.state).toBe('planned')
  expect(plannedDate(app, id)).toBe(app.today)
})

/**
 * D3. The picker offers exactly what the Day model shipped — no more, no fewer,
 * in the same order. Day used to fetch the WEEK model for this list and cache it
 * in a ref nothing invalidated, so after midnight it offered days the server
 * then rejected with a 409. The list rides on DayView precisely so the picker
 * and that rule cannot disagree.
 */
test('the reschedule picker offers exactly the days the Day model ships', async ({ page, app }) => {
  const id = app.seed.task(overdueSeed(app.today, 'Sweep the yard', 3))

  await page.goto(app.url)
  await row(page, 'Sweep the yard').getByRole('button', { name: /give it a day/i }).click()

  const day = await dayView(app)
  expect(day.placeable_dates[0]).toBe(app.today)
  await expect(picker(page, 'Sweep the yard').getByRole('button')).toHaveCount(
    day.placeable_dates.length,
  )

  // The last day offered is this Saturday, and picking it is accepted — the
  // picker never offers a date `place` would refuse with a 409.
  const last = day.placeable_dates.at(-1)!
  await picker(page, 'Sweep the yard').getByRole('button').last().click()

  await expect.poll(() => plannedDate(app, id)).toBe(last)
  await expect(page.getByRole('alert')).toHaveCount(0)
})

test('a daily task with a past planned_date is never overdue', async ({ page, app }) => {
  // Dailies are never placed; a stray date must not turn one overdue.
  app.seed.task({ name: 'Brush teeth', cadence: 'day', planned_date: addDays(app.today, -6) })

  await page.goto(app.url)

  await expect.poll(() => activeNames(page)).toEqual(['Brush teeth'])
  await expect(page.getByText(/needs a day/i)).toHaveCount(0)
  await expect(row(page, 'Brush teeth').getByRole('button', { name: /^unplan$/i })).toHaveCount(0)

  const day = await dayView(app)
  expect(day.has_overdue).toBe(false)
  expect(day.active.find((t) => t.name === 'Brush teeth')!.state).toBe('daily')
})

/**
 * Reset to backlog is NOT here. It lives in the To do panel and only there —
 * one control, reachable from both hosts, instead of the two Day and Week each
 * grew. Its behaviour is asserted in the panel's own suite.
 */
test('Day offers no reset-to-backlog control of its own', async ({ page, app }) => {
  app.seed.task(overdueSeed(app.today, 'Overdue one', 1))

  await page.goto(app.url)
  await expect.poll(() => activeNames(page)).toEqual(['Overdue one'])
  expect((await dayView(app)).has_overdue).toBe(true)

  // Not in the active section, and not anywhere else on the collapsed screen.
  await expect(activeRegion(page).getByRole('button', { name: /reset/i })).toHaveCount(0)
  await expect(page.getByRole('button', { name: /reset overdue to backlog/i })).toHaveCount(0)
})

// ---------------------------------------------------------------------------
// Mood and log
// ---------------------------------------------------------------------------

test('tapping a mood records it and tapping the selected one clears it', async ({ page, app }) => {
  await page.goto(app.url)

  const moods = page.getByRole('group', { name: 'Mood' })
  const happy = moods.getByRole('button', { name: /^happy/ })

  await expect(happy).toHaveAttribute('aria-pressed', 'false')
  await happy.click()

  await expect(happy).toHaveAttribute('aria-pressed', 'true')
  await expect.poll(async () => (await dayView(app)).mood).toBe('happy')

  // A different one replaces rather than adds.
  const anxious = moods.getByRole('button', { name: /^anxious/ })
  await anxious.click()
  await expect(anxious).toHaveAttribute('aria-pressed', 'true')
  await expect(happy).toHaveAttribute('aria-pressed', 'false')
  await expect.poll(async () => (await dayView(app)).mood).toBe('anxious')

  // Tapping the selected one clears it back to null.
  await anxious.click()
  await expect(anxious).toHaveAttribute('aria-pressed', 'false')
  await expect.poll(async () => (await dayView(app)).mood).toBeNull()
})

/**
 * The mood set is data, not a feature: a table seeded on first run and edited in
 * the database. There is no manager, no add form and no reorder control — the
 * row is a picker and nothing else, and `set_mood` is the only mood command.
 */
test('the mood row offers no way to edit the mood set', async ({ page, app }) => {
  await page.goto(app.url)

  const moodAndLog = page.getByRole('region', { name: 'Mood and log' })
  await expect(page.getByRole('group', { name: 'Mood' })).toBeVisible()

  // One button per active mood, and not one more.
  const active = (await dayView(app)).moods
  expect(active.length).toBeGreaterThan(0)
  await expect(page.getByRole('group', { name: 'Mood' }).getByRole('button')).toHaveCount(
    active.length,
  )
  await expect(moodAndLog.getByRole('button', { name: /manage|edit mood|add.*mood/i })).toHaveCount(0)
  await expect(page.getByRole('dialog', { name: 'Moods' })).toHaveCount(0)

  // And the endpoints behind it are gone.
  expect((await fetch(`${app.url}/api/moods`)).status).toBe(404)
  const create = await fetch(`${app.url}/api/commands/create_mood`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ slug: 'restless', emoji: '😖', label: 'restless' }),
  })
  expect(create.ok).toBe(false)
})

test('the log field saves its text', async ({ page, app }) => {
  await page.goto(app.url)

  const moodAndLog = page.getByRole('region', { name: 'Mood and log' })
  await moodAndLog.getByRole('button', { name: /log for today/i }).click()

  const field = page.getByRole('textbox', { name: 'Log for today' })
  await field.fill('Slept badly, still got the bins out.')
  await moodAndLog.getByRole('button', { name: /^save$/i }).click()

  await expect.poll(async () => (await dayView(app)).log).toBe('Slept badly, still got the bins out.')
  await expect(moodAndLog.getByText('Slept badly, still got the bins out.')).toBeVisible()
})

test('mood and log survive a reload', async ({ page, app }) => {
  await page.goto(app.url)

  await page.getByRole('group', { name: 'Mood' }).getByRole('button', { name: /^scattered/ }).click()
  await expect.poll(async () => (await dayView(app)).mood).toBe('scattered')

  const moodAndLog = page.getByRole('region', { name: 'Mood and log' })
  await moodAndLog.getByRole('button', { name: /log for today/i }).click()
  await page.getByRole('textbox', { name: 'Log for today' }).fill('Two loads of washing.')
  await moodAndLog.getByRole('button', { name: /^save$/i }).click()
  await expect.poll(async () => (await dayView(app)).log).toBe('Two loads of washing.')

  await page.reload()

  await expect(
    page.getByRole('group', { name: 'Mood' }).getByRole('button', { name: /^scattered/ }),
  ).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByText('Two loads of washing.')).toBeVisible()
})

// ---------------------------------------------------------------------------
// Capture
// ---------------------------------------------------------------------------

test('capture creates a dateless backlog item that stays off the Day list', async ({
  page,
  app,
}) => {
  app.seed.task({ name: 'Existing daily', cadence: 'day' })

  await page.goto(app.url)
  await page.getByRole('button', { name: 'Capture a new item' }).click()

  const sheet = page.getByRole('dialog', { name: 'Capture' })
  await sheet.getByRole('textbox', { name: 'Task name' }).fill('Replace the shower hose')
  await sheet.getByRole('button', { name: /^add$/i }).click()

  await expect(sheet).toHaveCount(0)

  const captured = inventory(await todoView(app), 'Replace the shower hose')
  expect(captured).toBeDefined()
  expect(captured!.cadence).toBeNull()
  expect(captured!.effective_date).toBeNull()

  // No date, so it is correctly absent from today's list. (Scoped to the list
  // rather than the page: the confirmation notice quotes the name.)
  await expect.poll(() => activeNames(page)).toEqual(['Existing daily'])
  const day = await dayView(app)
  expect(day.active.map((t) => t.name)).not.toContain('Replace the shower hose')
  expect(day.completed.map((t) => t.name)).not.toContain('Replace the shower hose')
})

// ---------------------------------------------------------------------------
// Task definition does NOT live here
// ---------------------------------------------------------------------------

/**
 * Since v3 nothing on a Day row opens a form. The list is for doing: every tap
 * on it is made mid-task while working through the day, and a definition sheet
 * arriving from a mis-tap is the opposite of cheap. Editing is a name-tap in the
 * To do panel — covered in e2e/todo.spec.ts.
 */
test('no row in the Day list opens an editor', async ({ page, app }) => {
  app.seed.task({ name: 'Vacuum', cadence: 'day' })
  await page.goto(app.url)

  await expect(activeRegion(page).getByRole('button', { name: /^Edit / })).toHaveCount(0)

  // The name is present, and is not a control.
  await expect(activeRegion(page).getByText('Vacuum')).toBeVisible()
  await activeRegion(page).getByText('Vacuum').click()
  await expect(page.getByRole('dialog', { name: 'Edit task' })).toHaveCount(0)
})

// ---------------------------------------------------------------------------
// Reorder
// ---------------------------------------------------------------------------

test('dragging a task in the reorder state persists days.task_order', async ({ page, app }) => {
  const alpha = app.seed.task({ name: 'Alpha job', cadence: 'day' })
  const bravo = app.seed.task({ name: 'Bravo job', cadence: 'day' })
  const charlie = app.seed.task({ name: 'Charlie job', cadence: 'day' })

  await page.goto(app.url)
  await expect.poll(() => activeNames(page)).toEqual(['Alpha job', 'Bravo job', 'Charlie job'])

  await page.getByRole('button', { name: /^reorder$/i }).click()
  await dragWithKeyboard(page, 'Bravo job', 'ArrowUp')
  await expect.poll(() => reorderNames(page)).toEqual(['Bravo job', 'Alpha job', 'Charlie job'])

  await page.getByRole('button', { name: /^done reordering$/i }).click()
  await expect.poll(() => activeNames(page)).toEqual(['Bravo job', 'Alpha job', 'Charlie job'])

  const day = await dayView(app)
  expect(day.active.map((t) => t.id)).toEqual([bravo, alpha, charlie])

  await page.reload()
  await expect.poll(() => activeNames(page)).toEqual(['Bravo job', 'Alpha job', 'Charlie job'])
})

/**
 * Bands never mix. Each band is its own drag context, so a baseline task and a
 * non-baseline one are never draggable against each other — the boundary is not
 * a rule being enforced, it is a move that cannot be expressed.
 */
test('a drag cannot move a task across the baseline boundary', async ({ page, app }) => {
  app.seed.task({ name: 'Zulu baseline', cadence: 'day', is_baseline: true })
  app.seed.task({ name: 'Alpha job', cadence: 'day' })
  app.seed.task({ name: 'Bravo job', cadence: 'day' })

  await page.goto(app.url)
  await expect.poll(() => activeNames(page)).toEqual(['Zulu baseline', 'Alpha job', 'Bravo job'])

  await page.getByRole('button', { name: /^reorder$/i }).click()

  // The top non-baseline task cannot be lifted above the baseline one.
  await dragWithKeyboard(page, 'Alpha job', 'ArrowUp', { expectMove: false })
  await expect.poll(() => reorderNames(page)).toEqual(['Zulu baseline', 'Alpha job', 'Bravo job'])

  await page.getByRole('button', { name: /^done reordering$/i }).click()
  const day = await dayView(app)
  expect(day.active.map((t) => t.name)).toEqual(['Zulu baseline', 'Alpha job', 'Bravo job'])
})

test('a task moves freely inside its own band, below a baseline one', async ({ page, app }) => {
  app.seed.task({ name: 'Zulu baseline', cadence: 'day', is_baseline: true })
  app.seed.task({ name: 'Alpha job', cadence: 'day' })
  app.seed.task({ name: 'Bravo job', cadence: 'day' })

  await page.goto(app.url)
  // Both of Day's fetches have to land before the edit state opens: a re-render
  // arriving mid-drag re-registers the sortable nodes. Every other reorder test
  // waits here for the same reason.
  await expect.poll(() => activeNames(page)).toEqual(['Zulu baseline', 'Alpha job', 'Bravo job'])
  await page.getByRole('button', { name: /^reorder$/i }).click()

  await dragWithKeyboard(page, 'Bravo job', 'ArrowUp')
  await expect.poll(() => reorderNames(page)).toEqual(['Zulu baseline', 'Bravo job', 'Alpha job'])

  await page.getByRole('button', { name: /^done reordering$/i }).click()
  const day = await dayView(app)
  expect(day.active.map((t) => t.name)).toEqual(['Zulu baseline', 'Bravo job', 'Alpha job'])
})

test('a pointer drag reorders too', async ({ page, app }) => {
  app.seed.task({ name: 'Alpha job', cadence: 'day' })
  app.seed.task({ name: 'Bravo job', cadence: 'day' })

  await page.goto(app.url)
  await page.getByRole('button', { name: /^reorder$/i }).click()

  const rows = sortableRows(page)
  const from = await rows.filter({ hasText: 'Bravo job' }).boundingBox()
  const to = await rows.filter({ hasText: 'Alpha job' }).boundingBox()
  expect(from && to).toBeTruthy()

  // Stepped moves: dnd-kit needs real intermediate pointer events, and the
  // sensor only arms after a few pixels of travel.
  await page.mouse.move(from!.x + from!.width / 2, from!.y + from!.height / 2)
  await page.mouse.down()
  await page.mouse.move(to!.x + to!.width / 2, to!.y + to!.height / 2, { steps: 12 })
  await page.mouse.move(to!.x + to!.width / 2, to!.y - 4, { steps: 6 })
  await page.mouse.up()

  await expect.poll(() => reorderNames(page)).toEqual(['Bravo job', 'Alpha job'])
})

/**
 * D5. The arrangement is the user's work: if the write fails it must still be on
 * screen to retry. Clearing the edit state before awaiting the command threw it
 * away silently and snapped the list back to the server's order.
 */
test('a failed reorder keeps the arrangement instead of discarding it', async ({ page, app }) => {
  app.seed.task({ name: 'Alpha job', cadence: 'day' })
  app.seed.task({ name: 'Bravo job', cadence: 'day' })

  await page.goto(app.url)
  await expect.poll(() => activeNames(page)).toEqual(['Alpha job', 'Bravo job'])

  await page.route('**/api/commands/set_task_order', (r) => r.abort())
  await page.getByRole('button', { name: /^reorder$/i }).click()
  await dragWithKeyboard(page, 'Bravo job', 'ArrowUp')
  await expect.poll(() => reorderNames(page)).toEqual(['Bravo job', 'Alpha job'])

  await page.getByRole('button', { name: /^done reordering$/i }).click()

  await expect(page.getByRole('alert')).toBeVisible()
  await expect(page.getByRole('button', { name: /^done reordering$/i })).toBeVisible()
  await expect.poll(() => reorderNames(page)).toEqual(['Bravo job', 'Alpha job'])

  // Retrying the same gesture, unblocked, saves what was still on screen.
  await page.unroute('**/api/commands/set_task_order')
  await page.getByRole('button', { name: /^done reordering$/i }).click()
  await expect.poll(() => activeNames(page)).toEqual(['Bravo job', 'Alpha job'])
})

/**
 * D7. A refetch triggered by anything else during the edit state reconciles the
 * held id list against a new model, and rows get silently dropped. The mood row
 * and the panel are both frozen while reordering so that cannot happen.
 */
test('the mood row and the panel are frozen while reordering', async ({ page, app }) => {
  app.seed.task({ name: 'Alpha job', cadence: 'day' })
  app.seed.task({ name: 'Bravo job', cadence: 'day' })

  await page.goto(app.url)
  await expect.poll(() => activeNames(page)).toEqual(['Alpha job', 'Bravo job'])

  await page.getByRole('button', { name: /^reorder$/i }).click()
  await expect(
    page.getByRole('group', { name: 'Mood' }).getByRole('button', { name: /^happy/ }),
  ).toBeDisabled()
  await expect(page.getByRole('button', { name: /log for today/i })).toBeDisabled()

  await page.getByRole('button', { name: /^done reordering$/i }).click()
  await expect(
    page.getByRole('group', { name: 'Mood' }).getByRole('button', { name: /^happy/ }),
  ).toBeEnabled()
})

// ---------------------------------------------------------------------------
// The To do and Backlog panels, hosted here
// ---------------------------------------------------------------------------

/**
 * Day hosts both panels and fetches the one model behind them; they are
 * collapsed here because the list above is arranged for doing and the panels
 * answer "what else is there?". The hole they fill is a period task that was
 * never placed: on no day's list, and before the panel existed, on no screen at
 * all — and a one-off with no date, which is now next door in Backlog.
 */
test('both panels are hosted here, collapsed, holding what Day does not show', async ({
  page,
  app,
}) => {
  app.seed.task({ name: 'Feed the dog', cadence: 'day' })
  app.seed.task({ name: 'Grocery run', cadence: 'week' })
  app.seed.task({ name: 'Call the vet', cadence: null })

  await page.goto(app.url)
  await expect.poll(() => activeNames(page)).toEqual(['Feed the dog'])

  // Unplaced, so both are correctly absent from today's list — and present in
  // the inventory, which is the point.
  expect(inventory(await todoView(app), 'Grocery run')!.effective_date).toBeNull()
  expect(inventory(await todoView(app), 'Call the vet')!.effective_date).toBeNull()

  for (const name of ['To do', 'Backlog'] as const) {
    await expect(panel(page, name)).toHaveCount(1)
    await expect(panelToggle(page, name)).toHaveAttribute('aria-expanded', 'false')
  }
  await expect(page.getByText('Grocery run')).toHaveCount(0)
  await expect(page.getByText('Call the vet')).toHaveCount(0)

  // Each opens on its own: the period groups are in one panel, the one-off
  // group in the other, and opening one does not open the other.
  await panelToggle(page, 'To do').click()
  await expect(panelToggle(page, 'To do')).toHaveAttribute('aria-expanded', 'true')
  await expect(panelToggle(page, 'Backlog')).toHaveAttribute('aria-expanded', 'false')
  await expect(panel(page, 'To do').getByText('Grocery run')).toBeVisible()
  await expect(page.getByText('Call the vet')).toHaveCount(0)

  await panelToggle(page, 'Backlog').click()
  await expect(panelToggle(page, 'Backlog')).toHaveAttribute('aria-expanded', 'true')
  await expect(panel(page, 'Backlog').getByText('Call the vet')).toBeVisible()
  await expect(panel(page, 'Backlog').getByText('Grocery run')).toHaveCount(0)
})

test('a command fired from the panel refetches Day as well', async ({ page, app }) => {
  app.seed.task({ name: 'Feed the dog', cadence: 'day' })

  await page.goto(app.url)
  await expect.poll(() => activeNames(page)).toEqual(['Feed the dog'])

  await panelToggle(page).click()
  await panel(page).getByRole('checkbox', { name: 'Complete Feed the dog' }).click()

  // Both models are refetched and replaced wholesale, so the host moves the row
  // into its own completed section without being told what changed.
  await expect.poll(() => completedNames(page)).toEqual(['Feed the dog'])
  await expect.poll(() => activeNames(page)).toEqual([])
})

// ---------------------------------------------------------------------------
// Console health
// ---------------------------------------------------------------------------

test('no console errors while exercising the main gestures', async ({ page, app }) => {
  const errors: string[] = []
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
  page.on('pageerror', (e) => errors.push(String(e)))

  app.seed.task({ name: 'Gesture daily', cadence: 'day' })
  app.seed.task(overdueSeed(app.today, 'Gesture overdue', 3))

  await page.goto(app.url)
  await expect.poll(() => activeNames(page)).toEqual(['Gesture daily', 'Gesture overdue'])

  await tick(page, 'Gesture daily').click()
  await expect(untick(page, 'Gesture daily')).toBeVisible()
  await untick(page, 'Gesture daily').click()
  await expect(tick(page, 'Gesture daily')).toBeVisible()

  await page.getByRole('group', { name: 'Mood' }).getByRole('button', { name: /^balanced/ }).click()
  await expect.poll(async () => (await dayView(app)).mood).toBe('balanced')

  await row(page, 'Gesture overdue').getByRole('button', { name: /give it a day/i }).click()
  await expect(picker(page, 'Gesture overdue')).toBeVisible()

  await panelToggle(page).click()
  await expect(panel(page).getByRole('region', { name: 'This week' })).toBeVisible()
  await panelToggle(page).click()

  await page.getByRole('button', { name: 'Capture a new item' }).click()
  await page.getByRole('dialog', { name: 'Capture' }).getByRole('button', { name: /^close$/i }).click()

  await page.getByRole('button', { name: /^reorder$/i }).click()
  await page.getByRole('button', { name: /^done reordering$/i }).click()
  await expect(page.getByRole('button', { name: /^reorder$/i })).toBeVisible()

  await page.waitForLoadState('networkidle')
  expect(errors).toEqual([])
})

/**
 * Capture gained the editor's full field set in v4, behind a disclosure. The
 * fast path is unchanged — a name and Add — and this covers the slow one.
 */
test('capture can set cadence and baseline from the More section', async ({ page, app }) => {
  await page.goto(app.url)
  await page.getByRole('button', { name: 'Capture a new item' }).click()

  const sheet = page.getByRole('dialog', { name: 'Capture' })
  await sheet.getByRole('textbox', { name: 'Task name' }).fill('Water the plants')

  // Closed by default: the fast path never sees these.
  await expect(sheet.getByRole('combobox', { name: 'Cadence' })).toBeHidden()
  await sheet.getByText('More', { exact: true }).click()

  await sheet.getByRole('combobox', { name: 'Cadence' }).selectOption('day')
  await sheet.getByRole('checkbox', { name: /baseline/i }).check()
  await sheet.getByRole('button', { name: /^add$/i }).click()
  await expect(sheet).toHaveCount(0)

  // A daily baseline task, so it lands on today's list rather than the backlog.
  await expect.poll(() => activeNames(page)).toContain('Water the plants')
  const day = await dayView(app)
  const made = day.active.find((t) => t.name === 'Water the plants')!
  expect(made.cadence).toBe('day')
  expect(made.is_baseline).toBe(true)
})

test('a baseline colour paints the row edge and the name, and only for baseline', async ({
  page,
  app,
}) => {
  const painted = app.seed.task({ name: 'MED', cadence: 'day', is_baseline: true, color: '#c2410c' })
  // Same colour stored, but not baseline — the server must not ship it.
  app.seed.task({ name: 'Zebra', cadence: 'day', is_baseline: false, color: '#c2410c' })

  await page.goto(app.url)
  const day = await dayView(app)
  expect(day.active.find((t) => t.id === painted)!.color).toBe('#c2410c')
  expect(day.active.find((t) => t.name === 'Zebra')!.color).toBeNull()

  const row = page.getByRole('listitem').filter({ hasText: 'MED' }).first()
  await expect(row).toHaveAttribute('data-colour', '')
  // The stripe is a background gradient keyed off --stripe-colour, not a border
  // and not a shadow: a border would indent the row away from its neighbours.
  const stripe = await row.evaluate((el) =>
    getComputedStyle(el).getPropertyValue('--stripe-colour').trim(),
  )
  expect(stripe).toBe('#c2410c')
  const gradient = await row.evaluate((el) => getComputedStyle(el).backgroundImage)
  expect(gradient).toContain('rgb(194, 65, 12)')

  const plain = page.getByRole('listitem').filter({ hasText: 'Zebra' }).first()
  await expect(plain).not.toHaveAttribute('data-colour', '')
})
