# alfred — Architecture

A household task tracker. One Bun process serves a JSON API and a React client
bundled from HTML at request time. Data is SQLite, reached through libSQL.

This document describes what the system is now. Deployment is in
[`deployment.md`](deployment.md).

---

## Stack

| | |
|---|---|
| Runtime | Bun 1.3.14 |
| Server | `Bun.serve` — routes for `/api/*`, an HTML import for everything else |
| Client | React 19, no router, no state library, no component library |
| Bundling | `Bun.serve` builds the client from `src/client/index.html` on first request. No build step. |
| Database | libSQL (`@libsql/client`) with Drizzle ORM on `sqlite-core` |
| Drag and drop | `@dnd-kit` |
| Tests | `bun test` for units, Playwright for browsers |

---

## Data model

Five tables.

### `users`

| Column | |
|---|---|
| `id` | integer, autoincrement |
| `username` | text, unique. Looked up lowercased. |
| `password_hash` | argon2id via `Bun.password`. Empty string means the account cannot be signed into. |
| `active` | boolean. False refuses sign-in. |
| `timezone` | IANA name, default `America/New_York`. Decides when this user's day rolls over. |
| `claim_token` | 32 random bytes as hex, or null. An unspent invitation. |
| `claim_expires` | epoch ms, or null. |

### `tasks`

| Column | |
|---|---|
| `id` | integer, autoincrement |
| `user_id` | owner. Indexed. Every query filters on it. |
| `name` | text |
| `is_baseline` | boolean. Sorts above everything else. |
| `cadence` | `day` \| `week` \| `month` \| `quarter` \| `year`, or **null for a one-off** |
| `planned_date` | `YYYY-MM-DD`, or null. The day this is placed on. |
| `color` | `#rrggbb`, or null. Rendered only for baseline tasks. |
| `category` | free text, or null. Matched exactly; clusters rows inside a group. |
| `active` | boolean. False is archived. |

### `completions`

`task_id` + `completed_on`, and nothing else. The pair is the primary key, so
completing twice on one date is a no-op. `completed_on` is indexed.

### `days`

One row per user per day: `user_id` + `date` as a composite primary key, plus
`mood` (a foreign key to `moods.slug`), `log` (free text), and `task_order` (a
JSON array of task ids).

### `moods`

`slug` (primary key), `emoji`, `label`, `sort_order`, `active`. Global — every
user picks from the same set. Edited directly in the database; there is no mood
editor in the app.

### Dates

Every date column is a `YYYY-MM-DD` string. No times are stored anywhere. The
only instants in the system are the session cookie's expiry, the login lockout,
and `claim_expires`, all epoch milliseconds.

---

## Derivation

Nothing about a task's state is stored. All of it is computed on read.

**Periods.** A cadence names a period: day, week, month, quarter, year. Weeks run
Sunday to Saturday. A null cadence is a one-off, whose period is unbounded.

**`effective_date`** is the placed date if it still falls inside the task's
current period, and null otherwise. It is what every screen shows. `planned_date`
is the stored column and may hold a date that has fallen out of its period.

**Done** means the current period is satisfied — there is a completion inside it.
A weekly task ticked on Monday is done for the rest of that week.

**Overdue** means placed on a date now past, within the current period, and not
done. Daily tasks are never overdue: they are on every day, so there is nothing
to catch up.

**Unplaced** means a recurring task with no effective date this period.

**Placement bounds.** A date may be set from today to the later of this Saturday
or the end of the task's own period. A one-off has no far edge.

`src/server/period.ts` holds all of it: `addDays`, `periodKey`, `periodStart`,
`periodEnd`, `effectiveDate`, `isDone`, `isUnplaced`, `isOverdue`,
`completionForPeriod`.

**Ordering** is one function, `sortTasks`: baseline first, then category
(uncategorised last), then name.

**Today** is `today(zone)` in `src/server/today.ts`, the only place a date is read
from the clock. It takes the viewer's timezone.

---

## Server

```
src/server/
  index.ts       Bun.serve: /api/* to the router, /* to the bundled client
  routes.ts      the whole HTTP surface
  auth.ts        argon2id, session cookie, lockout, invitations
  commands.ts    every write
  schema.ts      drizzle tables
  db.ts          libSQL connection, migrations, mood seed
  period.ts      period derivation
  sort.ts        the one ordering function
  today.ts       the only clock read for a date
  errors.ts      ApiFailure and its subclasses
  user-cli.ts    account management
  views/         one builder per screen
```

`src/shared/types.ts` is the contract both sides import: the wire types, the
validators, and `MIN_PASSWORD` — the one definition of how long a password has to
be, which the server enforces and both forms state.

### The API

Four ungated endpoints:

| | |
|---|---|
| `GET /api/status` | `{ ok, sha, database }` — `database` is `local` or `replica` |
| `POST /api/login` | `{ username, password }` → session cookie |
| `POST /api/claim` | `{ token, password, timezone }` → spends an invitation, returns a session cookie |
| `POST /api/logout` | clears the cookie |

Everything below requires a session. `currentUser` is the only place a request
becomes an identity.

| | |
|---|---|
| `GET /api/day` | `DayView` |
| `GET /api/todo` | `TodoView` |
| `GET /api/history` | `HistoryView`, accepting `limit` (max 365) and `before` |
| `POST /api/commands/<name>` | `{ ok: true }` |
| `GET /api/account` | `{ username, timezone }` — the two fields no view payload carries |
| `POST /api/account/timezone` | `{ timezone }` |
| `POST /api/account/password` | `{ current, next }`, and a fresh session cookie |

There is no CRUD. A client gets data because a view renders it. Anything
unrecognised — unknown path, or known path with the wrong method — is a 404.
Every response carries `cache-control: no-store`.

