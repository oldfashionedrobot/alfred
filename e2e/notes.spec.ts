import type { Page, Response } from '@playwright/test'
import type { NotesView } from '../src/shared/types.ts'
import { test, expect, type App } from './fixtures.ts'

/**
 * Notes — a board of cards, a note opened over it, saved as it is typed.
 *
 * Saves are waited for by their RESPONSE, never by a timer: a note saves a second
 * after typing stops, and a test that sleeps a second and a bit is a test that
 * passes on a fast machine and flakes on a loaded one. Where the debounce itself
 * is what is being tested, Playwright's clock drives it.
 *
 * The editor's input rules — `[] ` becoming a checkbox — fire on typed keys,
 * never on `fill()`, so typing into the editor is `keyboard.type`.
 */

async function openNotes(page: Page, app: App): Promise<void> {
  await page.goto(app.url)
  await page.getByRole('banner').getByRole('button', { name: 'Notes', exact: true }).click()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(/^(Notes|Archived)$/)
}

async function notesView(app: App, archived = false): Promise<NotesView> {
  const res = await app.fetch(`/api/notes${archived ? '?archived=true' : ''}`)
  return (await res.json()) as NotesView
}

const all = (v: NotesView) => [...v.pinned, ...v.others]

/** A card is one button, named by the note's title or its first line. */
const card = (page: Page, name: string) => page.getByRole('button', { name, exact: true })
const panel = (page: Page) => page.getByRole('dialog')
const titleBox = (page: Page) => panel(page).getByRole('textbox', { name: 'Title' })
const editor = (page: Page) => panel(page).getByRole('textbox', { name: 'Note text' })
const close = (page: Page) =>
  panel(page).getByRole('button', { name: 'Close', exact: true }).click()

const saved = (page: Page, command: string): Promise<Response> =>
  page.waitForResponse((r) => r.url().endsWith(`/api/commands/${command}`) && r.ok())

/** Puts the caret at the end of the editor's text. */
async function typeAtEnd(page: Page, text: string): Promise<void> {
  await editor(page).click()
  await page.keyboard.press('ControlOrMeta+End')
  await page.keyboard.type(text)
}

test('a new note is created, and is there after a reload', async ({ page, app }) => {
  await openNotes(page, app)
  await expect(page.getByText('No notes yet.')).toBeVisible()

  await page.getByRole('button', { name: 'New note' }).click()
  const created = saved(page, 'create_note')
  await titleBox(page).fill('Groceries')
  await editor(page).click()
  await page.keyboard.type('milk and eggs')
  await created
  await close(page)

  await expect(card(page, 'Groceries')).toBeVisible()
  await page.reload()
  await page.getByRole('banner').getByRole('button', { name: 'Notes', exact: true }).click()
  await expect(card(page, 'Groceries')).toBeVisible()

  const [note] = all(await notesView(app))
  expect(note!.title).toBe('Groceries')
  expect(note!.body).toContain('milk and eggs')
})

test('an edit survives a reload without the note being closed', async ({ page, app }) => {
  app.seed.note({ title: 'Plan', body: 'one' })
  await openNotes(page, app)
  await card(page, 'Plan').click()

  const updated = saved(page, 'update_note')
  await typeAtEnd(page, ' two')
  await updated

  await page.reload()
  await page.getByRole('banner').getByRole('button', { name: 'Notes', exact: true }).click()
  await card(page, 'Plan').click()
  await expect(editor(page)).toHaveText('one two')
})

test('typing on while the first save is held back still makes exactly one note', async ({
  page,
  app,
}) => {
  // The clock drives the one-second debounce, so the second save is queued
  // while the first is provably still in flight.
  await page.clock.install()
  let creates = 0
  let release: (() => void) | undefined
  const held = new Promise<void>((r) => (release = r))
  await page.route('**/api/commands/create_note', async (route) => {
    creates++
    await held
    await route.continue()
  })

  await openNotes(page, app)
  await page.getByRole('button', { name: 'New note' }).click()
  await titleBox(page).pressSequentially('Held')
  await page.clock.runFor(1100)
  await expect.poll(() => creates).toBe(1)

  // A second save, queued behind the first rather than racing it.
  await titleBox(page).pressSequentially(' more')
  await page.clock.runFor(1100)

  const updated = saved(page, 'update_note')
  release!()
  await updated

  expect(creates).toBe(1)
  const notes = all(await notesView(app))
  expect(notes.map((n) => n.title)).toEqual(['Held more'])
})

