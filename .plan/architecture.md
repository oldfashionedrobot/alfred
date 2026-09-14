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

Every command that writes `planned_date` applies it — `place`, `create_task`,
`create_tasks` and `update_task` — through one `placementFits`. It lived in
`place` alone until v16, which meant the editor's save could put a weekly task
six months out, where `effectiveDate` (backward-only) would never roll it back
and the task would sit un-overdue, un-unplaced and un-done until the day arrived.

A period can also shrink out from under a date nobody touched: the editor always
sends `cadence` and only sends `planned_date` when the day chip changed, so
narrowing a one-off placed months out to weekly arrives as a cadence and no date.
That date is **cleared**, not refused — it stopped meaning anything, exactly as a
daily task's does, and a rejection would point at a field the person never
edited.

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
| `GET /api/day` | `DayView` — one `tasks` array, done last, plus one week's panes. `?week=YYYY-MM-DD` chooses the week, forward only; `date` and `tasks` are still **today's** whatever is asked for. |
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
`set_task_order`, `set_completion`.

`runCommand` takes a `Viewer` — `{ id, timezone }` — reads the clock once, and
passes that date down. `loadTask` is the single point where ownership is
enforced; a task belonging to somebody else is a 404.

**Completing is a thing you do today.** `complete` and `uncomplete` take no date
and land on the viewer's today. That is enforced rather than described: both call
`onlyFields(b, ['task_id'])`, so handing them a date is a 400 and stays one
without anybody remembering to keep it so.

**Correcting is a different gesture.** `set_completion { task_id, date, done }`
is the one command that names a day, reachable from the Tracker grid and nowhere
else. It is bounded to daily tasks — whose period *is* that one day, so a dated
completion cannot retroactively satisfy a week or a quarter — and to dates that
have already happened.

It refuses to fill a cell on an archived task and allows one to be emptied,
following `complete` and `uncomplete` respectively for the half it matches: the
grid draws only active dailies, so a completion written against an archived task
would land on a column nothing renders.

The overlap on today is deliberate. Folding the two together would give the
everyday tick a date parameter, and a client that can name the day is what the
same-day rule exists to prevent.

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

The doing surface, and the only task surface. A horizontal track of panes, and a
strip that pages them. It fetches two models, its own and `/api/todo`.

**It pages forward, as far as you have scheduled.** `DayView.panes` is the viewed
week's panes — today through Saturday in this week, all seven in a later one —
and `last_placed` is the furthest date anything is placed on, which is where
`next` stops. You can always reach everything you have scheduled and never page
past the end of it. Empty weeks in between are reachable and have to be: a strip
that skipped to the next week with something in it would be worse than an empty
one.

Today's pane exists only in the week that contains today, which is what keeps
**only today can be ticked** true without a flag anywhere. Placement does not
follow the paging: `placeable_dates` and `placement` stay bounded from today, so
a weekly task can never be given a day outside its own week.

Paging is forward only. The past belongs to the Tracker, which already shows
every day of it.

The viewed week is client state, and three things depend on it: the fetch, the
refetch after a command — without which an unplan from a later pane bounces the
view home — and where the track lands when a week arrives. `usePagedTrack` reads
its index back off `scrollLeft`, so a week change scrolls explicitly, and
`stepPane` measures the track rather than reading that index: a click landing
mid-scroll would otherwise step from the pane being left, which at a week's edge
is the difference between one pane back and one week back.

A swipe cannot cross a week. The track snaps and contains its overscroll, so the
gesture stops at the last pane — weeks are the arrows' job, days are either's.

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

Commands for one row are **ordered**: two taps send two commands, and unordered
they race, so an `uncomplete` can land before the `complete` it was undoing.

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

A grid of days by task, paging backwards in blocks of up to 365. The one view
that opts out of `.app`'s 720px reading width, because a grid of days by task is
the one screen here that is better wide. Cells are square — a pattern needs its
marks the same shape — and the table sizes to them rather than stretching them.

**A record you can correct.** A cell is a checkbox INSIDE the `<td>`, never the
`td` itself: a cell carrying `role="checkbox"` stops being a grid cell and loses
the row and column position that is the only thing making it mean anything. Its
name carries both coordinates.

Cells predict like the ticks do, keyed by **cell** rather than by task — the same
task is on every row — and by the CLICK rather than by the value, since three
quick clicks on one cell are on, off, on and a value cannot tell its own repeat
apart. Commands for one cell are ordered, for the reason the ticks are.

