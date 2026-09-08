import { sqliteTable, text, integer, index, primaryKey } from 'drizzle-orm/sqlite-core'
import type { Cadence, ISODate } from '../shared/types.ts'

/**
 * Property names are snake_case, identical to the column names and to the wire
 * format. There is no mapping layer anywhere.
 *
 * Dates are TEXT 'YYYY-MM-DD', never timestamps — see `.plan/api.md`.
 *
 * OWNERSHIP. `tasks` and `days` carry a user_id; `completions` does not, because
 * a completion belongs to whoever owns its task and a second copy of that fact
 * could disagree with the first. `moods` is global — it is a vocabulary, not
 * anybody's data. See `.plan/changes/changes-v9.md`.
 */

/**
 * A person. There is no signup: users are created with `bun run user:add`, which
 * is also the only way to set a password — an argon2 hash cannot be typed into a
 * SQL console.
 *
 * `active` rather than deletion, like everywhere else in this model. Deleting a
 * user would orphan every task, completion and journal entry they own; setting
 * active to false stops them logging in and leaves the record intact.
 */
export const users = sqliteTable('users', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  username: text('username').notNull().unique(),
  /** argon2id, from Bun.password. Never compared by hand. */
  password_hash: text('password_hash').notNull(),
  active: integer('active', { mode: 'boolean' }).notNull().default(true),
  /**
   * IANA name. The user's day boundary, and therefore what `today()` means for
   * them — a day belongs to a person, not to the server and not to the device
   * they happen to be holding. See `.plan/changes/changes-v11.md`.
   */
  timezone: text('timezone').notNull().default('America/New_York'),
})

export const tasks = sqliteTable('tasks', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  /** Owner. Every query in every view builder filters on this. */
  user_id: integer('user_id')
    .notNull()
    .references(() => users.id),
  name: text('name').notNull(),
  is_baseline: integer('is_baseline', { mode: 'boolean' }).notNull().default(false),
  /** null = one-off. The load-bearing nullable in the whole model. */
  cadence: text('cadence', { enum: ['day', 'week', 'month', 'quarter', 'year'] }).$type<Cadence>(),
  planned_date: text('planned_date').$type<ISODate>(),
  /**
   * '#rrggbb'. Baseline tasks only — the views null it out for anything else,
   * so the stored value survives unticking Baseline and returns when it is
   * re-ticked. The one purely presentational field in the model.
   */
  color: text('color'),
  /**
   * Free text, matched exactly. Groups tasks inside the To do panel; the Day
   * list ignores it. Not a table: the editor suggests categories already in use,
   * which is the cheap half of one — see `.plan/data-model.md`.
   */
  category: text('category'),
  active: integer('active', { mode: 'boolean' }).notNull().default(true),
}, (t) => [
  // Every read starts "this user's active tasks", so this is the shape of
  // essentially every query the app makes.
  index('tasks_user_id_idx').on(t.user_id),
])

export const completions = sqliteTable(
  'completions',
  {
    task_id: integer('task_id')
      .notNull()
      .references(() => tasks.id),
    completed_on: text('completed_on').$type<ISODate>().notNull(),
  },
  (t) => [
    // Natural key, no surrogate. Makes completion idempotent for free.
    primaryKey({ columns: [t.task_id, t.completed_on] }),
    // History reads by date range; the pk only covers task_id-first lookups.
    index('completions_completed_on_idx').on(t.completed_on),
  ],
)

/**
 * One row per user per day. The key is (user_id, date): a day is only ever a
 * day for somebody, and two people record their own mood on the same date.
 */
export const days = sqliteTable(
  'days',
  {
    user_id: integer('user_id')
      .notNull()
      .references(() => users.id),
    date: text('date').$type<ISODate>().notNull(),
    /** FK -> moods.slug. At most one mood per day. */
    mood: text('mood').references(() => moods.slug),
    log: text('log'),
    /** JSON array of task ids, stored opaquely. Named task_order; `order` is reserved. */
    task_order: text('task_order'),
  },
  (t) => [primaryKey({ columns: [t.user_id, t.date] })],
)

export const moods = sqliteTable('moods', {
  slug: text('slug').primaryKey(),
  emoji: text('emoji').notNull(),
  label: text('label').notNull(),
  sort_order: integer('sort_order').notNull(),
  active: integer('active', { mode: 'boolean' }).notNull().default(true),
})

export type TaskRow = typeof tasks.$inferSelect
export type CompletionRow = typeof completions.$inferSelect
export type DayRow = typeof days.$inferSelect
export type MoodRow = typeof moods.$inferSelect
export type UserRow = typeof users.$inferSelect
