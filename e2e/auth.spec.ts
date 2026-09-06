import { test, expect, type App } from './fixtures.ts'
import type { Page } from '@playwright/test'

/**
 * Signing in, and staying signed in.
 *
 * Every test here starts without a session — `signedIn: false` — which is what
 * makes this file different from the other 236. Everywhere else the fixture
 * signs in, because the app has no other mode.
 *
 * What is proved elsewhere: that one user cannot READ another's data lives in
 * tests/isolation.test.ts, against the builders directly, because that is where
 * a missing `where` would be. Here it is about identity — who a browser is, and
 * for how long.
 */

test.use({ signedIn: false })

const PASSWORD = 'a-long-enough-password'

/** The migration's `owner` has no usable password until something gives it one. */
function withOwner(app: App): void {
  app.seed.password('owner', PASSWORD)
}

const signInButton = (page: Page) => page.getByRole('button', { name: 'Sign in' })

/** Fill the form that is already on screen and submit it. */
async function fillIn(page: Page, username = 'owner', password = PASSWORD) {
  await page.getByLabel('Name').fill(username)
  await page.getByLabel('Password').fill(password)
  await signInButton(page).click()
}

/**
 * Submit, and wait for the failure to land.
 *
 * The cleared password field is the signal: the view empties it on a rejection,
 * so a second attempt that fills the fields before that clear arrives loses its
 * password and leaves the button permanently disabled. Anywhere a failure is
 * expected, wait for it rather than for a timeout.
 */
async function failSignIn(page: Page, username = 'owner', password = 'wrong-one') {
  await fillIn(page, username, password)
  await expect(page.getByLabel('Password')).toHaveValue('')
}

/** Land on the app signed out — its first request 401s and the login view replaces it. */
async function arrive(page: Page, app: App) {
  await page.goto(app.url)
  await expect(signInButton(page)).toBeVisible()
}

test('an unauthenticated visitor gets the login form, not a broken app', async ({ page, app }) => {
  withOwner(app)
  app.seed.task({ name: 'Feed Barney', cadence: 'day' })

  // The bundle is not gated — Bun cannot serve it conditionally — so the app
  // does load. Its first request comes back 401 and the shell swaps it out.
  await arrive(page, app)
  await expect(page.getByText('Feed Barney')).toHaveCount(0)
})

test('the API refuses without a session, and says so as a 401', async ({ app }) => {
  withOwner(app)
  for (const path of ['/api/day', '/api/todo', '/api/history']) {
    expect((await fetch(`${app.url}${path}`)).status, path).toBe(401)
  }
  const res = await fetch(`${app.url}/api/commands/create_task`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'let me in' }),
  })
  expect(res.status).toBe(401)
})

test('every API response forbids caching', async ({ app }) => {
  withOwner(app)
  // These bodies are one person's tasks and journal, and Fly terminates TLS in
  // front of the app. Errors too: a 401 that got cached would be its own problem.
  expect((await fetch(`${app.url}/api/day`)).headers.get('cache-control')).toBe('no-store')
  expect((await app.fetch('/api/status')).headers.get('cache-control')).toBe('no-store')
})

test('the wrong password does not sign you in, and says nothing useful', async ({ page, app }) => {
  withOwner(app)
  await arrive(page, app)

  await failSignIn(page, 'owner', 'not-the-password')
  await expect(page.getByRole('alert')).toBeVisible()
  const wrongPassword = (await page.getByRole('alert').textContent()) ?? ''
  expect(wrongPassword).not.toBe('')

  // An unknown name gets exactly the same answer: telling them apart only helps
  // somebody finding out which names are real.
  await failSignIn(page, 'nobody-at-all', PASSWORD)
  await expect(page.getByRole('alert')).toHaveText(wrongPassword)

  // And the name survives while the password does not — retyping a name is
  // friction, retyping a password is the point.
  await expect(page.getByLabel('Name')).toHaveValue('nobody-at-all')
})

test('the right password signs you in and the board appears', async ({ page, app }) => {
  withOwner(app)
  app.seed.task({ name: 'Feed Barney', cadence: 'day' })

  await arrive(page, app)
  await fillIn(page)
  await expect(page.getByRole('checkbox', { name: 'Complete Feed Barney' })).toBeVisible()

  // It survives a reload, which is the whole point of a cookie — and the URL
  // never changed, because there is no /login to navigate to.
  expect(new URL(page.url()).pathname).toBe('/')
  await page.reload()
  await expect(page.getByRole('checkbox', { name: 'Complete Feed Barney' })).toBeVisible()
})

test('signing out ends the session', async ({ page, app }) => {
  withOwner(app)
  app.seed.task({ name: 'Feed Barney', cadence: 'day' })
  await arrive(page, app)
  await fillIn(page)
  await expect(page.getByRole('checkbox', { name: 'Complete Feed Barney' })).toBeVisible()

  await page.getByRole('button', { name: 'Sign out' }).click()
  await expect(signInButton(page)).toBeVisible()

  // Not just in this tab: the cookie is gone.
  await page.goto(app.url)
  await expect(signInButton(page)).toBeVisible()
})

test('two people see their own boards and nothing of each other', async ({ page, app }) => {
  withOwner(app)
  const other = app.seed.user({ username: 'wife', password: PASSWORD })
  app.seed.task({ name: 'Feed Barney', cadence: 'day' })
  app.seed.task({ name: 'Water the ferns', cadence: 'day', user_id: other })

  await arrive(page, app)
  await fillIn(page, 'wife')
  await expect(page.getByRole('checkbox', { name: 'Complete Water the ferns' })).toBeVisible()
  await expect(page.getByText('Feed Barney')).toHaveCount(0)

  await page.getByRole('button', { name: 'Sign out' }).click()
  await fillIn(page, 'owner')
  await expect(page.getByRole('checkbox', { name: 'Complete Feed Barney' })).toBeVisible()
  await expect(page.getByText('Water the ferns')).toHaveCount(0)
})

test('changing a password invalidates the sessions signed with the old one', async ({
  page,
  app,
}) => {
  withOwner(app)
  app.seed.task({ name: 'Feed Barney', cadence: 'day' })
  await arrive(page, app)
  await fillIn(page)
  await expect(page.getByRole('checkbox', { name: 'Complete Feed Barney' })).toBeVisible()

  // The cookie is signed with the user's password hash, so changing the password
  // revokes their cookies — no session table, no sign-out-everywhere command.
  app.seed.password('owner', 'a-completely-different-password')

  await page.reload()
  await expect(signInButton(page)).toBeVisible()
})

test('an account with no password set cannot be signed into', async ({ page, app }) => {
  // `owner` as the migration leaves it: it owns every pre-ownership row and has
  // an empty hash, which must never verify against anything — including ''.
  app.seed.task({ name: 'Feed Barney', cadence: 'day' })
  await arrive(page, app)
  for (const attempt of ['x', 'anything', PASSWORD]) {
    await failSignIn(page, 'owner', attempt)
  }
  await expect(page.getByText('Feed Barney')).toHaveCount(0)
})

test('repeated failures lock the account out for a while', async ({ page, app }) => {
  withOwner(app)
  await arrive(page, app)

  // The limit is 8. argon2 already costs ~55ms a try; this is the second of two
  // defences, not the only one.
  for (let i = 0; i < 8; i++) await failSignIn(page, 'owner', `wrong-${i}`)

  // Now even the right password is refused, which is what a lockout means.
  await failSignIn(page, 'owner', PASSWORD)
  await expect(signInButton(page)).toBeVisible()
})
