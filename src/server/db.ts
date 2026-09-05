import { Database } from 'bun:sqlite'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { migrate } from 'drizzle-orm/bun-sqlite/migrator'
import { sql } from 'drizzle-orm'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import * as schema from './schema.ts'

/**
 * Local-only for now. Deployment will decide where this lives — `.plan/tech-stack.md`
 * calls the ephemeral-filesystem failure mode out as silent, so the path is a single
 * constant with exactly one place for that decision to land.
 */
export const DB_PATH = process.env.DB_PATH ?? './data/alfred.db'

mkdirSync(dirname(DB_PATH), { recursive: true })

const sqlite = new Database(DB_PATH, { create: true })
sqlite.exec('PRAGMA journal_mode = WAL;')
sqlite.exec('PRAGMA foreign_keys = ON;')

export const db = drizzle(sqlite, { schema })
export type DB = typeof db

/** The eight starting states from `.plan/data-model.md`. The only seeded data. */
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

export function initDb(): void {
  migrate(db, { migrationsFolder: './drizzle' })

  // Seed only when empty. Never overwrites — the mood set is editable in-app,
  // so a restart must not resurrect a retired mood or undo a rename.
  const [existing] = db.select({ n: sql<number>`count(*)` }).from(schema.moods).all()
  if (existing && existing.n > 0) return

  db.insert(schema.moods)
    .values(STARTING_MOODS.map((m, i) => ({ ...m, sort_order: i, active: true })))
    .run()
}
