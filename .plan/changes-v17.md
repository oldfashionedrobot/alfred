# v17 — An hour at a time

Today's list gains **dividers**: rows carrying an hour, slid in between tasks, so
the day reads as a progression rather than a pile. You put in the hours you want
and no others — a 2pm, five tasks, a 5pm. A line marks where you are in it, and
the hours behind you dim.

It stays a list. That is the whole constraint — the dividers are rows in the same
list, not a calendar, not a grid, not a second surface. Everything below follows
from keeping that true.

And baseline stops deciding where a task sorts — on today's list, on the panes
ahead, in the Backlog and in the Tracker. It stays a mark on the row: a colour,
a weight and a tint.

No migration. `days.task_order` is already `TEXT` holding opaque JSON, so the
dividers live in the arrangement beside the task ids, and a day stored before
this reads as a day with no hours.

---

## What a divider is

**An entry in the day's arrangement, not a property of a task.**

`days.task_order` stops being `number[]` and becomes a mixed list: a task id, or
an hour. The day's shape and the day's order are one thing, saved by one command,
because they are one thing — where a task sits and which hour it sits under are
the same question asked twice.

```
task_order: [12, 7, { hour: 9 }, 3, 4, { hour: 11 }, { hour: 14 }, 9]
```

Two hours in a row is an **empty hour**, which is a thing you can make: somewhere
to drop the afternoon's work before you know what it is.

### Why positional survives, when it looked like it would not

The obvious objection is that the list is not a list, it is a sort — done sinks,
new rows land somewhere of the sort's choosing — so "this divider sits between
these two tasks" should drift within seconds of use.

It does not, and the reason is worth writing down. `task_order` is the **stored**
arrangement, not the rendered one, and ticking a task does not rewrite it. A
divider is drawn above however many **live** tasks the arrangement lists ahead of
it — distinct, present today, not done. The task above it sinks when ticked and
the divider stays put; the 9am divider goes on preceding the same remaining tasks.
Stale ids, duplicates and done rows count for nothing, so none of them can move
an hour.

That count only works because live listed tasks render in exactly their stored
order. The baseline band broke that — it hoisted rows past their stored
neighbours — which is the concrete reason it goes.

**What the arrangement does not place waits above the first hour.** A task added
after you arranged the day, or one that was already done when you arranged it and
is later unticked, has no slot. It lands above the first divider — unscheduled,
at the top, where you will see it and can drag it into an hour. As planned before
this was settled, it would have landed under the *last* hour, which is a claim
that you scheduled it for 5pm.

On a day with no hours, "above the first hour" is the bottom of the list, which
is where an unlisted task falls today. Nothing changes for a day that is not
using dividers.

---

## Decisions

**Baseline stops deciding position, anywhere.** It remains a mark on the row —
its colour, its weight and its tint — and the colour of its cells in the Tracker.
It stops being a band on today's list, on the panes ahead, in the Backlog's
groups and in the Tracker's columns.

On today's list it has to. A band re-orders rows across the whole list, so a
divider placed between two rows cannot survive one: with every baseline task
hoisted above every other, an hour could only ever partition *within* a band, and
a baseline task could never be scheduled for 2pm. You asked for 2pm.

Everywhere else it goes because you asked for that too, and because a flag that
lifts a task on some screens and not others means two things. The Backlog and the
Tracker still share one comparison, so they still agree with each other — which
was the reason it was one function in the first place.

The tint stays. It was the band's fill; now that a baseline task can sit
anywhere, it is what still tells you at a glance which rows are baseline.

What goes with it, deliberately:

