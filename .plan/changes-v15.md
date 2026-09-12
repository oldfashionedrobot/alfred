# v15 — To do, and the panels become a track

The Day screen becomes **To do** and stops being three stacked things. One list
of today that holds its own completed rows, one horizontal track of the six
cadence groups underneath it, and the mood behind a button that wears it.
History becomes **Tracker** and fills the window.

Nothing here touches the data model. There is no migration, no new command, and
no new endpoint — `DayView` changes shape and `sortTasks` grows two bands, and
that is the whole server half. Reading a day that is not today, and writing to
one, are [v16](#not-in-this-iteration).

The screen is renamed because it stopped being a day some time ago. v8 deleted
the Week view and hung the rest of the week off `/api/day` as panes; since then
"Day" has named a surface that shows seven of them. The panels below it are the
same inventory a second time, split into two accordions that are collapsed by
default — which is to say the complete list of everything you have to do is two
taps from view and drawn in the least prominent part of the screen.

---

## Decisions

**Day becomes To do, History becomes Tracker — labels only.** `/api/day`,
`/api/todo`, `DayView` and `TodoView` keep their names. Renaming through the
stack would touch every browser spec and both reference documents to change no
behaviour. The obvious objection is that "To do" is already the name of the
panel this iteration dissolves — which is exactly why the collision does not
survive: after v15 there is no To do panel, only a category track, and the name
is free.

**Backlog is promoted; one-off is relabelled.** Two words move at once and the
doc says which is which, because both end up on screen meaning different scopes:

| | |
|---|---|
| **Backlog** | the heading over the whole six-group track — everything that is not today. Previously it named the one-off panel alone. |
| **Any time** | the label on the `cadence: null` group inside it. Previously "One-off". |

`cadence: null` stays **one-off** in the model, in `period.ts`, `schema.ts` and
both reference documents. The model word and the label are allowed to differ;
the model word is in four places and the label is in one constant.

**Completed stops being its own section.** A completed row is already struck
through and already carries a ticked box — a second signal, a heading and a
separate list say the same thing a third time, and split the answer to "what is
left?" across two places. One list, with done sunk to the bottom. The section
was cheap to keep and is cheaper to delete.

**The surviving section takes its name from its own heading.** The two sections
being merged are labelled `aria-label="Active tasks"` and
`aria-label="Completed tasks"`, and the first of those already disagrees with the
`<h2>Today</h2>` inside it — two names for one thing, drifted apart. The merged
section drops `aria-label` for `aria-labelledby` pointing at the heading, so the
region is called **Today** to a screen reader and to a person reading it, and
cannot diverge again.

**The list sort gains a done band and a category tie-break.** This closes the
gap between Day's ordering and the panel's, which today disagree in two ways:
Day ignores `category` entirely, and has no notion of a done row sinking because
done rows were not in the array. After v15, `sortTasks` compares:

```
done          →  a done task sinks, whatever else is true of it
is_baseline   →  bands never mix
task_order    →  the manual arrangement, where one exists
category      →  uncategorised last
name
```

Done outranks baseline deliberately, and not for the first time:
[`byBand`](../src/server/views/todo.ts) already sinks a done baseline task below
live ones, on the grounds that a struck-through row at the top is not what "the
bare minimum to function" should look like. The same argument applies here, so
the same order does.

**`sortTasks` and `byBand` stay two functions.** They are closer after this than
before it, and still not the same: `byBand` has overdue, placed and unplaced
bands that Day does not want, and no `days.task_order`, which is the whole point
of Day's. Folding them would produce one function taking flags to switch off
half of itself.

**Overdue stays inline.** The panel bands overdue rows to the top; Day marks
them and leaves them where they fall, because Day is a list you work down and
the badge is the signal. That is existing, tested behaviour and v15 does not
disturb it — the only new band is done.

**Every tick checks before the server answers, on every surface.** `complete`
and `uncomplete` are round trips to a machine that may have just woken from
scale-to-zero, and today the box does not move until one lands. One set of ids
with a command in flight, held by the screen and passed down, renders those rows
as checked — ticking and unticking, today's list and every group pane. Four call
sites, one mechanism; a box that behaves differently in the panel than in the
list would be worse than the latency.

On failure the id is dropped and the notice bar says what happened, which is the
behaviour a failed command already has.

This is the second thing the client holds that it did not derive from a model —
`orderIds` is the first — and it is named here so it stays the second. It is not
a general optimistic layer: nothing else is predicted, and the model is still
replaced wholesale on refetch.

**The re-sort waits for the refetch.** The two changes above fight if both are
immediate: check the box optimistically *and* sink done rows locally, and the
row leaves from under the finger that tapped it. The box fills at once; the row
moves when the new model arrives. This is the one place the screen is
deliberately a frame behind itself.

**A manual arrangement records the list as it reads.** Reorder mode shows only
the not-done rows — you arrange what you are doing — but the saved order is the
whole rendered list: the rearranged rows, then the done ones after them.

```
task_ids: [...reorderedNotDone, ...doneIds]
```

One concat, no merge logic, no server change: `set_task_order` stores the array
opaquely and is already "tolerant of stale ids", so nothing validates
completeness. Sending only the not-done half instead would quietly drop every
done task's id, and today [`buildDayView`](../src/server/views/day.ts) sorts the
completed array with the *same* `task_order` — so a task you tick and untick
currently returns to its place, and would stop.

The consequence, recorded rather than hidden: a task you tick moves to the end
of the stored order, so unticking it later returns it to the bottom of your
arrangement rather than its original slot. Preserving the slot means splicing
the new sequence around the done ids' indices — real logic, for a row you have
already finished.

**Routine and Backlog become one track of six.** The same paging the week
already uses, with a button per group instead of per day:

| | |
|---|---|
| Any time | `cadence: null` — first, because it is where capture lands |
| Daily | |
| Weekly | |
| Monthly | |
| Quarterly | |
| Yearly | |

Six groups in two collapsed accordions becomes six groups one swipe apart. The
cost is that only one group is visible at a time, where Routine previously
showed five stacked — accepted, because five stacked groups is what made the
panel long enough to need collapsing in the first place.

**Reset to backlog moves onto the Backlog heading.** It has nowhere else to go:
it renders today only under `kind === 'periodic'`, inside the panel this
iteration dissolves, and it is the only bulk clear for overdue placements. On a
heading that names the whole track it is also finally in the right place —
`Todo.tsx` records that the control's count deliberately spans the whole view
while living in one panel, which once made it offer to clear "0 overdue items"
and then clear two. Scope and label now agree. The `KIND` map and every
`kind === 'periodic'` test go with the move.

**The track's mechanics are shared; its buttons are not.** The snap scrolling,
the index read back off `scrollLeft`, and the prev/next stepping are identical
for days and for groups, and become one hook and one pair of CSS classes. The
buttons are not identical — the day strip carries a today marker, disables the
days already past, and names itself "Saturday, 3 tasks"; the group strip does
none of those. Two small components over one with four flags, for the reason
`byBand` gives for not being `sortTasks`.

**Panes size themselves rather than stretching.** A flex row with no
`align-items` stretches every pane to the tallest, which across days is mild and
across six cadence groups is not — "Any time" holding a forty-item backlog would
set the height of "Yearly" holding one. `align-items: flex-start` on the track.
The page's own height then changes as you page between groups, which is
invisible here: the track is the last thing in normal flow, and the FAB and the
notice bar are both `position: fixed`.

**Mood and log move behind a button that wears the mood.** They are a once-a-day
gesture at the end of the day, sitting permanently in the middle of a screen used
all day long. The button opens the existing `Sheet` — and renders the selected
mood's emoji, falling back to a neutral glyph, because hiding the row otherwise
hides whether today has a mood at all. The accessible name says it rather than
leaving an emoji to carry the meaning: `Mood and log — balanced`, or
`Mood and log — none set`.

The button inherits the freeze `MoodAndLog` already has during a reorder: a mood
tap refetches, and reconciling `orderIds` against a fresh model drops rows.

**Icons are glyphs, not a dependency.** `Add task`, `Reorder` and `Edit` become
icon buttons using the same approach already in the codebase — a glyph in an
`aria-hidden` span with an `aria-label` on the button, as `☰`, `✎`, `≡` and
`‹ ›` already do. No icon library, no new package.

**One bug this iteration introduced, found by running it.** Both surfaces
declared the CSS anchor name `--pick-<id>` for their day picker. That was safe
only while the backlog was collapsed and the two could never be in the document
together; rendered at once, one name resolved to two elements and Day's picker
anchored to the backlog's button somewhere down the page, where it could not be
clicked. Anchor names are namespaced per surface — `--pick-day-` and
`--pick-group-`. Worth recording because nothing in the type system or the plan
would have caught it: it took a browser.

**The day strip renders on a Saturday.** Today it does not: `placeable_dates` on
a Saturday is one date, `upcoming` is therefore empty, and
[`Day.tsx`](../src/client/views/day/Day.tsx) hides the strip behind
`view.upcoming.length > 0`. One day in seven the week navigation disappears
entirely, which reads as breakage rather than as the deliberate "one pane, no
special case" it was. `week_dates` already ships all seven days and `DayStrip`
already disables the ones past, so the fix is deleting the guard: on a Saturday
the strip then shows one enabled button, six disabled, and both arrows disabled.
v16 gives the next arrow somewhere to go.

---

## Server

### `DayView` carries one array

| before | after |
|---|---|
| `active: DayTask[]` | `tasks: DayTask[]` — one list, sorted, done last |
| `completed: DayTask[]` | *gone* |

`DayTask` gains **`is_done: boolean`**, which `TodoTask` has carried since the
first commit. Membership of today is unchanged — the same union of four
independent rules in [`day.ts`](../src/server/views/day.ts), which must stay a
union and not a chain. What changes is that `is_done` decides how a member
*renders* rather than which array it lands in.

`upcoming` panes still drop period-satisfied tasks rather than striking them
through, so `is_done` is always false there. It is carried anyway, like `state`
and `effective_date` already are, rather than splitting the type.

### `sortTasks` takes the new bands

[`sort.ts`](../src/server/sort.ts) gains the two comparisons above. Its type
constraint widens by one column and one derived field — `is_done` is not on
`TaskRow` and cannot come from a `Pick`:

```ts
sortTasks<T extends Pick<TaskRow, 'id' | 'name' | 'is_baseline' | 'category'> & { is_done: boolean }>
```

It is called once per list now instead of twice — there is no second array to
sort independently. `buildUpcoming` calls it too, so `toDayTask` sets `is_done`
for future panes as well, where it is always false.

### `TODO_GROUPS` is reordered and retitled

In [`shared/types.ts`](../src/shared/types.ts), one constant, driving both the
server's group order and the strip's buttons:

```
{ cadence: null,      title: 'Any time'  }
{ cadence: 'day',     title: 'Daily'     }
{ cadence: 'week',    title: 'Weekly'    }
{ cadence: 'month',   title: 'Monthly'   }
{ cadence: 'quarter', title: 'Quarterly' }
{ cadence: 'year',    title: 'Yearly'    }
```

The titles change from period phrases to cadence adjectives because they are now
strip buttons and have a phone's width to share. The period range still renders
beside the group heading, where `periodLabel` already puts it — "Weekly ·
6 – 12 Sep 2026" says more than "This week" did.

---

## Client

### The To do screen

```
┌─────────────────────────────────────┐
│ Saturday, 12 September         😑   │  ← wears today's mood; opens a Sheet
├─────────────────────────────────────┤
│  ‹  S  M  T  W  T  F [S]  ›         │  ← day strip, all seven, always
├─────────────────────────────────────┤
│ Today                    ＋   ↕     │  ← add, reorder
│  ☐ Feed the dog                 ✎   │
│  ☑ M̶a̶k̶e̶ ̶t̶h̶e̶ ̶b̶e̶d̶                    │  ← done, sunk, in the same list
├─────────────────────────────────────┤
│ Backlog          [Reset to backlog] │  ← the whole track, and its one control
│  ‹ [Any time] Daily Weekly … ›      │
│  one group's tasks                  │
└─────────────────────────────────────┘
```

### One screen, one set of state

`Day.tsx` and `Todo.tsx` today each mount a `TaskEditor` and each hold an
`editingId` and an open-picker id; `Todo.tsx` additionally holds `open`,
`pending` and its own `run`. With the panel becoming a pane of the screen that
already hosts it, all of that collapses to one of each — one editor, one picker
id, one editing id, one `run`, and the one in-flight set the optimistic tick
needs. This is the fiddliest part of the refactor and the largest single
simplification in it.

### What moves

| | |
|---|---|
| `views/day/Day.tsx` | the Completed `<section>` is deleted; `rows` comes from `view.tasks`; the two `<Todo>` instances become one `<Backlog>`; `MoodAndLog` moves into a `Sheet` behind a button; the editor, picker and in-flight state consolidate here |
| `views/day/PagedTrack.tsx` | new — `usePagedTrack()` plus the track wrapper, lifted verbatim out of `Day.tsx` |
| `views/day/DayStrip.tsx` | keeps its buttons, loses the scroll mechanics to the hook |
| `views/day/GroupStrip.tsx` | new — six buttons, each with a not-done count |
| `views/Todo.tsx` | the accordion shell, the `KIND` two-panel split and the header counts go; what survives is `TodoRow` and the group rendering, now a pane, under a `Backlog` heading carrying the reset control |
| `views/day/TaskRow.tsx` | the `Edit` button becomes an icon; a done row renders struck through |
| `views/day/DragBand.tsx` | two icon buttons per row |
| `styles.css` | `.day-track` / `.day-pane` become `.track` / `.pane`, with `align-items: flex-start`; `.sheet` gains a desktop centring rule |
| `views/day/MoodAndLog.tsx` | unchanged internally; rendered inside a `Sheet` |
| `views/day/CaptureSheet.tsx` | two hint strings send people to "the Routine panel" and "the Routine or Backlog panel" for a cadence or a day. Both name surfaces that stop existing. No test asserts this copy. |

`.day-pane` carries `position: relative` and it is **not** decorative — the `.sr`
span inside a static tick is `position: absolute`, and with no positioned
ancestor it lands at the pane's document x, outside the track's clip, stretching
the page body sideways. It was caught by the body-never-scrolls-sideways test at
410px against a 390px viewport. The rule comes across to `.pane` with its
comment intact.

The counting the strips do — how many rows in a group are not done — is a count
for a label, not derived state. `Todo.tsx` already does exactly this and says so.

### Reorder mode gains two buttons

Move to top and send to bottom, per row, **within the row's own band**. Bands
never mix, and these two obey that the same way a drag does: top means the top of
the baseline band for a baseline task, and the top of the rest for everything
else.

The row keeps its whole-body drag handle. The reason for that decision —
"nothing else on a row is interactive, so there is nothing for a drag to be
confused with, and no separate grip to aim at on a phone" — half survives: the
premise is now false, but the conclusion still holds on a phone, where a grip is
a worse target than a row. The two buttons call `stopPropagation` on
`pointerdown` instead, which is a smaller change than moving the listeners to
the grip and losing the large target.

### The Tracker fills the window

The grid is not capped by the table — it is capped by `.app`, which is
`max-width: 720px` for reading width, and by fixed column widths. Two changes:
the Tracker view opts out of the `.app` cap, and the task columns take a minimum
rather than a width, so the table hands them its spare room.

**Correction found while building this.** Task columns are pinned at `30px`, not
`74px` — `74px` is the DATE column, which stays pinned. The floor still has to be
`74px` rather than `30px`, for a reason the arithmetic only gives up when you do
it: at 1280px with the cap lifted the grid is ~1233px wide, and the 24 seeded
columns in *"the grid scrolls sideways in its own box"* would total 862px, so the
box would stop scrolling and that test would fail. The cost is real and is
recorded in the CSS: a phone shows about three task columns where 30px showed
seven.

This is a deliberate exception to a global decision, and the only view that takes
it. A grid of days by task is the one screen here that is better wide.

---

## Accessibility

v12 closed WCAG 2.2 A and AA and this must not reopen it.

- Every icon button carries an `aria-label` and a `title`. Losing the visible
  text costs discoverability, which the tooltip buys back on a pointer device.
- Targets stay at `--tap`, 44px — including the two new reorder buttons, which
  are the smallest things added here.
- The merged list's region is named by its own `<h2>`, via `aria-labelledby`.
- The group strip is a `<nav>` labelled `Backlog groups`, with `aria-current` on
  the showing group — exactly as the day strip's `Days of this week` is. Each
  button names its count, because the badge is `aria-hidden` and "Weekly, 3
  tasks" is the point of it.
- The mood button's name carries the mood, so the emoji is never the only signal.
- The mood sheet is the existing `Sheet`: `role="dialog"`, `aria-modal`, Escape
  and the scrim both close it. Focus returns to the button that opened it.
- A done row's strike-through is not the only signal — the checkbox carries
  `aria-checked`, as it does now.
- The optimistic tick sets `aria-checked` immediately, which is the honest
  reading: the box is checked, and the row has not been told otherwise yet.

---

## Tests

| | |
|---|---|
| Unit | `sortTasks` sinks done below live, done below baseline, and orders by category before name; `buildDayView` returns one array with `is_done` set; `TODO_GROUPS` order |
| Browser | a completed task stays in the list at the bottom rather than moving to a section; the box shows checked before the command resolves, and reverts on a refusal, on both the list and a group pane; a saved arrangement keeps the done rows' ids; move to top and send to bottom cannot cross the baseline band; the group track pages through six groups and each button carries its count; reset to backlog works from the Backlog heading; the mood button shows today's mood and opens the sheet; the day strip renders on a Saturday |

### What the rewrite actually costs

Smaller than the raw counts suggest in one file and larger in the other.

**`day.spec.ts` — mostly absorbed.** 46 call sites reach the two regions through
`activeNames` / `completedNames` at [line 89](../e2e/day.spec.ts), which already
strip a `Complete ` or `Untick ` prefix off each tick's label. That prefix
encodes doneness, so with one region holding both, the two helpers partition on
it and **the 46 call sites do not change**.

One test in it does not survive re-anchoring: *"Day offers no reset-to-backlog
control of its own"* asserts the control is absent from this screen, on the
grounds that it lives in the panel. v15 puts it on the Backlog heading, which is
on this screen. The test inverts — it should assert the control is on that
heading and nowhere else.

**`todo.spec.ts` — not absorbed.** 57 references bind to `Routine` and `Backlog`
as two separate panels with accordions. That structure stops existing, and there
is no helper standing in front of it.

**`views.test.ts`** — 33 lines touch `.active` / `.completed`.

### The suite's coverage moves with the weekday

Both suites test against the real `today()`, so what runs depends on the day it
is run. This is not incidental to v15 — it lands on the two files that carry all
of the gating.

| | |
|---|---|
| `views.test.ts` | 12 tests gated on the weekday. **6 skip on a Saturday**, 2 midweek, and a different 5 on a Sunday. It is also the file that covers `buildDayView`, whose shape v15 changes. |
| `day.spec.ts` | six tests carry `test.skip(day.upcoming.length === 0, 'on a Saturday there is one pane and no strip')`. Run on Saturday 12 September: **12 skipped, 52 passed** — 19% of Day's browser coverage dark. Across both Chrome projects that is **24 of 294 skipped**, and every one of them is this file. |

Deleting the strip guard makes three of those skip reasons false and all six
worth revisiting; the ones that skip because there is genuinely nowhere to go
(`next === null`) stay correct. The Saturday case then deserves an explicit test
rather than an absent skip.

The practical consequence for doing this work: **on a Saturday the strip and
upcoming-pane changes cannot be verified by running the suite** — the tests that
would catch a regression are the ones that skip. Either do that part on another
day, or convert the six skips to seeded-date tests first so they run every day.

---

## Not in this iteration

**v16 — time travel.** The two changes that touch the model, kept together and
kept out of here:

- **Paging To do into future weeks.** The strip gains week stepping and
  `/api/day` learns to answer for a week that is not this one, while `date` stays
  today and every write still lands on today. This is not a reversal: v8 settled
  it when it added the panes — *"There is no `?date=` parameter and `GET /api/day`
  still means today: the same-day-only rule protects WRITES, and it does that in
  commands.ts, so a read parameter was never what it guarded against."* Forward
  only; the past belongs to the Tracker.
- **Editable Tracker cells.** A dated completion command, bounded to daily tasks
  and to dates not in the future. The grid shows only `cadence: 'day'` tasks,
  whose period is exactly one day, so a dated completion carries no period
  ambiguity — which is what makes this narrow enough to be worth doing. It
  retires "History is read-only" and puts a clause on *the history records when
  things were marked*, in the README and in
  [`architecture.md`](architecture.md).

**Past panes on To do.** Deferred with v16 and probably for good: the Tracker
already shows every past day, and a second way to look at one is not obviously
worth a read-only pane that refuses every gesture on it.

**Preserving a done task's slot in the manual order.** Declined above.

**Folding `byBand` into `sortTasks`.** Declined above.

**Per-user moods, a mood editor, an export UI, backups beyond Turso's one day.**
Unchanged and still deferred.
