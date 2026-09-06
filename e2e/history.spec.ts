import { test, expect, addDays, type App } from './fixtures.ts'
import type { Locator, Page } from '@playwright/test'

/**
 * The History view — the grid. Dates down, active daily tasks across, filled
 * cells for completions, one mood column, read-only.
 *
 * No date is ever hardcoded: every row expectation is derived from `app.today`
 * via `addDays`, and the grid's own claims are cross-checked against
 * `GET /api/history`.
 */

// ---------------------------------------------------------------------------
// Wire shapes (mirrors src/shared/types.ts — kept local so the spec never
// imports out of src/).
// ---------------------------------------------------------------------------

type MoodLite = { slug: string; emoji: string; label: string; active: boolean }
type HistoryLite = {
  columns: { task_id: number; name: string }[]
  rows: { date: string; mood: MoodLite | null; completed: number[] }[]
  next_before: string | null
}

// ---------------------------------------------------------------------------
// Date labelling oracle. Only Date.UTC() — never `new Date(iso)`.
// ---------------------------------------------------------------------------

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const

function parts(iso: string): { y: number; m: number; d: number } {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number]
  return { y, m, d }
}

/** 'Sat 5 Sep' — the row header's own text, and its accessible name. */
function shortDate(iso: string): string {
  const { y, m, d } = parts(iso)
  return `${DOW[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]} ${d} ${MON[m - 1]}`
}

// ---------------------------------------------------------------------------
// API helpers
// ---------------------------------------------------------------------------

async function getHistory(app: App, query = 'limit=365'): Promise<HistoryLite> {
  const res = await fetch(`${app.url}/api/history?${query}`)
  expect(res.ok).toBe(true)
  return (await res.json()) as HistoryLite
}

/** Total completions the grid could possibly be showing. */
async function completionCount(app: App): Promise<number> {
  const h = await getHistory(app)
  return h.rows.reduce((n, r) => n + r.completed.length, 0)
}

// ---------------------------------------------------------------------------
// Grid helpers — role-based throughout. The date column is a rowheader, so a
// data row is exactly "a row containing a rowheader"; the header row is not.
// ---------------------------------------------------------------------------

async function openHistory(page: Page, app: App): Promise<void> {
  await page.goto(app.url)
  await page.getByRole('navigation').getByRole('button', { name: 'History', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'History' })).toBeVisible()
}

const dataRows = (page: Page): Locator =>
  page.getByRole('row').filter({ has: page.getByRole('rowheader') })

/** Row for `date`, addressed by the date its sticky header shows. */
function rowFor(page: Page, date: string): Locator {
  return dataRows(page).filter({
    has: page.getByRole('rowheader', { name: shortDate(date), exact: true }),
  })
}

/**
 * A row's cells from the MOOD column on: the mood cell, then one per task column.
 * '' is an empty cell, 'done' a filled one (the visually-hidden label), and an
 * emoji in the mood cell. Reading the whole row at once asserts the filled and
 * the unfilled cells in the same breath.
 *
 * The leading LOG cell is dropped. It holds a control rather than a value, and
 * it has its own tests further down; counting it here would put a meaningless
 * empty string in front of every expectation in this file. Its absence from
 * this helper is why every one of them said `['', 'done']` and got `['', '',
 * 'done']` from the moment v6 added the column — this suite has been red since,
 * and nothing else noticed.
 */
function cells(row: Locator): Promise<string[]> {
  return row
    .getByRole('cell')
    .evaluateAll((els) => els.slice(1).map((e) => (e.textContent ?? '').trim()))
}

const scroller = (page: Page): Locator => page.getByRole('region', { name: 'History grid' })

// ===========================================================================
// Columns
// ===========================================================================

test('columns are the active daily tasks only, in sort order', async ({ page, app }) => {
  const baseline = app.seed.task({ name: 'Zzz Baseline Daily', cadence: 'day', is_baseline: true })
  app.seed.task({ name: 'Beta Daily', cadence: 'day' })
  app.seed.task({ name: 'Alpha Daily', cadence: 'day' })
  app.seed.task({ name: 'Weekly Chore', cadence: 'week', planned_date: app.today })
  app.seed.task({ name: 'One Off Thing', cadence: null })
  app.seed.task({ name: 'Archived Daily', cadence: 'day', active: false })
  app.seed.completion(baseline, app.today)

  await openHistory(page, app)

  const headers = await page
    .getByRole('columnheader')
    .evaluateAll((els) => els.map((e) => (e.textContent ?? '').trim()))

  // Baseline is band 1; alphabetical within a band. Weekly, one-off and
  // archived tasks are not columns at all.
  expect(headers).toEqual(['Log', 'Date', 'Mood', 'Zzz Baseline Daily', 'Alpha Daily', 'Beta Daily'])

  const h = await getHistory(app)
  expect(h.columns.map((c) => c.name)).toEqual([
    'Zzz Baseline Daily',
    'Alpha Daily',
    'Beta Daily',
  ])
})

