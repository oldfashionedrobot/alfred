# Household Tracker — Changes v13

Continues [`changes-v12.md`](changes-v12.md).

**BUILT.** A way for a second person to get an account without you typing their
password for them.

---

## Claim-by-token, and no email

**The problem.** Adding somebody today means running `user:add` with their
password on stdin — so you choose it, you see it, and you have to get it to them
somehow. That is fine for `owner` and wrong for anybody else.

**What is already there.** `user:add` creates a user with an *empty*
`password_hash`, and `authenticate` treats that as un-signin-able:

```ts
if (!user || !user.active || user.password_hash === '') return null
```

That is an unclaimed account, and it is how `owner` shipped: the migration created
it empty and it was claimed afterwards. This formalises something the system
already does rather than inventing a state.

### The design

**`bun run user:invite jess`** creates an unclaimed account, generates a token, and
prints a URL:

```
https://alfred.goodghost.com/claim?t=8f3c…
```

**You deliver it.** Text it, hand over the phone, read it out. She opens it, sets
a password, and the token is spent.

**`user:add` is unchanged** and stays what it is: set a password directly, for
yourself, from a laptop with the credentials.

### Why the token and not a username

A first draft of this had the claim form take a *username*, on the reasoning that
an unclaimed name is one only you know. **That is security through obscurity and
it fails on the first guessable name — `jess` is guessable.** Anyone who reached
the form could claim an account that was waiting.

The token fixes that properly: 32 random bytes, single-use, time-limited. And it
removes a second problem for free — **there is no username field to probe**, so
the claim form cannot be used to find out who has an account. `authenticate`
already goes to some trouble to give one answer for every failure precisely so
names cannot be enumerated; a username-based claim form would have undone that.

### Why no email

Email is **delivery**, not security. The token does the security work whichever
way it travels, and for this app email is the most expensive way to move it:

| | |
|---|---|
| Provider | Resend's free tier is 3,000/month; this would send perhaps three, ever |
| DNS | SPF and DKIM on `goodghost.com`, plus DMARC, which Gmail, Outlook and Yahoo increasingly require or filter |
| Secrets | An API key in Fly |
| Failure mode | The mail does not arrive and she is stuck, with nothing to tell you whether it sent |
| Tests | Sending has to be mocked or bypassed |

That is a mail pipeline and a deliverability problem, to hand a link to someone in
the same house. **Handing it over directly is not the cheap compromise — it is
more reliable**, because you can watch it arrive.

If there is ever a user who is not in the house, email becomes a delivery swap
behind the same token rather than a redesign.

### Schema

```
users.claim_token    TEXT     -- 32 random bytes, hex. NULL once spent.
users.claim_expires  INTEGER  -- epoch ms, like the session cookie's expiry
```

Epoch milliseconds rather than the `YYYY-MM-DD` strings used elsewhere, because
this is an instant and not a day — the same distinction `auth.ts` already makes
for cookie expiry and lockout.

### The endpoint

`POST /api/claim` with `{ token, password }`, ungated, beside login and logout.
It succeeds only if **all** of: the token matches a user, it has not expired, and
that user's `password_hash` is still empty. Then it sets the hash, clears the
token, and issues the session cookie — so claiming signs you in, which is the
only reason anybody is on that page.

**One answer for every failure**, as login does. "That link is not valid" covers
expired, spent, wrong, and never-existed. Anything more specific tells an
attacker which of those it was.

**Expiry: 7 days.** Long enough to be handed over at a convenient moment, short
enough that a link left in a message thread stops working.

### Tests

| | |
|---|---|
| unit | claiming sets the hash and clears the token; an expired token is refused; a spent token is refused; a claimed account cannot be re-claimed |
| browser | the flow end to end — invite, open the link, set a password, land signed in |
| isolation | a second claimed user sees their own board and nothing of the first |

The last one is the existing isolation suite, which already covers two users. It
gains nothing new to prove; it should simply keep passing with a user who arrived
this way rather than through `user:add`.

---

## Folded in, because a second person makes them real

### The timezone field lives here

v12 deferred a timezone writer with the trigger *"a second person in a different
zone"*. This is that iteration, and the claim form is a signup form — which is
where a zone gets set, rather than in a settings screen nobody opens.