| | |
|---|---|
| `sortTasks`'s baseline comparison | today's list and the panes ahead order done → arrangement → category → name |
| `byBaselineCategoryName`'s baseline comparison | renamed `byCategoryName`: category, then name. The Backlog's groups and the Tracker's columns still both sort by it — and so does `sortTasks`'s tail, which is why it has to change too: left alone, baseline would still lead on every day nobody arranged. |
| *"Sorts to the top."* | the hint beside the Baseline checkbox in the task editor, which would be false. It keeps *"the bare minimum to function."* |
| *"Baseline tasks stay above the rest."* | the hint shown in Reorder mode, `Day.tsx` |
| Two `DndContext`s | one list, one context. *"Bands never mix — crossing is not something that can be expressed"* was structural, and is now simply not a rule. |
| `bands`, `reorderBand`, `moveWithinBand` | the per-band plumbing in `Day.tsx`, which collapses into one move over one list |
| `.day-row--band-start`, `dividerAt`, `bandStart` | the 2px rule between bands, the index that placed it, and the prop on `TaskRow` that carried it. The hour dividers are the separator now, which is a better one: it says what it separates. |

The comments that argued for baseline-first go with it: the header of `sort.ts`,
`byBand` in `views/todo.ts`, the column sort in `views/history.ts`, the band
comments in `Day.tsx`, and *"the server has already sorted these to the top"*
over the tint in `day.css`.

This is the first ordering rule to be reversed since v1, and the reversal is the
feature rather than a side effect of it.

**Done still sinks, below every hour.** The timeline is a plan for what is left,
not a record of what happened — tick something and it leaves the hours and
collects at the foot of the list, exactly as it has since v15. The day reads:
anything unscheduled, the hours and their tasks, then the done block.

The cost, recorded: the timeline cannot tell you what you did at 10am, only what
is still owed. The Tracker records the day; nothing records the hour, and nothing
is being built to.

**Reorder saves the live arrangement and the hours, and no longer the done ids.**
Since v15 a save has appended every done id after the arrangement, so that a task
ticked and unticked would come back to where it was. With hours, the end of the
arrangement is the last hour's block, and a task done when you arranged the day
would come back under 5pm. Left out of the save, it is simply unlisted, and comes
back above the first hour. A task ticked *after* the save keeps its slot — until
the arrangement is saved again, which leaves it out like any done task, so
unticked after that it comes back above the first hour, one drag from where it
was. Keeping it in place across saves would need the server to merge the old
arrangement into the new, for an untick after a re-arrangement; not worth it.
The done block's own order falls to category and name.

**Hours are per-day, and a new day starts blank.** `task_order` is keyed
`(user_id, date)` like the mood and the log, so the dividers are too. Every
morning is a fresh arrangement.

This was argued against and chosen anyway, twice, and it is written down as a
decision rather than an oversight: laying out the day is a morning ritual, and a
shape that carried forward would be a shape you maintain instead of one you set.
If it turns out to grate, the cheapest fix is a day with no arrangement
inheriting the most recent day that had one — one lookup in the view builder, and
no stored state to keep in step.

**Arranging happens in Reorder mode, which is now what its name says.** Today it
means "drag rows". It comes to mean "arrange the day": drag rows, add an hour,
drag the hour, re-time it, take it out. One edit state, one saved arrangement, one
command.

- **Adding** is an *Add an hour* button in the Reorder bar. The new divider
  appears at the top of the list, set to the current hour in the stored zone,
  ready to be dragged down and re-timed.
- **Re-timing** is a native `<select>` of the day's 24 hours on the divider, in
  Reorder mode only. A phone gives it its own wheel, a keyboard can drive it, and
  it needs no popover state — a grid of 24 chips in a popover would have needed
  all three.
- **Removing** is a button on the divider in that mode. Its tasks join the block
  above.
- **Move to top** means above the first hour — out of every hour, into the
  unscheduled part of the day. **Send to bottom** means into the last block.
  Neither stops at a band any more, because there is none.

None of it writes until the mode closes, exactly as dragging already works.

The list outside that mode does not change at all, which is the point. No control
appears between rows, nothing new is tappable, and a day you are working rather
than planning looks exactly as it does now.

**The now-line is its own line, drawn and never stored.** An hour on a divider is
a label, and the line is computed at render — nothing about time is written by
this iteration.

