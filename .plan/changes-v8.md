# Household Tracker — Changes v8

Continues [`changes.md`](changes.md), which runs v4 → v7. Same rules: what changed,
why, and what it cost, including the decisions it reverses.

Two changes, both to the client surface, both made before the first deployment so
that what goes out is the shape we intend to keep.

---

## Day absorbs Week

**What.** The Week view is deleted. Day's task list becomes a horizontal track of
day panes — today through Saturday — that you swipe through. Today's pane is the
Day view exactly as it was. The other panes show what is placed on that date, and
nothing else.

**Why.** Week was a planning surface showing seven day sections and the To do
panel. Day was a doing surface showing today's list and the same To do panel. Two
screens, one panel, and the only real difference was how far ahead you could see.
The question Week answered — *how loaded is Thursday?* — is one you ask while
looking at today's list, and switching screens to answer it lost your place.

### The model: one new field, no new endpoint

`DayView` grows `upcoming`:

```ts
interface UpcomingDay {
  date: ISODate
  tasks: DayTask[]     // planned_date === date
}
```

`upcoming` covers tomorrow through Saturday. The panes are `placeable_dates` —
today through Saturday — which the day model already shipped for the reschedule
picker. **The track's range and the day picker's range are now the same list from
the same derivation**, so they cannot drift apart, which is why `placeable_dates`
was put on this model in the first place (D3 in `design/review-findings.md`).

On a Saturday `placeable_dates` is one date and `upcoming` is empty: one pane,
nothing to scroll, and the screen is what it was before this change. That is the
degenerate case falling out rather than a branch written for it.

**There is no `?date=` parameter, and `GET /api/day` still means today.**
`design/api.md` has no endpoint accepting a date meaning "the day to render", and
`today.ts` stays the only place in the codebase that reads the clock. Worth being
precise about why that rule survived, because it looked like the obstacle here:
the rule protects **writes**, and it does so in `commands.ts` — `complete` inserts
`completed_on: today()` and accepts no date, so a read parameter would never have
weakened it. It survived because it was not needed, not because it could not have
been broken safely.

`UpcomingDay.tasks` is `DayTask[]` rather than a narrower type. Every upcoming row
is `state: 'planned'` and its `effective_date` equals its `date`, so two fields are
predictable rather than informative. Carrying them anyway means **one row
component renders every pane**, which is the point of merging the screens; a
second task shape would have rebuilt the split inside one file.

### Future panes show placed tasks only

No daily tasks. A daily task is on every day equally, so repeating it across the
panes makes them look identical and buries the one thing a pane exists to show —
what *you* put there. The panes are for reading load while placing, and a daily
task contributes nothing to that reading because it contributes the same amount
everywhere.

This needs no filter. A daily task can never hold a `planned_date`: `create_task`
writes null for one and `update_task` clears it when the cadence changes to day.
So `planned_date === date` excludes dailies structurally, and `buildWeekView`'s
explicit `cadence != 'day'` clause is not carried across.

The cost is that a future day looks lighter than it will be. Accepted: the question
is *"what have I committed to Thursday"*, not *"how many boxes will Thursday have"*.

Ordering on a future pane is `sortTasks(tasks, null)` — baseline band, then name.
`days.task_order` is per-day and only today's exists.

**A task already satisfied for its period is not shown on a future pane either.**
Place a weekly task on Thursday, then tick it on Monday from the Routine panel —
which you can, the panel has ticks — and Thursday's pane would otherwise show it
as outstanding. It is filtered by `isDone`.

This is the only place in the app where doneness removes a row rather than moving
it or striking it through, and that is deliberate. `WeekTask` carried an `is_done`
flag and struck the row; `DayTask` has no such field, because today's pane says
the same thing by which array a task is in. Reproducing it here needed either a
second array on `UpcomingDay` or a flag on `DayTask` that today's pane already
answers — two sources of truth for one fact, which is the shape of the D1 defect.
Filtering needs neither, and it matches what the panes are for: a done task adds
no load to Thursday, so leaving it there overstates the day.

The cost is that a task placed on Thursday and finished early is not on Thursday.
It is in the Routine panel, struck through, with its date against it.

### What a future pane can do

- **No completion.** The tick renders disabled, keeping the row's shape and rhythm
  identical to today's. Nothing writes to a date that is not today, which was
  already true and is now visible.
- **Move and Unplan**, opening the same `DayPicker` over the same
  `placeable_dates`, posting the same `place` and `unplan` commands. This is
  `WeekRow`'s behaviour moving into Day's row rather than being written again.
