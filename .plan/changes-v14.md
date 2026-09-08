# v14 — Account settings

A signed-in person can change their own timezone and their own password, from
inside the app.

This finishes machinery that already exists rather than adding a capability.
v11 put a `timezone` column on `users`; v13 let a claiming user choose one. But
[`claimAccount`](../src/server/auth.ts) is the only code that has ever written
that column, so the value is write-once — and user 1 (`owner`, created by
migration 0003 with a password set later by `user:add`) never passed through a
claim form at all. They hold the schema default, `America/New_York`, having
never been asked.

That is correct today only by luck. It is wrong the moment anyone is set up with
`user:add` instead of `user:invite`, or travels, and the failure mode is the one
v11 existed to kill: a day that rolls over at the wrong hour.

Changing a timezone rewrites nothing. Completions are stored as date strings, so
a new zone only changes what `today()` returns from then on. There is no
migration and no backfill.

---

## Decisions

**A password change re-issues the cookie.** The session cookie is
`<user_id>.<expiry-ms>.<hmac>`, and the HMAC key is the user's own password
hash. Changing the hash therefore invalidates every cookie that user holds —
including the one making the request. The response to a successful password
change carries a fresh `Set-Cookie` built from the updated row, so the device
that made the change stays signed in and every other device is signed out. That
is the correct meaning of a password change, and it costs nothing:
`sessionCookie(user)` already takes the row.

**Changing a password requires the current one.** Without it, a borrowed
unlocked browser is a permanent account takeover. `Bun.password.verify` against
the stored hash, the same call `signIn` makes.

**Changing a timezone does not.** It is not a security-relevant field, and
asking for a password to correct a clock is friction that buys nothing.

**Two write routes, not one.** Because the two operations have different rules, one
endpoint would have to branch on which fields arrived and apply the
current-password requirement conditionally. Two endpoints each carry one job and
one validation, which is how `/api/login`, `/api/claim` and `/api/logout`
are already shaped.

**Not the command bus.** `runCommand` reads the clock once per command as
`today(viewer.timezone)` and passes it down. A `set_timezone` command would
consume a clock reading derived from the very value it is about to replace. The
bus is for task and day-record data; an account is not that.

---

## Server

Three new routes, all below the gate in `routes.ts` — the point where `user` is
resolved and a missing cookie becomes a 401. Everything above it is ungated:
`/api/status`, `/api/login`, `/api/claim`, `/api/logout`. These are not.
`changePassword` takes the resolved row, which is already threaded through
everything below that line.

| | |
|---|---|
| `GET /api/account` | `{ username, timezone }` |
| `POST /api/account/timezone` | `{ timezone }` → `204`. Rejects anything `isTimezone` does not accept. |
| `POST /api/account/password` | `{ current, next }` → `204` plus a fresh `Set-Cookie`. Rejects a wrong `current`, and a `next` shorter than `MIN_PASSWORD`. |

The `GET` is needed because nothing currently exposes either field: no view
payload carries the viewer's timezone or username, so without it the settings
form has nothing to prefill and no way to say who you are signed in as. It is a
route rather than a field added to `/api/day` because account data does not
belong in a task view, and History would not carry it.

The `GET` needs no helper: `routes.ts` already holds the resolved row and can
answer from it. The two writes go in `auth.ts` beside `claimAccount`, which
already does the hash-and-write half of the password path:

- `setTimezone(db, userId, zone)` — validate, update, done.
- `changePassword(db, user, current, next)` — verify `current`, hash `next`,
  update, return the updated row so the route can mint a cookie from it.

`MIN_PASSWORD` stays the single definition of long enough, now used by three
callers: the CLI, `/api/claim`, and this.

The login lockout (`FAILURE_LIMIT`, `LOCKOUT_MS`) is not extended to these
routes. It exists to blunt guessing at the sign-in door, where the attacker has
no session. Here they already hold one, and the current-password check is not
the thing standing between them and the account.

---

## Client

### A top bar

The bottom nav is replaced by a bar across the top holding the same two tabs,
plus a menu.

| | |
|---|---|
| Left | `Day` and `History`, the existing tabs, unchanged in behaviour |
| Right | a menu button opening `Settings` and `Sign out` |

The trade, recorded because it is real: this app is ticked throughout the day on
a phone, and a fixed bottom bar sits under the thumb in a way a top bar does
not. It is accepted here because there are two tabs and switching between them
is rare — the Day view is where the app is used. If that stops being true, the
tabs can move back down and the menu can stay up.

The menu is a plain conditional render — not the native `popover` attribute.
Popover support is one of the engine differences the WebKit projects exist to
catch, and this does not need it.

### A Settings view

A third view beside `Day` and `History`, reached only from the menu, holding two
independent forms:

- **Timezone** — the same `<select>` the claim form uses, prefilled from
  `GET /api/account` rather than from the browser's guess, because here the
  stored value is the thing being corrected.
- **Password** — current, new, and the same `MIN_PASSWORD` rule the claim form
  states.

Each saves on its own. Nothing is a single "save settings" button, because the
two carry different requirements and a shared button would imply otherwise.

### What moves and what goes

| | |
|---|---|
| `main.tsx` | `Tab` gains `settings`; the bottom `<nav>` becomes the top bar |
| `styles.css` | `.nav` becomes the top bar; `.app` bottom padding moves to the top, where the reserved space now is |
| `day.css` | `.day-fab` bottom offset loses the term that cleared the old nav; `.day-signout` is deleted |
| `Day.tsx` | the sign-out block and the `logout` import go — the menu owns it now |
| `views/Settings.tsx` | new |
| `api.ts` | `getAccount`, `setTimezone` and `changePassword` beside `logout` |

Sign out currently lives inside the Day view, which means it cannot be reached
from History. Moving it into the menu fixes that and removes a one-off, rather
than adding a second one.

---

## Accessibility

v12 closed WCAG 2.2 A and AA, and a disclosure menu is the usual place that
regresses. The menu button carries an accessible name and `aria-expanded`;
`Escape` and a click outside both close it; focus returns to the button on
close. Targets stay at `--tap` (44px), above the 24×24 of SC 2.5.8. The two
forms get labelled fields and errors announced the way the claim form's are.

---

## Tests

| | |
|---|---|
| Unit | `setTimezone` rejects a bad zone; `changePassword` rejects a wrong current and a short next; a changed password stops the old cookie verifying and the returned row mints one that does |
| Browser | the settings form prefills with the STORED zone, not the browser's — run under an emulated zone that differs from it, or the test passes for the wrong reason; change a timezone and see the Day view's date follow; change a password, stay signed in, and sign in again with the new one; the menu opens, closes on `Escape`, and returns focus |

The browser suite signs in already, so these need no new fixture.

---

## Not in this iteration

- **`user:list`.** The database is readable directly, and an admin surface is a
  larger question than a CLI verb.
- **Changing a username.** It is the login identifier and nothing asks for it.
- **Per-user moods.** Still global, still fine.
- **Backups, cold start, Bun 1.4.** Unchanged and still deferred.
