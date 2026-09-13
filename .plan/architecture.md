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

**Done is a field, not an address.** `DayTask.is_done` decides how a row renders
rather than which array it arrives in — membership of today is the same union of
four independent rules it has always been, and doneness only ever adds to it.

**Placement bounds.** A date may be set from today to the later of this Saturday
or the end of the task's own period. A one-off has no far edge.

`src/server/period.ts` holds all of it: `addDays`, `periodKey`, `periodStart`,
`periodEnd`, `effectiveDate`, `isDone`, `isUnplaced`, `isOverdue`,
`completionForPeriod`.

**Ordering** is two functions, deliberately not one.

`sortTasks` orders the To do list: **done** last whatever else is true of it,
then baseline, then the day's own arrangement from `days.task_order`, then
category (uncategorised last), then name. Done outranks baseline because a
struck-through row at the top is not what "the bare minimum to function" should
look like.

`byBand` orders a backlog group: overdue, placed, unplaced, done — then baseline,
category, name. It has bands the To do list does not want and no `task_order`,
which is the whole point of the other one. Folding them would produce one
function taking flags to switch off half of itself.

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
| `GET /api/day` | `DayView` — one `tasks` array, done last, plus the week's panes |
| `GET /api/todo` | `TodoView` — all six cadence groups, one-off first |
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
  TaskEditor.tsx     the editor, opened from a To do row's Edit button and from a backlog row's name
  styles.css         tokens and primitives, including .track and .pane
  icons/             generated favicons
  views/
    day/             Day.tsx, TaskRow, DayStrip, GroupStrip, PagedTrack, UpcomingPane, CaptureSheet, DragBand, MoodAndLog
    Todo.tsx         the Backlog track
    History.tsx      the Tracker grid
    Login.tsx        the signed-out surface
    Claim.tsx        spending an invitation
    Settings.tsx     your own timezone and password
