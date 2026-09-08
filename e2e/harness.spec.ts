import { test, expect, addDays } from './fixtures.ts'

/**
 * Proves the harness itself: an isolated server per test, direct DB seeding for
 * rows the API refuses, and a real browser rendering the app. If this fails,
 * nothing else in e2e/ is trustworthy.
 */

test('app boots and renders the Day view', async ({ page, app }) => {
  await page.goto(app.url)
  await expect(page.locator('#root')).not.toBeEmpty()
  await expect(page.getByRole('button', { name: /^day$/i })).toHaveAttribute('aria-current', 'page')
})

test('each test gets an isolated database', async ({ page, app }) => {
  app.seed.task({ name: 'ISOLATION MARKER', cadence: 'day' })
  await page.goto(app.url)
  await expect(page.getByText('ISOLATION MARKER')).toBeVisible()
})

test("the previous test's data is gone", async ({ page, app }) => {
  await page.goto(app.url)
  await expect(page.getByText('ISOLATION MARKER')).toHaveCount(0)
})

test('a past-dated placement seeds an overdue task', async ({ page, app }) => {
  // `place` rejects past dates, so this can only come from the DB.
  //
  // A ONE-OFF, deliberately: its period start is unbounded, so a past date stays
  // overdue on every weekday. A weekly task placed two days ago is overdue from
  // Tuesday on, but on a Sunday it sits in the PREVIOUS week — its effective date
  // has fallen out the back of the period, so it is unplaced rather than overdue,
  // and this test would fail for a correct reason one day in seven.
  app.seed.task({ name: 'SEEDED OVERDUE', cadence: null, planned_date: addDays(app.today, -2) })
  const day = await (await app.fetch('/api/day')).json()
  expect(day.active.find((t: any) => t.name === 'SEEDED OVERDUE').state).toBe('overdue')
  await page.goto(app.url)
  await expect(page.getByText('SEEDED OVERDUE')).toBeVisible()
})

test('no console errors on load', async ({ page, app }) => {
  const errors: string[] = []
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
  page.on('pageerror', (e) => errors.push(String(e)))
  await page.goto(app.url)
  await page.waitForLoadState('networkidle')
  expect(errors).toEqual([])
})

/**
 * The suite must never touch a real database, and for one afternoon it did.
 *
 * `.env` gained Turso credentials, Bun auto-loaded them in the spawned server,
 * and every test server became an embedded replica of PRODUCTION — writing ~200
 * rows there before anyone noticed. `DB_PATH` still pointed at a temp file, so
 * isolation between tests (above) looked perfect throughout.
 *
 * That is the gap this closes: those tests prove the databases differ from each
 * other, not that they are local. See `.plan/changes-v10.md`.
 */
test('the server under test is a local file, never a Turso replica', async ({ app }) => {
  // Asked, not inferred. This used to check for the absence of a libSQL `-info`
  // file beside the database — true at the time, and an implementation detail
  // that could change without anybody noticing this guard had stopped guarding.
  const status = (await app.fetch('/api/status').then((r) => r.json())) as {
    ok: boolean
    database: string
  }
  expect(status.ok).toBe(true)
  expect(status.database).toBe('local')

  // And the fixture carries the same answer, so a test can assert on it without
  // making a request of its own.
  expect(app.database).toBe('local')
})
