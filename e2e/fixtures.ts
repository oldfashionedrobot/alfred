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
    const out = execFileSync('bun', ['e2e/seed-cli.ts', this.dbPath, JSON.stringify(op)], {
      cwd: ROOT,
      encoding: 'utf8',
    })
    return JSON.parse(out.trim() || '{}')
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
  }): number {
    return this.run({ kind: 'task', ...t }).id as number
  }

  /** A completion on any date, including the past. */
  completion(task_id: number, completed_on: string): void {
    this.run({ kind: 'completion', task_id, completed_on })
  }

  day(date: string, d: { mood?: string | null; log?: string | null; task_order?: number[] | null }): void {
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

/** One server process, one SQLite file, one test. */
export type App = {
  /** Base URL of this test's own server. */
  url: string
  /** Direct DB access for rows the command API refuses to create. */
  seed: Seed
  /** The server's notion of today, 'YYYY-MM-DD'. Never hardcode a date. */
  today: string
}

export const test = base.extend<{ app: App }>({
  app: async ({}, use) => {
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
    const proc: ChildProcess = spawn('bun', ['src/server/index.ts'], {
      cwd: ROOT,
      env: { ...process.env, DB_PATH: dbPath, PORT: '0' },
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
    let today = ''
    for (;;) {
      try {
        const r = await fetch(`${url}/api/day`)
        if (r.ok) {
          today = ((await r.json()) as { date: string }).date
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

    await use({ url, seed: new Seed(dbPath), today })

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