test('a blank new note sends nothing; an emptied note is deleted on close', async ({
  page,
  app,
}) => {
  const commands: string[] = []
  page.on('request', (r) => {
    if (r.url().includes('/api/commands/')) commands.push(r.url())
  })

  await openNotes(page, app)
  await page.getByRole('button', { name: 'New note' }).click()
  await expect(titleBox(page)).toBeVisible()
  await close(page)
  await expect(panel(page)).toHaveCount(0)
  expect(commands).toEqual([])

  app.seed.note({ title: 'Temp', body: 'scratch' })
  await page.reload()
  await page.getByRole('banner').getByRole('button', { name: 'Notes', exact: true }).click()
  await card(page, 'Temp').click()
  await titleBox(page).fill('')
  await editor(page).click()
  await page.keyboard.press('ControlOrMeta+a')
  await page.keyboard.press('Backspace')

  const deleted = saved(page, 'delete_note')
  await close(page)
  await deleted
  expect(all(await notesView(app))).toEqual([])
})

test('pinning moves a card to the pinned section', async ({ page, app }) => {
  app.seed.note({ title: 'Alpha', updated_at: 1_000 })
  app.seed.note({ title: 'Bravo', updated_at: 2_000 })
  await openNotes(page, app)
  await expect(page.getByRole('heading', { name: 'Pinned' })).toHaveCount(0)

  await card(page, 'Alpha').click()
  const pinned = saved(page, 'update_note')
  await panel(page).getByRole('button', { name: 'Pin' }).click()
  await pinned
  await close(page)

  await expect(card(page, 'Alpha')).toBeVisible()
  await expect(page.getByRole('region', { name: 'Pinned' })).toContainText('Alpha')
  await expect(page.getByRole('region', { name: 'Others' })).toContainText('Bravo')
})

test('a colour shows on the card, and the popover closes alone on Escape', async ({
  page,
  app,
}) => {
  app.seed.note({ title: 'Tinted', body: 'x' })
  await openNotes(page, app)
  await card(page, 'Tinted').click()

  const coloured = saved(page, 'update_note')
  await panel(page)
    .getByRole('button', { name: /^Colour/ })
    .click()
  await page
    .getByRole('group', { name: 'Note colour' })
    .getByRole('button', { name: 'Sage' })
    .click()
  await coloured

  await panel(page)
    .getByRole('button', { name: /^Colour/ })
    .click()
  const palette = page.getByRole('group', { name: 'Note colour' })
  await expect(palette.getByRole('button', { name: 'Sage' })).toHaveAttribute(
    'aria-pressed',
    'true',
  )

  // Escape inside the popover closes the popover, not the note behind it.
  await page.keyboard.press('Escape')
  await expect(palette).toHaveCount(0)
  await expect(panel(page)).toBeVisible()

  await close(page)
  await expect(page.locator('.note-card', { has: card(page, 'Tinted') })).toHaveAttribute(
    'data-color',
    'sage',
  )
})

test('archive takes a note off the board; restore puts it back', async ({ page, app }) => {
  app.seed.note({ title: 'Old', body: 'stuff' })
  await openNotes(page, app)
  await card(page, 'Old').click()

  const archived = saved(page, 'update_note')
  await panel(page).getByRole('button', { name: 'Archive' }).click()
  await archived
  // Archiving closes the note.
  await expect(panel(page)).toHaveCount(0)
  await expect(card(page, 'Old')).toHaveCount(0)

  await page.getByRole('button', { name: 'Archived', exact: true }).click()
  await card(page, 'Old').click()
  const restored = saved(page, 'update_note')
  await panel(page).getByRole('button', { name: 'Restore' }).click()
  await restored
  await expect(card(page, 'Old')).toHaveCount(0)

  await page.getByRole('button', { name: 'Archived', exact: true }).click()
  await expect(card(page, 'Old')).toBeVisible()
})

