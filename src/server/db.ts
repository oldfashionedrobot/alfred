import { createClient, type Client } from '@libsql/client'
import { drizzle } from 'drizzle-orm/libsql'
import { migrate } from 'drizzle-orm/libsql/migrator'
import { sql } from 'drizzle-orm'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import * as schema from './schema.ts'

/**
 * libSQL, in one of two modes depending on the environment.
 *
 *   TURSO_URL unset  →  a plain local SQLite file at DB_PATH.
 *                       Development and the whole test suite run this way, so
 *                       neither needs a network or a Turso account.
 *
 *   TURSO_URL set    →  an EMBEDDED REPLICA: the same local file, kept in sync
 *                       with Turso. Reads are served from local disk at the
 *                       microsecond speeds `design/tech-stack.md` assumed;
 *                       writes go to Turso and come back down. The durable copy
 *                       lives in Turso, which is what retires that document's
 *                       "silent failure mode" — losing the instance now loses
 *                       a cache, not a month of history.
 *
 * The schema is unchanged by any of this. libSQL is SQLite, so `schema.ts`
 * stays on drizzle's `sqlite-core` and the existing migrations still apply.
 */

export const DB_PATH = process.env.DB_PATH ?? './data/alfred.db'

/*
 * An EMPTY value counts as unset, and that is load-bearing rather than tidy.
 *
 * Bun auto-loads `.env` in every process it starts, including one spawned by the
 * test fixture — so deleting these keys from the parent's environment does
 * nothing, because the child reads `.env` and puts them straight back. An
 * explicitly-passed variable does win over `.env`, so passing an empty string is
 * the only way a caller can say "local file, whatever .env holds". The browser
 * fixture relies on it; without it the suite ran against the PRODUCTION
 * database, which is not hypothetical — it happened, and wrote ~200 rows there.
 */
const TURSO_URL = process.env.TURSO_URL || undefined
const TURSO_AUTH_TOKEN = process.env.TURSO_AUTH_TOKEN

mkdirSync(dirname(DB_PATH), { recursive: true })

/** How often the replica pulls from Turso, in seconds. */
const SYNC_INTERVAL = 60

function connect(): Client {
  const url = `file:${DB_PATH}`
  if (TURSO_URL === undefined) return createClient({ url })

  if (TURSO_AUTH_TOKEN === undefined) {
    throw new Error('TURSO_URL is set but TURSO_AUTH_TOKEN is not')
  }
  return createClient({
    url,
    syncUrl: TURSO_URL,
    authToken: TURSO_AUTH_TOKEN,
    syncInterval: SYNC_INTERVAL,
  })
}

export const client = connect()
export const db = drizzle(client, { schema })
export type DB = typeof db

/** True when this process is talking to Turso rather than a bare local file. */
export const isReplica = TURSO_URL !== undefined

/** The eight starting states from `design/data-model.md`. The only seeded data. */
const STARTING_MOODS: ReadonlyArray<{ slug: string; emoji: string; label: string }> = [
  { slug: 'angry', emoji: '🤬', label: 'angry' },
  { slug: 'scattered', emoji: '🤯', label: 'scattered' },
  { slug: 'depressed', emoji: '🤢', label: 'depressed' },
  { slug: 'anxious', emoji: '🥶', label: 'anxious' },
  { slug: 'fiending', emoji: '😈', label: 'fiending' },
  { slug: 'shutdown', emoji: '💀', label: 'shutdown' },
  { slug: 'balanced', emoji: '😑', label: 'balanced' },
  { slug: 'happy', emoji: '😊', label: 'happy' },
]

export async function initDb(): Promise<void> {
  if (isReplica) {
    // Pull before migrating: a replica that has not synced yet would be migrated
    // from an empty local file and then collide with the primary.
    await client.sync()
  } else {
    // libSQL defaults to `delete`; design/tech-stack.md asks for WAL so a read
    // never blocks the writer. A replica's storage is Turso's to manage.
    await client.execute('PRAGMA journal_mode = WAL')
  }

  // Already ON by default in libSQL, unlike stock SQLite — set explicitly so the
  // guarantee does not rest on that default.
  await client.execute('PRAGMA foreign_keys = ON')

  await migrate(db, { migrationsFolder: './drizzle' })

  // Seed only when empty. Never overwrites — the mood set is edited in the
  // database, so a restart must not resurrect a retired mood or undo a rename.
  const [existing] = await db.select({ n: sql<number>`count(*)` }).from(schema.moods)
  if (existing && existing.n > 0) return

  await db
    .insert(schema.moods)
    .values(STARTING_MOODS.map((m, i) => ({ ...m, sort_order: i, active: true })))
}