It sits directly under the divider of the **latest hour that has started**: at
3:30, with dividers at 2pm and 5pm, it sits under 2pm, above that block's tasks.
So 11am is not behind at 11:30; it is the hour you are in. Before the first hour
starts, the line sits above the first divider. If two dividers share the hour,
it sits under the later one. The rule never looks at list order, so a day that
runs 9, 2pm, 11 still gets one well-defined line.

Dividers for hours before the current one are dimmed — their tags, using
`--text-dim`, never their tasks. A task under 9am that is still undone at noon is
still owed, and fading it would say otherwise; and dimming by opacity would break
the 4.5:1 contrast every text colour here is held to.

The line is not drawn in Reorder mode. Between draggable rows it would be
overlapped mid-drag, and while you are arranging the day you are not reading it.

It needs the viewer's **stored** timezone, not the browser's. v11 settled that a
day belongs to a person rather than to the device they are holding, and an hour
is that same claim at finer grain — a phone in another zone would otherwise draw
the line in the wrong place on a list whose hours were set at home. `DayView`
carries `timezone`, which is a stable string rather than an instant.

**This is the client's first read of the clock.** Until now the client never asked
what day it was; every model carried its own date. It still never asks the day —
it now asks the **hour**, in the model's zone, and only for this line. Day keeps
the current hour in state and checks it once a minute, so it re-renders when the
hour turns and not otherwise. That hour joins architecture.md's count of what the
client holds that it did not derive from a model.

A stale tab is wrong about the line and about nothing else. Waking a phone can
leave the line up to a minute behind; that is accepted rather than chased with a
visibility listener.

**Dragging announces names.** dnd-kit's default screen-reader announcements read
raw ids — *"Picked up draggable item 12"* — and hours would have made it *"item
h1"*. Every sortable row gets an accessible name and the announcements read it.

---

## Server

### `days.task_order` holds a mixed list

No schema change — the column is `TEXT` and the shape inside it is ours.
`set_task_order` widens from "an array of integers" to "an array of integers and
hours":

```
task_ids: (number | { hour: 0..23 })[]
```

The field keeps its name, `task_ids`. A tab open across the deploy will still
post it, and an old tab's integers-only list is a valid new one.

| Accepted | Refused with a `BadRequest` |
|---|---|
| `[]`, integers as today (stale and duplicate ids included), `{ hour: 0 }` through `{ hour: 23 }`, the same hour twice, hours out of order | `{ hour: 24 }`, `{ hour: -1 }`, `{ hour: 9.5 }`, `{ hour: "9" }`, `{ hour: null }`, `{}`, `{ hour: 9, m: 30 }`, `{ h: 9 }`, `[9]`, `null`, `"9"`, `true`, `1.5` |

An hour is an object with exactly one key, `hour`, holding an integer 0–23 — the
same "a typo is a 400" stance `onlyFields` takes. Nothing checks that hours
ascend or are unique: a day that runs 9, 2pm, 11 is somebody's day, and a rule
with one enforcement point is a rule that drifts. The order is still stored
opaquely and still tolerant of ids that match nothing.

That check is one function, `isHourEntry`, in `shared/types.ts` beside
`isISODate` and `isHexColor`. The validator refuses what fails it and the reader
drops what fails it, and the 0–23 rule lives in one place.

`parseTaskOrder` in `views/day.ts` learns the second shape. It already drops an
element it cannot read and keeps the rest, and a malformed hour is dropped the
same way. A value that is not a JSON array at all is still no order.

Rolling back is safe: v16's reader keeps only numbers, so a v17 row read by v16
keeps its order and loses its hours.

### Both sorts lose a band, and the view gains rows

`sortTasks` drops the `is_baseline` comparison and orders today and the panes
ahead by done → arrangement → category → name. `byBaselineCategoryName` drops it
too and becomes `byCategoryName`, so the Backlog and the Tracker order by
category, then name. Neither reads `is_baseline` any more, so it leaves both
`Pick`s; the flag is read only where a row's colour, weight and tint are decided.

