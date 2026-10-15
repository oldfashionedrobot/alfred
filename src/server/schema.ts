import { sqliteTable, text, integer, index, primaryKey } from 'drizzle-orm/sqlite-core'
import type { Cadence, ISODate, NoteColor } from '../shared/types.ts'

/**
 * Property names are snake_case, identical to the column names and to the wire
 * format. There is no mapping layer anywhere.
 *
 * Dates are TEXT 'YYYY-MM-DD'. The one instant stored as data is a note's
 * `updated_at`, since v18; the others are a session's, a lockout's and an
 * invitation's expiry.
 *
 * OWNERSHIP. `tasks`, `days` and `notes` carry a user_id; `completions` does not, because
 * a completion belongs to whoever owns its task and a second copy of that fact
 * could disagree with the first. `moods` is global — it is a vocabulary, not
 * anybody's data.
 */

/**
 * A person. There is no signup: users are created with `bun run user:add`, which
 * is also the only way to set a password — an argon2 hash cannot be typed into a
 * SQL console.
 *
 * `active` rather than deletion, like everywhere else in this model — the one
 * exception being a note deleted forever from Archived, since v18. Deleting a
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
   * they happen to be holding.
   */
  timezone: text('timezone').notNull().default('America/New_York'),
  /**
   * An unspent invitation. 32 random bytes as hex, NULL once claimed.
   *
   * The token IS the security: the claim form takes it instead of a username,
   * so there is nothing to guess and nothing to enumerate.
   */
  claim_token: text('claim_token'),
  /** Epoch ms — an instant, not a day, like the session cookie's expiry. */
  claim_expires: integer('claim_expires'),
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
   * which is the cheap half of one.
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
    /** JSON array of task ids and, since v17, `{ hour }` dividers, stored opaquely. Named task_order; `order` is reserved. */
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

/**
 * A note: a title and a Markdown body, on a board of cards.
 *
 * Owned like a task, and nobody else's to see. The body is Markdown — the text
 * you would have typed in any Markdown editor, checklists included — so it reads
 * as text here and in anything exported, and a later link to a task can be an
 * ordinary Markdown link.
 *
 * `archived` is the delete: off the board, restorable, and the only place a note
 * can be deleted forever from.
 */
export const notes = sqliteTable(
  'notes',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    /** Owner. Every query filters on it, and `loadNote` enforces it. */
    user_id: integer('user_id')
      .notNull()
      .references(() => users.id),
    title: text('title').notNull().default(''),
    /** Markdown. Not validated beyond being a string: Markdown has no invalid documents. */
    body: text('body').notNull().default(''),
    /** A palette name — see NOTE_COLORS — or null for the default. Never a hex. */
    color: text('color').$type<NoteColor>(),
    pinned: integer('pinned', { mode: 'boolean' }).notNull().default(false),
    archived: integer('archived', { mode: 'boolean' }).notNull().default(false),
    /**
     * Epoch ms of the last change to the title or the body — the first instant
     * stored as data rather than as a session or an invitation. Pinning,
     * colouring and archiving do not move it.
     */
    updated_at: integer('updated_at').notNull(),
  },
  (t) => [index('notes_user_id_idx').on(t.user_id)],
)

export type TaskRow = typeof tasks.$inferSelect
export type CompletionRow = typeof completions.$inferSelect
export type DayRow = typeof days.$inferSelect
export type MoodRow = typeof moods.$inferSelect
export type UserRow = typeof users.$inferSelect
export type NoteRow = typeof notes.$inferSelect
