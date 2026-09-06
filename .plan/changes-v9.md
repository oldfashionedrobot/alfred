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

### `owner`

The migration creates **user 1, `owner`**, and gives it every row written before
ownership existed. It has an empty password hash, which never verifies against
anything, so the account cannot be signed into until `user:add` gives it one.
That is also how you claim data that predates accounts.

### Signing in is not optional, and there is no flag

A first draft of this change had an `AUTH_REQUIRED` flag: unset in development
and across the test suite, where every request resolved to the lowest-id user,
with the server refusing to start in production if it was not set.

**That was the wrong trade and it is gone.** The flag bought one thing — a test
suite that never logs in — and cost a state the app should not be able to be in,
plus a startup guard whose only job was to catch that state, plus the standing
risk that development and production behave differently in the one area where
that matters most. A guard is also only as good as remembering to write it.

With no flag there is nothing to misconfigure, so the guard went with the switch.
What replaces it is smaller than either: the server warns at startup when no user
has a password yet, because a database nobody can sign into is *locked*, which is
the safe direction to fail in and needs saying rather than guarding against.

**The cost lands on the browser suite, which now signs in** — once, in
`e2e/fixtures.ts`, over HTTP exactly the way a browser does. A fixture that
minted its own cookie would have been a second implementation of the thing under
test. Specs did not change beyond `fetch(...)` becoming `app.fetch(...)`, which
carries the session; the 25 sites that needed it were mostly inside five helpers.

Unit tests were unaffected: they call the builders directly with a user id and
never had a session to begin with.

**It costs about a minute of wall clock.** The browser suite went from 2.3 to
3.3 minutes, which is one argon2 hash and one login round trip per test — 256 of
each. That is the price of the fixture exercising the real sign-in rather than
minting a cookie, and it is worth paying: a cheaper hash in tests would mean the
suite never runs the code that actually guards the app.

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

## The login page is a React view, and the gate could not be built

The form started as a server-rendered HTML string, on the reasoning that a
password should not pass through the client bundle. **That reasoning does not
survive contact.** Both paths send the password over TLS to the same server, and
anyone able to alter the bundle owns the app either way. It was a rationalisation,
not a security property.

What the string actually cost was **seventeen lines restating colour tokens,
inputs and buttons** — a second style system, which is the precise thing `ui.tsx`
exists to prevent and which this project's first review was about. It would have
drifted.

So the form is `views/Login.tsx`, using `.field`, `.input` and `.btn--primary`
from `styles.css` like every other screen. `POST /api/login` and
`POST /api/logout` join `/api/status` as the endpoints before the gate.
`auth.ts` lost 54 lines; the client gained 111 across a view and its placement
CSS — near enough a wash, with one style system instead of two.

**There is no `/login` URL.** The client owns the signed-out state, so one place
decides you are signed out rather than a server route and a client route that
have to agree. `api.ts` is where a 401 is recognised — from the first fetch on
load, from a command, or from signing out — and the shell swaps the app for the
form. No screen has to know whether it is signed in, which is the same division
the view models already draw.

Two details worth keeping:

**`login()` deliberately bypasses `request()`.** A wrong password is a 401, and
`request` treats a 401 as *you have been signed out* and never resolves — right
everywhere else, and it would stop the form ever showing an error.

**A failed attempt clears the password and keeps the name.** Retyping a name is
friction; retyping the password is the point. That also gave the browser suite a
deterministic signal — the cleared field is how a test knows a rejection landed,
without which a second attempt fills the fields before the clear arrives and
leaves the button disabled forever. Which it did, once.

**`deployment.md` also specified gating `/*`** so an unauthenticated visitor got
the form instead of downloading the client. That cannot be built. A Bun route
handler can return a `Response` but not an `HTMLBundle` — tested, not assumed:
returning the bundle from a handler serves Bun's "Welcome to Bun!" placeholder.

It matters less than it reads. The repository is public, so the bundle was never
a secret; what the gate was really protecting was a visitor's experience, and
that is preserved by the client leaving for `/login` the moment its first request
comes back `401`. The bundle loads and is immediately abandoned.

`GET /api/status` is one of three endpoints before the gate. It answers three questions
that all have to be answerable without a session — is the process up, which build
is it, what does it think today is — and it is what CI's post-deploy smoke test
will ask instead of a Fly health check.

---

## Caching, compression, and what Bun will not do

`Cache-Control: no-store` on **every API response, errors included**. This matters
more with accounts than it did without them: the bodies are one person's tasks,
moods and journal, and Fly terminates TLS in front of the app. Without it an
intermediary is entitled to hold a response and hand it to the next request —
which could now be somebody else. Nothing here is cacheable in any useful sense
anyway; every view is derived per request and changes on every tick.

**Bun cannot be configured to compress, and cannot be given a `Cache-Control` for
its bundled assets.** Checked against the type definitions rather than assumed:
`Bun.serve`'s only bundler-adjacent option is `development`, which controls HMR,
console streaming and devtools. There is no compression setting and no static
header setting.

Measured against `NODE_ENV=production`:

| | |
|---|---|
| Client JS | 269,163 bytes, minified, React's production build |
| The same bytes gzipped | 85,470 |
| `Content-Encoding` when asked for gzip | none |
| `ETag` | present |
| `If-None-Match` revalidation | **304** |
| `Cache-Control` | none |
| Sourcemap | external, 630 bytes — negligible |

**This corrects a claim made during the deployment review.** That review said a
returning visitor re-downloads the bundle every time. They do not: Bun sends an
ETag and honours `If-None-Match` with a 304, so a repeat visit costs one round
trip and no body. What the missing `Cache-Control` costs is that round trip, on
every asset, on every page load — which on a machine that sleeps can mean waking
it up to be told nothing changed.

The bundle is already about as small as it gets without removing a dependency: it
is minified, it links React's production build, and its sourcemap is a stub.

### What is deliberately not being done

Serving the assets ourselves — pre-building with `Bun.build`, which exposes the
output files and their headers, then handing them back with gzip and
`Cache-Control: immutable` — would fix both. It would also add the build step
`design/tech-stack.md` spent a paragraph avoiding, to save a round trip that
already returns 304 and nothing else.

**The question is whether Fly Proxy compresses on the way out, and that cannot be
answered from a laptop.** So it stays open until there is something deployed to
measure. If Fly compresses, this costs nothing and the note is just a record. If
it does not, 184 KB a cold visit is a real number to weigh a build step against —
but it is a number worth having before writing the code, not after.

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

The fixture gained one option, and it is the inverse of what it first had:
`test.use({ signedIn: false })`, set only by `auth.spec.ts`, because arriving
without a session is precisely what that file is about. Everywhere else the
session is simply there.

### One harness bug this surfaced

The readiness probe waited for `/api/day` to return `ok`, which with auth on is
`401` forever. It now probes `/api/status`, which is also where it reads the
date from — so no test computes a date the server did not give it.
