# Household Tracker — Changes v10

Continues [`changes-v9.md`](changes-v9.md). Same rules: what changed, why, and
what it cost, including the decisions it reverses.

Two threads. The first is small and was asked for: a faster way to put something
on today's list, and a way to edit a task from the list you are looking at. The
second was not asked for and is the more important entry — the browser suite had
been writing to the **production database**, and the fix that looked obvious did
not work.

---

## Place today, at capture

**What.** The capture sheet has a **Place today** checkbox, and Day's Today
heading has an **Add task** button beside Reorder that opens capture with the box
already ticked. The `+` button is unchanged and leaves it clear.

**Why two entry points that differ by one checkbox.** They are two different
gestures. `+` is for emptying your pockets — a thing you thought of, filed for
later, no date. "Add task" is for the day in front of you. Before this, the
second gesture was capture, then find the row in a panel, then place it: three
steps for the most common thing there is.

**The checkbox governs both One and Many.** It lives in the capture sheet rather
than in `TaskFields`, and that is deliberate: Many has no draft to put it in — it
is a textarea and a count — and a per-mode checkbox would lose its state when you
switched. `create_tasks` grew a `planned_date`, applied to the whole batch,
because "these five things, today" is the gesture; there is no version of it
where one line means today and the rest do not.

**A daily cadence disables the box** rather than ignoring it. The server nulls
`planned_date` for a daily task on write — a daily task is on every day, and a
column saying otherwise is a lie the views would then work around. The form now
says that instead of showing a tick that does nothing.

---

## Editing from the day's own list

**What.** Every row on Day carries a small **Edit** button that opens the task
editor — the same editor the To do panel opens, now extracted out of `Todo.tsx`
and shared.

**This reverses a rule.** `design/views.md` and a comment in `Todo.tsx` both said
the panel was the ONLY place a task is defined, and gave the reason: *"the Day
list is for doing, and a tap there is a tap you make while working, not one you
make to change what a task means."*

That reasoning is still right, and it is about **tapping the name**. A distinct,
quiet button is a deliberate gesture — you cannot hit it while ticking things
off. So the rule is reversed and the reasoning it rested on is kept: the row's
name is still not an edit target on Day.

**`DayTask` gained `category`.** The editor edits it, so a row that arrived
without it would open a form that silently cleared the field. Day renders it
nowhere; it is carried for the editor alone, and a test says so.

---

## Placement in the editor

**What.** The editor grew a day picker and a **Clear day** control. Not a "place
today" checkbox — that box is capture's.

**Why not the same checkbox.** A checkbox has two states and placement has more
than two. Open the editor on a task placed Thursday: an unchecked box would be
truthful, and saving would then clear Thursday. Silent data loss to save a
picker.

**Placement is sent only when it changed**, and this is the subtle part. The
draft is seeded from `effective_date`, which is **not** `tasks.planned_date` — a
task whose date has fallen out of its period reads as null here while the column
still holds the old value. Sending the draft back unconditionally would rewrite
that column on every save, quietly, for tasks nobody had touched. The editor
holds the date it opened on and omits the field unless it differs.

---

## Simplifications taken along the way

**`placementMaxFor`** — the same nine lines, doc comment included, existed in
both `Day.tsx` and `Todo.tsx`. One copy now, in `ui.tsx` beside `DayPicker`,
whose `max` prop it feeds.

**`TaskEditor`** — moved out of `Todo.tsx` into its own module so Day opens the
same editor rather than growing a second one.

**`tests/harness.ts`** — `views` and `isolation` each carried their own
`mkdtemp`, `createClient`, `PRAGMA`, `migrate` and mood seed, and a third suite
would have made three. One `freshDb()` now backs all three.

**One simplification was considered and refused.** The Move/Place button, its
popover and its `DayPicker` look duplicated between the two views. Merging them
needs about eight props to save about eight lines, and they genuinely differ —
`planned_date` against `effective_date`, different labels, different close
behaviour. Left alone.

---

## The browser suite was writing to production

This is the entry worth reading twice.

**What happened.** `e2e/fixtures.ts` spawned each test server with
`{ ...process.env, DB_PATH: <temp file> }`. Bun auto-loads `.env`, so once this
repository had a `.env` holding real Turso credentials, every test server booted
as an **embedded replica of the production database**. `DB_PATH` still pointed at
a temp file and nothing looked wrong — but that file was a replica, and every
write the suite made was forwarded to Turso.