**The device proposes, the person decides.** The browser knows its own zone from
`Intl.DateTimeFormat().resolvedOptions().timeZone`; the form prefills with it and
she can change it. That keeps v11's rule intact — a day belongs to a person, not
to the device they are holding — while removing the need to choose from 445 IANA
zones by hand.

`users.timezone` already exists and already defaults to `America/New_York`, so
this is a writer for a column that works, not a new concept.

### `user:disable` and `user:enable`

`users.active` exists and `authenticate` checks it, but `user-cli` always writes
`active: true` — so revoking access means hand-written SQL. With one user that is
theoretical. With two it is "turn this off", and it should not require a
database client.

Two commands, and the mechanism is already there.

### The docs stop being true, and say so

`README.md` and [`changes-v9.md`](changes-v9.md) both say *"there is no signup
page and no plan for one."* This adds one.

**The README is updated**, because it describes what is true now.
**`changes-v9.md` is not.** It was true when it was written, and rewriting a
record of what was decided in v9 to match v13 would destroy the thing those
documents are for. It gets a pointer forward instead — the same treatment the
wrong WebKit figure got in v12, and for the same reason.

**The reasoning behind the original rule survives the reversal**, which is why it
is a reversal and not an abandonment: there is still no self-registration. An
account exists only because you made one. What changes is who types the password.

---

## Decided, not built

**Moods stay global.** The `moods` table has no `user_id`, so both people share
one vocabulary and `days.mood` points at a shared slug. That is not an oversight
to fix — it predates accounts entirely — but nobody had ever decided it, and a
second person is when it becomes real.

**Decided: shared is correct here.** A household talking about its days in the
same eight words is a feature, and per-user moods would be a migration, a
per-user seed, and a second editing path for a screen that changes twice a year.
Easy to revisit: it is one column and a backfill if it ever stops being true.

**Cold start stays deferred.** v12's trigger was a guest hitting seven seconds
with no idea why, and a second person is that guest. It is left anyway, because
the fix is `min_machines_running = 1` at ~$2/month and the end of scale-to-zero —
and it is a one-line change on the day it starts to matter. Waiting costs nothing
that cannot be undone in a minute.

---

### Admin runs on the machine, and the footgun it removes

Documenting `user:invite` against production went through three answers before
arriving at the obvious one.

**The first** was to run it from a laptop with `DB_PATH` pointed at a throwaway
replica. That works, and it exposed something worse than the instruction:
`DB_PATH` means two different things — the database without `TURSO_URL`, the
local *replica file* with it. Forgetting it does not corrupt anything, since
libSQL refuses with *"db file exists but metadata file does not"* when the dev
database is there. **But if that file does not exist** — a fresh clone, or after a
reset — it creates a replica of PRODUCTION at `./data/alfred.db`, and the next
`bun run dev` opens the household's real data as the development database.
Silent, and the same shape as the afternoon the test suite spent writing to
production.

**The second** was a third connection mode in `db.ts`: `TURSO_URL` with no
`DB_PATH` meaning a direct connection, no local file at all. It works — it was
built and tested — and it was reverted, because it solved a problem the third
answer does not have.

**The third, and the right one: run it where the data is.**

```sh
fly ssh console -a gg-alfred -C "sh -c 'bun run user:invite jess'"
```

Nothing is passed. The secrets are deployed, `fly.toml` carries `DB_PATH` and now
`APP_URL`, and the write goes through the machine's own replica so it is visible
there immediately. No override to forget, so the footgun above cannot be reached
in the first place.

**`deployment.md` used to recommend the laptop**, on the reasoning that it "does
not care whether the machine is awake, stopped, or deployed at all — you could
run it before Fly exists." True at bootstrap, and stale the moment a machine
existed. That is corrected there, and the laptop keeps `.env.turso` for one
thing only: the pre-deploy boot check, which by definition happens before there
is a machine to run anything on.

One fewer copy of a write token, and it is why `-slim` was chosen over
distroless: `fly ssh console` on an image with no shell is a bad evening.

### What this is not

**Not self-registration.** An account must exist before anything can claim it, and
only you can create one. A stranger at `/claim` with no token has nothing to do.

**Not a password reset.** The guard is that the hash is *empty*, which is a
one-way transition. Resetting a claimed account is still `user:add`, from a
laptop, deliberately.