test('delete forever is behind Confirm, and only offered in Archived', async ({ page, app }) => {
  app.seed.note({ title: 'Live', body: 'keep' })
  app.seed.note({ title: 'Gone', body: 'drop', archived: true })
  await openNotes(page, app)

  await card(page, 'Live').click()
  await expect(panel(page).getByRole('button', { name: 'Delete forever' })).toHaveCount(0)
  await close(page)

  await page.getByRole('button', { name: 'Archived', exact: true }).click()
  await card(page, 'Gone').click()
  await panel(page).getByRole('button', { name: 'Delete forever' }).click()
  await expect(panel(page).getByText('Delete this note forever?')).toBeVisible()

  const deleted = saved(page, 'delete_note')
  await panel(page).getByRole('button', { name: 'Delete forever' }).click()
  await deleted
  await expect(panel(page)).toHaveCount(0)
  expect(all(await notesView(app, true))).toEqual([])
  expect(all(await notesView(app)).map((n) => n.title)).toEqual(['Live'])
})

test('search finds by every word, on the board and in Archived', async ({ page, app }) => {
  app.seed.note({ title: 'Vet appointment', body: 'Take the dog on Tuesday' })
  app.seed.note({ title: 'Bins', body: 'Thursday' })
  app.seed.note({ title: 'Dog food', body: 'old brand', archived: true })
  await openNotes(page, app)

  await page.getByRole('searchbox', { name: 'Search notes' }).fill('dog vet')
  await expect(card(page, 'Vet appointment')).toBeVisible()
  await expect(card(page, 'Bins')).toHaveCount(0)

  await page.getByRole('searchbox', { name: 'Search notes' }).fill('dog cat')
  await expect(page.getByText('Nothing matches “dog cat”.')).toBeVisible()

  await page.getByRole('button', { name: 'Archived', exact: true }).click()
  await page.getByRole('searchbox', { name: 'Search archived notes' }).fill('dog')
  await expect(card(page, 'Dog food')).toBeVisible()
  await expect(card(page, 'Vet appointment')).toHaveCount(0)
})

test('Back, Escape and a tap outside each close a note, and focus comes home', async ({
  page,
  app,
}) => {
  app.seed.note({ title: 'Door', body: 'x' })
  await openNotes(page, app)
  const url = page.url()

  // Back pops the entry opening pushed, without the URL ever changing.
  await card(page, 'Door').click()
  await expect(panel(page)).toBeVisible()
  expect(page.url()).toBe(url)
  await page.goBack()
  await expect(panel(page)).toHaveCount(0)
  expect(page.url()).toBe(url)
  // Still in the app, on the board.
  await expect(card(page, 'Door')).toBeVisible()

  await card(page, 'Door').click()
  await page.keyboard.press('Escape')
  await expect(panel(page)).toHaveCount(0)
  await expect(card(page, 'Door')).toBeFocused()

  // A phone's note fills the screen, so there is no outside to tap.
  if (test.info().project.name.startsWith('desktop')) {
    await card(page, 'Door').click()
    await page.mouse.click(8, 400)
    await expect(panel(page)).toHaveCount(0)
  }
})

test('a new note focuses its title, and closing it focuses New note again', async ({
  page,
  app,
}) => {
  await openNotes(page, app)
  await page.getByRole('button', { name: 'New note' }).click()
  await expect(titleBox(page)).toBeFocused()
  // The title's autofocus moves focus before the sheet could record where it
  // came from — so the sheet records it during its first render instead.
  await close(page)
  await expect(page.getByRole('button', { name: 'New note' })).toBeFocused()
})

test('a close whose save fails keeps the note open, with its text', async ({ page, app }) => {
  await page.route('**/api/commands/create_note', (route) =>
    route.fulfill({ status: 500, body: '{"error":"down"}' }),
  )
  await openNotes(page, app)
  await page.getByRole('button', { name: 'New note' }).click()
  await titleBox(page).fill('Do not lose me')
  await close(page)

  await expect(page.getByText(/^Not saved/)).toBeVisible()
  await expect(panel(page)).toBeVisible()
  await expect(titleBox(page)).toHaveValue('Do not lose me')

  // Once the server answers, closing saves and closes.
  await page.unroute('**/api/commands/create_note')
  await close(page)
  await expect(panel(page)).toHaveCount(0)
  expect(all(await notesView(app)).map((n) => n.title)).toEqual(['Do not lose me'])
})

