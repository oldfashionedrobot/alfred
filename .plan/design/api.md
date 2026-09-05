# Household Tracker — API & Shared Contracts


> **Frozen.** This describes the design as built, and is no longer maintained.
> It was checked against the code and corrected on 2026-09-05, so it is accurate
> as of that date — but anything decided since lives in
> [`../changes.md`](../changes.md), which is authoritative where the two differ.

Status: v5 — category and the Backlog panel · frozen after v6
Companion to `data-model.md`, `views.md` and `tech-stack.md`.

This document is the seam between pieces of the implementation written separately. Everything here is a contract more than one file depends on.

v1 of this document specified CRUD over the four tables with derivation on the client. Superseded — see *Why the server derives*.

---

## Shape

**The server owns every derivation. The client renders and issues commands.**

Two kinds of endpoint, and nothing else:

| Kind | Verb | Returns |
|---|---|---|
| **Queries** | `GET /api/<view>` | a view model — exactly what one screen renders, already ordered and sectioned |
| **Commands** | `POST /api/commands/<name>` | `{ "ok": true }` — the client refetches |

The client holds no model logic. It does not know what a period is, does not compute overdue, does not sort, and does not decide which day a completion belongs to. It receives arrays that are already in render order and posts named gestures back.

### Why the server derives

The period logic in `data-model.md` is the subtle part of this system — it is where the one known bug came from, and its edge cases are month and week boundaries that occur on specific calendar days and are easy to never hit by hand. It belongs on one side of the wire, next to the data, where it can be tested against the database and where `today` has exactly one definition.

The consequences are worth stating because they are the point:

- **Rules become enforceable rather than advisory.** `data-model.md` names two write-time constraints the maths does not derive — daily tasks are never placed, and `planned_date` never goes beyond the current week — and v1 could only ask the interface to be careful. The server now knows what week it is, so `place` rejects both violations outright. The picker still offers only valid days; that is now a courtesy rather than the enforcement.
- **Ambiguous writes resolve correctly.** Unticking a weekly task on Wednesday that was completed Tuesday has to delete Tuesday's row, not write-then-delete Wednesday's. The server knows which completion satisfies the current period. A client posting `DELETE /completions/7/2026-09-09` would have had to work that out for itself.
- **One clock.** `today` is read in one place, on one machine.

The cost is that the endpoints are shaped like screens, so changing a screen usually means touching the server. Accepted: there are three screens and they are specified.

**Corollary: there is no general-purpose CRUD.** No `GET /api/tasks`. If a client needs data, it is because a view renders it, and it arrives in that view's model.

---

## Conventions

| | |
|---|---|
| Base path | `/api` |
| Content type | `application/json` both directions |
| Field names | `snake_case`, matching `data-model.md` |
| Dates | `YYYY-MM-DD` strings, always. Never timestamps, never `Date` on the wire |
| Booleans | real JSON `true`/`false`, not SQLite's 0/1 |
| Absent optional value | `null`, never omitted |

**Dates are strings end to end.** Stored as text, sent as text, compared as text, parsed only inside the period module where calendar arithmetic is genuinely needed. `YYYY-MM-DD` compares and sorts correctly with `<`, which is most of what this model asks of a date. The failure this avoids is a `Date` picking up a timezone offset, landing on the wrong day, and corrupting history silently.

**`today` is never a parameter.** No endpoint accepts a date meaning "the day to render." The server reads its own clock. A client cannot ask for yesterday, which is what makes *Recording is same-day only* in `data-model.md` structural rather than a rule the UI is trusted to follow.

### Errors

```
4xx / 5xx  →  { "error": "human-readable message" }
```

| Code | When |
|---|---|
| `400` | malformed body, bad date format, unknown cadence or mood slug |
| `404` | no such task id or mood slug, or no such endpoint |
| `409` | the command is valid JSON but the model refuses it — see *Rejections* |
| `500` | anything else |

One string, no error codes, no field-level validation objects. The client is the only consumer and is written by the same person.

Four codes, three error classes. A wrong method on a real path is a `404` like any other unroutable request, not a `405`: only a hand-written `curl` can produce one, and a fourth error class for that is ceremony this API does not need.

### Rejections

`409` is its own code because these are the model refusing a gesture, not the request being malformed. All of them come from rules the server can now enforce:

| Rejection | Rule |
|---|---|
| placing a task with `cadence = 'day'` | daily tasks are never placed |
| placing beyond this Saturday | `planned_date` never leaves the current week |
| placing before today | the picker offers remaining days only |
| completing an already-archived task | archived tasks are not in any current view |
| placing an already-archived task | same |