**A corrected cell does not refetch, and that is a deliberate exception to the
data rule.** Everywhere else the client posts a command and refetches the view
wholesale. This is the one screen that ACCUMULATES: `loadEarlier` concatenates
older pages onto what is already there, so refetching the first page would throw
away everything somebody had paged back through. The one row that changed is
patched instead. The write is the narrowest in the system — one task, one date —
so there is nothing else a refetch would have said.

Editing a cell costs something, and it is worth naming: the history recorded when
things were **marked**, and a corrected cell is now indistinguishable from one
marked on the day. That fidelity is only ever lost deliberately, by somebody
going to the grid; the everyday tick still cannot name a day.

Moods and logs are not editable here. Only the cells are.

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

`bun test` runs 234. Each suite names its own timezone rather than inheriting the
process's.

Playwright runs 636 across four projects — `mobile` and `desktop` on Chrome,
`mobile-webkit` and `desktop-webkit` on WebKit. Every test gets its own server
process and its own database file; the fixture signs in over HTTP. WebKit cannot
run on macOS 14, so `bun run e2e` is Chrome only and `bun run e2e:docker` runs
the WebKit half in Linux.

**The suite runs with reduced motion emulated.** The day track scrolls smoothly,
and a test that waits out an animation ends up measuring the animation — five
different waits were tried against it before the question became whether the
animation should be running at all. It should not, for anybody who has asked for
less motion, and the app honours that. One test opts back in, because the smooth
path is what most people get.

**Coverage still moves with the weekday**, because both suites run against the
real `today()` — but far less than it did. `views.test.ts` gates six tests on what
day it is, down from twelve: a builder that takes a week can be handed a future
one outright instead of waiting for the calendar. `day.spec.ts` gates four, down
from eight.

The gates that remain are the ones paging cannot supply: a day EARLIER this week,
which forward paging never reaches; the strip carrying today's mark and the
showing mark at once, which needs today and another day in one week; and
reordering, which is today-only, so proving the track is frozen needs today's
pane and somewhere it is refusing to go.

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

**One documented exception**, in the Tracker: a cell is 26px square. Enlarging it
is not the answer, because square means the row height follows the width — 44px
cells would make a sixty-day grid 2,640px tall against 1,560px, and reading a
month at a glance is what the grid is for. WCAG 2.2 AA asks 24×24 (SC 2.5.8) and
26 clears it; 44 is this repo's own stricter convention for controls you hit with
a thumb, which a grid you read is not.

`prefers-reduced-motion` is honoured: the day track's scroll and the app's
transitions both flatten under it.

---

## What is deliberately not here

**Writing to a day that is not today, except one narrow way.** `today(zone)` is
the only clock read, and `complete`, `uncomplete`, `place` and the rest take no
date — `onlyFields` makes sure of it. `set_completion` is the single exception,
bounded to daily tasks and to days that have already happened, and reachable only
from the Tracker grid.

The read side was never the rule, and v8 said why when it added the week's panes.
It is worth keeping because it is easy to relitigate: *"There is no `?date=`
parameter and `GET /api/day` still means today: the same-day-only rule protects
WRITES, and it does that in commands.ts, so a read parameter was never what it
guarded against."* `?week=` followed that reasoning; `date` and `tasks` are still
today's whatever week is asked for.

**Paging To do backwards.** Forward only. The Tracker already shows every past
day and now lets you correct one, so a read-only pane that refuses every gesture
would be a second way to look at a day you can already see.

**Correcting anything but a daily task's cell.** A weekly task satisfied once
covers seven cells, so a row of them would stop meaning one thing per cell. The
grid shows daily tasks, whose period is exactly one day, and that is what makes
the dated write narrow enough to be safe.

**Correcting a past mood or log.** They live in `days`, keyed differently, and
nothing has asked for it.

**Recording that a completion was corrected.** A corrected cell is
indistinguishable from one marked on the day. Storing both dates means a column
on `completions`, a migration, and a second meaning for every existing row, to
answer a question nobody has asked.

**A cancel on the log.** Dismissal commits, by every route, because the textarea
has always saved on blur. Giving it a real abandon needs an explicit Discard or a
confirm on clearing, and it would have to apply to blur too or it is inconsistent
again. Worth doing on its own terms, not as a side effect.

**Per-user moods, a mood editor, an export UI.** Unchanged and still deferred.
