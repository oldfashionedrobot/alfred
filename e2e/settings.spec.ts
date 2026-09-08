import { test, expect, TEST_PASSWORD, type App } from './fixtures.ts'
import type { Page } from '@playwright/test'

/**
 * Changing your own account: the zone your day rolls over in, and your password.
 *
 * The server-side rules are proved in tests/auth.test.ts, against the helpers
 * directly. What is here is what only a browser can answer: that the form is
 * reachable, that it is filled from the right source, and that a password change
 * does not sign you out of the device that made it.
 */

/**
 * Deliberately NOT the stored zone.
 *
 * The account's zone is the schema default, America/New_York. Emulating a
 * different one in the browser is what gives the prefill assertion below any
 * force: on a machine already in New York it would pass no matter which source
 * the form read.
 */
test.use({ timezoneId: 'Asia/Tokyo' })

const menuButton = (page: Page) => page.getByRole('button', { name: 'Account menu' })

async function openMenu(page: Page) {
  await menuButton(page).click()
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible()
}

async function openSettings(page: Page) {
  await openMenu(page)
  await page.getByRole('button', { name: 'Settings' }).click()
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible()
}

/** What `today` is in a zone, the same way the server computes it. */
const dateIn = (zone: string) =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date())

test.describe('the account menu', () => {
  test('opens, closes on Escape, and puts focus back on the trigger', async ({ page, app }) => {
    await page.goto(app.url)
    await openMenu(page)
    expect(await menuButton(page).getAttribute('aria-expanded')).toBe('true')

    await page.keyboard.press('Escape')
    await expect(page.getByRole('button', { name: 'Sign out' })).toBeHidden()
    expect(await menuButton(page).getAttribute('aria-expanded')).toBe('false')
    // Closing into nowhere would strand a keyboard: the bar has nothing adjacent
    // to fall back to.
    await expect(menuButton(page)).toBeFocused()
  })

  test('carries sign out, which used to be reachable only from Day', async ({ page, app }) => {
    await page.goto(app.url)
    await page.getByRole('button', { name: 'History' }).click()
    await openMenu(page)
    await page.getByRole('button', { name: 'Sign out' }).click()
    await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible()
  })
})

test.describe('timezone', () => {
  test('prefills from the stored zone, not from the browser', async ({ page, app }) => {
    await page.goto(app.url)
    await openSettings(page)
    // The context is Asia/Tokyo. Reading the device here would be the bug.
    await expect(page.getByLabel('Your timezone')).toHaveValue('America/New_York')
  })

  test('saving one moves the day boundary the app renders', async ({ page, app }) => {
    await page.goto(app.url)
    await openSettings(page)

    // +14 and -11: 25 hours apart, so these two are never the same calendar day.
    await page.getByLabel('Your timezone').selectOption('Pacific/Kiritimati')
    await page.getByRole('button', { name: 'Save timezone' }).click()
    await expect(page.getByText('Timezone saved.')).toBeVisible()

    const far = ((await (await app.fetch('/api/day')).json()) as { date: string }).date
    expect(far).toBe(dateIn('Pacific/Kiritimati'))

    await page.getByLabel('Your timezone').selectOption('Pacific/Midway')
    await page.getByRole('button', { name: 'Save timezone' }).click()
    await expect(page.getByText('Timezone saved.')).toBeVisible()

    const near = ((await (await app.fetch('/api/day')).json()) as { date: string }).date
    expect(near).toBe(dateIn('Pacific/Midway'))
    expect(near).not.toBe(far)
  })

  test('refuses a zone the server does not know', async ({ app }) => {
    const res = await app.fetch('/api/account/timezone', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ timezone: 'Mars/Olympus_Mons' }),
    })
    expect(res.status).toBe(400)
  })
})

test.describe('password', () => {
  const NEXT = 'a-brand-new-password'

  async function change(page: Page, current: string, next: string) {
    await page.getByLabel('Current password').fill(current)
    await page.getByLabel('New password').fill(next)
    await page.getByRole('button', { name: 'Change password' }).click()
  }

  test('changing it keeps THIS device signed in', async ({ page, app }) => {
    await page.goto(app.url)
    await openSettings(page)
    await change(page, TEST_PASSWORD, NEXT)

    await expect(page.getByText(/Password changed/)).toBeVisible()
    // The cookie is signed with the password hash, so without the re-issue this
    // is exactly where the app would throw the person back to the login form.
    await expect(page.getByRole('button', { name: 'Sign in' })).toBeHidden()
    await page.getByRole('button', { name: 'Day' }).click()
    await expect(page.getByRole('button', { name: 'Account menu' })).toBeVisible()
  })

  test('and the new one is what signs in afterwards', async ({ page, app }) => {
    await page.goto(app.url)
    await openSettings(page)
    await change(page, TEST_PASSWORD, NEXT)
    await expect(page.getByText(/Password changed/)).toBeVisible()

    await openMenu(page)
    await page.getByRole('button', { name: 'Sign out' }).click()
    await page.getByLabel('Name').fill('owner')
    await page.getByLabel('Password').fill(NEXT)
    await page.getByRole('button', { name: 'Sign in' }).click()
    await expect(page.getByRole('button', { name: 'Account menu' })).toBeVisible()
  })

  test('a wrong current password is refused and changes nothing', async ({ page, app }) => {
    await page.goto(app.url)
    await openSettings(page)
    await change(page, 'not-my-password', NEXT)

    await expect(page.getByText('That is not your current password.')).toBeVisible()
    // Still the old one.
    const res = await app.fetch('/api/account/password', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ current: TEST_PASSWORD, next: NEXT }),
    })
    expect(res.ok).toBe(true)
  })
})
