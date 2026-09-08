import { MIN_PASSWORD, isISODate, type ISODate } from '../shared/types.ts'
import {
  authenticate,
  claimAccount,
  changePassword,
  clearedCookie,
  currentUser,
  sessionCookie,
  setTimezone,
} from './auth.ts'
import { runCommand } from './commands.ts'
import { db, isReplica } from './db.ts'
import { ApiFailure, BadRequest, NotFound, Unauthorized } from './errors.ts'
import { today } from './today.ts'
import { buildDayView } from './views/day.ts'
import { buildHistoryView } from './views/history.ts'
import { buildTodoView } from './views/todo.ts'

/** History pages back at most a year at a time. The only ceiling, and it is here. */
const MAX_LIMIT = 365

/**
 * The /api router. Two endpoint kinds and nothing else:
 *   GET  /api/status                          -> { ok, date, sha }, ungated
 *   POST /api/login | /api/logout             -> { ok: true }, ungated
 *   GET  /api/day | /api/todo | /api/history  -> a view model
 *   POST /api/commands/<name>                  -> { ok: true }
 *
 * Every one of them is answered FOR A USER. `currentUser` is the only place a
 * request becomes an identity, and nothing below it can forget to ask.
 *
 * There is no general-purpose CRUD. If a client needs data it is because a view
 * renders it, and it arrives in that view's model.
 *
 * Anything else — an unknown path, or a known path with the wrong method — is a
 * 404. The error taxonomy has four codes and three classes: a 405 is a
 * fourth class serving only a hand-written curl, so the method is part of the
 * route match rather than a check with its own error.
 *
 * bun:sqlite is synchronous, so every query and command below is a plain call.
 * This is async only because reading the request body is.
 */
export async function handleApi(req: Request): Promise<Response> {
  try {
    const url = new URL(req.url)
    const path = normalise(url.pathname)

    /*
     * The one endpoint before the gate, and deliberately so.
     *
     * It answers three questions that all have to be answerable without a
     * session: is the process up, which build is it, and which database it is
     * talking to. The first two are what CI's post-deploy smoke test asks — see
     * `.plan/deployment.md`, which uses them instead of a Fly health check. The
     * third is what the browser harness asserts, so a test run pointed at
     * production fails instead of writing to it.
     *
     * Nothing here is private: a commit hash from a public repository, and the
     * word 'local' or 'replica'.
     */
    if (req.method === 'GET' && path === '/api/status') {
      return json({
        ok: true,
        sha: process.env.BUILD_SHA ?? 'dev',
        // Which database this process is talking to. The browser fixture asserts
        // it is 'local', which is the durable version of a guard that used to
        // infer it from a libSQL file artifact.
        database: isReplica ? 'replica' : 'local',
      })
    }

    // Signing in and out are the other two things that cannot require a session.
    if (req.method === 'POST' && path === '/api/login') {
      const { username, password } = objectBody(await readBody(req))
      if (typeof username !== 'string' || typeof password !== 'string') {
        throw new BadRequest('username and password are required')
      }
      const user = await authenticate(db, username, password)
      // One answer for every failure — unknown name, wrong password, disabled
      // account, no password set. Telling them apart only helps somebody
      // finding out which names are real.
      if (user === null) throw new Unauthorized('That name and password did not match.')
      return json({ ok: true }, 200, { 'set-cookie': sessionCookie(user) })
    }

    /*
     * Spending an invitation. Ungated for the same reason login is: the person
     * doing it has no session yet, and cannot get one any other way.
     *
     * It takes a TOKEN, not a username — so there is nothing here to guess and
     * nothing to enumerate, which a username field would have reintroduced after
     * `authenticate` went to some trouble to avoid it.
     */
    if (req.method === 'POST' && path === '/api/claim') {
      const { token, password, timezone } = objectBody(await readBody(req))
      if (typeof token !== 'string' || typeof password !== 'string' || typeof timezone !== 'string') {
        throw new BadRequest('token, password and timezone are required')
      }
      if (password.length < MIN_PASSWORD) {
        throw new BadRequest(`a password needs at least ${MIN_PASSWORD} characters`)
      }
      const user = await claimAccount(db, token, password, timezone)
      // One answer for every failure — wrong, expired, spent, disabled. Telling
      // them apart only helps somebody probing for a live invitation.
      if (user === null) throw new Unauthorized('That link is not valid.')
      return json({ ok: true }, 200, { 'set-cookie': sessionCookie(user) })
    }

    if (req.method === 'POST' && path === '/api/logout') {
      return json({ ok: true }, 200, { 'set-cookie': clearedCookie() })
    }

    // Resolved once, here, and threaded through everything below. There is no
    // request without a user: no cookie is a 401, and the client turns that into
    // a trip to /login.
    const user = await currentUser(db, req)
    if (user === null) throw new Unauthorized('sign in at /login')

    /*
     * Your own account, and only ever your own: the row these read and write is
     * the one the cookie already resolved to, so none of them carries an id.
     */
    if (req.method === 'POST' && path === '/api/account/timezone') {
      const { timezone } = objectBody(await readBody(req))
      if (typeof timezone !== 'string') throw new BadRequest('timezone is required')
      if (!(await setTimezone(db, user.id, timezone))) {
        throw new BadRequest('not a timezone this system knows')
      }
      return json({ ok: true })
    }

    /*
     * The current password is required because a session alone must not be
     * enough to take an account over — otherwise a borrowed unlocked browser is
     * permanent. `authenticate`'s lockout is deliberately NOT extended here: it
     * blunts guessing at the sign-in door, where the caller has no session, and
     * this one already holds the session the guess would be trying to reach.
     */
    if (req.method === 'POST' && path === '/api/account/password') {
      const { current, next } = objectBody(await readBody(req))
      if (typeof current !== 'string' || typeof next !== 'string') {
        throw new BadRequest('current and next are required')
      }
      if (next.length < MIN_PASSWORD) {
        throw new BadRequest(`a password needs at least ${MIN_PASSWORD} characters`)
      }
      const updated = await changePassword(db, user, current, next)
      if (updated === null) throw new BadRequest('That is not your current password.')
      // Signed with the NEW hash, so this device survives the change it made
      // while every other session this user has stops verifying.
      return json({ ok: true }, 200, { 'set-cookie': sessionCookie(updated) })
    }

    if (req.method === 'POST' && path.startsWith('/api/commands/')) {
      const name = path.slice('/api/commands/'.length)
      if (name !== '' && !name.includes('/')) {
        await runCommand(db, user, name, await readBody(req))
        return json({ ok: true })
      }
    }

    if (req.method === 'GET') {
      switch (path) {
        // Not a view: the two fields a person can change about themselves,
        // which no view payload carries.
        case '/api/account':
          return json({ username: user.username, timezone: user.timezone })
        case '/api/day':
          return json(await buildDayView(db, user))
        case '/api/todo':
          return json(await buildTodoView(db, user))
        case '/api/history':
          return json(await buildHistoryView(db, user, historyOptions(url.searchParams, user.timezone)))
      }
    }

    throw new NotFound('no such endpoint')
  } catch (err) {
    if (err instanceof ApiFailure) return json({ error: err.message }, err.status)

    // Anything unhandled is a bug: the wire gets the message, the console gets
    // the stack, so it is debuggable after the fact.
    console.error('[api]', err)
    return json({ error: err instanceof Error ? err.message : String(err) }, 500)
  }
}