Every one of these is unreachable through the interface. They exist so that the interface being wrong is a visible error rather than a silent bad write.

---

## Queries

### `GET /api/day`

Everything the Day view renders. No parameters — it is always today.

```ts
interface DayView {
  date: ISODate
  mood: string | null              // moods.slug
  log: string | null
  moods: Mood[]                    // active only, in sort_order — the picker row
  active: DayTask[]                // render order, baseline band first
  completed: DayTask[]             // render order, sorted independently
  has_overdue: boolean             // enables "reset to backlog"
  placeable_dates: ISODate[]       // today through Saturday — the reschedule picker
}

interface DayTask {
  id: number
  name: string
  is_baseline: boolean
  color: string | null             // '#rrggbb'. NULL unless the task is baseline
  cadence: Cadence | null
  planned_date: ISODate | null
  state: 'daily' | 'planned' | 'overdue'
  effective_date: ISODate | null
}
```

Membership is *What appears* in `views.md` — an active task matching **any** of four rules:

```
cadence === 'day'
effective_date === today
isOverdue                        // effective_date in the past, not done
a completion dated today         // whatever you ticked, whenever it was due
```

Overdue items are in the same `active` array — not a separate section — carrying `state: 'overdue'` for the visual mark.

**The fourth rule is easy to leave out and it is load-bearing.** `isOverdue` is false once a task is done, so without it, ticking an overdue task drops it out of *both* arrays and off the screen, with nothing left to tap to untick. That is what the first build did. Membership is a union of four independent rules, not a chain of `else if` — write it as one.

Note the asymmetry with `is_done`: doneness decides which array a member lands in, and via the fourth rule can only ever *add* a task to the set, never remove one.

`placeable_dates` is carried here as well as on Week because the reschedule picker opens from an overdue row on this screen. Day must never fetch the Week model to get it: that is one view reaching for another's data, and any cache of it goes stale against the server's own clock — the precise disagreement this field exists to prevent.

`completed` holds everything in that membership set where `is_done` is true. **`is_done` is period-satisfaction, not same-day** — a task placed today but already satisfied earlier this period lands there rather than in `active`.

Membership still decides what is on screen at all, so a task placed *and* completed on an earlier day is not here: it matched none of the four rules. A completed task stays for the day it was ticked, and the Routine panel answers for the rest of its period.

Both arrays are sorted by the server. The client renders them in the order given and never reorders.

**`color` is null unless the task is baseline**, whatever the column holds. `data-model.md` keeps the stored value when a task stops being baseline so that re-ticking restores it; nulling it here is what stops the client needing to know that rule. `WeekTask` carries no `color` at all — baseline is a flag on daily tasks, and daily tasks never appear in the Week model.

`planned_date` and `cadence` ride along on every task so the edit panel opens without a second request.

### `GET /api/week`

```ts
interface WeekView {
  week_start: ISODate              // Sunday
  week_end: ISODate                // Saturday
  today: ISODate
  placeable_dates: ISODate[]       // today through Saturday — exactly what the picker offers
  days: WeekDay[]                  // always 7, Sunday first
}

interface WeekDay {
  date: ISODate
  is_today: boolean
  is_past: boolean                 // read-only section
  tasks: WeekTask[]
}

interface WeekTask {
  id: number
  name: string
  is_baseline: boolean
  cadence: Cadence | null
  planned_date: ISODate | null
  is_done: boolean
  can_complete: boolean            // false on past days
}
```

Daily tasks never appear anywhere in this model — they are never placed and never overdue, so a planning surface has nothing to say about them.

`overdue`, `unplaced` and `backlog` were fields here and are gone. Each was a filter over a list `GET /api/todo` now returns in full, and shipping both would put the same task in two places on one screen. Week is the seven days; the panel is everything else.

`placeable_dates` is the server telling the client what the picker may offer. The client does not compute it, which means the picker and the `409` on `place` can never disagree.

### `GET /api/history`

```
?limit=<n>     default 60, maximum 365
?before=<date> exclusive; must not be in the future; omit for most recent
```

Both bounds are enforced in `routes.ts` beside the rest of the query-string validation, and both return `400`. The ceiling lives there rather than in the builder so that limit validation has exactly one home.

