import { sqliteTable, text, integer, index, primaryKey } from 'drizzle-orm/sqlite-core'
import type { Cadence, ISODate } from '../shared/types.ts'

/**
 * Property names are snake_case, identical to the column names and to the wire
 * format. There is no mapping layer anywhere.
 *
 * Dates are TEXT 'YYYY-MM-DD', never timestamps — see `.plan/api.md`.
 */

export const tasks = sqliteTable('tasks', {
  id: integer('id').primaryKey({ autoIncrement: true }),
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
})

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

export const days = sqliteTable('days', {
  date: text('date').$type<ISODate>().primaryKey(),
  /** FK -> moods.slug. At most one mood per day. */
  mood: text('mood').references(() => moods.slug),
  log: text('log'),
  /** JSON array of task ids, stored opaquely. Named task_order; `order` is reserved. */
  task_order: text('task_order'),
})

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