// ===========================================================================
// Rows
// ===========================================================================

test('rows run most recent first and include days with nothing recorded', async ({ page, app }) => {
  const task = app.seed.task({ name: 'Take meds', cadence: 'day' })
  const old = addDays(app.today, -5)
  app.seed.completion(task, old)

  await openHistory(page, app)

  // today .. today-5 inclusive: six rows, five of them completely empty.
  await expect(dataRows(page)).toHaveCount(6)
  for (let i = 0; i < 6; i++) {
    await expect(dataRows(page).nth(i).getByRole('rowheader')).toHaveText(
      shortDate(addDays(app.today, -i)),
    )
  }

  // The gap is real and rendered: four empty rows between today and the record.
  for (let i = 0; i < 5; i++) {
    expect(await cells(dataRows(page).nth(i))).toEqual(['', ''])
  }
  expect(await cells(dataRows(page).nth(5))).toEqual(['', 'done'])

  const h = await getHistory(app)
  expect(h.rows.map((r) => r.date)).toEqual(
    Array.from({ length: 6 }, (_, i) => addDays(app.today, -i)),
  )
  expect(h.rows[5]!.date).toBe(old)
})

test('cells are filled exactly where a completion exists', async ({ page, app }) => {
  const a = app.seed.task({ name: 'Alpha Task', cadence: 'day' })
  const b = app.seed.task({ name: 'Bravo Task', cadence: 'day' })
  const back = addDays(app.today, -3)
  app.seed.completion(a, app.today)
  app.seed.completion(a, back)
  app.seed.completion(b, back)

  await openHistory(page, app)

  await expect(dataRows(page)).toHaveCount(4)
  // [mood, Alpha, Bravo]
  expect(await cells(rowFor(page, app.today))).toEqual(['', 'done', ''])
  expect(await cells(rowFor(page, addDays(app.today, -1)))).toEqual(['', '', ''])
  expect(await cells(rowFor(page, addDays(app.today, -2)))).toEqual(['', '', ''])
  expect(await cells(rowFor(page, back))).toEqual(['', 'done', 'done'])

  const h = await getHistory(app)
  expect(h.rows.find((r) => r.date === app.today)!.completed).toEqual([a])
  expect(h.rows.find((r) => r.date === back)!.completed).toEqual([a, b])
  expect(h.rows.find((r) => r.date === addDays(app.today, -1))!.completed).toEqual([])
})

// ===========================================================================
// Moods
// ===========================================================================

test("the mood column renders the day's emoji", async ({ page, app }) => {
  app.seed.task({ name: 'Take meds', cadence: 'day' })
  app.seed.day(app.today, { mood: 'happy' })
  app.seed.day(addDays(app.today, -2), { mood: 'angry' })

  await openHistory(page, app)

  await expect(dataRows(page)).toHaveCount(3)
  expect(await cells(rowFor(page, app.today))).toEqual(['😊', ''])
  expect(await cells(rowFor(page, addDays(app.today, -1)))).toEqual(['', ''])
  expect(await cells(rowFor(page, addDays(app.today, -2)))).toEqual(['🤬', ''])

  // The glyph is labelled, not decorative.
  await expect(rowFor(page, app.today).getByRole('img', { name: 'happy' })).toBeVisible()
  await expect(rowFor(page, addDays(app.today, -2)).getByRole('img', { name: 'angry' })).toBeVisible()

  const h = await getHistory(app)
  expect(h.rows.find((r) => r.date === app.today)!.mood?.slug).toBe('happy')
  expect(h.rows.find((r) => r.date === addDays(app.today, -1))!.mood).toBeNull()
})