```ts
interface HistoryView {
  columns: HistoryColumn[]         // active daily tasks, in sort order
  rows: HistoryRow[]               // most recent date first
  next_before: ISODate | null      // null when exhausted
}

interface HistoryColumn {
  task_id: number
  name: string
  color: string | null             // '#rrggbb'. NULL unless the task is baseline
}

interface HistoryRow {
  date: ISODate
  mood: Mood | null                // resolved, including retired moods
  completed: number[]              // task_ids with a completion on this date
  log: string | null               // that day's entry, if one was written
}
```

`columns` are ordered by baseline, then category, then name — the same comparator the Routine panel uses for its tie-break, so the two screens cannot show the same tasks in different orders.

`log` carries the entry itself rather than a flag, so the client can open it without a second request. `set_log` already stores `""` as `null`, so an empty entry is not a state this has to express.

Rows cover every date in the range, including days with nothing recorded — a gap is a fact the grid is there to show, so the server emits the empty row rather than making the client fill holes.

`mood` is the resolved mood object, not a slug, and resolves retired moods too. History is the one place a mood no longer in the picker must still render.

### `GET /api/todo`

The Routine panel. Fetched by Day and by Week, which host the same panel and render this model identically.

```ts
interface TodoView {
  today: ISODate
  groups: TodoGroup[]              // always 6: day, week, month, quarter, year, once
  placeable_dates: ISODate[]
  has_overdue: boolean             // enables "reset to backlog"
  categories: string[]             // distinct categories in use, sorted
}

interface TodoGroup {
  cadence: Cadence | null          // null = the one-off group
  period_start: ISODate | null     // null only for the one-off group
  period_end: ISODate | null       // null only for the one-off group
  tasks: TodoTask[]                // render order — see below
}

interface TodoTask {
  id: number
  name: string
  cadence: Cadence | null
  is_baseline: boolean              // for the task editor, which opens here
  color: string | null              // '#rrggbb'. NULL unless the task is baseline
  category: string | null           // free text; clusters rows inside a group
  effective_date: ISODate | null   // NOT tasks.planned_date — see below
  is_done: boolean                 // struck through
  is_overdue: boolean              // "needs a day"
}

interface Mood {
  slug: string
  emoji: string
  label: string
  sort_order: number
  active: boolean
}
```

**Six groups, always all six, always in cadence order**, even when empty — the panel is a map of the periods as much as a list of tasks, and a month that vanishes when nothing is monthly makes it a worse map. Empty groups render quietly.

`period_start` and `period_end` are the current period's boundaries, shipped as dates so the client can label a group without knowing where a quarter begins. The client formats them and nothing more. The one-off group carries `null` for both: its period is unbounded. **There is no week number in this model, deliberately** — `data-model.md` rejects them; the client renders a range from these two dates.

**`effective_date` is not `tasks.planned_date`.** Rollover is a read: nothing ever clears `tasks.planned_date`, so a weekly task placed last Tuesday still has that date stored when viewed this Sunday — but it has fallen out the back of its period, and `data-model.md` is explicit that such a task "has no day against it". Shipping the stored value would put a stale date from a past week on the row and reintroduce exactly the staleness `effective_date` exists to remove. Null here also drops the row into the unplaced band, which is where it belongs.

The field is named for what it carries. `DayTask` and `WeekTask` still ship `planned_date`, which really is the column — the two names mean different things and are no longer spelled the same.

Group membership is every active task of that cadence, placed or not, done or not. The one exception is the one-off group: one-offs that are not done, plus those completed **this week**. A one-off completed earlier is finished and gone.

Ordering inside a group:

```
band       overdue → placed → unplaced → done
then       baseline first
then       category, uncategorised LAST
then       name, alphabetical
```

**Baseline outranks category**, so baseline rows form an unheaded block at the top of a group. The cost is stated in `views.md`: a baseline task never appears under its own category.

**Uncategorised sorts last.** The client renders no heading, chip or label for a category at all — clustering the rows *is* the whole of what a category does on screen. This endpoint ships the order and the `category` field; nothing downstream draws it.

This is *not* `sortTasks()`: there is no `days.task_order`, which belongs to Day's list.

**One response, two panels.** The client renders this model twice — the five period groups as **Routine**, the one-off group as **Backlog** — because six groups in one column is hard to read. The split is entirely a client concern: this endpoint still returns all six groups, in cadence order, and knows nothing about it.

`categories` exists for the task editor's suggestion list. Free text matched exactly means `Dog` and `dog` are two categories; suggesting the existing ones is what makes that unlikely rather than impossible.

---

## Commands

```
POST /api/commands/<name>   →   { "ok": true }
```

