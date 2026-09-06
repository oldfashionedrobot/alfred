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

**Each day carries a count** of what is outstanding on it — today's `active`,
and each upcoming pane's `tasks`, both of which are already filtered to what is
still to do. That puts the week's shape back on one screen, which is what the
panes cost when they replaced Week's seven visible sections: you can now see that
Thursday is heavy without flipping to it.

A zero is left blank rather than drawn. The slot is still rendered so the buttons
stay the same height, but a row of zeroes is noise and an empty day is not news.
The count also goes in the accessible name — "Monday, 7 September, 2 tasks" —
because the badge itself is `aria-hidden` and a bare number read out beside a
weekday says nothing.

**Today and "the day you are looking at" are marked differently**, because the
strip has to answer both questions at once and one highlight cannot. Today is the
accent colour with a wash of it behind; the day you are on is the raised pill.
When they are the same day the pill takes the background and today keeps its
colour, so neither mark is lost.

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

## A task can be placed as far ahead as its period reaches

**What.** `place` was bounded by the current week: today through Saturday, for
everything. It is now bounded by **this week UNION the task's own current
period**. A one-off can be given any date at all, a yearly task any day this
year, a monthly task any day this month; a weekly task is unchanged, because its
period *is* the week.

**Why the period, and not "the end of the year".** The question was whether a
date could be picked further out — to December, say. The calendar year turns out
to be the wrong boundary, because what makes a placement *mean* anything is
whether the date sits inside the period the task is accountable for.
`planned_date` says which day inside the current period you intend to do it on.

**What placing outside the period actually does.** Checked before deciding, not
reasoned about:

```
weekly, placed 3 weeks out      overdue=false unplaced=false done=false
monthly, placed next month      overdue=false unplaced=false done=false
one-off, placed in December     overdue=false unplaced=false done=false
```

A weekly task placed three weeks out is in **no band that asks for anything**.
`effectiveDate` is backward-only, so the date is never rolled back; the task is
not overdue, not unplaced, and not done. This week's obligation goes unmet, and
next week's, and the one after — with nothing on any screen saying so. The same
for a monthly task placed into next month.

The one-off row is the same three values and is **correct**: a one-off's period
is unbounded, so there is no recurring obligation to drop. That is the whole
distinction, and it is why the bound is the period rather than a fixed horizon.

### Why it is a union and not just the period

`periodEnd` alone would have been a **regression**. `period.ts` documents the
case: in the week of Sun 27 Sep – Sat 3 Oct, a monthly task may be placed on
Friday 2 October while today is Tuesday 29 September. That is exactly why
rollover is backward-only, and bounding by September's end would have taken it
away. So the rule is `max(Saturday, periodEnd)`, and both halves do real work —
for a weekly task the two are the same date, and for a monthly task in a
straddling week Saturday is the later one.

`placementMax` is fifteen lines over `periodEnd` and `placeableDates`, both of
which already existed. Its tests use FIXED dates rather than `today()`, breaking
this suite's usual rule deliberately: the union only shows its teeth on a week
that straddles a month boundary, and that cannot be reached by deriving from an
arbitrary today.

### The interface does not grow

**Nothing new is displayed.** The panes stay today through Saturday, the strip
stays seven days, and neither knows this changed. A task placed in November
simply appears on no pane — it sits in Routine or Backlog with its date against
it, which is where a placed task's day has always been shown.

The one visible change is inside the picker: this week stays as chips, and a
date field appears beside them **only for a cadence whose period outruns
Saturday**. A weekly task never grows one. The chips stay because the common
case is this week and a chip is one tap; the field is there for the case that
used to be impossible.

**`placeable_dates` keeps its meaning and its job.** It is still today through
Saturday, still one derivation shared by the picker's chips and the panes. What
it stopped being is the *whole* placeable range — `placement` carries that, one
entry per cadence, and `place` rejects against the same function that builds it
so the two cannot disagree. That is the same reason the field existed at all
(D3 in `design/review-findings.md`).

`'day'` has no entry: a daily task is never placed.

---

## The day picker is a popover

**What.** Opening the picker no longer expands a block inside the task row. It
opens as a menu in the **top layer**, anchored under the button that opened it.

**Why the top layer, and not an absolutely positioned dropdown.** Two ancestors
would have clipped one. The picker opens from rows inside `.day-track`, a
horizontal scroll container, and from inside the To do panel; a dropdown would be
cut off at the first ancestor with `overflow` and would then have to win a
z-index argument as well. A popover is in neither's overflow nor its stacking
context, so there is nothing to fight.

The layout shift was the request; the clipping is what made a popover the only
simple answer rather than one of several.

