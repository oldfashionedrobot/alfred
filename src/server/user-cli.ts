/**
 * `bun run user:add <username>` — create a user, or set an existing user's
 * password. The password is read from stdin.
 *
 * This exists because it has to: passwords are stored as argon2id hashes, and a
 * hash cannot be typed into a SQL console. There is no signup page and no plan
 * for one — accounts are made here, deliberately, one at a time.
 *
 * Creating and setting a password are the same command because they are the same
 * intention: "this person should be able to sign in." The migration leaves an
 * `owner` account holding every pre-ownership row and no usable password, so
 * `user:add owner` is also how you claim data that predates accounts.
 */
import { eq } from 'drizzle-orm'
import { db, initDb } from './db.ts'
import { users } from './schema.ts'

const MIN_LENGTH = 12

function fail(message: string): never {
  console.error(message)
  process.exit(1)
}

const raw = process.argv[2]
if (raw === undefined) fail('usage: bun run user:add <username>   (password on stdin)')

// Lowercased, because `authenticate` looks up the lowercased form — a user
// created as "Sanjeev" who could never sign in would be a miserable bug.
const username = raw.trim().toLowerCase()
if (username === '') fail('a username cannot be blank')

if (process.stdin.isTTY) process.stderr.write(`password for ${username}: `)
const password = (await Bun.stdin.text()).replace(/\r?\n$/, '')
if (password.length < MIN_LENGTH) {
  fail(`a password needs at least ${MIN_LENGTH} characters; that one has ${password.length}`)
}

await initDb()
const password_hash = await Bun.password.hash(password)

const existing = await db.select().from(users).where(eq(users.username, username)).get()
if (existing) {
  // Changing the hash invalidates that user's cookies, because the hash is the
  // key their session is signed with. Revocation, for free.
  await db.update(users).set({ password_hash, active: true }).where(eq(users.id, existing.id)).run()
  console.log(`updated ${username} (id ${existing.id}); their existing sessions are now invalid`)
} else {
  const [made] = await db.insert(users).values({ username, password_hash, active: true }).returning()
  console.log(`created ${username} (id ${made!.id})`)
}
process.exit(0)