**Every command returns the same thing.** On success, `{ "ok": true }` and nothing else — no id, no affected rows, no view. The client refetches the view it is on.

Uniform because the alternative is a per-command return shape, which is a second contract to keep in step with the first for no gain: a command that changes a screen changes it in ways only the view builder knows, so the refetch has to happen regardless of what the response carries. Two round trips against a local SQLite file is not a cost worth designing around.

Failures return an error object and one of the codes in *Errors* — a `409` in particular means the write did not happen and the current view is still accurate.

All commands take a JSON body. Ids are task ids.

### Day and Week

| Command | Body | Effect |
|---|---|---|
| `complete` | `{ task_id }` | writes a completion dated today. Idempotent — the `(task_id, completed_on)` key absorbs a double tap |
| `uncomplete` | `{ task_id }` | deletes **the completion satisfying the current period**, not necessarily today's. See below |
| `place` | `{ task_id, date }` | sets `planned_date`. Rejects a daily task, a date outside `placeable_dates` |
| `unplan` | `{ task_id }` | clears `planned_date` |
| `reset_overdue` | `{}` | clears `planned_date` on every overdue task, in one transaction |

**`uncomplete` resolves the period, which is the reason it is a command and not a `DELETE`.** Unticking a weekly task on Wednesday that was completed Tuesday deletes Tuesday's row — that is the row making the task appear complete. The server finds the completion whose `period_key` matches today's and deletes it. If several exist in the period, it deletes the most recent. A client would have had to replicate the period logic to name the right row.

**`reset_overdue` takes no arguments.** The server computes the overdue set itself. v1 had the client send ids, which meant the set could be computed from a view rendered seconds earlier and no longer true.

### Tasks

| Command | Body | Effect |
|---|---|---|
| `create_task` | `{ name, is_baseline?, cadence?, planned_date?, color?, category? }` | full definition. A name alone yields a backlog item: no cadence, no date, not baseline |
| `update_task` | `{ id, name?, is_baseline?, cadence?, planned_date?, color?, category? }` | any subset; omitted untouched, explicit `null` clears |
| `archive_task` | `{ id }` | sets `active = false`. The only removal — there is no delete |

**`capture` is deleted.** It existed only to enforce one-field discipline on the fast input path, and `views.md` has since given the capture sheet a collapsed *More* section carrying the full set of fields. `create_task` with a name and nothing else already produces exactly what `capture` produced, so keeping both would be two commands doing one job. The capture sheet posts `create_task`.

`category` is trimmed free text; `""` and `null` both store `null`, so there is no third state between "no category" and "a category that is empty".

`color` must be `#rrggbb` — six hex digits, lower or upper case, leading `#` required. Anything else is a `400`. The server does not check that the task is baseline when storing it; the *views* decide whether to ship it, which keeps a presentational rule out of the write path.

Changing `cadence` to `'day'` via `update_task` clears `planned_date` in the same transaction — a daily task cannot be placed, so the old date would be a value the model says cannot exist.

### Day record

| Command | Body | Effect |
|---|---|---|
| `set_mood` | `{ slug }` or `{ slug: null }` | today's mood. `null` clears |
| `set_log` | `{ text }` | today's log. `""` is stored as `null` |
| `set_task_order` | `{ task_ids }` | today's `task_order` |

All three upsert today's `days` row, creating it if absent — which is what keeps `days` rows sparse without the client tracking whether one exists.

`set_task_order` takes the full ordered id list as the client rendered it. The server stores it opaquely, validating nothing: `data-model.md` has it disposable, per-day, and tolerant of ids that no longer resolve.

### Moods

**None.** The mood set is not editable through the API. `set_mood` above records the day's mood; nothing creates, renames, reorders or retires one.

Four commands and a `GET /api/moods` query existed for a manager panel that has been removed — see *Moods are data, not a feature* in `views.md`. The table is seeded on first run and edited directly in the database. `Mood` still crosses the wire inside `DayView.moods` (the picker row) and `HistoryRow.mood`, which resolves retired moods so a past day still renders its glyph.

---

## Shared types

The only types crossing the wire. One definition, imported by both sides.

```ts
type Cadence = 'day' | 'week' | 'month' | 'quarter' | 'year'
type ISODate = string            // 'YYYY-MM-DD'
```

`Cadence | null` — null meaning one-off — is the load-bearing type in the system. Everything downstream branches on that null, and it is why `tech-stack.md` chose Drizzle: the compiler enforces the nullability rather than requiring it to be remembered.

