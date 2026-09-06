import { test, expect, type App } from './fixtures.ts'
import type { Page } from '@playwright/test'

/**
 * Signing in, and staying signed in.
 *
 * Every test here runs a server with AUTH_REQUIRED=1. The rest of the suite
 * leaves it off — with it off the app resolves to user 1 and there is no login
 * step to thread through 236 tests — so this file is the only place the gate is
 * actually closed.
 *
 * What is proved elsewhere: that one user cannot READ another's data lives in
 * tests/isolation.test.ts, against the builders directly, because that is where
 * a missing `where` would be. Here it is about identity — who a browser is, and
 * for how long.
 */

test.use({ authRequired: true })

const PASSWORD = 'a-long-enough-password'

/** The migration's `owner` has no usable password until something gives it one. */
function withOwner(app: App): void {
  app.seed.password('owner', PASSWORD)
}

async function signIn(page: Page, app: App, username = 'owner', password = PASSWORD) {
  await page.goto(`${app.url}/login`)
  await page.getByLabel('Name').fill(username)
  await page.getByLabel('Password').fill(password)
  await page.getByRole('button', { name: 'Sign in' }).click()
}

const loginForm = (page: Page) => page.getByRole('button', { name: 'Sign in' })

test('an unauthenticated visitor lands on the login page, not a broken app', async ({
  page,
  app,
}) => {
  withOwner(app)
  app.seed.task({ name: 'Feed Barney', cadence: 'day' })

  // The bundle is not gated — Bun cannot serve it conditionally — so the app
  // does load. Its first request comes back 401 and the client leaves.
  await page.goto(app.url)
  await expect(loginForm(page)).toBeVisible()
  expect(new URL(page.url()).pathname).toBe('/login')
  // And nothing of the board leaked on the way past.
  await expect(page.getByText('Feed Barney')).toHaveCount(0)
})

test('the API refuses without a session, and says so as a 401', async ({ app }) => {
  withOwner(app)
  for (const path of ['/api/day', '/api/todo', '/api/history']) {
    expect((await fetch(`${app.url}${path}`)).status, path).toBe(401)
  }
  // A command too — reading and writing are gated by the same line.
  const res = await fetch(`${app.url}/api/commands/create_task`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'let me in' }),
  })
  expect(res.status).toBe(401)
})

test('the wrong password does not sign you in, and says nothing useful', async ({ page, app }) => {
  withOwner(app)
  await signIn(page, app, 'owner', 'not-the-password')

  await expect(loginForm(page)).toBeVisible()
  await expect(page.getByRole('alert')).toBeVisible()
  // The same message an unknown name gets: telling them apart only helps
  // somebody finding out which names are real.
  const wrongPassword = (await page.getByRole('alert').textContent()) ?? ''
  await signIn(page, app, 'nobody-at-all', PASSWORD)
  await expect(page.getByRole('alert')).toHaveText(wrongPassword)
})

test('the right password signs you in and the board appears', async ({ page, app }) => {
  withOwner(app)
  app.seed.task({ name: 'Feed Barney', cadence: 'day' })

  await signIn(page, app)
  await expect(page.getByRole('checkbox', { name: 'Complete Feed Barney' })).toBeVisible()
  expect(new URL(page.url()).pathname).toBe('/')

  // And it survives a reload, which is the whole point of a cookie.
  await page.reload()
  await expect(page.getByRole('checkbox', { name: 'Complete Feed Barney' })).toBeVisible()
})

test('signing out ends the session', async ({ page, app }) => {
  withOwner(app)
  app.seed.task({ name: 'Feed Barney', cadence: 'day' })
  await signIn(page, app)
  await expect(page.getByRole('checkbox', { name: 'Complete Feed Barney' })).toBeVisible()

  await page.getByRole('button', { name: 'Sign out' }).click()
  await expect(loginForm(page)).toBeVisible()

  await page.goto(app.url)
  await expect(loginForm(page)).toBeVisible()
})

test('the sign-out control only exists where there is a session to end', async ({ page, app }) => {
  withOwner(app)
  await signIn(page, app)
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible()
})

test('two people see their own boards and nothing of each other', async ({ page, app }) => {
  withOwner(app)
  const other = app.seed.user({ username: 'wife', password: PASSWORD })
  app.seed.task({ name: 'Feed Barney', cadence: 'day' })
  app.seed.task({ name: 'Water the ferns', cadence: 'day', user_id: other })

  await signIn(page, app, 'wife')
  await expect(page.getByRole('checkbox', { name: 'Complete Water the ferns' })).toBeVisible()
  await expect(page.getByText('Feed Barney')).toHaveCount(0)

  await page.getByRole('button', { name: 'Sign out' }).click()
  await signIn(page, app, 'owner')
  await expect(page.getByRole('checkbox', { name: 'Complete Feed Barney' })).toBeVisible()
  await expect(page.getByText('Water the ferns')).toHaveCount(0)
})

test('changing a password invalidates the sessions signed with the old one', async ({
  page,
  app,
}) => {
  withOwner(app)
  app.seed.task({ name: 'Feed Barney', cadence: 'day' })
  await signIn(page, app)
  await expect(page.getByRole('checkbox', { name: 'Complete Feed Barney' })).toBeVisible()

  // The cookie is signed with the user's password hash, so changing the password
  // revokes their cookies — no session table, no logout-everywhere command.
  app.seed.password('owner', 'a-completely-different-password')

  await page.reload()
  await expect(loginForm(page)).toBeVisible()
})

test('an account with no password set cannot be signed into', async ({ page, app }) => {
  // `owner` as the migration leaves it: it owns every pre-ownership row and has
  // an empty hash, which must never verify against anything — including ''.
  app.seed.task({ name: 'Feed Barney', cadence: 'day' })
  for (const attempt of ['', 'anything', PASSWORD]) {
    await signIn(page, app, 'owner', attempt)
    await expect(loginForm(page)).toBeVisible()
  }
  await expect(page.getByText('Feed Barney')).toHaveCount(0)
})

test('repeated failures lock the account out for a while', async ({ page, app }) => {
  withOwner(app)

  // The limit is 8. argon2 already costs ~55ms a try; this is the second of two
  // defences, not the only one.
  for (let i = 0; i < 8; i++) await signIn(page, app, 'owner', `wrong-${i}`)

  // Now even the right password is refused, which is what a lockout means.
  await signIn(page, app)
  await expect(loginForm(page)).toBeVisible()
})
