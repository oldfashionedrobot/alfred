/**
 * Seeds rows the command API deliberately refuses to write — past-dated
 * placements, back-dated completions, retired moods. Run under Bun (for
 * bun:sqlite) from the Playwright fixture, which runs under Node.
 *
 *   bun e2e/seed-cli.ts <dbPath> '<json op>'
 *
 * Prints JSON to stdout: { id } for a task, {} otherwise.
 */
import { Database } from 'bun:sqlite'

const [dbPath, raw] = process.argv.slice(2)
if (!dbPath || !raw) throw new Error('usage: seed-cli <dbPath> <json>')

const op = JSON.parse(raw) as Record<string, any>
const db = new Database(dbPath)
let out: Record<string, unknown> = {}

switch (op.kind) {
  case 'task': {
    db.run(
      'INSERT INTO tasks (name, is_baseline, cadence, planned_date, color, active) VALUES (?, ?, ?, ?, ?, ?)',
      [
        op.name,
        op.is_baseline ? 1 : 0,
        op.cadence ?? null,
        op.planned_date ?? null,
        op.color ?? null,
        (op.active ?? true) ? 1 : 0,
      ],
    )
    out = db.query('SELECT last_insert_rowid() AS id').get() as Record<string, unknown>
    break
  }
  case 'completion':
    db.run('INSERT OR IGNORE INTO completions (task_id, completed_on) VALUES (?, ?)', [op.task_id, op.completed_on])
    break
  case 'day':
    db.run(
      'INSERT INTO days (date, mood, log, task_order) VALUES (?, ?, ?, ?) ' +
        'ON CONFLICT(date) DO UPDATE SET mood=excluded.mood, log=excluded.log, task_order=excluded.task_order',
      [op.date, op.mood ?? null, op.log ?? null, op.task_order ? JSON.stringify(op.task_order) : null],
    )
    break
  case 'mood':
    db.run('INSERT OR REPLACE INTO moods (slug, emoji, label, sort_order, active) VALUES (?, ?, ?, ?, ?)', [
      op.slug, op.emoji, op.label, op.sort_order, (op.active ?? true) ? 1 : 0,
    ])
    break
  case 'retire':
    db.run('UPDATE moods SET active = 0 WHERE slug = ?', [op.slug])
    break
  default:
    throw new Error(`unknown seed op: ${op.kind}`)
}

db.close()
console.log(JSON.stringify(out))