- **No reorder.** The arrangement lives on today's `days` row and there is no such
  row for a future date.

Today's pane is unchanged: its tick, its Reorder toggle, and the "Give it a day" /
"Unplan" actions on an overdue row.

**The reset bar is not on a pane at all.** It lives in the Routine panel, is scoped
to the whole view, and sits below the track — see the note at `Todo.tsx`'s tally,
which is where v5 put it and why. It is unaffected by which pane you are looking at.

### The track is CSS; the strip is nine buttons

`scroll-snap-type: x mandatory` on the track, `scroll-snap-align: start` on the
panes. Native momentum, native swipe, no library and no gesture handling of our
own.

**One pane at any width.** An earlier draft gave panes a fixed basis so that a
wide screen showed five or six at once, reusing the breakout from the 720px shell
that `week.css` used for its seven columns. Built and looked at, that is too much
to read at once: the pane you are on stops being obvious, and the screen turns
back into the week grid this change exists to replace. Panes are 100% wide on
every viewport and the breakout is deleted.

**A strip of nine buttons sits above the track**: previous, seven days, next.
This also reverses the draft, which had no strip on the argument that with
several panes visible "the selected pane" has no answer. With one pane visible it
has exactly one, so that argument expired along with the multi-pane layout.

**All seven days are rendered, and the ones already past are disabled** rather
than left out. The strip is then the same width all week instead of shrinking day
by day, and a greyed button says plainly that a past day is not somewhere you can
go — the one thing a strip holding only the remaining days could not say.

That costs a field. `placeable_dates` is today through Saturday, so the server
also ships **`week_dates`**: all seven, Sunday first. **This reverses one of the
simplifications below** — `weekDates()` was to become local to `completions.ts`
once `buildWeekView` stopped calling it; instead it stays exported and has one
caller again. What does not change is that the client derives no dates.

**Which pane is showing is read back off the scroll position** rather than held
as the source of truth. A button scrolls the track, the track's scroll handler
sets the index, the strip renders from the index. A swipe and a button press then
agree by construction instead of by being kept in step, and there is no second
copy of "where am I" to drift. It is the same reasoning as `can_complete`: ask
the thing that knows.

`design/tech-stack.md` rejected drag-and-drop as "fragile touch-event code"
before v4 reversed it with a library; this is the same worry answered a third
way, by using scroll behaviour the browser already has.

**The track is as tall as the tallest pane**, which is nearly always today's, so
a light Thursday leaves whitespace below its one row. That is the trade taken
rather than a thing left unfinished: the alternative is a track that resizes to
whatever pane you are on, which makes the Routine and Backlog panels below it
jump up and down every time you flip a day. A stable page that is sometimes empty
beats a page that moves under your thumb.

**The track locks during a reorder.** Reorder is today-only, so there is nothing
to swipe to, and a `dnd-kit` context inside a snapping scroll container is
exactly the interaction that produced two wrong fixes in v4. `overflow-x: hidden`
while the edit state is open removes the interaction rather than debugging it.

### Everything below the track stays put

Routine, Backlog and the mood/log section sit below the panes and do not move with
them. The panels are period-scoped, so they are correct on any pane; mood and log
are today's and stay visible on every pane rather than appearing and disappearing
as you swipe. **The pane itself carries the distinction** — today's heading names
it, and a future pane's disabled ticks say the rest. A section that vanishes when
you swipe is a worse signal than one that is plainly labelled.

**The panels stay collapsed by default.** Week opened them expanded on the grounds
that "on this screen the panel IS the planning surface"; Day is now the only
surface, so that argument would carry over automatically. It is declined: Day's
first screen is the day's list, and two expanded panels above the fold would push
it down for a gesture that costs one tap.

### What it deletes

| removed | lines |
|---|---|
| `src/server/views/week.ts` | 72 |
| `src/client/views/Week.tsx` | 231 |
| `src/client/views/week.css` | 188 |
| `e2e/week.spec.ts` | 611 |
| `describe('buildWeekView')` in `tests/views.test.ts` | 94 |
| `WeekView` / `WeekTask` / `WeekDay` in `shared/types.ts` | 30 |
| `GET /api/week`, `getWeek()`, the Week tab in `main.tsx` | ~8 |

About 1,230 lines, against roughly 160 added across the day model, `Day.tsx` and
`day.css`. The tests in `week.spec.ts` covering move, unplan, the picker's
contents, and same-day-only completion move into `day.spec.ts` against the new
panes; the ones covering Week's seven-section structure and its responsive layout
go with the structure.

