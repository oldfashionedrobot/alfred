import { test as base, expect } from '@playwright/test'
import { spawn, execFileSync, type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

/**
 * This file runs under Node (Playwright's runner), while the app runs under Bun.
 * Anything needing bun:sqlite is shelled out to e2e/seed-cli.ts.
 */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Writes rows the command API refuses to create. */
export class Seed {
  constructor(private readonly dbPath: string) {}

  private run(op: Record<string, unknown>): Record<string, any> {
    const out = execFileSync('bun', ['--no-env-file', 'e2e/seed-cli.ts', this.dbPath, JSON.stringify(op)], {
      cwd: ROOT,
      encoding: 'utf8',
    })
    return JSON.parse(out.trim() || '{}')
  }

  /**
   * A second account, for the tests that prove one person cannot see another's
   * data. Pass a password to make it one you can actually sign in as.
   *
   * User 1 is `owner`, created by the migration: who the app resolves to when
   * AUTH_REQUIRED is unset, and therefore who every other test is about.
   */
  user(u: { username: string; password?: string; active?: boolean }): number {
    return this.run({ kind: 'user', ...u }).id as number
  }

  /** Give an existing user a password — `owner` has none until something does. */
  password(username: string, password: string): void {
    this.run({ kind: 'password', username, password })
  }

  /** Returns the new task id. planned_date may be any date, including the past. */
  task(t: {
    name: string
    cadence?: 'day' | 'week' | 'month' | 'quarter' | 'year' | null
    is_baseline?: boolean
    planned_date?: string | null
    /** '#rrggbb'. Only rendered when the task is baseline. */
    color?: string | null
    active?: boolean
    /** Owner. Defaults to user 1, the migration's `owner`. */
    user_id?: number
  }): number {
    return this.run({ kind: 'task', ...t }).id as number
  }

  /** A completion on any date, including the past. */
  completion(task_id: number, completed_on: string): void {
    this.run({ kind: 'completion', task_id, completed_on })
  }

  day(
    date: string,
    d: { mood?: string | null; log?: string | null; task_order?: number[] | null; user_id?: number },
  ): void {
    this.run({ kind: 'day', date, ...d })
  }

  mood(m: { slug: string; emoji: string; label: string; sort_order: number; active?: boolean }): void {
    this.run({ kind: 'mood', ...m })
  }

  /** Retire an existing mood — for asserting History still renders it. */
  retire(slug: string): void {
    this.run({ kind: 'retire', slug })
  }
}

/** The password the fixture gives `owner`. Only ever used by the suite. */
export const TEST_PASSWORD = 'e2e-fixture-password'

/** One server process, one SQLite file, one test. */
export type App = {
  /** Base URL of this test's own server. */
  url: string
  /** Direct DB access for rows the command API refuses to create. */
  seed: Seed
  /** The server's notion of today, 'YYYY-MM-DD'. Never hardcode a date. */
  today: string
  /**
   * fetch against this test's server, carrying its session.
   *
   * Every endpoint but `/api/status` needs one, so a bare `fetch` here would
   * get a 401 and the test would fail somewhere unrelated to what it is about.
   */
  fetch: (path: string, init?: RequestInit) => Promise<Response>
  /** `name=value`, for the rare test that builds a request by hand. */
  cookie: string
  /** This test's database file. */
  dbPath: string
  /**
   * What the server says it is connected to: 'local' or 'replica'. A contract,
   * unlike the libSQL file artifact the guard used to infer this from.
   */
  database: string
}

export const test = base.extend<{ app: App; signedIn: boolean }>({
  /**
   * Every test arrives signed in, because the app has no other mode: auth is
   * unconditional and there is no flag to turn it off. The fixture signs in as
   * the migration's `owner` once, and both the browser and `app.fetch` carry
   * the cookie — so no spec has to think about it.
   *
   * `e2e/auth.spec.ts` sets `test.use({ signedIn: false })`, because arriving
   * without a session is exactly what it is testing.
   */
  signedIn: [true, { option: true }],

  app: async ({ context, signedIn }, use) => {
    const dir = mkdtempSync(join(tmpdir(), 'alfred-e2e-'))
    const dbPath = join(dir, 'test.db')

    /*
     * PORT=0 lets the SERVER choose, and we read back what it chose.
     *
     * This used to ask the OS for a free port — bind :0, read the number, close
     * the socket, hand it to bun — which is a race with four workers starting
     * servers at once. The benign outcome is a failure to bind. The one that
     * actually bit was silent: the loop below fetches /api/day, gets a 200 from
     * ANOTHER test's server that took the port first, and the whole test then
     * runs against a foreign database. It fails later, somewhere else, as a
     * missing row or an unexpected click target — which is what "flaky" looked
     * like here. Nothing guesses a port now, so there is nothing to race.
     */
    /*
     * TURSO_* is EMPTIED, not deleted, and the difference is the whole point.
     *
     * Once this repository had a `.env` holding real Turso credentials,
     * `{ ...process.env }` turned every test server into an embedded replica of
     * the PRODUCTION database. `DB_PATH` still pointed at a temp file, so
     * nothing looked wrong — but that file was a replica, and every write the
     * suite made was forwarded to Turso. It put ~200 rows in the live database.
     *
     * Deleting the keys does NOT fix it: Bun auto-loads `.env` in the child, so
     * the child reads them back. An explicitly-passed variable does beat `.env`,
     * so an empty string is the only thing that reaches the child as "unset" —
     * and `db.ts` treats an empty URL as unset for exactly this reason.
     *
     * `--no-env-file` is the second, independent guard: the credentials now live
     * in `.env.turso`, which nothing loads unless asked, and this keeps the suite
     * correct no matter what anybody later puts back into `.env`. Two guards,
     * because one of them was already believed to be working while it was not.
     */
    const proc: ChildProcess = spawn('bun', ['--no-env-file', 'src/server/index.ts'], {
      cwd: ROOT,
      env: { ...process.env, TURSO_URL: '', TURSO_AUTH_TOKEN: '', DB_PATH: dbPath, PORT: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    proc.stdout?.on('data', (d) => (stdout += d))
    proc.stderr?.on('data', (d) => (stderr += d))

    const deadline = Date.now() + 25_000
    let port = 0
    for (;;) {
      // `alfred → http://localhost:<port>`, printed once bun is listening.
      const printed = /http:\/\/localhost:(\d+)/.exec(stdout)
      if (printed) {
        port = Number(printed[1])
        break
      }
      if (Date.now() > deadline) {
        proc.kill('SIGKILL')
        throw new Error(`server never printed a port\n${stdout}\n${stderr}`)
      }
      await sleep(50)
    }

    const url = `http://127.0.0.1:${port}`
    let database = ''
    for (;;) {
      try {
        // /api/status rather than /api/day: it is the one endpoint before the
        // auth gate, so this probe works whether or not the test wants a login.
        //
        // It no longer carries a date. It is ungated, so with per-user zones
        // there is no user whose day it could name — see `.plan/changes/changes-v11.md`.
        // `today` comes from /api/day below, after signing in, which is the only
        // point at which "today" means anything.
        const r = await fetch(`${url}/api/status`)
        if (r.ok) {
          database = ((await r.json()) as { database: string }).database
          break
        }
      } catch {
        /* listening but not answering yet */
      }
      if (Date.now() > deadline) {
        proc.kill('SIGKILL')
        throw new Error(`server never answered on ${port}\n${stderr}`)
      }
      await sleep(50)
    }

    const seed = new Seed(dbPath)

    /*
     * Sign in once, over HTTP, exactly the way a browser does — rather than
     * minting a cookie here. A fixture that knew how to sign one would be a
     * second implementation of the thing the app is supposed to be tested on.
     */
    let cookie = ''
    if (signedIn) {
      seed.password('owner', TEST_PASSWORD)
      const res = await fetch(`${url}/api/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: 'owner', password: TEST_PASSWORD }),
      })
      const header = res.headers.get('set-cookie')
      if (!res.ok || header === null) {
        proc.kill('SIGKILL')
        throw new Error(`fixture could not sign in: ${res.status}`)
      }
      cookie = header.split(';')[0]!
      const eq = cookie.indexOf('=')
      await context.addCookies([
        { name: cookie.slice(0, eq), value: cookie.slice(eq + 1), url },
      ])
    }

    const api = (path: string, init: RequestInit = {}): Promise<Response> =>
      fetch(`${url}${path}`, {
        ...init,
        headers: { ...(init.headers ?? {}), ...(cookie === '' ? {} : { cookie }) },
      })

    /*
     * The server's notion of today, for THIS user — read from the view rather
     * than reimplemented here, so no test computes a date the server did not
     * give it. Empty for a `signedIn: false` test, which is correct: an
     * unauthenticated client has no day.
     */
    let today = ''
    if (signedIn) {
      today = ((await (await api('/api/day')).json()) as { date: string }).date
    }

    await use({ url, seed, today, fetch: api, cookie, dbPath, database })

    proc.kill('SIGKILL')
    rmSync(dir, { recursive: true, force: true })
  },
})

export { expect }

/** n days from an ISO date. Mirrors the server's addDays; never use `new Date(iso)` in a test. */
export function addDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}
