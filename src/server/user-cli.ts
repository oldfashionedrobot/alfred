/**
 * Account management, one verb at a time.
 *
 *   bun run user:add <name>      set a password directly   (password on stdin)
 *   bun run user:invite <name>   create unclaimed, print a claim link
 *   bun run user:disable <name>  revoke access, keep the data
 *   bun run user:enable <name>   restore it
 *
 * This exists because it has to: passwords are stored as argon2id hashes, and a
 * hash cannot be typed into a SQL console. There is no self-registration and no
 * plan for one — an account exists because somebody here made it. What
 * `user:invite` adds is that the person can choose their own password.
 */
import { eq } from 'drizzle-orm'
import { randomBytes } from 'node:crypto'
import { MIN_PASSWORD } from '../shared/types.ts'
import { db, initDb } from './db.ts'
import { users } from './schema.ts'

/** A week: long enough to hand over at a convenient moment, short enough to rot. */
const CLAIM_DAYS = 7

function fail(message: string): never {
  console.error(message)
  process.exit(1)
}

const VERBS = ['add', 'invite', 'disable', 'enable'] as const
type Verb = (typeof VERBS)[number]

const verb = process.argv[2] as Verb | undefined
const raw = process.argv[3]

if (verb === undefined || !VERBS.includes(verb)) {
  fail(`usage: bun run user:<${VERBS.join('|')}> <username>`)
}
if (raw === undefined) {
  // Name the command they actually typed, not the path underneath it.
  const extra = verb === 'add' ? '   (password on stdin)' : ''
  fail(`usage: bun run user:${verb} <username>${extra}`)
}

// Lowercased, because `authenticate` looks up the lowercased form — a user
// created as "Sanjeev" who could never sign in would be a miserable bug.
const username = raw.trim().toLowerCase()
if (username === '') fail('a username cannot be blank')

await initDb()
const existing = await db.select().from(users).where(eq(users.username, username)).get()

if (verb === 'disable' || verb === 'enable') {
  if (!existing) fail(`no user called ${username}`)
  const active = verb === 'enable'
  await db.update(users).set({ active }).where(eq(users.id, existing.id)).run()
  // Disabling does not clear the password hash, so their cookies still verify
  // as signatures — `authenticate` refuses them on `active`, which is the check
  // that matters and the one place it is made.
  console.log(`${username} is now ${active ? 'enabled' : 'disabled'}`)
  process.exit(0)
}

if (verb === 'invite') {
  if (existing && existing.password_hash !== '') {
    fail(`${username} already has a password — use user:add to reset it`)
  }
  const claim_token = randomBytes(32).toString('hex')
  const claim_expires = Date.now() + CLAIM_DAYS * 24 * 60 * 60 * 1000

  if (existing) {
    await db.update(users).set({ claim_token, claim_expires }).where(eq(users.id, existing.id)).run()
  } else {
    await db.insert(users).values({ username, password_hash: '', active: true, claim_token, claim_expires }).run()
  }

  // APP_URL rather than a hardcoded domain: this command runs from a laptop,
  // against whichever database the environment points at.
  const base = process.env.APP_URL ?? 'http://localhost:3000'
  console.log(`invited ${username}. This link is single-use and expires in ${CLAIM_DAYS} days:\n`)
  console.log(`  ${base}/claim?t=${claim_token}\n`)
  console.log('Send it to them however suits — it is a password, so treat it like one.')
  process.exit(0)
}

// --- add ---------------------------------------------------------------------
if (process.stdin.isTTY) process.stderr.write(`password for ${username}: `)
const password = (await Bun.stdin.text()).replace(/\r?\n$/, '')
if (password.length < MIN_PASSWORD) {
  fail(`a password needs at least ${MIN_PASSWORD} characters; that one has ${password.length}`)
}

const password_hash = await Bun.password.hash(password)

if (existing) {
  // Changing the hash invalidates that user's cookies, because the hash is the
  // key their session is signed with. Revocation, for free. Any unspent
  // invitation goes with it: setting a password is claiming the account.
  await db
    .update(users)
    .set({ password_hash, active: true, claim_token: null, claim_expires: null })
    .where(eq(users.id, existing.id))
    .run()
  console.log(`updated ${username} (id ${existing.id}); their existing sessions are now invalid`)
} else {
  const [made] = await db.insert(users).values({ username, password_hash, active: true }).returning()
  console.log(`created ${username} (id ${made!.id})`)
}
process.exit(0)
