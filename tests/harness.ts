import { createClient, type Client } from '@libsql/client'
import { drizzle } from 'drizzle-orm/libsql'
import { migrate } from 'drizzle-orm/libsql/migrator'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { DB } from '../src/server/db.ts'
import * as schema from '../src/server/schema.ts'

/**
 * One temporary database per test, set up the way production is.
 *
 * Not a test file — `bunfig.toml` scopes the runner to `*.test.ts`, so this is
 * only ever imported. It exists because three suites had begun to carry the same
 * eight lines of `mkdtemp`, `createClient`, `PRAGMA`, `migrate` and mood seed.
 *
 * A local libSQL file: the same driver production uses, pointed at a temp path
 * rather than Turso, so the suite needs no network and no Turso account.
 */

const MIGRATIONS = join(import.meta.dir, '..', 'drizzle')

export type Harness = { db: DB; client: Client; dir: string }

/**
 * `days.mood` is a foreign key, so the picker has to exist before a day can
 * point at one. `retired` is inactive on purpose: the mood row must not offer it
 * while History still renders it.
 */
const MOODS = [
  { slug: 'balanced', emoji: '😑', label: 'balanced', sort_order: 0, active: true },
  { slug: 'happy', emoji: '😊', label: 'happy', sort_order: 1, active: true },
  { slug: 'retired', emoji: '👻', label: 'retired', sort_order: 2, active: false },
]

export async function freshDb(prefix: string): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), `alfred-${prefix}-`))
  const client = createClient({ url: `file:${join(dir, 'alfred.db')}` })
  await client.execute('PRAGMA foreign_keys = ON')
  const db = drizzle(client, { schema })
  await migrate(db, { migrationsFolder: MIGRATIONS })
  await db.insert(schema.moods).values(MOODS)
  return { db, client, dir }
}

export function closeDb({ client, dir }: Harness): void {
  client.close()
  rmSync(dir, { recursive: true, force: true })
}
