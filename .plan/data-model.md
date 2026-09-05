# Household Tracker — Data Model

Status: v5 — category added
Scope: data model only. Views documented separately.

v2 folds in the pre-build clarification round: `mood` becomes a categorical set with its own table, and same-day-only recording is stated explicitly.

---

## Principles

1. **Append-only.** Nothing is ever cleared or reset. Completing a task writes a row; it never erases one. This is the fix for the current spreadsheet's main defect.
2. **One task table.** Baseline, cadence, and backlog status are attributes of a task, not separate lists. The current left/right split in the sheet is a rendering choice, not a data distinction.
3. **Planned, not due.** Dates on tasks are non-binding intentions that get revised. Nothing in this system is late.
4. **The calendar is a separate system and stays that way.** Google Calendar already works and this does not touch it. There is no time-of-day field, no duration, no clock-based reminders, no sync, and no import. `planned_date` is a day and nothing finer — that constraint is what keeps this from drifting into scheduling. An appointment is never a task; only the act of arranging one is. "Call the vet" belongs here. The 3pm Thursday appointment that results does not.
5. **Derive rather than store.** Streaks, misses, due, overdue, and period rollover are computed on read. None are fields, and none require a scheduled job. The system has no background behaviour at all.
6. **Recurrence is period-based, never interval-based.** A task is due once per period. Nothing tracks elapsed time since last completion. Vacuuming Saturday then Sunday satisfies two weeks in two days, and that is fine.
7. **No metadata that isn't used by a view.** No counters, no timestamps, no notes, no ages. Every field earns its place by appearing on a screen.

---

## Tables

### `tasks`

| Field | Type | Notes |
|---|---|---|
| `id` | int, pk | |
| `name` | text | |
| `is_baseline` | bool | true = the bare minimum to function |
| `cadence` | enum, nullable | `day` \| `week` \| `month` \| `quarter` \| `year`. **Null means one-off.** |
| `planned_date` | date, nullable | soft intention — the day this is meant to land on |
| `color` | text, nullable | `#rrggbb`. Baseline tasks only — see below |
| `category` | text, nullable | free text. Groups tasks inside the To do panel |
| `active` | bool | false = archived, retired from all current views, history preserved |

Eight fields. One nullable enum carries all recurrence — there is no second cadence field and no branch in the due calculation.

**`color` is the one purely presentational field.** Every other field here is an observation or an intention; this one exists only to be looked at. It earns its place by the same rule as the rest — it appears on a screen — but it is the first where appearing is the whole job, so it is worth naming rather than letting it pass unnoticed.

It applies to **baseline tasks only**. Day's list already separates the baseline band with a rule at the boundary; the To do panel has no bands, so baseline tasks sit unmarked among every other daily task there. A colour marks them in both places without either screen needing to understand bands.

The value survives a task ceasing to be baseline rather than being cleared, so re-ticking the flag restores it. Views ship `color` as null for anything not baseline, which keeps the rule on the server and leaves the client rendering what it is given.

**`category` is free text, matched exactly.** No table, no enum, no normalisation — the editor suggests categories already in use so that picking an existing one is easier than retyping it, which is the cheap half of a categories table. `Dog` and `dog` are two categories; that is a known cost, accepted rather than solved.

Like `color`, it is presentational in effect but not in kind: it changes how the To do panel groups, which is a real organising fact about a task rather than a mark on it.

**Backlog items are tasks with `cadence = null`.** No separate table.

**A backlog item is finished** when it has at least one completion row. It then drops out of the backlog automatically — no `done` field needed.

**Repeated instances stay separate tasks.** Feed Barney 1, 2 and 3 are three rows, not one row with a counter. The instances are not interchangeable — they are morning, noon and night, and Ringo med 1 and 2 are likely different drugs. A 1/3 counter could tell you a feed was missed but not *which*, which is the exact question the tracker exists to answer. The resulting daily list is long, around seventeen items. Prefixes like `Dog: Feed Barney 1` group the block alphabetically at zero cost in fields; `days.task_order` overrides that per day.

**Always archive; never delete.** Removing a task sets `active = false`. It retires from every current view and its completions survive untouched. There is no hard delete anywhere in the system, not even for a task with no history.

An earlier version of this model deleted history-free tasks and archived the rest, with the interface picking silently. Rejected: it makes destructiveness depend on a condition the user cannot see, so the same gesture on two rows that look identical does two different things. One rule that is always true is easier to trust than a clever rule that is usually invisible. The cost is dead rows in a table nobody reads directly, which is not a cost.

### `completions`

| Field | Type | Notes |
|---|---|---|
| `task_id` | int | composite pk |
| `completed_on` | date | composite pk |

Two fields, no surrogate key. `(task_id, completed_on)` as the primary key makes completion idempotent for free — double-tapping a daily task cannot write two rows.