### Commands

`complete`, `uncomplete`, `place`, `unplan`, `reset_overdue`, `create_task`,
`create_tasks`, `update_task`, `archive_task`, `set_mood`, `set_log`,
`set_task_order`.

`runCommand` takes a `Viewer` — `{ id, timezone }` — reads the clock once, and
passes that date down. `loadTask` is the single point where ownership is
enforced; a task belonging to somebody else is a 404.

No command accepts a date meaning "the day to render", so writes always land on
the viewer's today.

### Auth

A stateless cookie, `alfred_session`, holding `<user_id>.<expiry-ms>.<hmac>`.
The HMAC key is the user's own password hash, so changing a password invalidates
that user's sessions and nothing else. `HttpOnly`, `SameSite=Lax`, `Secure` in
production, 90 days.

Sign-in is refused for an unknown name, a wrong password, an inactive account, or
an empty hash — all with one message. Eight failures locks a name out for 60
seconds, in memory.

An invitation is a `claim_token` with an expiry. `POST /api/claim` spends it,
setting the password and timezone, only if the token matches, has not expired,
the account is active, and the hash is still empty. One message for every failure.

Changing your own password requires the current one: a session alone must not be
enough to take an account over. The response carries a cookie signed with the new
hash, so the device that made the change stays signed in while every other
session that account holds stops verifying. The sign-in lockout does not apply —
it blunts guessing where there is no session, and this caller already holds one.

Changing your own timezone requires nothing but the session. It is not a
security-relevant field, and it rewrites no data: dates are stored as strings, so
a new zone only changes what `today()` returns from then on.

### Accounts

```
bun run user:add <name>       set a password directly (stdin)
bun run user:invite <name>    create unclaimed, print a claim link
bun run user:disable <name>   revoke access, keep the data
bun run user:enable <name>
```

There is no self-registration. `APP_URL` decides what the printed claim link
points at.

Once an account exists, its owner changes their own timezone and password from
the Settings view. Nothing else about an account is editable from the app: a
username is the login identifier, and `active` is an administrative decision.

---

## Client

```
src/client/
  main.tsx           the shell: signed-in state, top bar, tab, and the /claim route
  api.ts             typed fetch, the client's only I/O
  dates.ts           date formatting and calendar arithmetic on strings
  zones.ts           the IANA zone list, for the two forms that offer one
  ui.tsx             NoticeBar, Tick, Popover, DayPicker, Confirm, Sheet, placementMaxFor
  TaskFields.tsx     the task definition fields
  TaskEditor.tsx     the editor, opened from Day rows and from the panel
  styles.css         tokens and primitives
  icons/             generated favicons
  views/
    day/             Day.tsx, TaskRow, DayStrip, UpcomingPane, CaptureSheet, DragBand, MoodAndLog
    Todo.tsx         the Routine and Backlog panels
    History.tsx      the grid
    Login.tsx        the signed-out surface
    Claim.tsx        spending an invitation
    Settings.tsx     your own timezone and password
```

The server derives everything. The client renders arrays that arrive already
ordered and sectioned, posts named commands, and refetches. It never sorts,
filters, or computes a period. It never asks what day it is — every view model
carries its own date.

### The shell

A fixed top bar carries the two tabs — Day and History — and an account menu.
The menu holds Settings and Sign out, so both are reachable from every view. It
is `ui.tsx`'s `Popover`, which closes on `Escape` and on a pointer landing
outside; the shell returns focus to the menu button.

### Day

The doing surface, and the only task surface. A horizontal track of panes: today
first, then the remaining days of this week. Only today's pane can be ticked.

Day fetches two models, its own and `/api/todo`, and hosts the Routine and
Backlog panels — one component rendered twice over the same model.

A row shows a tick, a name, a left stripe (border grey, overdue colour, or a
baseline task's own colour), and an Edit button. Overdue and future rows also
offer a day picker and an unplan.

Reorder is a modal state holding a locally rearranged id list; drags cannot cross
the baseline boundary because each band is its own drag context.

### To do

The complete inventory, grouped by cadence: Today, This week, This month, This
quarter, This year, One-off. **Routine** draws the five recurring groups and
**Backlog** the one-off group.

### History

A grid of days by task. Read-only. Pages backwards in blocks, up to 365 at a time.

### Settings

Two independent forms, each saving on its own, because they carry different
requirements. The timezone select is prefilled from `GET /api/account` rather
than from the browser: the stored value is the thing being corrected, so offering
the device's guess would hide the mismatch the form exists to fix.

---

## Tests

| | |
|---|---|
| `tests/period.test.ts` | period derivation and `today(zone)` |
| `tests/sort.test.ts` | the ordering function |
| `tests/views.test.ts` | the view builders, against a real database |
| `tests/commands.test.ts` | what commands write |
| `tests/isolation.test.ts` | that one user never sees another's data |
| `tests/auth.test.ts` | claiming an invitation, and changing your own zone or password |
| `tests/harness.ts` | a temporary migrated database per test |

`bun test` runs 198. Each suite names its own timezone rather than inheriting the
process's.

Playwright runs 588 across four projects — `mobile` and `desktop` on Chrome,
`mobile-webkit` and `desktop-webkit` on WebKit. Every test gets its own server
process and its own database file; the fixture signs in over HTTP. WebKit cannot
run on macOS 14, so `bun run e2e` is Chrome only and `bun run e2e:docker` runs
the WebKit half in Linux.

---

## Accessibility

WCAG 2.2 Level A and AA. Every foreground/background token pair meets 4.5:1 for
text and 3:1 for interface elements, in both the light and dark themes.
`--border-control` is the boundary colour for controls; `--border` is decorative
and not held to 3:1. `:focus-visible` is styled globally. Interactive targets are
`--tap`, 44px.