The table row types (`TaskRow`, `CompletionRow`, `DayRow`, `MoodRow`) are **server-internal**. They are Drizzle's inferred types and no client file imports them — the client's vocabulary is `DayView`, `DayTask`, `WeekView` and the rest. Where a view type looks like a row type it is a coincidence of this version, not a contract, and the two are free to diverge.

---

## Server modules

### Period logic

Pure, I/O-free, server-side. The single implementation of *Computing state* in `data-model.md`, and the first thing covered by `tests/` — which also covers `sort.ts` and the view builders.

```ts
periodKey(date: ISODate, cadence: Cadence | null): string
periodStart(today: ISODate, cadence: Cadence | null): ISODate | null   // null = unbounded
periodEnd(today: ISODate, cadence: Cadence | null): ISODate | null     // null = unbounded

effectiveDate(task: TaskRow, today: ISODate): ISODate | null
isDone(task: TaskRow, completions: CompletionRow[], today: ISODate): boolean
isUnplaced(task: TaskRow, today: ISODate): boolean
isOverdue(task: TaskRow, completions: CompletionRow[], today: ISODate): boolean

// The completion satisfying today's period — the row `uncomplete` deletes,
// which is not necessarily today's. Most recent when several qualify.
completionForPeriod(task: TaskRow, completions: CompletionRow[], today: ISODate): CompletionRow | null

// Plain calendar stepping. Lives here so parsing a date stays in one module.
addDays(date: ISODate, n: number): ISODate
```

| Cadence | `periodKey` | `periodStart` | `periodEnd` |
|---|---|---|---|
| `day` | `2026-09-05` | today | today |
| `week` | `W2026-08-30` | Sunday of this week | that Saturday |
| `month` | `2026-09` | 1st of this month | last of this month |
| `quarter` | `2026-Q3` | 1st of this quarter | last of this quarter |
| `year` | `2026` | 1 Jan | 31 Dec |
| `null` | `once` | `null` — unbounded | `null` — unbounded |

`periodEnd` exists only to label the Routine panel's groups. Pure and testable like the rest, and it keeps the client from ever needing to know that September has thirty days.

**Weeks run Sunday to Saturday**, and the week key is that Sunday's date, never an ISO week number.

These take `today` as an argument rather than reading the clock, which is what makes them testable — the month-boundary regression in `data-model.md` is just a call with `today = '2026-09-29'`.

### Ordering

`views.md`'s `sort()`, now server-side, applied wherever a view model emits a task array.

```ts
sortTasks<T extends Pick<TaskRow, 'id' | 'name' | 'is_baseline'>>(
  tasks: T[],
  taskOrder: number[] | null,
): T[]

// Baseline, then category (uncategorised last), then name. The tie-break the
// Routine panel and History's columns share, so the two cannot order the same
// tasks differently. NOT sortTasks: no days.task_order, and baseline outranks
// category deliberately.
byBaselineCategoryName(a, b): number
```

Band 1 is `is_baseline`, band 2 is everything else. Within a band: `taskOrder` position if listed, otherwise name, alphabetical. Anything unlisted falls below everything listed. Bands never mix — the reorder gesture moves a task within its band only, which is what the baseline flag means.

Run independently over the active and completed arrays, so completed items keep their arrangement inside their own section rather than being flattened or re-sorted.

### Today

```ts
today(): ISODate
```

One function, one place, the server's local date. Nothing else in the codebase constructs today's date. One process, one machine, one household — there is no timezone to reconcile.

---

## Client fetching

Each view fetches its model on mount and refetches it after any command it issues. The refetched model replaces the previous one wholesale — never merged, never patched.

Day and Week each fetch **two** models: their own, and `/api/todo` for the panel they host. After any command from either surface, both are refetched. Two requests where one would do, and the right trade: embedding the panel inside `DayView` and `WeekView` would duplicate a large structure across two models and make the panel's shape depend on who asked. The panel is a view; it fetches its own model. What Day must never do is fetch `WeekView` — that is one view reading another's, and it is how the stale `placeable_dates` cache got in.

There is no cache, no query library, no store, and **no derived state anywhere on the client** — nothing computed from a view model and held, because the view model already is the computation. Components read fields and render them.

The single exception is the reorder edit state in Day, where the client holds a locally rearranged list until the toggle closes and `set_task_order` is posted. It is the one moment the client's list differs from the server's.

Requests are more numerous than a caching client would make, and are microseconds against a local SQLite file.
