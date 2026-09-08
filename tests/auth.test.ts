import { test, expect, describe, beforeEach, afterEach } from 'bun:test'
import { eq } from 'drizzle-orm'

import type { DB } from '../src/server/db.ts'
import * as schema from '../src/server/schema.ts'
import {
  changePassword,
  claimAccount,
  currentUser,
  isTimezone,
  sessionCookie,
  setTimezone,
} from '../src/server/auth.ts'
import { closeDb, freshDb, type Harness } from './harness.ts'

/**
 * Claiming an invitation.
 *
 * Every one of these is a guard rather than a feature. The token is the whole
 * security model — 32 random bytes standing in for a username nobody can guess —
 * so the interesting assertions are the refusals, and that they are
 * indistinguishable from each other.
 */

const TOKEN = 'a'.repeat(64)
const WEEK = 7 * 24 * 60 * 60 * 1000
const GOOD = 'a-long-enough-password'

let h: Harness
let db: DB

beforeEach(async () => {
  h = await freshDb('auth')
  db = h.db
})
afterEach(() => closeDb(h))

/** An unclaimed account: it exists, it has no password, it holds a token. */
async function invite(over: Partial<typeof schema.users.$inferInsert> = {}) {
  const [row] = await db
    .insert(schema.users)
    .values({
      username: 'jess',
      password_hash: '',
      active: true,
      claim_token: TOKEN,
      claim_expires: Date.now() + WEEK,
      ...over,
    })
    .returning()
  return row!
}

const reload = async (id: number) =>
  (await db.select().from(schema.users).where(eq(schema.users.id, id)).get())!

describe('claimAccount', () => {
  test('sets the password and the zone, and spends the token', async () => {
    const u = await invite()
    const claimed = await claimAccount(db, TOKEN, GOOD, 'Europe/London')
    expect(claimed).not.toBeNull()

    const row = await reload(u.id)
    expect(row.password_hash).not.toBe('')
    expect(row.timezone).toBe('Europe/London')
    // Single use: the row that let them in cannot let anybody else in.
    expect(row.claim_token).toBeNull()
    expect(row.claim_expires).toBeNull()
    expect(await Bun.password.verify(GOOD, row.password_hash)).toBe(true)
  })

  test('returns the NEW hash, because the cookie is signed with it', async () => {
    await invite()
    const claimed = await claimAccount(db, TOKEN, GOOD, 'America/New_York')
    // Returning the pre-claim row would mint a cookie signed with '' — one that
    // could never verify, so claiming would silently fail to sign anybody in.
    expect(claimed!.password_hash).not.toBe('')
  })

  test('an expired token is refused', async () => {
    await invite({ claim_expires: Date.now() - 1 })
    expect(await claimAccount(db, TOKEN, GOOD, 'America/New_York')).toBeNull()
  })

  test('a token with no expiry at all is refused', async () => {
    await invite({ claim_expires: null })
    expect(await claimAccount(db, TOKEN, GOOD, 'America/New_York')).toBeNull()
  })

  test('a wrong token is refused', async () => {
    await invite()
    expect(await claimAccount(db, 'b'.repeat(64), GOOD, 'America/New_York')).toBeNull()
  })

  test('an empty token matches nothing, including a spent invitation', async () => {
    // The guard that matters: `claim_token` is NULL once spent, and an empty
    // string must not be allowed to find its way to a NULL column.
    await invite({ claim_token: null })
    expect(await claimAccount(db, '', GOOD, 'America/New_York')).toBeNull()
  })

  test('an account that already has a password cannot be re-claimed', async () => {
    // This is what makes it a claim and not a password reset.
    await invite({ password_hash: 'already-set' })
    expect(await claimAccount(db, TOKEN, GOOD, 'America/New_York')).toBeNull()
  })

  test('a disabled account cannot be claimed', async () => {
    await invite({ active: false })
    expect(await claimAccount(db, TOKEN, GOOD, 'America/New_York')).toBeNull()
  })

  test('an invalid timezone is refused, and nothing is written', async () => {
    const u = await invite()
    expect(await claimAccount(db, TOKEN, GOOD, 'Mars/Olympus_Mons')).toBeNull()
    const row = await reload(u.id)
    expect(row.password_hash).toBe('')
    expect(row.claim_token).toBe(TOKEN)
  })
})

describe('isTimezone', () => {
  test('accepts IANA names and rejects anything else', async () => {
    for (const good of ['America/New_York', 'Europe/London', 'UTC', 'Pacific/Kiritimati']) {
      expect(isTimezone(good)).toBe(true)
    }
    for (const bad of ['', 'Mars/Olympus_Mons', 'EST5EDT_nope', 'not a zone']) {
      expect(isTimezone(bad)).toBe(false)
    }
  })
})

// ---------------------------------------------------------------------------
// Changing your own account
// ---------------------------------------------------------------------------

/** A claimed account: a real password hash, no token. */
async function member(password = GOOD) {
  const [row] = await db
    .insert(schema.users)
    .values({ username: 'sam', password_hash: await Bun.password.hash(password), active: true })
    .returning()
  return row!
}

/** `sessionCookie` returns a Set-Cookie; a request sends only the name=value. */
const asRequest = (setCookie: string) =>
  new Request('http://alfred.test/api/day', { headers: { cookie: setCookie.split(';')[0]! } })

describe('setTimezone', () => {
  test('stores a zone Intl accepts', async () => {
    const u = await member()
    expect(await setTimezone(db, u.id, 'Europe/London')).toBe(true)
    expect((await reload(u.id)).timezone).toBe('Europe/London')
  })

  test('refuses one it does not, and leaves the stored zone alone', async () => {
    const u = await member()
    await setTimezone(db, u.id, 'Europe/London')
    expect(await setTimezone(db, u.id, 'Mars/Olympus_Mons')).toBe(false)
    // A rejected write must not be a write. The default would look like success
    // to anybody who only checked the return value.
    expect((await reload(u.id)).timezone).toBe('Europe/London')
  })
})

describe('changePassword', () => {
  test('replaces the hash when the current password is right', async () => {
    const u = await member()
    const updated = await changePassword(db, u, GOOD, 'a-different-long-password')
    expect(updated).not.toBeNull()

    const row = await reload(u.id)
    expect(row.password_hash).not.toBe(u.password_hash)
    expect(await Bun.password.verify('a-different-long-password', row.password_hash)).toBe(true)
    // The caller signs a cookie with what it is handed, so it has to be current.
    expect(updated!.password_hash).toBe(row.password_hash)
  })

  test('refuses a wrong current password and changes nothing', async () => {
    const u = await member()
    expect(await changePassword(db, u, 'not-the-password', 'a-different-long-password')).toBeNull()
    expect((await reload(u.id)).password_hash).toBe(u.password_hash)
  })

  /*
   * The point of the whole design: the cookie is HMAC'd with the password hash,
   * so a change revokes every session the user has — and the route hands back a
   * row precisely so the device that made the change can be given a new one.
   */
  test('the old cookie stops verifying, and the returned row mints one that works', async () => {
    const u = await member()
    const before = sessionCookie(u)
    expect(await currentUser(db, asRequest(before))).not.toBeNull()

    const updated = await changePassword(db, u, GOOD, 'a-different-long-password')
    expect(await currentUser(db, asRequest(before))).toBeNull()
    expect(await currentUser(db, asRequest(sessionCookie(updated!)))).not.toBeNull()
  })
})