`can_complete` disappears with `WeekTask`. It existed so the client would not infer
writability from `is_past`; with one screen, pane zero is today and the question
does not arise.

**This reverses `design/views.md`**, which has Day and Week as two surfaces with
distinct jobs — "the doing surface" and "the planning surface". The split was real
when Week held Overdue, Unplaced and Backlog sections. v5 moved all three into the
Routine and Backlog panels, and what was left of Week was seven lists. This change
finishes what v5 started rather than contradicting it.

### What it gives up

Three things go, and each is a deliberate trade rather than an oversight.

**An overdue task no longer renders on the day it was placed.** Week showed past
days, so a task placed last Tuesday still appeared in Tuesday's section, read-only.
The panes start at today, so an overdue task now appears only on today's pane,
marked overdue, with its original date in the badge. One place instead of two, and
the badge already carried the date.

**The To do panel loses its second host.** "Hosted by Day and by Week, identical in
both" is asserted in four comments — `shared/types.ts`, `server/views/todo.ts`,
`client/views/Todo.tsx`, `client/views/todo.css` — and proved by four tests in
`todo.spec.ts` that switch to Week and re-check the panel there. Two of those tests
exist *for* the dual host: that both panels open expanded on Week, and that a
command fired from the panel refreshes the host. The comments are corrected and
those tests reduce to their Day halves. What the property was protecting — that the
panel holds no host-specific state — is now unobservable, which is the honest
consequence of there being one host.

**On a phone you can no longer see the whole week at once.** Week stacked seven
sections vertically; the panes show one at a time. Flicking through them is the
gesture this change was asked for, and on a wide screen every day is visible again,
but a phone now trades the overview for the depth.

### What it simplifies

Removing a screen removes things that only existed because there were two.

**`weekDates()` stops being shared** — *and then does not.* With `buildWeekView`
gone it had one caller in its own file and was made local; the day strip then
needed all seven dates, so it is exported again as `DayView.week_dates`. Recorded
as a reversal rather than quietly restored: the simplification was real and the
strip is what undid it. What did change is the module's header, which claimed to
serve "every view builder" and now serves two.

**`defaultOpen` is deleted from the To do panel.** Week held the only `true`.
Every remaining call site passes `false`, so it is a required prop encoding a
constant; `useState(false)` inside instead.

**One data-loading implementation instead of two.** Day loads with `useEffect`, a
`reloads` counter and a local `alive` flag; Week loads with `useCallback`,
`useRef(alive)` and `load(first)`. The same job — fetch both models, replace
wholesale, fatal on first load and a notice on a refetch — written twice in two
shapes, which is the "twins" pattern `design/review-findings.md` names. It
resolves by deletion. Day's version stays exactly as it is; nothing is carried
across from Week's.

Considered and left alone: `placeable_dates` now rides on both `DayView` and
`TodoView`, fetched by the same component. Both come from one `placeableDates()`
call so they cannot disagree, and having the panel read the day model instead
would grow its prop surface to save seven strings.

### A daily task says so

Day's rows carry one piece of metadata beside the name: the cadence word, for
`week`, `month`, `quarter` and `year`. `day` was excluded, on the reasoning that
a daily task is the ordinary case on a screen headed "Today" and does not need
labelling.

It does. The unlabelled case was doing double duty — a daily task and a one-off
placed today both rendered as a bare name, and those are the two ends of the
model. `day` now gets its word like every other cadence, and a blank means
one-off and only that.

---

## Bulk capture

**What.** The capture sheet gains a **One / Many** toggle. *Many* swaps the name
input for a textarea: one task per line, created in a single write.

**Why.** Getting a list out of your head is a different activity from defining a
task. Ten items typed one sheet at a time is ten open-type-submit-reopen cycles,
and the friction is enough that the list stays in your head.

### `create_tasks`

```
POST /api/commands/create_tasks   { names: string[] }
```

Names are trimmed, empty lines dropped, duplicates within the batch collapsed, and
the batch capped at 100. A body whose lines are all blank is a `BadRequest`, the
same answer `create_task` gives an empty name — creating nothing and reporting
success would be worse. Everything else defaults: no cadence, not baseline, no
date, no category — exactly a backlog item, which is what "edit it properly later"
means. One multi-row insert.

**Duplicates against existing tasks are not checked.** Nothing else in the model
treats a name as unique, and adding that here would be a rule with one enforcement
point. Collapsing repeats *within a paste* is different — it is one gesture that
obviously meant one task.

