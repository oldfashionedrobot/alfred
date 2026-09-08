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
      'INSERT INTO tasks (user_id, name, is_baseline, cadence, planned_date, color, active) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [
        // The migration's `owner`, which is who the app resolves to with auth
        // off. A seed for a second user passes its id explicitly.
        op.user_id ?? 1,
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
      'INSERT INTO days (user_id, date, mood, log, task_order) VALUES (?, ?, ?, ?, ?) ' +
        'ON CONFLICT(user_id, date) DO UPDATE SET mood=excluded.mood, log=excluded.log, task_order=excluded.task_order',
      [op.user_id ?? 1, op.date, op.mood ?? null, op.log ?? null, op.task_order ? JSON.stringify(op.task_order) : null],
    )
    break
  // A second account, for the tests that prove one user cannot see another's
  // data. The hash is real so the login flow can be exercised.
  case 'user': {
    const password_hash = op.password ? await Bun.password.hash(op.password) : ''
    db.run('INSERT INTO users (username, password_hash, active) VALUES (?, ?, ?)', [
      op.username, password_hash, (op.active ?? true) ? 1 : 0,
    ])
    out = db.query('SELECT last_insert_rowid() AS id').get() as Record<string, unknown>
    break
  }
  case 'password': {
    db.run('UPDATE users SET password_hash = ? WHERE username = ?', [
      await Bun.password.hash(op.password), op.username,
    ])
    break
  }
  case 'invite': {
    // An unclaimed account: exists, no password, holds a token. The same state
    // `user:invite` creates, and the one the migration left `owner` in.
    db.run(
      'INSERT INTO users (username, password_hash, active, claim_token, claim_expires) VALUES (?, ?, 1, ?, ?)',
      [op.username, '', op.token, op.expires ?? Date.now() + 7 * 24 * 60 * 60 * 1000],
    )
    break
  }

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