// ---------------------------------------------------------------------------

/** Anything but a promise. See `json`. */
type NotPromise<T> = T extends PromiseLike<unknown> ? never : T

/**
 * `data` is deliberately not `unknown`: a Promise satisfies `unknown`, and
 * `JSON.stringify` turns one into `{}` — so a forgotten `await` on a view
 * builder would ship an empty body with a 200 and typecheck cleanly. Every
 * builder became async in the libSQL migration, which is exactly when that
 * mistake is easiest to make, so the type rules it out instead.
 */
function json<T>(data: NotPromise<T>, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json',
      /*
       * NO-STORE, on every API response including the errors.
       *
       * This matters more since accounts than it did before them: these bodies
       * are one person's tasks, moods and journal, and Fly terminates TLS in
       * front of the app. Without it an intermediary is entitled to hold a
       * response and hand it to the next request — which, now, could be somebody
       * else. Nothing here is cacheable in any useful sense anyway: every view
       * is derived per request and changes on every tick.
       */
      'cache-control': 'no-store',
      ...extra,
    },
  })
}

/** A trailing slash names the same endpoint. `/api` itself is not one. */
function normalise(pathname: string): string {
  return pathname.length > 1 && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname
}

/** Every POST body here is a JSON object. One place says so, for all of them. */
function objectBody(body: unknown): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new BadRequest('body must be a JSON object')
  }
  return body as Record<string, unknown>
}

async function readBody(req: Request): Promise<unknown> {
  const text = await req.text()
  // A command with no arguments may legitimately arrive with no body at all.
  if (text.trim() === '') return {}
  try {
    return JSON.parse(text)
  } catch {
    throw new BadRequest('malformed JSON body')
  }
}

/**
 * The whole query-string boundary for History, and the only one: `limit` is
 * validated and bounded here, not again downstream.
 */
function historyOptions(params: URLSearchParams, zone: string): { limit?: number; before?: ISODate } {
  const opts: { limit?: number; before?: ISODate } = {}

  const limit = params.get('limit')
  if (limit !== null) {
    if (!/^\d+$/.test(limit) || Number(limit) === 0) {
      throw new BadRequest('limit must be a positive integer')
    }
    if (Number(limit) > MAX_LIMIT) throw new BadRequest(`limit must be at most ${MAX_LIMIT}`)
    opts.limit = Number(limit)
  }

  const before = params.get('before')
  if (before !== null) {
    if (!isISODate(before)) throw new BadRequest('before must be a date in YYYY-MM-DD form')
    // Every view is anchored to now, so History must never be asked to page
    // from a date it could only answer with future-dated rows.
    if (before > today(zone)) throw new BadRequest('before must not be in the future')
    opts.before = before
  }

  return opts
}