**A command rather than a loop.** The client could post `create_task` N times with
no server change at all. Against that: N sequential round trips against a machine
that under scale-to-zero may have just woken; and a failure at item seven leaves
four created, three not, and nothing sensible to say about it. Fifteen lines buys
one write and one refetch.

**This is not `capture` coming back.** v4 deleted the `capture` command because
`create_task` with a name and nothing else already did the same thing, and two
commands doing one thing was one too many. `create_tasks` does something
`create_task` cannot express at all.

### The toggle

*Many* hides the *More* disclosure. Cadence, category, baseline and colour are
per-task judgements, and applying one answer to eight pasted lines would be wrong
more often than right. Validity in this mode is "at least one line survives
trimming", not `draftIsValid`, which describes the single-task draft. The submit
button counts what it will do — "Add 6 tasks" — off the same parse the command
will receive, so the split is visible before it happens.

*One* is untouched and remains the default: the fast path stays one tap in, type,
one tap out.

---

## A dead field goes too

`DayView.has_overdue` is computed by `buildDayView` and read by nothing. The
Routine panel's reset bar is driven by `TodoView.has_overdue`; Day's copy is a
leftover from before v5 moved that control into the panel, and it has been on the
wire ever since without rendering anything.

It is removed, along with nine assertion sites across `day.spec.ts`,
`harness.spec.ts` and `views.test.ts` that checked a field no screen consults.
Every one sat beside a richer assertion about `active`, `completed` or a row's
`state`, so nothing lost coverage; the one exception is the test that Day offers
no reset control, where the precondition now reads `TodoView.has_overdue` — the
flag that actually drives the control, which is more accurate than what it replaced.

This was planned as its own commit and is not one. The same three test files were
being rewritten for the merge, so the two changes interleave line by line inside
them and separating the commits would have meant unpicking hunks rather than
splitting files. Recorded rather than left as a plan that quietly did not happen.

---

## Documentation this makes wrong

`design/` is frozen and `changes.md` is where changes are recorded, so the design
docs are not being edited. Two specific staleness points are worth naming, because
they are the kind that mislead rather than merely lag:

**`design/api.md` documents `GET /api/week`**, an endpoint that no longer exists.
**`changes.md`'s own header contradicts itself** — it says `design/` is "frozen and
no longer updated" and then, two lines later, that `design/views.md` and
`design/api.md` are "always current". Both cannot be true, and after this change
the second is plainly false. The header is corrected to say what is actually the
arrangement: the design docs describe the first build, and the change logs are the
current state.

---

## Two defects found on the way

**A visually-hidden label was scrolling the page sideways.** `.sr` — the
screen-reader-only text inside a static tick — is `position: absolute`, and had
no positioned ancestor, so its containing block was the initial one. On a pane
scrolled off to the right that put it at the pane's *document* x, outside the
track's clip, and the page body grew by its width: 410px against a 390px window
on the narrow viewport. `.day-pane` is now `position: relative`, which puts the
label back inside the scroller where overflow can clip it.

Worth recording because the bug is invisible in every obvious sense — a 1px
element with `clip-path: inset(50%)`, in a pane you cannot see, moving a scrollbar
by twenty pixels. The rule that caught it is the one `views.md` has carried since
the first build: **the page body never scrolls sideways.** It was asserted for
the new track for exactly that reason and found this on the first run.

**History's browser tests had been failing since v6, and nothing said so.** v6
added the log column to the grid and moved it left of the date; the suite's `cells()`
helper still assumed the mood cell came first, so every expectation in the file
was short by one and the whole suite was red. Two more assertions indexed cells
positionally and had the same off-by-one.

The helper now drops the leading log cell — which has its own tests, and holds a
control rather than a value — so the thirteen expectations it feeds read as
before. This is not a v8 change and is committed separately, but it is the second
time a column has been added without its tests: `e2e/` going untypechecked was
the first, in v4.

## Considered and not done

**A loading view for the cold start.** `deployment.md` puts the first tap after
idle at 1–2 seconds, and the obvious response is a spinner. It would not work.
That interval is Fly starting the machine, the process booting and `initDb()`
running its migration and first sync — all of it *before any HTML exists*, so
there is no page for React to render a spinner into. Only two things reach it: a
static skeleton inlined in `index.html`, which covers the bundle download but not
the boot; and a web app manifest, whose OS splash screen is the only thing that
covers the boot at all, and only from a home-screen icon. Neither is being built.
Recorded so the next reader can tell this was measured rather than missed.
