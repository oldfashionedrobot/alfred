import { test, expect, addDays, type App } from './fixtures.ts'
import type { Locator, Page } from '@playwright/test'

/**
 * The Week view — the planning surface. Two things and nothing else: the seven
 * days of the current week, and the panels it hosts.
 *
 * Overdue, Unplaced and Backlog were sections here and are gone; each was a
 * filter over a list the panels now hold in full. Since v5 that list is drawn
 * by two of them — "To do" for the five period groups, "Backlog" for the
 * one-off group — so "Backlog" on this screen is a panel, still not a section.
 * Everything the panels do is asserted in e2e/todo.spec.ts. This file asserts
 * the seven days, and that both panels are present and expanded — nothing else
 * about them.
 *
 * Nothing here hardcodes a date. Every expectation is derived from `app.today`
 * and from `GET /api/week`, because the shape of this view depends entirely on
 * which day of the week the suite happens to run: on a Sunday there are seven
 * placeable dates and no past day at all; on a Saturday there is exactly one
 * placeable date and no future day.
 */

// ---------------------------------------------------------------------------
// Wire shapes (mirrors src/shared/types.ts — kept local so the spec never
// imports out of src/).
// ---------------------------------------------------------------------------

type WeekTaskLite = {
  id: number
  name: string
  is_baseline: boolean
  cadence: string | null
  planned_date: string | null
  is_done: boolean
  can_complete: boolean
}
type WeekDayLite = { date: string; is_today: boolean; is_past: boolean; tasks: WeekTaskLite[] }
type WeekLite = {
  week_start: string
  week_end: string
  today: string
  placeable_dates: string[]
  days: WeekDayLite[]
}

// ---------------------------------------------------------------------------
// Date labelling oracle, mirroring src/client/dates.ts. Only Date.UTC() is
// used — never `new Date(iso)`, which the fixture warns about.
// ---------------------------------------------------------------------------

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const
const DOW_LONG = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
] as const
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const
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

function dowIndex(iso: string): number {
  const { y, m, d } = parts(iso)
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay()
}

/** 'Sunday, 6 September' — the day-section heading. */
function longDate(iso: string): string {
  const { m, d } = parts(iso)
  return `${DOW_LONG[dowIndex(iso)]}, ${d} ${MON_LONG[m - 1]}`
}

/** 'Sat 5 Sep' — a day-picker chip. */
function shortDate(iso: string): string {
  const { m, d } = parts(iso)
  return `${DOW[dowIndex(iso)]} ${d} ${MON[m - 1]}`
}

/**
 * The range header. A week is seven days, so only three of periodLabel()'s
 * shapes can ever occur — and a week number is never one of them.
 */
function weekRange(start: string, end: string): string {
  const a = parts(start)
  const b = parts(end)
  if (a.y !== b.y) return `${a.d} ${MON[a.m - 1]} ${a.y} – ${b.d} ${MON[b.m - 1]} ${b.y}`
  if (a.m !== b.m) return `${a.d} ${MON[a.m - 1]} – ${b.d} ${MON[b.m - 1]} ${a.y}`
  return `${a.d} – ${b.d} ${MON[a.m - 1]} ${a.y}`
}

/** The aria-label the Week view gives a day section. */
function dayLabel(iso: string, today: string): string {
  if (iso === today) return `${longDate(iso)} (today)`
  if (iso < today) return `${longDate(iso)} (past, read-only)`
  return longDate(iso)
}

/** The accessible name of one chip in the day picker. */
const pickerChip = (iso: string, today: string): string => (iso === today ? 'Today' : shortDate(iso))

// ---------------------------------------------------------------------------
// API helpers — every UI assertion is cross-checked against these.
// ---------------------------------------------------------------------------

async function getWeek(app: App): Promise<WeekLite> {
  const res = await fetch(`${app.url}/api/week`)
  expect(res.ok).toBe(true)
  return (await res.json()) as WeekLite
}

async function getHistory(app: App): Promise<{
  columns: { task_id: number; name: string }[]
  rows: { date: string; mood: unknown; completed: number[] }[]
}> {
  const res = await fetch(`${app.url}/api/history?limit=365`)
  expect(res.ok).toBe(true)
  return (await res.json()) as never
}

