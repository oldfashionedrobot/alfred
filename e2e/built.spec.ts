import { test, expect } from './fixtures.ts'

/**
 * The client as production serves it — built ahead with `bun run build:client`,
 * code-split, minified, production React — which only the `built` project runs.
 * The rest of the suite covers what the client does; this covers what only the
 * build can break.
 */

const NOTES_CHUNK = /\/assets\/Notes-[a-z0-9]+\.js$/
const IMMUTABLE = 'public, max-age=31536000, immutable'

const notesTab = (page: import('@playwright/test').Page) =>
  page.getByRole('banner').getByRole('button', { name: 'Notes', exact: true })

test('To do loads without the Notes chunk; Notes fetches it once, and works', async ({
  page,
  app,
}) => {
  const scripts: string[] = []
  page.on('request', (r) => {
    if (r.resourceType() === 'script') scripts.push(new URL(r.url()).pathname)
  })

  await page.goto(app.url)
  await expect(page.getByRole('region', { name: 'Today', exact: true })).toBeVisible()
  await page.waitForLoadState('networkidle')
  expect(scripts.length).toBeGreaterThan(0)
  expect(scripts.every((s) => s.startsWith('/assets/'))).toBe(true)
  expect(scripts.filter((s) => NOTES_CHUNK.test(s))).toEqual([])

  await notesTab(page).click()
  await expect(page.getByText('No notes yet.')).toBeVisible()
  expect(scripts.filter((s) => NOTES_CHUNK.test(s))).toHaveLength(1)

  // The editor, under the production build: a note is written and saved.
  await page.getByRole('button', { name: 'New note' }).click()
  const created = page.waitForResponse(
    (r) => r.url().endsWith('/api/commands/create_note') && r.ok(),
  )
  await page.getByRole('dialog').getByRole('textbox', { name: 'Title' }).fill('Built')
  await created
  await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click()
  const card = page.locator('.note-card', {
    has: page.getByRole('button', { name: 'Built', exact: true }),
  })
  await expect(card).toBeVisible()
  // Notes' styles arrive with the main stylesheet, not with the chunk.
  await expect(card).not.toHaveCSS('border-radius', '0px')
})

test('the page is never cached, its assets are cached forever, and an unknown one is a 404', async ({
  app,
}) => {
  const page = await fetch(`${app.url}/claim?t=x`)
  expect(page.headers.get('cache-control')).toBe('no-cache')
  const entry = /src="(\/assets\/[^"]+\.js)"/.exec(await page.text())![1]!

  const script = await fetch(`${app.url}${entry}`)
  expect(script.headers.get('cache-control')).toBe(IMMUTABLE)
  expect(script.headers.get('content-type')).toContain('javascript')

  // The chunk the entry names exists — a wrong public path would break this
  // and nothing else.
  const notes = /\/assets\/Notes-[a-z0-9]+\.js/.exec(await script.text())![0]
  const chunk = await fetch(`${app.url}${notes}`)
  expect(chunk.status).toBe(200)
  expect(chunk.headers.get('cache-control')).toBe(IMMUTABLE)

  const gone = await fetch(`${app.url}/assets/Notes-gone.js`)
  expect(gone.status).toBe(404)
  expect(gone.headers.get('content-type')).not.toContain('text/html')
})

test('a tab opened before a deploy is told to reload, and reloading brings Notes back', async ({
  page,
  app,
}) => {
  // The old chunk, which the new build no longer has.
  await page.route(NOTES_CHUNK, (route) => route.fulfill({ status: 404, body: 'Not found' }))
  await page.goto(app.url)
  await notesTab(page).click()
  await expect(page.getByText(/Alfred has probably been updated/)).toBeVisible()

  await page.unroute(NOTES_CHUNK)
  await page.getByRole('button', { name: 'Reload' }).click()
  await notesTab(page).click()
  await expect(page.getByText('No notes yet.')).toBeVisible()
})
