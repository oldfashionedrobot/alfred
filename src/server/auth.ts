import { createHmac, timingSafeEqual } from 'node:crypto'
import { eq, ne } from 'drizzle-orm'
import type { DB } from './db.ts'
import { users, type UserRow } from './schema.ts'

/**
 * Accounts, sessions and the login page.
 *
 * WHO A REQUEST IS. Every view builder and every command takes a user id, and
 * this is the only place one comes from: the session cookie, always.
 *
 * THERE IS NO WAY TO TURN THIS OFF. An earlier draft had an `AUTH_REQUIRED`
 * flag — unset in development and in the test suite, with the server refusing to
 * start in production without it. That is one more thing that has to be right,
 * guarding a state that should not exist, and a guard is only as good as
 * remembering to write it. With no flag there is no misconfigured deploy to
 * catch, so the check went with the switch.
 *
 * The cost lands on the browser suite, which now signs in. `e2e/fixtures.ts`
 * does that once per test rather than every spec doing it by hand.
 */

/** The one definition of long enough, used by the CLI and by `/api/claim`. */
export const MIN_PASSWORD = 12

const COOKIE = 'alfred_session'
const MAX_AGE_DAYS = 90
const MAX_AGE_SECONDS = MAX_AGE_DAYS * 24 * 60 * 60

const production = process.env.NODE_ENV === 'production'

/**
 * Not a guard — there is nothing left to misconfigure. A database where nobody
 * has a password is simply locked, which is the safe direction to fail in; this
 * says so rather than leaving somebody at a login page that cannot work.
 */
export async function warnIfNobodyCanSignIn(db: DB): Promise<void> {
  const anyone = await db.select().from(users).where(ne(users.password_hash, '')).limit(1).get()
  if (anyone === undefined) {
    console.warn('alfred: no user has a password yet — run `bun run user:add <name>`')
  }
}

// ---------------------------------------------------------------------------
// The cookie
//
//   <user_id>.<expiry-ms>.<hmac>
//
// Stateless: verifying is recomputing the HMAC and checking the clock. No
// sessions table, nothing to clean up, and it survives the restarts that
// scale-to-zero causes several times a day.
//
// THE KEY IS THE USER'S OWN PASSWORD HASH. That buys revocation for nothing —
// change a password and that user's cookies stop verifying, immediately and
// only theirs — and it means there is no separate session secret to configure,
// rotate or leak. A hash is already a high-entropy per-user value that never
// leaves the server.
// ---------------------------------------------------------------------------

function mac(user: UserRow, payload: string): string {
  return createHmac('sha256', user.password_hash).update(payload).digest('hex')
}

/** Constant time, and length-checked first: timingSafeEqual throws on a mismatch. */
function sameMac(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  return timingSafeEqual(Buffer.from(a), Buffer.from(b))
}

export function sessionCookie(user: UserRow): string {
  const expiry = Date.now() + MAX_AGE_SECONDS * 1000
  const payload = `${user.id}.${expiry}`
  const parts = [
    `${COOKIE}=${payload}.${mac(user, payload)}`,
    'HttpOnly',
    'Path=/',
    // Withholds the cookie from cross-site POSTs. Every mutation here is a POST,
    // so this is CSRF protection without a token scheme.
    'SameSite=Lax',
    `Max-Age=${MAX_AGE_SECONDS}`,
  ]
  // Local development is plain http://localhost, where Secure would drop it.
  if (production) parts.push('Secure')
  return parts.join('; ')
}

export function clearedCookie(): string {
  return `${COOKIE}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0`
}

function readCookie(req: Request, name: string): string | null {
  const header = req.headers.get('cookie')
  if (header === null) return null
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq === -1) continue
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim()
  }
  return null
}