async function post(app: App, name: string, body: Record<string, unknown> = {}): Promise<void> {
  const res = await fetch(`${app.url}/api/commands/${name}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  expect(res.ok, `${name} -> ${res.status}`).toBe(true)
}

/** Every task the week model mentions. It is the seven days, and nothing else. */
function allTasks(w: WeekLite): WeekTaskLite[] {
  return w.days.flatMap((d) => d.tasks)
}

function findTask(w: WeekLite, id: number): WeekTaskLite | undefined {
  return allTasks(w).find((t) => t.id === id)
}

const names = (tasks: WeekTaskLite[]): string[] => tasks.map((t) => t.name)

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------

async function openWeek(page: Page, app: App): Promise<WeekLite> {
  await page.goto(app.url)
  await page.getByRole('navigation').getByRole('button', { name: 'Week', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'This week', exact: true })).toBeVisible()
  return getWeek(app)
}

/**
 * The seven-day grid alone. Every active task is also in one of the panels on
 * this same screen, so an unscoped getByText would match twice — and the
 * panels' contents belong to e2e/todo.spec.ts, not here.
 */
const days = (page: Page): Locator => page.locator('.week-days')

const daySection = (page: Page, iso: string, today: string): Locator =>
  page.getByRole('region', { name: dayLabel(iso, today), exact: true })

/**
 * The panels Week hosts. Since v5 the one panel is rendered twice — "To do"
 * drawing the five period groups and "Backlog" the one-off group — and both are
 * expanded here, because on this screen they ARE the planning surface.
 */
type PanelName = 'To do' | 'Backlog'
const PANELS = ['To do', 'Backlog'] as const
const panel = (page: Page, name: PanelName = 'To do'): Locator =>
  page.getByRole('region', { name, exact: true })
/** Anchored at the start: the toggle's name carries a count ("To do 2 not done"). */
const panelToggle = (page: Page, name: PanelName = 'To do'): Locator =>
  panel(page, name).getByRole('button', { name: new RegExp(`^${name}`, 'i') })

// ===========================================================================
// Structure
// ===========================================================================

test('renders exactly seven day sections, Sunday first, then the two panels', async ({ page, app }) => {
  const w = await openWeek(page, app)

  // The API's own claim, verified first: seven days, Sunday first, spanning
  // week_start..week_end, and week_start really is a Sunday.
  expect(w.days).toHaveLength(7)
  expect(dowIndex(w.week_start)).toBe(0)
  expect(w.days.map((d) => d.date)).toEqual(
    Array.from({ length: 7 }, (_, i) => addDays(w.week_start, i)),
  )
  expect(w.days[6]!.date).toBe(w.week_end)
  expect(w.today).toBe(app.today)

  // Every landmark the grid renders, in DOM order. This asserts the seven day
  // sections, their order, their dates, that today is marked as today and that
  // earlier days are marked past — all at once.
  const rendered = await days(page)
    .getByRole('region')
    .evaluateAll((els) => els.map((e) => e.getAttribute('aria-label') ?? ''))

  expect(rendered).toEqual(w.days.map((d) => dayLabel(d.date, w.today)))

  // And then the two panels, and nothing else. Overdue, Unplaced and Backlog
  // were sections here; each is now a view of a list the panels hold in full —
  // and "Backlog" is a panel drawing the one-off group, not a section of Week.
  for (const name of PANELS) await expect(panel(page, name)).toHaveCount(1)
  await expect(days(page).getByRole('region', { name: 'Backlog' })).toHaveCount(0)

  // The today section carries a visible flag, not only an aria suffix.
  await expect(daySection(page, w.today, w.today).getByText('Today', { exact: true })).toBeVisible()
})

test('the week is named as a date range, never a week number', async ({ page, app }) => {
  const w = await openWeek(page, app)

  // ISO week numbers are Monday-based and cannot express a Sunday-start week,
  // so the header is a range — and a range cannot be wrong. The panel labels
  // its own week group with the same range, hence the scoped locator.
  await expect(page.locator('.week-head__range')).toHaveText(
    weekRange(w.week_start, w.week_end),
  )
})

test('has no week navigation', async ({ page, app }) => {
  const w = await openWeek(page, app)

  // Only the three view tabs navigate anywhere.
  await expect(page.getByRole('navigation').getByRole('button')).toHaveCount(3)

  const buttons = await page
    .getByRole('button')
    .evaluateAll((els) =>
      els.map((e) => (e.getAttribute('aria-label') ?? e.textContent ?? '').trim()),
    )
  const navish = buttons.filter((n) =>
    /prev|previous|next|earlier week|later week|last week|←|→|«|»|◀|▶/i.test(n),
  )
  expect(navish).toEqual([])

  // Seven day sections and no more. No day outside this week is rendered at
  // all, in either direction.
  const regions = await days(page)
    .getByRole('region')
    .evaluateAll((els) => els.map((e) => e.getAttribute('aria-label') ?? ''))
  expect(regions).toHaveLength(7)
  for (const outside of [addDays(w.week_start, -1), addDays(w.week_end, 1)]) {
    expect(regions.some((n) => n.startsWith(longDate(outside)))).toBe(false)
  }
})

test('hosts both panels, expanded', async ({ page, app }) => {
  // On Week the panels ARE the planning surface, so both open expanded — unlike
  // Day, which collapses them. What is inside them is e2e/todo.spec.ts's job;
  // this asserts only that Week hosts each one and hands it its own state.
  app.seed.task({ name: 'Grocery run', cadence: 'week' })
  app.seed.task({ name: 'Call the vet', cadence: null })

  await openWeek(page, app)

  for (const name of PANELS) {
    await expect(panel(page, name)).toBeVisible()
    await expect(panelToggle(page, name)).toHaveAttribute('aria-expanded', 'true')
  }
  // The period groups are in one, the one-off group in the other.
  await expect(panel(page, 'To do').getByText('Grocery run')).toBeVisible()
  await expect(panel(page, 'Backlog').getByText('Call the vet')).toBeVisible()

  // And they collapse independently: closing one leaves the other open.
  await panelToggle(page, 'To do').click()
  await expect(panelToggle(page, 'To do')).toHaveAttribute('aria-expanded', 'false')
  await expect(panelToggle(page, 'Backlog')).toHaveAttribute('aria-expanded', 'true')
  await expect(panel(page, 'Backlog').getByText('Call the vet')).toBeVisible()
  await expect(page.getByText('Grocery run')).toHaveCount(0)
})

test('days earlier in the week are read-only', async ({ page, app }) => {
  const before = await getWeek(app)
  test.skip(before.today === before.week_start, 'no past day exists in the week on a Sunday')

  const past = addDays(app.today, -1)
  app.seed.task({ name: 'Was placed yesterday', cadence: null, planned_date: past })

  const w = await openWeek(page, app)
  const region = daySection(page, past, w.today)

  await expect(region.getByText('Was placed yesterday')).toBeVisible()
  await expect(region.getByText('Past', { exact: true })).toBeVisible()
  // Read-only means exactly that: no tick, no move, no unplan.
  await expect(region.getByRole('button')).toHaveCount(0)
  // ...but whether it was done is still readable, not merely a dimmed glyph.
  await expect(region.getByText('not done', { exact: true })).toBeVisible()

  // The server says the same thing, so the read-only-ness is not just CSS.
  const day = w.days.find((d) => d.date === past)!
  expect(day.is_past).toBe(true)
  expect(day.tasks.every((t) => !t.can_complete)).toBe(true)
})

// ===========================================================================
// Membership — what does and does not reach the seven days
// ===========================================================================

test('daily tasks never appear in the seven days', async ({ page, app }) => {
  const dailies = ['Dog: Feed Barney 1', 'Dog: Feed Barney 2', 'Take meds', 'Wash up']
  for (const name of dailies) {
    app.seed.task({ name, cadence: 'day', is_baseline: name === 'Take meds' })
  }
  // One non-daily on a day, so the grid has something to render and the test
  // cannot pass merely because the page is blank.
  const w0 = await getWeek(app)
  const target = w0.placeable_dates[w0.placeable_dates.length - 1]!
  app.seed.task({ name: 'Grocery run', cadence: 'week', planned_date: target })

  const w = await openWeek(page, app)

  await expect(daySection(page, target, w.today).getByText('Grocery run')).toBeVisible()
  for (const name of dailies) {
    // They are implicit on every day and would be pure noise in a plan. They
    // are still in the panel, which is how one is ticked without leaving here.
    await expect(days(page).getByText(name)).toHaveCount(0)
    expect(names(allTasks(w))).not.toContain(name)
    await expect(panel(page).getByText(name)).toBeVisible()
  }
})

test("a task placed on a day of this week appears in that day's section", async ({ page, app }) => {
  const w0 = await getWeek(app)
  // The last day this week that can hold a placement — Saturday, or today if
  // today is Saturday. Always exists.
  const target = w0.placeable_dates[w0.placeable_dates.length - 1]!
  app.seed.task({ name: 'Grocery run', cadence: 'week', planned_date: target })

  const w = await openWeek(page, app)

  expect(names(w.days.find((d) => d.date === target)!.tasks)).toEqual(['Grocery run'])
  await expect(daySection(page, target, w.today).getByText('Grocery run')).toBeVisible()
  await expect(days(page).getByText('Grocery run')).toHaveCount(1)
})

test('a task with no day appears on no day', async ({ page, app }) => {
  app.seed.task({ name: 'Buy stamps', cadence: null })
  app.seed.task({ name: 'Grocery run', cadence: 'week' })

  const w = await openWeek(page, app)

  expect(allTasks(w)).toEqual([])
  await expect(days(page).getByText('Buy stamps')).toHaveCount(0)
  await expect(days(page).getByText('Grocery run')).toHaveCount(0)
})

test('an overdue task still renders on the day it was placed', async ({ page, app }) => {
  const before = await getWeek(app)
  test.skip(
    before.today === before.week_start,
    'a past day inside this week only exists after Sunday',
  )

  const placed = addDays(app.today, -1)
  // A one-off's period is unbounded, so a past date never falls out of it —
  // this is overdue on any day of the week.
  const id = app.seed.task({ name: 'Call the vet', cadence: null, planned_date: placed })

  const w = await openWeek(page, app)

  // Once, on its own day, and read-only there like any other past day.
  expect(names(w.days.find((d) => d.date === placed)!.tasks)).toEqual(['Call the vet'])
  expect(allTasks(w).filter((t) => t.id === id)).toHaveLength(1)
  await expect(daySection(page, placed, w.today).getByText('Call the vet')).toBeVisible()
  await expect(days(page).getByText('Call the vet')).toHaveCount(1)
  await expect(daySection(page, placed, w.today).getByRole('button')).toHaveCount(0)
})

test('a task placed before this week appears on no day', async ({ page, app }) => {
  const before = await getWeek(app)
  const placed = addDays(before.week_start, -3)
  app.seed.task({ name: 'Call the vet', cadence: null, planned_date: placed })

  const w = await openWeek(page, app)

  expect(allTasks(w)).toEqual([])
  await expect(days(page).getByText('Call the vet')).toHaveCount(0)
})

test('archived tasks appear nowhere', async ({ page, app }) => {
  const w0 = await getWeek(app)
  const target = w0.placeable_dates[w0.placeable_dates.length - 1]!

  app.seed.task({ name: 'Archived placed', cadence: null, planned_date: target, active: false })
  app.seed.task({
    name: 'Archived overdue',
    cadence: null,
    planned_date: addDays(app.today, -4),
    active: false,
  })
  app.seed.task({ name: 'Live placed item', cadence: null, planned_date: target })

  const w = await openWeek(page, app)

  expect(names(allTasks(w))).toEqual(['Live placed item'])
  for (const name of ['Archived placed', 'Archived overdue']) {
    await expect(page.getByText(name)).toHaveCount(0)
  }
})

// ===========================================================================
// Gestures on the seven days
// ===========================================================================

test('the day picker offers exactly placeable_dates', async ({ page, app }) => {
  const w0 = await getWeek(app)
  app.seed.task({ name: 'Buy stamps', cadence: null, planned_date: w0.today })

  const w = await openWeek(page, app)
  const placeable = w.placeable_dates

  // The server's own contract first: today through Saturday, nothing else.
  expect(placeable[0]).toBe(w.today)
  expect(placeable[placeable.length - 1]).toBe(w.week_end)
  expect(placeable.every((d) => d >= w.today && d <= w.week_end)).toBe(true)

  const section = daySection(page, w.today, w.today)
  await section.getByRole('button', { name: 'Reschedule Buy stamps', exact: true }).click()

  const picker = section.getByRole('group', { name: 'Pick a day' })
  await expect(picker).toBeVisible()

  const offered = await picker
    .getByRole('button')
    .evaluateAll((els) => els.map((e) => (e.textContent ?? '').trim()))

  // Exactly the placeable dates, in order, and nothing else: no day already
  // past this week, and nothing in next week. The client never works the list
  // out for itself, so the picker and the 409 on `place` cannot disagree.
  expect(offered).toEqual(placeable.map((d) => pickerChip(d, w.today)))

  // Stated explicitly as well as implied by the equality above.
  const forbidden = [
    ...w.days.map((d) => d.date).filter((d) => d < w.today),
    addDays(w.week_end, 1),
    addDays(w.week_end, 3),
  ]
  for (const d of forbidden) {
    await expect(picker.getByRole('button', { name: shortDate(d), exact: true })).toHaveCount(0)
  }
})

test('rescheduling moves a task to the day picked', async ({ page, app }) => {
  const w0 = await getWeek(app)
  test.skip(
    w0.placeable_dates.length < 2,
    'rescheduling needs a second placeable day; on a Saturday there is none',
  )

  const from = w0.placeable_dates[0]!
  const target = w0.placeable_dates[w0.placeable_dates.length - 1]!
  const id = app.seed.task({ name: 'Buy stamps', cadence: null, planned_date: from })

  const w = await openWeek(page, app)
  const section = daySection(page, from, w.today)
  await section.getByRole('button', { name: 'Reschedule Buy stamps', exact: true }).click()
  await section
    .getByRole('group', { name: 'Pick a day' })
    .getByRole('button', { name: pickerChip(target, w.today), exact: true })
    .click()

  await expect.poll(async () => findTask(await getWeek(app), id)?.planned_date).toBe(target)
  await expect(daySection(page, target, w.today).getByText('Buy stamps')).toBeVisible()
  await expect(daySection(page, from, w.today).getByText('Buy stamps')).toHaveCount(0)
  await expect(days(page).getByText('Buy stamps')).toHaveCount(1)
})

test('unplan takes a task off its day', async ({ page, app }) => {
  const id = app.seed.task({ name: 'Grocery run', cadence: 'week', planned_date: app.today })

  const w = await openWeek(page, app)
  expect(names(w.days.find((d) => d.date === w.today)!.tasks)).toEqual(['Grocery run'])

  await daySection(page, w.today, w.today)
    .getByRole('button', { name: 'Unplan Grocery run', exact: true })
    .click()

  await expect.poll(async () => findTask(await getWeek(app), id)?.planned_date ?? null).toBeNull()

  // Off every day, not merely off this one. Where it went — the panel, with no
  // day shown against it — is e2e/todo.spec.ts's business.
  expect(allTasks(await getWeek(app))).toEqual([])
  await expect(days(page).getByText('Grocery run')).toHaveCount(0)
})

test("ticking on today's section writes a completion dated today", async ({ page, app }) => {
  const id = app.seed.task({ name: 'Grocery run', cadence: 'week', planned_date: app.today })

  const w = await openWeek(page, app)
  const section = daySection(page, w.today, w.today)
  expect(w.days.find((d) => d.date === w.today)!.tasks[0]!.can_complete).toBe(true)

  await section.getByRole('checkbox', { name: 'Complete Grocery run', exact: true }).click()

  // It stays on the day, struck through and untickable-back-again: a mis-tap
  // has to be recoverable from the screen it happened on.
  await expect
    .poll(async () => findTask(await getWeek(app), id)?.is_done)
    .toBe(true)
  await expect(
    section.getByRole('checkbox', { name: 'Untick Grocery run', exact: true }),
  ).toBeChecked()

  /* The date of a non-daily completion is not exposed by any view model, and
     the harness cannot read the DB back. Editing is unversioned and retroactive
     (`.plan/views.md`, "Editing is unversioned"), so flipping the task to
     cadence 'day' re-slices its history into the grid — where the completion
     date IS exposed. Nothing else was ever recorded in this database, so a
     single row dated today is proof of the write date. */
  await post(app, 'update_task', { id, cadence: 'day' })

  const history = await getHistory(app)
  expect(history.rows.map((r) => r.date)).toEqual([app.today])
  expect(history.rows[0]!.completed).toEqual([id])
})

test('unticking on a past day is not offered, whatever the server says', async ({ page, app }) => {
  const before = await getWeek(app)
  test.skip(before.today === before.week_start, 'no past day exists in the week on a Sunday')

  const past = addDays(app.today, -1)
  const id = app.seed.task({ name: 'Call the vet', cadence: null, planned_date: past })
  app.seed.completion(id, past)

  const w = await openWeek(page, app)
  const section = daySection(page, past, w.today)

  // Done, on a past day: can_complete is the server's word and it is false.
  const task = w.days.find((d) => d.date === past)!.tasks[0]!
  expect(task.is_done).toBe(true)
  expect(task.can_complete).toBe(false)

  await expect(section.getByRole('checkbox')).toHaveCount(0)
  await expect(section.getByText('done', { exact: true })).toBeVisible()
})

// ===========================================================================
// Responsive
// ===========================================================================

test('the seven days lay out as columns on a wide viewport', async ({ page, app }) => {
  test.skip((page.viewportSize()?.width ?? 0) < 900, 'column layout starts at 900px')

  const w = await openWeek(page, app)
  const sunday = await daySection(page, w.days[0]!.date, w.today).boundingBox()
  const monday = await daySection(page, w.days[1]!.date, w.today).boundingBox()
  const saturday = await daySection(page, w.days[6]!.date, w.today).boundingBox()

  expect(sunday && monday && saturday).toBeTruthy()
  // Side by side: same row, marching rightwards.
  expect(Math.abs(monday!.y - sunday!.y)).toBeLessThan(4)
  expect(Math.abs(saturday!.y - sunday!.y)).toBeLessThan(4)
  expect(monday!.x).toBeGreaterThan(sunday!.x + sunday!.width / 2)
  expect(saturday!.x).toBeGreaterThan(monday!.x)
})

test('the seven days stack on a narrow viewport', async ({ page, app }) => {
  test.skip((page.viewportSize()?.width ?? 0) >= 900, 'stacked layout is below 900px')

  const w = await openWeek(page, app)
  const sunday = await daySection(page, w.days[0]!.date, w.today).boundingBox()
  const monday = await daySection(page, w.days[1]!.date, w.today).boundingBox()

  expect(sunday && monday).toBeTruthy()
  // Stacked: same column, marching downwards.
  expect(Math.abs(monday!.x - sunday!.x)).toBeLessThan(2)
  expect(monday!.y).toBeGreaterThan(sunday!.y + sunday!.height / 2)
})

test('the page body never scrolls sideways', async ({ page, app }) => {
  const w0 = await getWeek(app)
  // Content that would push a naive layout wide: a long unbroken name, and
  // something on every single day of the week.
  app.seed.task({
    name: 'Reorganiseeverythingintheentiregarageincludingtheshelves',
    cadence: null,
    planned_date: w0.days[0]!.date,
  })
  for (const d of w0.days.map((x) => x.date)) {
    app.seed.task({ name: `Placed on ${d}`, cadence: null, planned_date: d })
  }

  await openWeek(page, app)

  const overflow = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }))
  expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth)
})