**Position is progressive, and there is no fallback to maintain.** Where CSS
anchor positioning is supported the menu sits under its trigger and follows it on
scroll, with nothing of ours measuring a bounding box. Where it is not, the rules
inside `@supports` do not apply and the popover keeps the UA's own placement —
`inset: 0` with `margin: auto`, centred in the viewport. That is a reasonable
menu rather than a broken one, so the fallback is the absence of code.

**Dismissal is ours, not the platform's.** It began as `popover="auto"`, which
light-dismisses on any pointerdown outside the element — and the browser's own
date-picker chrome is outside it. Opening the calendar from the date field and
clicking through to another month dismissed the popover mid-interaction, and the
input committed whatever it was sitting on as it went: **clicking a month arrow
placed a task.** It is `popover="manual"` now, with Escape and outside-pointerdown
handled here, because an event whose target is the date field is inside the
popover by any measure we apply. A dozen lines to make the field usable.

Giving up `auto` gives up its one-open-at-a-time behaviour, which costs nothing:
`pickerFor` is a single id, so React never mounts two.

**The trigger opens; it does not toggle.** The trigger counts as outside, so a
toggling handler would race its own dismissal — dismiss-then-toggle and
toggle-then-dismiss give opposite results. Opening only is deterministic. Escape,
a click outside, or picking a date all close it.

**The date field refuses what it does not advertise.** `min` and `max` constrain
the calendar but not the keyboard, and `place` answers an out-of-range date with
a 409. Rather than show an error for something the field appeared to offer, a
typed date outside the range is simply not sent.

**It covers the rows beneath it while open.** That is what a popover does, and it
is the reason light dismiss and Escape both had to be wired through rather than
left to the element. It showed up as a test failing to click a panel toggle that
the open picker was sitting over — a real consequence, found by a test that was
not looking for it.

`.day-row-picker` and `.todo-row__pick` are deleted: the two blocks that used to
make room in the row.

---

## Where the tests are, after all this

Counted rather than asserted, because "well tested" is not a number.

**156 unit tests** over the view builders and the pure rules, **226 browser
tests** across two viewports. Everything added in v8 carries its own: the panes
and the strip, the count badges, bulk capture, the placement range, the popover.

**Two holes were found and closed while writing this section.**

The first is the one worth recording. `buildUpcoming` asks `isDone` about **the
pane's own date** rather than about today, which matters only at a period
boundary — and the integration test for it is guarded by "does this week straddle
a month", so it runs about twelve weeks a year and skips the rest. The subtlest
rule in the change was covered roughly one run in four. It now has a companion
test at fixed dates that proves the two questions give opposite answers, so the
distinction is guarded on every run whatever the calendar is doing.

The second was ordinary: `create_tasks` had its cap and its type checks written
and not exercised. A 101-name batch, a non-string in the list and an extra field
are now all asserted to be 400s.

Four more went in with the popover and after it: that opening the picker moves
nothing else on the page, that Escape and an outside click both close it, that
only one is open at a time, and that a picker opened from a future pane is
usable — the last being the one that would fail if the track's overflow were
clipping it. Then two for the date field: that a typed date past the advertised
range is refused, and that clicking the field does not dismiss the picker, which
is the bug above written down as a test.

Two long-standing claims also got tests they never had: that the week track and
the day strip are both frozen during a reorder, and that `GET /api/week` is a 404
now rather than a model nothing reads and nobody maintains.

**What is still not covered, honestly.**

The popover's no-anchor-positioning fallback is never exercised: Playwright runs
`channel: 'chrome'`, so the `@supports` block always applies and the centred
placement is only reasoned about. The same goes for what a native date picker
does to an open popover on iOS — tapping the date field opens browser chrome, and
whether that counts as a dismissing click outside is a question this suite cannot
ask. Both want a second browser in the matrix, which `design/tech-stack.md`
deliberately does not have.

**The flakiness was a real bug in the harness, and it is fixed.** Two different
tests had each failed once under a full parallel run and passed everywhere else.
Contention was the easy explanation and it was wrong.

`e2e/fixtures.ts` asked the OS for a free port — bind `:0`, read the number,
**close the socket**, hand it to bun — which is a race the moment four workers
start servers at once. The benign outcome is a failure to bind. The one that
actually bit is silent: the fixture's readiness probe fetches `/api/day`, gets a
200 from **another test's server** that took the port first, and the whole test
then runs against a foreign database. It fails later and somewhere else, as a row
that should be there and is not, or a click landing on something unexpected.
Which is exactly what those two failures looked like, and why neither reproduced.

Nothing guesses a port now: `PORT=0` lets bun choose and the fixture reads the
number back off the line the server already prints. There is no window to race.

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
by twenty pixels. The rule that caught it is the one `design/views.md` has carried since
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
