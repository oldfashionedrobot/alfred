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
 *                       microsecond speeds it was designed for;
 *                       writes go to Turso and come back down. The durable copy
 *                       lives in Turso, which is what retires that document's
 *                       "silent failure mode" — losing the instance now loses
 *                       a cache, not a month of history.
 *
 * The schema is unchanged by any of this. libSQL is SQLite, so `schema.ts`
 * stays on drizzle's `sqlite-core` and the existing migrations still apply.
 */

/*
 * DB_PATH means two different things, and that is why this guard exists.
 *
 * Without TURSO_URL it is THE DATABASE. With TURSO_URL it is the local REPLICA
 * file — a cache of the real database, which lives in Turso. Those want
 * different locations, and there is no single sensible default for both.
 *
 * Defaulting the replica to `./data/alfred.db` is actively dangerous. If that
 * file exists, libSQL refuses with "db file exists but metadata file does not",
 * which is at least loud. If it does NOT exist — a fresh clone, or after a
 * reset — it cheerfully creates a replica of PRODUCTION there, and the next
 * `bun run dev` opens the household's real data as the development database.
 *
 * So: with Turso, say where.
 */
if (process.env.TURSO_URL && !process.env.DB_PATH) {
  throw new Error(
    'TURSO_URL is set but DB_PATH is not.\n\n' +
      'With Turso, DB_PATH is the local replica file rather than the database, ' +
      'and defaulting it to ./data/alfred.db would put production data in your ' +
      'development database. Point it somewhere throwaway:\n\n' +
      '  DB_PATH=/tmp/alfred-admin.db bun --env-file=.env.turso run user:invite <name>\n',
  )
}

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

/** The eight starting states. The only seeded data. */
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
    // libSQL defaults to `delete`; WAL means a read
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