It put **206 tasks and 83 completions** into the live database: `Item 1` through
`Item 99`, `Ring the plumber`, `Milk`, `Bin day`. Real data was untouched — all
44 tasks compared field for field against a known-good copy, zero differences —
and the rows were deleted by id.

**The obvious fix does not work.** Deleting `TURSO_URL` from the parent's
environment does nothing, because Bun reads `.env` in the *child* and puts it
straight back. That fix was written, believed, and reported as done; the suite
kept talking to production. What proved it was a controlled experiment — the same
reproduction against the previous commit passed, against the working tree failed,
and the only difference that survived bisection was the presence of `.env`.

**What actually works.** An explicitly-passed variable beats `.env` in Bun, and
an empty string is the only value that can reach the child meaning "unset". So
the fixture passes `TURSO_URL: ''`, and `db.ts` treats an empty URL as unset:

```ts
const TURSO_URL = process.env.TURSO_URL || undefined
```

Two lines, in two files, each carrying the reason.

**Three things this cost, worth naming.** The failure surfaced as `WalConflict`
on every write — libSQL holding a replica file while `seed-cli` wrote it through
`bun:sqlite` — which looks nothing like a configuration problem and sent the
first hour into the wrong half of the system. WAL was suspected and tested and
was **not** the cause; it was very nearly removed on a plausible story. And the
diagnostic scripts written to investigate the leak reproduced it, adding twenty
more rows to production before they were deleted.

**What would have caught it earlier.** Nothing in the suite asserted it was
talking to a local file. `harness.spec.ts` now does: a replica keeps a `-info`
file beside its database and a plain local file does not, so the difference is
one `existsSync`. The isolation tests beside it prove each test's database
differs from the last, which is not the same claim and is why this ran silently.

### The credentials moved out of `.env`

Fixing the fixture fixes the suite and nothing else. Bun loads `.env` in **every**
process started in this directory, so anything there reaches every throwaway
script too — which is not hypothetical either: the diagnostics written to
investigate this leak reproduced it, and put another twenty rows in production
before they were deleted.

So `.env` no longer holds them. `.env.turso` does, gitignored, and nothing loads
it without being asked:

```sh
bun --env-file=.env.turso run user:add owner
```

The default in this directory is now a local file, and reaching the real database
is a visible act in the command that does it. `.env` survives as comments saying
so, because the place someone would paste credentials back is the place to
explain why not to.

The fixture also passes `--no-env-file` now. That is a second guard where one
would do, and it is deliberate: the first guard was believed to be working while
it was not, and this one holds no matter what anybody later puts in `.env`.

---

## Tests

| | |
|---|---|
| `tests/commands.test.ts` | New. Command *writes* had no home: `views` covers what builders derive, `isolation` covers who may see it. Eight tests over bulk placement, the daily rule, and `update_task` leaving an omitted date alone. |
| `tests/views.test.ts` | A Day row carries its category, which Day draws nowhere. |
| `e2e/day.spec.ts` | Six: the two entry points differing by the checkbox, the box surviving a switch to Many, a daily cadence disabling it, the row editor renaming, and the editor clearing a placement. |
| `tests/harness.ts` | Not a test. The shared database setup, extracted. |

Unit tests 171 → 180, browser tests 256 → 268.

---

## The container had no timezone

**What.** `fly.toml` sets `TZ=America/New_York`.

**Why it was wrong.** `today.ts` reads the process's local date, and its comment
said *"one process, one machine, one household — there is no timezone to
reconcile."* That was true while the app ran on a laptop in the household. The
container has no `/etc/timezone` and an empty `TZ`, so it ran UTC: at 22:35
Eastern the deployed app was serving `2026-09-08`, and had been rolling over to
tomorrow at 8pm every evening since the first deploy.

The consequence is not cosmetic. A task ticked at 9pm is written against the
wrong date, and **dates are stored as strings with no time** — `planned_date`,
`completed_on` and `days.date` are all `YYYY-MM-DD`. There is no instant to
reinterpret, so changing the timezone fixes nothing already written. The fix is
forward-only and the affected rows were corrected by hand.

**Checked, not assumed.** The slim image has no `/etc/timezone`, so `TZ` might
have done nothing — it works: `TZ=America/New_York` inside the container gives
Eastern, and Bun's `Date` honours it.

**A per-user zone is the answer for more than one household.** It was built in
v11, immediately after this, and it removed the `TZ` line above rather than
building on it — see [`changes-v11.md`](changes-v11.md).

---

Continued in [`changes-v11.md`](changes-v11.md).

