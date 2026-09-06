import { isISODate, type ISODate } from '../shared/types.ts'
import { currentUser } from './auth.ts'
import { runCommand } from './commands.ts'
import { db } from './db.ts'
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
 * 404. `.plan/api.md`'s error table has four codes and three classes: a 405 is a
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
     * session: is the process up, which build is it, and what does it think
     * today is. The first two are what CI's post-deploy smoke test asks — see
     * `.plan/deployment.md`, which uses them instead of a Fly health check. The
     * third is what the Playwright fixture reads so that no test computes a date
     * the server did not give it.
     *
     * Nothing here is private: a date and a commit hash from a public repository.
     */
    if (req.method === 'GET' && path === '/api/status') {
      return json({ ok: true, date: today(), sha: process.env.BUILD_SHA ?? 'dev' })
    }

    // Resolved once, here, and threaded through everything below. There is no
    // request without a user: no cookie is a 401, and the client turns that into
    // a trip to /login.
    const user = await currentUser(db, req)
    if (user === null) throw new Unauthorized('sign in at /login')

    if (req.method === 'POST' && path.startsWith('/api/commands/')) {
      const name = path.slice('/api/commands/'.length)
      if (name !== '' && !name.includes('/')) {
        await runCommand(db, user.id, name, await readBody(req))
        return json({ ok: true })
      }
    }

    if (req.method === 'GET') {
      switch (path) {
        case '/api/day':
          return json(await buildDayView(db, user.id))
        case '/api/todo':
          return json(await buildTodoView(db, user.id))
        case '/api/history':
          return json(await buildHistoryView(db, user.id, historyOptions(url.searchParams)))
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
function json<T>(data: NotPromise<T>, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

/** A trailing slash names the same endpoint. `/api` itself is not one. */
function normalise(pathname: string): string {
  return pathname.length > 1 && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname
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
function historyOptions(params: URLSearchParams): { limit?: number; before?: ISODate } {
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
    if (before > today()) throw new BadRequest('before must not be in the future')
    opts.before = before
  }

  return opts
}