`sortTasks` never sees an hour. `buildDayView` splits the stored list once: its
numbers go to `sortTasks`, and the hours are placed afterwards by one small
function in `views/day.ts`. `sortTasks` gains a single optional argument — where
in the arrangement unlisted tasks go — and `buildDayView` passes the first hour's
position. Nothing else passes it, so the panes and every day without hours sort
exactly as now. Where a task sits in the arrangement is one function,
`arrangementPosition` in `sort.ts`, used by both the sort and the hour
placement, so the two cannot disagree about it.

`DayView` changes shape once more:

| | |
|---|---|
| `tasks: DayTask[]` | unchanged — still the day's rows, sorted, done last |
| **`hours: HourMark[]`** | new. `{ hour: number; before: number }` — the hour, and the index in `tasks` it is drawn above. `before` counts live rows only, so `0 ≤ before ≤` the number of live rows, and an hour at the foot of the plan sits above the done block. |
| **`timezone: string`** | new. The viewer's zone, for the now-line. Already in hand as `viewer.timezone`. This makes `GET /api/account`'s comment in `routes.ts` — the zone is a field *"no view payload carries"* — false, and it is corrected. |

The server emits the positions; the client splices. That is placement, not
derivation — the same division that has `placeable_dates` arrive ready rather
than being worked out on the client. The client never has to reason about stale,
done or unlisted ids.

Two hours with the same `before` is an empty hour, and the order they appear in
the array is the order they are drawn.

The panes ahead never read `task_order` — `buildUpcoming` passes no arrangement,
and `set_task_order` writes only today — so `UpcomingDay` gains no `hours`.

---

## Client

```
  Saturday, 12 September                    😑
   ‹  S  M  T  W  T  F  S  ›
  ─────────────────────────────────────────────
    ☐ Call the bank                         ✎
  9am ─────────────────────────────────────────
    ☐ Feed the dog                          ✎
    ☐ Email Jess                            ✎
  2pm ─────────────────────────────────────────
  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━  now
    ☐ Ring the plumber                      ✎
    ☐ Vacuum                                ✎
  5pm ─────────────────────────────────────────
    ☐ Cook                                  ✎
  ─────────────────────────────────────────────
    ☑ M̶a̶k̶e̶ ̶t̶h̶e̶ ̶b̶e̶d̶
```

| | |
|---|---|
| `views/day/Day.tsx` | one `splice(tasks, hours)` builds the rendered list and also seeds Reorder's edit state, since `before` already indexes the live rows. One drag context, one move function. Holds the current hour for the now-line — above the early return, where hooks have to be. The Reorder bar gains *Add an hour*. |
| `views/day/DragBand.tsx` → `DragList.tsx` | renamed, because it is no longer a band. Gains a sortable hour row beside `DragRow`, with the re-time `<select>` and the remove button. |
| `views/day/TaskRow.tsx` | the `bandStart` prop goes |
| `views/day/day.css` | the hour row, the now-line, the dimmed tag. `.day-row--band-start` is deleted; the baseline tint stays under a corrected comment. |
| `TaskFields.tsx` | the Baseline hint loses *"Sorts to the top."* |

There is no `HourRow.tsx`. The static hour row is about five lines in `Day.tsx`,
and the draggable one needs `useSortable`, so it lives next to `DragRow`.

**The hour row is not a task and must not read as one.** No tick, no edit button,
no stripe — a tag and a rule. It is `<li class="day-hour"><h3>9am</h3></li>`
under the list's `<h2>`: a valid list item, and a heading, so a screen reader
announces the day's shape and can jump hour to hour. A `role="separator"` would
have failed the list rule — a list's children must be list items — and dnd-kit
overwrites a sortable row's role in Reorder mode anyway.

It does not reuse `.day-row`, which draws the cadence stripe, and its tag sits
**inside** the row rather than hanging off the left: `.day-list` clips its
overflow and a phone has no gutter to hang it in.

Labels read `9am`, `12pm`, `12am`.

**Ids.** In Reorder mode an hour needs a stable key the client makes up, because
two dividers can hold the same hour and positions move during a drag. Keys are
strings that cannot collide with a task id once React stringifies both, and the
drag handler stops assuming every id is a number — `Number(active.id)` on an
hour's key is `NaN`, and the drop would silently do nothing. `orderIds` becomes a
list of task ids and keyed hours; the save maps it back to `task_ids`.

