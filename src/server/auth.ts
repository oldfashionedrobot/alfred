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
// The login page
//
// Server-rendered HTML, not a React view: a password should never pass through
// the client bundle, and this way the whole of auth lives on the server.
// ---------------------------------------------------------------------------

export function loginPage(message: string | null = null): Response {
  const note =
    message === null ? '' : `<p class="err" role="alert">${message.replace(/[<&]/g, '')}</p>`
  return new Response(
    `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<meta name="theme-color" content="#111417" />
<title>alfred</title>
<style>
  :root { color-scheme: light dark; --bg:#f6f7f8; --fg:#111417; --line:#d7dade; --accent:#3d6ee0; }
  @media (prefers-color-scheme: dark) {
    :root { --bg:#111417; --fg:#e7eaee; --line:#2b3138; --accent:#6b93f0; }
  }
  body { margin:0; min-height:100dvh; display:grid; place-items:center; background:var(--bg);
         color:var(--fg); font:16px/1.5 system-ui, -apple-system, sans-serif; }
  form { width:min(22rem, calc(100vw - 3rem)); display:grid; gap:.75rem; }
  h1 { margin:0 0 .5rem; font-size:1.35rem; }
  label { display:grid; gap:.3rem; font-size:.85rem; }
  input { min-height:44px; padding:0 .6rem; font:inherit; color:inherit;
          background:transparent; border:1px solid var(--line); border-radius:10px; }
  button { min-height:44px; border:0; border-radius:10px; background:var(--accent);
           color:#fff; font:inherit; font-weight:600; }
  .err { margin:0; color:#c0392b; font-size:.85rem; }
  @media (prefers-color-scheme: dark) { .err { color:#ff8a80; } }
</style>
</head>
<body>
  <form method="post" action="/login">
    <h1>alfred</h1>
    ${note}
    <label>Name
      <input name="username" autocomplete="username" autocapitalize="none" autofocus required />
    </label>
    <label>Password
      <input name="password" type="password" autocomplete="current-password" required />
    </label>
    <button type="submit">Sign in</button>
  </form>
</body>
</html>`,
    { status: message === null ? 200 : 401, headers: { 'content-type': 'text/html; charset=utf-8' } },
  )
}