This table is the entire history. Everything the current spreadsheet loses on reset is preserved here.

### `days`

| Field | Type | Notes |
|---|---|---|
| `date` | date, pk | |
| `mood` | text, nullable | FK → `moods.slug`. At most one mood per day. |
| `log` | text, nullable | the journal entry |
| `task_order` | text, nullable | ordered list of task ids for this day |

Mood and journal are not tasks and are not modelled as such. This mirrors columns I and K of the current sheet. The current LOG checkbox (column J) is unnecessary — a non-empty `log` is the same fact.

**Mood is categorical, not a scale.** It is one state drawn from a named set, not a point on an axis. Nothing orders, averages, or compares moods, and no view treats one as higher than another — so `mood` is a slug, not a number. At most one per day: selecting a different one replaces it, selecting the current one clears it back to null.

**Rows are sparse.** A row exists only once a mood, log, or arrangement has been recorded. No row means none of those happened — which is the correct meaning, and avoids empty rows implying a day was logged.

**`task_order` is per-day and disposable.** Absence means default order; anything not listed falls to the bottom. The system never interprets the order, only replays it, so one mechanism covers arranging by grouping one day and by morning/afternoon/evening the next. Tomorrow starts fresh. Ids that no longer resolve to a task shown that day — archived, or simply not on the list — are ignored on read, so no cleanup is needed.

It is the one field here that is view state rather than an observation about the day. Named `task_order` because `order` is a reserved word in SQL.

**Anything computable from the date is not stored.** Sunday shading, weekends, week numbers, month boundaries — all view logic. Sunday is lighter in practice but has no functional difference and no flag.

### `moods`

| Field | Type | Notes |
|---|---|---|
| `slug` | text, pk | stable identifier, referenced by `days.mood` |
| `emoji` | text | the display glyph |
| `label` | text | the word |
| `sort_order` | int | position in the picker row |
| `active` | bool | false = retired, hidden from the picker, past days still resolve it |

The fourth table, and the only one that is configuration rather than record. It exists because the mood set is personal and will be revised — a fixed code constant would mean a deploy to add a state, and the point of logging a mood is that the available words fit.

**It is edited in the database, not in the app.** Seeded on first run, changed with `bun run db:studio` or `sqlite3`. A manager panel was built and then removed: eight rows revised twice a year did not justify a form on the most-used screen in the app, and the reason for choosing a table over a code constant — revising without a deploy — is satisfied just as well by editing the row.

Starting set:

| slug | emoji | label |
|---|---|---|
| `angry` | 🤬 | angry |
| `scattered` | 🤯 | scattered |
| `depressed` | 🤢 | depressed |
| `anxious` | 🥶 | anxious |
| `fiending` | 😈 | fiending |
| `shutdown` | 💀 | shutdown |
| `balanced` | 😑 | balanced |
| `happy` | 😊 | happy |

**Retire, never delete.** `days.mood` rows point at slugs, so removing a mood would orphan history. Setting `active = false` drops it from the picker while past days continue to render it — the same delete-vs-archive split that `tasks.active` makes, for the same reason.

**No ordering semantics.** `sort_order` is picker layout and nothing else. It does not imply that `happy` outranks `angry`, and nothing in the system compares two moods.

---

## Computing state

Two primitives, both pure functions of a date and a cadence.

```
period_key(date, cadence):          period_start(today, cadence):
  day     → "2026-09-05"              day     → today
  week    → "W2026-08-30"             week    → Sunday of this week
  month   → "2026-09"                 month   → 1st of this month
  quarter → "2026-Q3"                 quarter → 1st of this quarter
  year    → "2026"                    year    → 1 Jan
  null    → "once"                    null    → unbounded
```

**Weeks run Sunday to Saturday.** This is the one place the model departs from the ISO default, and it propagates: `period_start` returns Sunday, the Week view runs Sunday through Saturday, and the day picker offers today through Saturday.

**The week key is the week's Sunday, not a week number.** `W2026-08-30`, never `2026-W36`. ISO week numbers are Monday-based and cannot express a Sunday-start week without an off-by-one at every year boundary — the week containing Jan 1 belongs to two numbering schemes at once, and the bug surfaces once a year in a system nobody is looking at closely in January. A date is unambiguous, sorts correctly as a string, and needs no numbering rules at all. It is also self-describing when read out of the database by hand.

A null cadence mapping every date to the same key, and to an unbounded period start, is what stops one-offs from being a special case anywhere downstream.

Everything else is three definitions:

```
effective_date(task, today) =
  planned_date, unless planned_date < period_start(today, cadence)
  otherwise null

is_done(task, today) =
  ∃ completion where
    period_key(completion.completed_on, cadence) == period_key(today, cadence)

is_unplaced(task, today) =  effective_date is null
is_overdue(task, today)  =  not is_done  and  effective_date < today
```