**The now-line** is an `aria-hidden` rule under the current divider. It tells you
where you are at a glance and says nothing a screen reader needs, which already
hears the hours as headings.

---

## Tests

Every number here was measured, not counted from names: the baseline comparisons
were removed in a scratch worktree and both suites run. Before the change, `bun
test` ran 234 (233 pass, 1 skip) and the Chrome projects 318, all passing. After
it, 14 unit tests and 7 browser tests failed on every attempt, on both phone and
desktop. Three more browser tests die only once the client changes.

**Time is pinned with Playwright's clock, not the account's zone.** Moving the
zone sets the hour but not the minute, so a test running across 10:59 → 11:00
flakes; and the fixture reads `app.today` once in New York, so a moved zone seeds
the wrong date for part of every day. The stored zone stays New York and
`page.clock` fixes a January instant, where the offset cannot shift under the
test. A scratch spec confirmed both `setFixedTime` and `install` + `runFor` drive
the app.

### Unit — to change

| | |
|---|---|
| `sort.test.ts:48` | becomes *baseline does not lift a task: names decide* — Aardvark, Bins, Meds, Zebra |
| `sort.test.ts:58` | becomes *the arrangement interleaves baseline and plain tasks freely* — `[1, 4, 3, 2]` |
| `sort.test.ts:87` | deleted; `:80` already covers unlisted below listed |
| `sort.test.ts:149` | *the four fields it compares*; `is_baseline` leaves the rows; expects planned, daily |
| `sort.test.ts:174`, `:181` | deleted; done sinking is covered by `:160`, `:168` and `:188` |
| `sort.test.ts:217` | *arrangement, then names* — Meds, Sleep, Vacuum, Bins, Exercise, Grocery run |
| `views.test.ts:363` | *names are alphabetical, baseline included* — Apple, Banana, Zebra |
| `views.test.ts:371` | *an unlisted baseline task falls below listed ones* — Banana, Apple, Zebra |
| `views.test.ts:381` | Banana, Apple, Zebra; its comment goes |
| `views.test.ts:668` | *a pane is sorted by name, baseline included* — Apple, Middle, Zebra |
| `views.test.ts:1017` | Apple, Zebra |
| `views.test.ts:1142` | becomes *baseline does not outrank category* — Aaa chore, Zzz vital |
| `views.test.ts:1189` | *columns order by category, then name — as the panel does* — Brush Ringo, Aardvark chore, Zzz vital, Dishes; the panel-agreement assertion stays |

Names that still pass but say "band": `sort.test.ts:38`, `:74`, `:134`, and the
comments at `sort.test.ts:170` and `views.test.ts:1119`.

### Unit — new

| | |
|---|---|
| `commands.test.ts` — `set_task_order` | stores a mixed list exactly as given, duplicate and out-of-order hours included; accepts `{ hour: 0 }` and `{ hour: 23 }`; refuses each shape in the table above with a `BadRequest` and writes no row; still accepts `[]`, stale ids and duplicate ids. **Nothing tests this command today** — `isolation.test.ts:249` only calls it. |
| `views.test.ts` — hours | no arrangement is `hours: []`; a v16 `number[]` row keeps its order with no hours; `[{9}, a, b, {11}, c]` places 9 at 0 and 11 at 2; two hours together share a `before`, in stored order; a trailing hour sits above the done block; a task ticked after arranging leaves its hour and the next hour still precedes the same tasks; stale and duplicate ids move nothing; a task created after arranging waits above the first hour; on a day without hours it still falls to the bottom; a baseline task can sit under 2pm; raw `not json` and a bare object are name order with no hours; a malformed hour is dropped and the rest kept; `timezone` is the viewer's (`Asia/Tokyo`); hours are today's when a later week is viewed |
| `isolation.test.ts:249` | extended: one account's hours never reach another's view |

`views.test.ts`'s `setDay` widens past `number[]`, and gains a raw-string path so
the rubbish cases can be seeded — `parseTaskOrder` is not exported.