test('emptying a pinned note keeps it — a pin is something', async ({ page, app }) => {
  app.seed.note({ title: 'Keep me', body: 'old list', pinned: true })
  await openNotes(page, app)
  await card(page, 'Keep me').click()
  await titleBox(page).fill('')
  await editor(page).click()
  await page.keyboard.press('ControlOrMeta+a')
  await page.keyboard.press('Backspace')

  const saved_ = saved(page, 'update_note')
  await close(page)
  await saved_
  await expect(panel(page)).toHaveCount(0)
  const [note] = all(await notesView(app))
  expect(note).toMatchObject({ title: '', pinned: true })
})

test('closing a note and opening another at once leaves the new one open', async ({
  page,
  app,
}) => {
  app.seed.note({ title: 'Alpha', body: 'a' })
  app.seed.note({ title: 'Bravo', body: 'b' })
  await openNotes(page, app)

  // Hold history.back() until released, so the second note is provably opened
  // before the first one's traversal lands — the race, made deterministic.
  await page.evaluate(() => {
    const w = window as unknown as { held?: () => void }
    const back = history.back.bind(history)
    history.back = () => {
      w.held = back
    }
  })

  await card(page, 'Alpha').click()
  await page.keyboard.press('Escape')
  await expect(panel(page)).toHaveCount(0)
  await card(page, 'Bravo').click()
  await expect(page.getByRole('dialog', { name: 'Bravo' })).toBeVisible()

  const popped = page.evaluate(
    () => new Promise<void>((r) => addEventListener('popstate', () => r(), { once: true })),
  )
  await page.evaluate(() => (window as unknown as { held: () => void }).held())
  await popped
  // Alpha's traversal landed — and Bravo is still open.
  await expect(page.getByRole('dialog', { name: 'Bravo' })).toBeVisible()
})

test('a ticked item is struck through and stays where it is', async ({ page, app }) => {
  app.seed.note({ title: 'List', body: '- [ ] milk\n- [ ] eggs\n  - [ ] free-range\n- [ ] bread' })
  await openNotes(page, app)
  await card(page, 'List').click()

  const item = (name: string) => editor(page).locator('li').filter({ hasText: name }).last()
  const words = () =>
    editor(page)
      .locator('li > div > p')
      .evaluateAll((ps) => ps.map((p) => p.textContent))

  const ticked = saved(page, 'update_note')
  await panel(page).getByRole('checkbox', { name: 'Task item checkbox for eggs' }).check()
  await ticked
  // Ticking does not focus the editor — on a phone, that would raise the
  // keyboard for every tick.
  await expect(editor(page)).not.toBeFocused()

  await expect(item('eggs').locator('> div > p')).toHaveCSS('text-decoration-line', 'line-through')
  // Its own line only: the unticked item nested under it is not struck.
  await expect(item('free-range').locator('> div > p')).toHaveCSS('text-decoration-line', 'none')
  // Nothing moved.
  expect(await words()).toEqual(['milk', 'eggs', 'free-range', 'bread'])

  await close(page)
  // The card draws it the same way, and lets nothing be ticked or followed.
  const onCard = page.locator('.note-card', { has: card(page, 'List') })
  await expect(onCard.locator('li[data-checked="true"] > div > p')).toHaveText('eggs')
  await expect(onCard.locator('li[data-checked="true"] > div > p')).toHaveCSS(
    'text-decoration-line',
    'line-through',
  )
  await expect(onCard.getByRole('checkbox')).toHaveCount(0)
  await expect(onCard.getByRole('link')).toHaveCount(0)
})

