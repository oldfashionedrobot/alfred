# Household Tracker — Changes v9

Continues [`changes-v8.md`](changes-v8.md). Same rules: what changed, why, and
what it cost, including the decisions it reverses.

This is the first entry that is not about the interface. It is the last thing
between the app and a public URL — see [`deployment.md`](deployment.md), whose
auth section this replaces wholesale.

---

## Accounts, and data that belongs to somebody

**What.** A `users` table. `tasks` and `days` carry a `user_id`. Every view
builder and every command takes a user, and answers only for them. Signing in is
a username and a password; there is no signup page and no plan for one.

**Why this and not the shared password.** `deployment.md` specified a single
password in an environment variable, checked in middleware — no users, no
ownership. That is a doorkey, not an identity: it cannot tell two people apart,
so a second person would have shared one board, and changing the password would
have signed everybody out at once.

These are personal tasks. If somebody else wants to use this, they should get
their own board, which means rows have to belong to people.

### What it cost, stated plainly

Twenty-two query sites, a rebuilt `days` table, and **a class of bug that is
invisible while there is one user**: with one account every query returns the
same rows whether or not it filters on `user_id`, so the existing suite could not
tell correct code from a missing `where`. That is the real price, and it is paid
in [`tests/isolation.test.ts`](../tests/isolation.test.ts) rather than avoided.

### The shape

```
users        id, username, password_hash, active
tasks        + user_id           (indexed: every read starts here)
days         PK date  ->  PK (user_id, date)
completions  unchanged
moods        unchanged
```

**`completions` gets no `user_id`.** A completion belongs to whoever owns its
task, and a second copy of that fact is a second thing that can be wrong. Every
completion query is bounded by the caller's task ids instead — which the builders
already had to hand, since they all begin by loading that user's tasks.

**`moods` stays global.** It is a vocabulary, not anybody's data.

**`days` gains a composite key** so that two people record their own mood on the
same date. In SQLite a primary key change is a full table rebuild, on the table
holding the journal.

### The migration was hand-written, because the generated one could not run

`drizzle-kit` produced two statements that fail regardless of how many rows exist:

- `INSERT INTO __new_days(...) SELECT "user_id", ... FROM days` — reading a
  column that the old table does not have.
- `ALTER TABLE tasks ADD user_id integer NOT NULL` — SQLite refuses a NOT NULL
  column with no default.

Both tables are rebuilt by hand instead, supplying the owner in the `SELECT`.
**Task ids are copied rather than reassigned**: `completions` references them and
the rebuild runs with foreign keys off, so renumbering would have silently
orphaned every completion in the database.

Verified against a copy of the real development database rather than a fresh one:
44 tasks, 2 days and 18 completions survived, all owned, no orphans, no foreign
key violations, ids unchanged. Worth doing because that database is in WAL mode —
copying only `alfred.db` would have tested an almost empty file and proved nothing.

### `owner`, and what happens with auth off

The migration creates **user 1, `owner`**, and gives it every row written before
ownership existed. It has an empty password hash, which never verifies against
anything, so the account cannot be signed into until `user:add` gives it one.

**With `AUTH_REQUIRED` unset, every request is the lowest-id user.** That single
decision is why 236 browser tests and 171 unit tests still run with no login step
threaded through any of them — the same shape `db.ts` already used for `TURSO_URL`.
The server **refuses to start** with `NODE_ENV=production` and it unset.

---

## Sessions

A stateless cookie: `<user_id>.<expiry-ms>.<hmac>`. No sessions table, nothing to
clean up, and it survives the restarts scale-to-zero causes several times a day.

**The key is the user's own password hash.** That buys three things for nothing: 
revocation (change a password and only that user's cookies stop verifying), no
separate session secret to configure or leak, and a per-user key that is already
high-entropy and never leaves the server. Changing a password logging you out of
your other devices is the behaviour people expect anyway.

`HttpOnly`, `Path=/`, `Max-Age` 90 days, `Secure` in production only — local
development is plain `http://localhost`, where `Secure` would drop the cookie
silently. **`SameSite=Lax` is the one doing quiet work**: it withholds the cookie
from cross-site POSTs, and every mutation here is a POST, so that is CSRF
protection without a token scheme.

The expiry is checked **after** the HMAC, so an expired cookie and a forged one
take the same path and roughly the same time.

### Passwords

`Bun.password` — argon2id, no dependency. Measured on this machine: **67 ms to
hash, 55 ms to verify, and a wrong password takes the same 56 ms.**

This is better than what `deployment.md` specified — a plaintext password in an
environment variable, compared in constant time — and it retires two of that
document's guards. The 16-character minimum was there because a cheap comparison
makes guessing cheap; at 55 ms a try, online guessing runs at about eighteen
attempts a second before any rate limiting. A lockout after eight failures is
still there, as the second of two defences rather than the only one.

### `user:add` is not a convenience

```sh
echo 'a-long-enough-password' | bun run user:add sanjeev
```

It exists because it has to: an argon2 hash cannot be typed into a SQL console.
Creating a user and setting a password are one command because they are one
intention — *this person should be able to sign in* — and that is also how the
`owner` account left by the migration is claimed.

---

## The login page, and the gate that could not be built

The login page is server-rendered HTML. A password never passes through the React
bundle, and the whole of auth stays on the server.

**`deployment.md` also specified gating `/*`** so an unauthenticated visitor got
the form instead of downloading the client. That cannot be built. A Bun route
handler can return a `Response` but not an `HTMLBundle` — tested, not assumed:
returning the bundle from a handler serves Bun's "Welcome to Bun!" placeholder.

It matters less than it reads. The repository is public, so the bundle was never
a secret; what the gate was really protecting was a visitor's experience, and
that is preserved by the client leaving for `/login` the moment its first request
comes back `401`. The bundle loads and is immediately abandoned.

`GET /api/status` is the one endpoint before the gate. It answers three questions
that all have to be answerable without a session — is the process up, which build
is it, what does it think today is — and it is what CI's post-deploy smoke test
will ask instead of a Fly health check.

---

## The tests are the point of this change

**[`tests/isolation.test.ts`](../tests/isolation.test.ts)** is a dedicated file
with one assertion per surface: every view builder answers for one user only,
every command that names a task returns **404** on somebody else's, and every
command that writes without naming one stamps the caller. A 404 rather than a
403, because a 403 confirms the id exists.

**It was mutation-tested, and it needed to be.** Four deliberate leaks —
unscoping the To do panel, `reset_overdue`'s candidate list, `loadTask`, and
`earliestRecord` — produced nine failures. The fourth produced none: the history
test seeded another user's *completion* but not their *day row*, and
`earliestRecord` takes a minimum over both. The test was strengthened and the
mutation re-run until it failed. A test that passes with and against the fix is
worth nothing, and the only way to know which kind you have is to break the code.

**[`e2e/auth.spec.ts`](../e2e/auth.spec.ts)**, twenty tests across both viewports,
covers identity rather than isolation: bounced to the login page, 401 from every
endpoint, one message for every kind of failure, sign in, reload, sign out, two
people on two boards, a password change invalidating a live session, an account
with no password set, and the lockout.

The fixture gained one option — `test.use({ authRequired: true })` — and nothing
else changed in the other 236 tests.

### One harness bug this surfaced

The readiness probe waited for `/api/day` to return `ok`, which with auth on is
`401` forever. It now probes `/api/status`, which is also where it reads the
date from — so no test computes a date the server did not give it.