### Browser — to change

| | |
|---|---|
| `day.spec.ts:332` | renamed; expects Apple ordinary, Banana ordinary, Yak baseline, Zebra baseline |
| `day.spec.ts:346` | renamed only — *"within a band"* |
| `day.spec.ts:360` | renamed; the arrangement holds across baseline — D ordinary, C ordinary, B baseline, A baseline |
| `day.spec.ts:591`, `:614` | deleted with `.day-row--band-start`; they fail once it goes |
| `day.spec.ts:625` | deleted **by hand** — it asserts the divider's absence and would pass forever, vacuously |
| `day.spec.ts:1091` | converted into *a baseline task can be dragged below a plain one and stays there* — the same seeds, the move now expected; its docblock goes |
| `day.spec.ts:1110` | deleted; once `:1091` is converted it duplicates `:1064` |
| `todo.spec.ts:616` | Aardvark admin, Zzz vital, Dishes |
| `history.spec.ts:175` | the baseline column moves last, in the headers and the API check; the *"Baseline is band 1"* comment goes |
| `history.spec.ts:600` | renamed; Brush Ringo, Aardvark chore, Zzz vital, Dishes |

`history.spec.ts:659`'s comment says baseline leads; it still passes only because
MED sorts before Zebra, and the comment is corrected. `todo.spec.ts:1072` and
`day.spec.ts:1327` and `:1351` assert the weight and the colour, and stand.

### Browser — new

| | |
|---|---|
| Hours render | as headings with no tick, an empty hour included — seeded `[{9}, A, {11}, {14}, B]` |
| Done sinks below every hour | a ticked task sits after the last divider |
| Unscheduled waits above | a task added after arranging appears above the first hour |
| Add, set, drag, save, reload | Reorder: *Add an hour*, set it with the select, keyboard-drag it, close, reload. The sortable hour is addressed by its accessible name (*"9am hour"*): the select's option text would otherwise match every `hasText` filter in `dragWithKeyboard`. |
| Remove merges up | removing a divider puts its tasks in the block above |
| Move to top, Send to bottom | across hours and baseline rows. **No test covers these buttons today**, in either meaning. |
| Baseline drags freely | the converted `:1091` |
| The line and the dimming | `timezoneId: 'Asia/Tokyo'` with `page.clock.setFixedTime('2026-01-15T16:30:00Z')` — 11:30 in New York, 01:30 on the device. The line is under 11am, 9am's tag is dimmed, 2pm is neither: the stored zone wins over the device's. |
| The line moves | `page.clock.install` at 16:59:30Z, then `runFor('01:00')` |
| No line while reordering | |
| No console errors | `day.spec.ts:1269` extended with a seeded hour and an add and remove in Reorder — catching duplicate React keys and dnd-kit id mistakes |

`reorderNames` learns to read hour labels, and `Seed.day`'s `task_order` type
widens past `number[]` (`fixtures.ts:84`); `seed-cli.ts` already stringifies.

---

## Not in this iteration

**Minutes.** Hours only. A divider at 9:30 is a different feature and a much
denser list, and nothing about the ask needs it.

**Hours on future panes or in the Backlog.** Reorder is today-only and stays so.
Planning Thursday hour by hour on Tuesday is a different thing from laying out
the day in front of you, and the Backlog is an inventory rather than a day.

**Carrying a shape forward.** Argued and declined above. The fix is recorded
there if it grates.

**Tidying the hours once everything is done.** With nothing outstanding, Reorder
is switched off, so the dividers stay above the done block, empty, until
something is added or the day turns over. Tomorrow starts blank anyway; hiding
them was offered and is not worth the line.

**Recording the hour a task was done.** The timeline is a plan, not a record. The
Tracker knows the day; nothing knows the hour, and giving it one means a column,
a migration, and a second meaning for every completion ever written.

**A notification when an hour arrives.** No service worker, no push, no
background anything. The line moves when you look at it.

**Per-user moods, a mood editor, an export UI, a cancel on the log.** Unchanged
and still deferred.