test('a retired mood still renders in History', async ({ page, app }) => {
  app.seed.task({ name: 'Take meds', cadence: 'day' })
  app.seed.day(app.today, { mood: 'happy' })
  app.seed.retire('happy')

  // Retired really means retired: the Day view's picker row is what it has
  // dropped out of. (There is no /api/moods — the mood set is not editable
  // through the API at all.)
  const day = (await (await fetch(`${app.url}/api/day`)).json()) as { moods: MoodLite[] }
  expect(day.moods.map((m) => m.slug)).not.toContain('happy')

  await openHistory(page, app)

  // ...and still resolved here. This is the one place it must still appear.
  expect(await cells(rowFor(page, app.today))).toEqual(['😊', ''])
  await expect(rowFor(page, app.today).getByRole('img', { name: 'happy' })).toBeVisible()

  const h = await getHistory(app)
  expect(h.rows[0]!.mood?.emoji).toBe('😊')
  expect(h.rows[0]!.mood?.active).toBe(false)
})

// ===========================================================================
// Read-only
// ===========================================================================

test('the grid is read-only: clicking cells changes nothing', async ({ page, app }) => {
  const task = app.seed.task({ name: 'Take meds', cadence: 'day' })
  app.seed.completion(task, app.today)
  app.seed.completion(task, addDays(app.today, -2))

  await openHistory(page, app)
  const before = await completionCount(app)
  expect(before).toBe(2)

  // Cell 0 is the log, cell 1 the mood; the single task column is cell 2.
  const filled = rowFor(page, app.today).getByRole('cell').nth(2)
  const empty = rowFor(page, addDays(app.today, -1)).getByRole('cell').nth(2)
  await expect(filled).toHaveText('done')
  await expect(empty).toHaveText('')

  await filled.click()
  await empty.click()
  await filled.dblclick()

  // Nothing was written, nothing was cleared, and the grid did not move.
  expect(await completionCount(app)).toBe(before)
  await expect(filled).toHaveText('done')
  await expect(empty).toHaveText('')
  await expect(dataRows(page)).toHaveCount(3)
})

// ===========================================================================
// Overflow
// ===========================================================================

test('the grid scrolls sideways in its own box, never the page body', async ({ page, app }) => {
  // Enough columns to overflow the widest project viewport: the shell is
  // 720px wide at most, and a task column is 30px.
  let first = 0
  for (let i = 0; i < 24; i++) {
    const id = app.seed.task({ name: `Daily task ${String(i).padStart(2, '0')}`, cadence: 'day' })
    if (i === 0) first = id
  }
  app.seed.completion(first, app.today)

  await openHistory(page, app)
  await expect(page.getByRole('columnheader')).toHaveCount(27) // Log + Date + Mood + 24

  const box = await scroller(page).evaluate((el) => ({
    scrollWidth: el.scrollWidth,
    clientWidth: el.clientWidth,
  }))
  const body = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }))

  // The grid's own container is the thing that scrolls...
  expect(box.scrollWidth).toBeGreaterThan(box.clientWidth)
  // ...and the page body never does.
  expect(body.scrollWidth).toBeLessThanOrEqual(body.clientWidth)
})

// ===========================================================================
// Paging
// ===========================================================================

test('load earlier appends older rows, then reports the beginning of the record', async ({
  page,
  app,
}) => {
  const task = app.seed.task({ name: 'Take meds', cadence: 'day' })
  for (const n of [0, -30, -70, -100]) app.seed.completion(task, addDays(app.today, n))

  await openHistory(page, app)

  // First page: 60 rows, today back to today-59.
  await expect(dataRows(page)).toHaveCount(60)
  await expect(dataRows(page).nth(59).getByRole('rowheader')).toHaveText(
    shortDate(addDays(app.today, -59)),
  )
  await expect(page.getByText('Beginning of the record.')).toHaveCount(0)

  const more = page.getByRole('button', { name: 'Load earlier' })
  await expect(more).toBeVisible()
  await more.click()

  // Older rows appended, down to the earliest thing recorded (today-100).
  await expect(dataRows(page)).toHaveCount(101)
  await expect(dataRows(page).nth(100).getByRole('rowheader')).toHaveText(
    shortDate(addDays(app.today, -100)),
  )
  expect(await cells(rowFor(page, addDays(app.today, -70)))).toEqual(['', 'done'])
  expect(await cells(rowFor(page, addDays(app.today, -100)))).toEqual(['', 'done'])
  expect(await cells(rowFor(page, addDays(app.today, -99)))).toEqual(['', ''])

  // Exhausted: the affordance is replaced, not merely disabled.
  await expect(page.getByRole('button', { name: 'Load earlier' })).toHaveCount(0)
  await expect(page.getByText('Beginning of the record.')).toBeVisible()

  const h = await getHistory(app, `limit=60&before=${addDays(app.today, -59)}`)
  expect(h.next_before).toBeNull()
  expect(h.rows[h.rows.length - 1]!.date).toBe(addDays(app.today, -100))
})