test('a checklist starts from [] anywhere in the text', async ({ page, app }) => {
  await openNotes(page, app)
  await page.getByRole('button', { name: 'New note' }).click()
  await editor(page).click()
  await page.keyboard.type('Ingredients')
  await page.keyboard.press('Enter')
  const created = saved(page, 'create_note')
  await page.keyboard.type('[] flour')
  await created
  await expect(
    panel(page).getByRole('checkbox', { name: 'Task item checkbox for flour' }),
  ).toBeVisible()
  await expect(editor(page).locator('> p').first()).toHaveText('Ingredients')
})

test('an address typed into a note becomes a link', async ({ page, app }) => {
  await openNotes(page, app)
  await page.getByRole('button', { name: 'New note' }).click()
  await editor(page).click()
  await page.keyboard.type('see https://example.com today')
  await expect(editor(page).getByRole('link', { name: 'https://example.com' })).toBeVisible()
})

test('the edited time is a time today and a date before', async ({ page, app }) => {
  app.seed.note({ title: 'Fresh', body: 'x' })
  // Noon UTC on 15 January — the same date in New York, where the account is.
  app.seed.note({ title: 'Stale', body: 'y', updated_at: Date.UTC(2026, 0, 15, 12) })
  await openNotes(page, app)

  await card(page, 'Fresh').click()
  await expect(panel(page).getByText(/^Edited \d{1,2}:\d{2}(am|pm)$/)).toBeVisible()
  await close(page)

  await card(page, 'Stale').click()
  await expect(panel(page).getByText(/^Edited 15 Jan( \d{4})?$/)).toBeVisible()
})

test('one column on a phone, centred columns on a desktop, never sideways', async ({
  page,
  app,
}) => {
  // A geometry assertion: the suite reads roles and names, and would pass a
  // board with no CSS at all.
  app.seed.note({ title: 'One', body: 'a' })
  app.seed.note({ title: 'Two', body: 'b' })
  await openNotes(page, app)
  await expect(card(page, 'Two')).toBeVisible()

  const boxes = await page.locator('.note-card').evaluateAll((els) =>
    els.map((e) => {
      const r = e.getBoundingClientRect()
      return { x: r.x, y: r.y, w: r.width, right: window.innerWidth - r.right }
    }),
  )
  const [a, b] = boxes as [(typeof boxes)[0], (typeof boxes)[0]]
  if (test.info().project.name.startsWith('mobile')) {
    expect(a.x).toBe(b.x)
    expect(b.y).toBeGreaterThan(a.y)
  } else {
    expect(a.y).toBe(b.y)
    expect(b.x).toBeGreaterThan(a.x)
    // Two cards, two columns, in the middle — the gap left equals the gap right.
    expect(Math.abs(a.x - b.right)).toBeLessThanOrEqual(2)
  }
  const sideways = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
  )
  expect(sideways).toBe(false)
})

test('no console errors working a note', async ({ page, app }) => {
  const errors: string[] = []
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
  page.on('pageerror', (e) => errors.push(String(e)))

  await openNotes(page, app)
  await page.getByRole('button', { name: 'New note' }).click()
  const created = saved(page, 'create_note')
  await titleBox(page).fill('Working')
  await editor(page).click()
  await page.keyboard.type('[] one')
  await created
  await panel(page).getByRole('button', { name: 'Bold' }).click()
  await page.keyboard.type(' strong')
  await panel(page).getByRole('button', { name: 'Pin' }).click()
  await panel(page)
    .getByRole('button', { name: /^Colour/ })
    .click()
  await page
    .getByRole('group', { name: 'Note colour' })
    .getByRole('button', { name: 'Fog' })
    .click()
  const archived = saved(page, 'update_note')
  await panel(page).getByRole('button', { name: 'Archive' }).click()
  await archived

  await page.waitForLoadState('networkidle')
  expect(errors).toEqual([])
})

test('the notes view takes ?archived=true and no other spelling', async ({ app }) => {
  // One spelling of the Archived view — routes.ts is the whole query-string
  // boundary, and checks it as strictly as it checks `week`.
  expect((await app.fetch('/api/notes?archived=true')).status).toBe(200)
  for (const bad of ['1', 'false', 'yes', '']) {
    expect((await app.fetch(`/api/notes?archived=${bad}`)).status).toBe(400)
  }
})