**A date that has fallen out the back of its period is simply not there.** That is the whole of `effective_date`, and it removes staleness as a separate concept — there is no `is_stale` to reason about, and no null guards, since a null date fails the comparison on its own.

**The check is backward-only by design.** It asks whether a date has fallen behind the current period, never whether it sits ahead of one. The forward direction is a write-time constraint instead (see Scheduling rules) and must not be handled here. A symmetric period-key comparison would break at period boundaries: in the week of Sun Sep 27 – Sat Oct 3, a monthly task placed on Fri Oct 2 while today is Tue Sep 29 sits inside the current week but in a different month, and would be wrongly discarded — placed, then vanished.

Behaviour that falls out with no additional logic:

| Case | Result |
|---|---|
| Weekly task placed Tuesday, today Wednesday | Effective date holds → **overdue**, wants a new day this week |
| Same task, today the following Sunday | Before this week's start → effective date null → **due and unplaced**, no debt carried |
| One-off placed Tuesday, today the following Sunday | `period_start` unbounded → effective date holds → still **overdue** |
| Daily task | Never placed, so effective date is always null |
| Monthly task placed Oct 2, today Sep 29 | Not before this month's start → **planned**, sits in Friday's list |

### Rollover is a read, not a write

Nothing ever clears `planned_date`. `effective_date` simply stops returning it. So there is no dependency on the app having been opened on any particular day — go dark for three weeks and state computes correctly on return.

One-offs have an unbounded period start, so their date never falls out. It persists until resolved by hand, and nothing sweeps the backlog.

---

## Scheduling rules

**The gesture is: pick a day.** Assigning anything to a day sets `planned_date`. That is the only scheduling operation in the system. There is no separate "pull into today" — today is just one of the seven days you can pick.

**Everything but daily tasks gets placed.** Weekly planning assigns backlog one-offs *and* period tasks to specific days. "Grocery run" must land on a day or it never appears in any day's list.

Two write-time constraints, neither derived — the maths will not catch either, so the interface must:

- **Daily tasks are never placed.** They are implicitly on every day. `planned_date` stays null.
- **`planned_date` is never set beyond the current week**, for every task including one-offs. The picker offers this week's remaining days and nothing else. Something you want to do in three weeks stays in the backlog until that week arrives.

**Forward is bounded; backward is not.** A one-off planned for last Tuesday stays overdue indefinitely until resolved by hand. Only the future is capped. This asymmetry is the whole point: it prevents far-future filing without ever quietly discarding something you didn't get to.

**Overdue means "needs a new day," not "you failed."** The item still appears folded into that day's list — it is not hidden or moved to a separate screen — but it is visually marked and asks for a decision. Two resolutions, both one action:

- **Reschedule** — set a new `planned_date`.
- **Unplan** — clear `planned_date`.

Completing it is of course the third resolution. Weekly planning is where overdue items get resolved, deliberately and manually.

### Recording is same-day only

**A completion is always written with today's date.** There is no gesture anywhere that writes a past-dated completion, and no surface that navigates to a previous day to tick something. The Day view is today; the Week view is the current week; History is read-only.

This is a deliberate narrowing, and it has two consequences worth stating rather than discovering:

- **A task done Tuesday but ticked Thursday is recorded on Thursday.** The history is a record of when things were *marked*, not when they were done. Accepted: the alternative is a date picker on every checkbox, which is friction on the most-used gesture in the system.
- **A missed daily task can never be caught up.** Daily tasks are never placed, so their effective date is always null, so they are never overdue — there is nothing to resolve and nothing to reschedule. Yesterday's missed daily is a permanent gap in the grid. This is what period-based recurrence means: the period passed.

Everything that *is* catchable-up is already covered by overdue. A weekly, monthly, quarterly, yearly or one-off task that was placed and not done stays on today's list until it is completed, rescheduled or unplanned. Catching up is not a separate feature; it is the overdue mechanic.

### Reset to backlog

A bulk action clearing `planned_date` on every overdue item at once, so a bad week can be cleared in one gesture rather than twelve. Without it, a wall of overdue markers becomes its own avoidance trigger.

Scope is deliberately narrow: **overdue items only**, never days still ahead. Thursday's plan is still a good plan on Wednesday.

Effect depends on the task. A one-off returns to the backlog. A period task becomes *unplaced* — still due this period, just without a day — and will want placing again during weekly planning.

A wider "wipe this week's board" version may be worth having, but it belongs to weekly planning, not the daily view.

---

## What this replaces in the current sheet