async function userFromCookie(db: DB, req: Request): Promise<UserRow | null> {
  const raw = readCookie(req, COOKIE)
  if (raw === null) return null

  const [idPart, expiryPart, given] = raw.split('.')
  if (idPart === undefined || expiryPart === undefined || given === undefined) return null

  const id = Number(idPart)
  const expiry = Number(expiryPart)
  if (!Number.isInteger(id) || id <= 0 || !Number.isFinite(expiry)) return null

  const user = await db.select().from(users).where(eq(users.id, id)).get()
  // An unusable hash cannot sign anything worth honouring — see `user:add`.
  if (!user || !user.active || user.password_hash === '') return null

  if (!sameMac(given, mac(user, `${idPart}.${expiryPart}`))) return null
  // Checked AFTER the mac, so an expired cookie and a forged one take the same
  // path and the same time.
  if (Date.now() > expiry) return null

  return user
}

export async function currentUser(db: DB, req: Request): Promise<UserRow | null> {
  return await userFromCookie(db, req)
}

// ---------------------------------------------------------------------------
// Logging in
// ---------------------------------------------------------------------------

/**
 * A short lockout after a handful of failures, in memory.
 *
 * One machine and one process, so a Map is the whole implementation. argon2id
 * already makes guessing expensive — a verify costs ~55ms whether it succeeds or
 * fails — so this is the second of two defences rather than the only one.
 */
const FAILURE_LIMIT = 8
const LOCKOUT_MS = 60_000
const failures = new Map<string, { count: number; until: number }>()

function lockedOut(who: string): boolean {
  const f = failures.get(who)
  if (f === undefined) return false
  if (Date.now() > f.until) {
    failures.delete(who)
    return false
  }
  return f.count >= FAILURE_LIMIT
}

function recordFailure(who: string): void {
  const f = failures.get(who)
  const count = f !== undefined && Date.now() <= f.until ? f.count + 1 : 1
  failures.set(who, { count, until: Date.now() + LOCKOUT_MS })
}

/** Test seam. Never called by the server. */
export function resetLockouts(): void {
  failures.clear()
}

export async function authenticate(
  db: DB,
  username: string,
  password: string,
): Promise<UserRow | null> {
  const who = username.trim().toLowerCase()
  if (who === '' || lockedOut(who)) return null

  const user = await db.select().from(users).where(eq(users.username, who)).get()
  // Unknown user, disabled user, or one whose password was never set: all the
  // same answer, and all recorded as a failure.
  if (!user || !user.active || user.password_hash === '') {
    recordFailure(who)
    return null
  }

  if (!(await Bun.password.verify(password, user.password_hash))) {
    recordFailure(who)
    return null
  }

  failures.delete(who)
  return user
}

// ---------------------------------------------------------------------------
// Claiming an invitation
// ---------------------------------------------------------------------------

/** A zone is valid if Intl will format with it. No 445-entry list to maintain. */
export function isTimezone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: zone })
    return true
  } catch {
    return false
  }
}

/**
 * Spend an invitation: set the password and the zone, clear the token.
 *
 * Returns null for every failure — wrong token, expired, already spent, account
 * disabled — because the caller must not be able to tell them apart. The claim
 * form takes a token rather than a username precisely so there is nothing to
 * enumerate, and a helpful error would hand that back.
 *
 * The empty-hash check is what makes this a claim and not a password reset: it
 * is a one-way transition, and resetting a claimed account stays a deliberate
 * act from a laptop. See `.plan/changes/changes-v13.md`.
 */
export async function claimAccount(
  db: DB,
  token: string,
  password: string,
  timezone: string,
): Promise<UserRow | null> {
  if (token === '' || !isTimezone(timezone)) return null

  const user = await db.select().from(users).where(eq(users.claim_token, token)).get()
  if (!user || !user.active) return null
  if (user.password_hash !== '') return null
  if (user.claim_expires === null || Date.now() > user.claim_expires) return null

  const password_hash = await Bun.password.hash(password)
  await db
    .update(users)
    .set({ password_hash, timezone, claim_token: null, claim_expires: null })
    .where(eq(users.id, user.id))
    .run()

  // The cookie is signed with the hash, so it has to be the NEW one.
  return { ...user, password_hash, timezone, claim_token: null, claim_expires: null }
}