test('an empty database shows nothing recorded rather than an empty grid', async ({
  page,
  app,
}) => {
  await openHistory(page, app)

  await expect(page.getByText('Nothing recorded yet.')).toBeVisible()
  await expect(dataRows(page)).toHaveCount(0)

  const h = await getHistory(app)
  expect(h.rows).toEqual([])
  expect(h.next_before).toBeNull()
})

/**
 * The Log column. A journal entry is prose and will not fit a grid cell, so the
 * column says only whether there is one and opens it on demand.
 */
test('a day with a log offers a control that opens it; a day without offers none', async ({
  page,
  app,
}) => {
  app.seed.task({ name: 'MED', cadence: 'day' })
  app.seed.day(app.today, { log: 'Long day.\nThe gate is finally fixed.' })
  app.seed.day(addDays(app.today, -1), { mood: 'balanced' }) // a day, but no log

  await page.goto(app.url)
  await page.getByRole('button', { name: /^history$/i }).click()

  const opener = page.getByRole('button', { name: new RegExp(`^Read the log for`) })
  await expect(opener).toHaveCount(1) // only the day that has one

  await opener.click()
  const sheet = page.getByRole('dialog')
  await expect(sheet).toBeVisible()

  // The entry's own line breaks survive: it was typed as prose.
  const body = sheet.locator('.hist-read__log')
  await expect(body).toContainText('The gate is finally fixed.')
  expect(await body.innerText()).toContain('\n')

  await sheet.getByRole('button', { name: /^close$/i }).click()
  await expect(sheet).toHaveCount(0)
})

test('the grid stays read-only: opening a log changes nothing', async ({ page, app }) => {
  const id = app.seed.task({ name: 'MED', cadence: 'day' })
  app.seed.completion(id, app.today)
  app.seed.day(app.today, { log: 'noted' })

  const before = await (await fetch(`${app.url}/api/history`)).json()

  await page.goto(app.url)
  await page.getByRole('button', { name: /^history$/i }).click()
  await page.getByRole('button', { name: /^Read the log for/ }).click()
  await expect(page.getByRole('dialog')).toBeVisible()
  await page.getByRole('dialog').getByRole('button', { name: /^close$/i }).click()

  const after = await (await fetch(`${app.url}/api/history`)).json()
  expect(after).toEqual(before)
})

test('columns are ordered by baseline, then category, then name', async ({ page, app }) => {
  const post = (name: string, extra: Record<string, unknown>) =>
    fetch(`${app.url}/api/commands/create_task`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, cadence: 'day', ...extra }),
    })
  // Alphabetically Aardvark < Brush < Dishes < Zzz; by the real rule the
  // baseline task leads despite its name, then Dog, House, uncategorised.
  await post('Zzz vital', { is_baseline: true, category: 'Zebra' })
  await post('Aardvark chore', { category: 'House' })
  await post('Brush Ringo', { category: 'Dog' })
  await post('Dishes', {})

  await page.goto(app.url)
  await page.getByRole('button', { name: /^history$/i }).click()

  const heads = await page.locator('.hist-h--task').allInnerTexts()
  expect(heads.map((h) => h.trim())).toEqual([
    'Zzz vital',
    'Brush Ringo',
    'Aardvark chore',
    'Dishes',
  ])
})

/**
 * A filled cell takes the task's colour where the column has one, so a
 * completion reads the same here as it does in the Day list and the panel.
 */
test('a filled cell wears the baseline task\'s colour, and a plain one does not', async ({
  page,
  app,
}) => {
  const post = (name: string, extra: Record<string, unknown>) =>
    fetch(`${app.url}/api/commands/create_task`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, cadence: 'day', ...extra }),
    })
  await post('MED', { is_baseline: true, color: '#c2410c' })
  await post('Zebra', {})

  // Tick both from the Day list so the completions are real.
  await page.goto(app.url)
  for (const name of ['MED', 'Zebra']) {
    await page.getByRole('checkbox', { name: `Complete ${name}` }).click()
    await expect(page.getByRole('checkbox', { name: `Untick ${name}` })).toBeVisible()
  }

  await page.getByRole('button', { name: /^history$/i }).click()
  const cells = page.locator('.hist-cell--on')
  await expect(cells).toHaveCount(2)

  const painted = await cells.evaluateAll((els) =>
    els.map((el) => getComputedStyle(el).backgroundImage),
  )
  // Column order puts the baseline task first.
  expect(painted[0]).toContain('rgb(194, 65, 12)')
  expect(painted[1]).not.toContain('rgb(194, 65, 12)')
})