| Current sheet | New model |
|---|---|
| Columns B–H (PLN, MED, JOB, TRY, EXC, EAT, SLP) | tasks, `is_baseline = true`, `cadence = day` |
| Column I (MND) | `days.mood` |
| Columns J–K (LOG) | `days.log` |
| Column N (Daily) | tasks, `is_baseline = false`, `cadence = day` |
| Column P (Weekly) | tasks, `cadence = week` |
| Column R (Monthly) | tasks, `cadence = month` |
| Column T (Seasonally) | tasks, `cadence = quarter` |
| Google Keep lists | tasks, `cadence = null` |

`quarter` replaces the sheet's fuzzy "seasonally." `year` is new — for registrations, annual vet visits, and similar.

---

## Vocabulary

These distinctions carry weight in the model and shouldn't be used loosely.

| Term | Meaning |
|---|---|
| **Task** | Anything doable, recurring or one-off. One table for both. |
| **Baseline** | Flag on a daily task. The bare minimum to function. |
| **Cadence** | How often a task recurs. Null means one-off. |
| **Backlog** | One-offs with no `planned_date`. **Only one-offs are ever in the backlog.** |
| **Unplaced** | No effective date — either never placed, or placed in a period now past. Still due; just has no day. A model term, not a screen: the To do panel shows such a task as simply having no day against it. |
| **Planned** | Has an effective date. Non-binding. |
| **Overdue** | Effective date in the past, not done. Means *needs a new day*, not *late*. |
| **Placing** | Assigning a day to something. The only scheduling gesture in the system. |
| **Archived** | `active = false`. Retired from every current view, history intact. The only way anything is ever removed. |
| **Weekly planning** | The session where overdue items get resolved and the coming week is placed. |
| **Mood** | One named state from the `moods` table, recorded against a day. Categorical, unordered, at most one per day. |

---

## Closed decisions

All closed by rejection.

| Proposal | Outcome |
|---|---|
| Multi-occurrence counter (`occurrences`) | Rejected. Instances aren't interchangeable; they stay separate rows. |
| Interval recurrence (`cadence_type`, `interval_days`) | Rejected. Period only. Three fields collapsed into one nullable enum. |
| Week-level planning (`planned_week`) | Rejected. Scheduling is always "pick a day." |
| Reschedule counter (`reschedules`) | Rejected. Overdue is derivable. |
| Task notes (`note`) | Rejected. The name carries it. This is the field that grows into subtasks. |
| Completion timestamp (`created_at`) | Rejected. Speculative metadata. |
| Completion surrogate key (`id`) | Rejected. `(task_id, completed_on)` is the natural key and gives idempotency. |
| Task creation date (`created_at`) | Rejected. Backlog age is not a signal — a task is either still relevant or gets archived. |
| Category (`category`) | ~~Rejected. Name prefixes carry default grouping.~~ **Reversed in v5.** A prefix groups within one list; it does nothing across the To do panel's six period groups, which is exactly where a category is wanted. Prefixes stay and still order tasks inside a category. |
| `color` on every task | Rejected. Baseline only — the problem it solves is that baseline tasks are unmarked in the To do panel. A palette across the whole list is a different feature nobody asked for. |
| Clearing `color` when Baseline is unticked | Rejected. Keeping it makes unticking non-destructive and re-ticking free. Nothing renders it in the meantime. |
| Contrast-adjusting the chosen colour | Rejected. The swatch should not lie about what will render. An unreadable pick is visible instantly and fixed by picking again. |
| `sort_order` on tasks | Rejected. Per-day `days.task_order` covers the real need. |
| Rest-day flag | Rejected. Sunday is derivable from the date. |
| `tier` as enum | Reduced to `is_baseline` boolean. |
| `mood` as int 1–5 | Rejected. The states that matter are not ordered, so a scale mis-models them. Replaced by a categorical slug plus a `moods` table. |
| Multiple moods per day | Rejected. One state per day keeps logging to one tap and the History cell one glyph wide. |
| Moods as a code constant | Rejected. The set is personal and will be revised; a code edit per revision is the wrong cost. A table edited directly in the database gets this without a management screen. |
| Backfilling past days | Rejected. Overdue already carries anything worth catching up; a date picker on the checkbox is friction on the most-used gesture. |
| Hard-deleting history-free tasks | Rejected. Makes destructiveness depend on an invisible condition. Archive is the only removal. |
| Monday-start weeks | Rejected. Weeks run Sunday to Saturday, and the week key is that Sunday's date rather than an ISO week number. |

---

## Open decisions

None.

`mood` is resolved as a categorical slug against a `moods` table — eight starting states, one per day, editable in the app. This supersedes the earlier 1–5 single axis, which mis-modelled the states as ordered. Energy as a second axis stays rejected: not requested, and it doubles logging friction.

Deployment and the question of where the SQLite file lives are open, but they are `tech-stack.md`'s to answer and touch nothing here.