```

The server derives everything. The client renders arrays that arrive already
ordered and sectioned, posts named commands, and refetches. It never sorts,
filters, or computes a period. It never asks what day it is — every view model
carries its own date.

### The shell

A fixed top bar carries the two tabs — **To do** and **Tracker** — and an account
menu. The labels are not the keys: the tabs are keyed `day` and `history`, which
name the view models, the routes and the files. "Day" stopped being a day in v8,
when the rest of the week became panes beside it; renaming through the stack
would have been a rename of everything to change two words on screen.
The menu holds Settings and Sign out, so both are reachable from every view. It
is `ui.tsx`'s `Popover`, which closes on `Escape` and on a pointer landing
outside; the shell returns focus to the menu button.

### To do

The doing surface, and the only task surface. A horizontal track of panes: today
first, then the remaining days of this week. Only today's pane can be ticked. It
fetches two models, its own and `/api/todo`.

**One list, not two.** `DayView.tasks` is a single array with done sunk to the
bottom, and a completed row stays in place, struck through, rather than moving to
a section of its own. The section was a third way of saying what the tick and the
strike-through already said, and it split the answer to "what is left?" across
two places. The list's region takes its name from its own `<h2>`, so the visible
name and the accessible one cannot drift apart.

**The tick is predicted.** A row holds the done state the person asked for until
the model agrees, so the box moves on the tap rather than after the round trip.
The command is chosen from what is on screen, not from the model — otherwise a
tap on a visibly-checked box re-sends `complete` and the undo is lost. Only the
box is predicted; the re-sort waits for the refetch, or the row would leave from
under the finger that tapped it. With `orderIds` this is one of exactly two
things the client holds that it did not derive from a model.

A row shows a tick, a name, a left stripe (border grey, overdue colour, or a
baseline task's own colour), and an Edit button. Overdue and future rows also
offer a day picker and an unplan.

Reorder is a modal state holding a locally rearranged id list; drags cannot cross
the baseline boundary because each band is its own drag context. Move to top and
send to bottom go through the same reorder a drag does, so they obey the bands
for free. The saved order is the whole rendered list, done ids included — sending
only the live half would drop their positions, since `sortTasks` arranges the
done band by the same `task_order`.

The mood and the log sit behind a button on the date heading that wears the
selected mood. They are a once-a-day gesture and were taking permanent space on a
screen used all day. A dirty log draft is committed when the sheet closes, by any
route — dismissal has always meant commit here, because the textarea saves on
blur.

### Backlog

The complete inventory, under one heading, as a track of six panes paged by a
strip: **Any time**, Daily, Weekly, Monthly, Quarterly, Yearly. Same mechanics as
the week's days — `usePagedTrack` and `Track` are shared, the buttons are not,
because a day button marks today and disables the days already past while a group
button does neither.

"Any time" is the label on `cadence: null`; the model still calls it a one-off.
**Backlog** names the whole track, which is also where *Reset to backlog* lives —
the one control that clears every overdue day. It counts every group and now sits
on the only heading that names them all, which it did not before.

### Tracker

A grid of days by task. Read-only. Pages backwards in blocks, up to 365 at a
time. The one view that opts out of `.app`'s 720px reading width, because a grid
of days by task is the one screen here that is better wide.

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
| `tests/sort.test.ts` | the two ordering functions |
| `tests/views.test.ts` | the view builders, against a real database |
| `tests/commands.test.ts` | what commands write |
| `tests/isolation.test.ts` | that one user never sees another's data |
| `tests/auth.test.ts` | claiming an invitation, and changing your own zone or password |
| `tests/harness.ts` | a temporary migrated database per test |

`bun test` runs 208. Each suite names its own timezone rather than inheriting the
process's.

Playwright runs 620 across four projects — `mobile` and `desktop` on Chrome,
`mobile-webkit` and `desktop-webkit` on WebKit. Every test gets its own server
process and its own database file; the fixture signs in over HTTP. WebKit cannot
run on macOS 14, so `bun run e2e` is Chrome only and `bun run e2e:docker` runs
the WebKit half in Linux.

**Coverage moves with the weekday**, because both suites run against the real
`today()`. `views.test.ts` gates twelve tests on what day it is, and `day.spec.ts`
skips six on a Saturday — when `placeable_dates` is one date, so there is no
future pane to assert against. On a Saturday that is 40 of the browser suite's
620. v16 closes it by giving a Saturday somewhere to page to.

A note on what the browser suite can and cannot see. It addresses roles and
accessible names, which is why the backlog strip shipped with no CSS at all —
306px tall, bulleted, vertically stacked — through a fully green run. The few
assertions that bound geometry rather than semantics are there for that reason,
and are worth adding to rather than trusting the count.

---

## Accessibility

WCAG 2.2 Level A and AA. Every foreground/background token pair meets 4.5:1 for
text and 3:1 for interface elements, in both the light and dark themes.
`--border-control` is the boundary colour for controls; `--border` is decorative
and not held to 3:1. `:focus-visible` is styled globally. Interactive targets are
`--tap`, 44px.

---

## What is deliberately not here

**Reading or writing a day that is not today.** Every view is anchored to
`today(zone)`, no endpoint takes a date meaning "the day to render", and no
command writes to one. v8 settled the read half when it added the week's panes,
and the reasoning is worth keeping because it is easy to relitigate: *"There is
no `?date=` parameter and `GET /api/day` still means today: the same-day-only
rule protects WRITES, and it does that in commands.ts, so a read parameter was
never what it guarded against."*

v16 is the two halves of moving past that, kept together:

- **Paging To do into future weeks.** The strip gains week stepping and
  `/api/day` learns to answer for a week that is not this one, while `date` stays
  today and every write still lands on today. Forward only — the past belongs to
  the Tracker. This is what closes the Saturday hole above.
- **Editable Tracker cells.** A dated completion command, bounded to daily tasks
  and to dates not in the future. The grid shows only `cadence: 'day'` tasks,
  whose period is exactly one day, so a dated completion carries no period
  ambiguity — which is what makes it narrow enough to be worth doing. It retires
  "the Tracker is read-only" and puts a clause on *the history records when
  things were marked*.

**A cancel on the log.** Dismissal commits, by every route, because the textarea
has always saved on blur. Giving it a real abandon needs an explicit Discard or a
confirm on clearing, and it would have to apply to blur too or it is inconsistent
again. Worth doing on its own terms, not as a side effect.

**Per-user moods, a mood editor, an export UI.** Unchanged and still deferred.
