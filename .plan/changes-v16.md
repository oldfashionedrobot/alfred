# v16 — Paging forward, and correcting the record

Two changes: **To do pages forward** into the weeks you have scheduled into, and
**the Tracker lets you correct a day you got wrong**.

To do looks ahead and plans; the Tracker looks back and corrects. Neither is a
second way of doing the other.

---

## Completing is still a thing you do today

This has to be first, because it is the thing most easily misread about this
iteration.

**Ticking a task is unchanged.** `complete` and `uncomplete` take no date, are
the only completion commands the To do screen can fire, and still land on the
viewer's today. A future pane still cannot be ticked. Paging to next week does
not let you tick next week. None of that moves.

What is being added is a **correction**, which is a different gesture with a
different name, reachable from the Tracker grid and nowhere else. You reach for
it when you forgot to tick Tuesday — not when you are doing the thing.

That distinction is the whole design, so it is enforced rather than described.
`complete` and `uncomplete` call `onlyFields(b, ['task_id'])`, which makes any
extra field a 400 — so the everyday path cannot be handed a date even by a client
that tries, and it stays that way without anybody remembering to keep it that
way. The correcting path is bounded on the other side: daily tasks only, and no
day that has not happened yet.

### What this does and does not reverse

`today()` is the only clock read, and no command has ever accepted a date. The
architecture reference states the consequence: *same-day-only recording is
structural rather than a rule the UI is trusted to follow.*

**The paging half reverses nothing.** v8 settled that when it hung the rest of
the week off `/api/day`, and its words are worth repeating because this is the
kind of thing that gets relitigated:

> There is no `?date=` parameter and `GET /api/day` still means today: the
> same-day-only rule protects WRITES, and it does that in commands.ts, so a read
> parameter was never what it guarded against.

So `date` stays today, every existing command still lands on today, and the
same-day rule is untouched by paging.

**The correcting half narrows the rule rather than dropping it.** One command
accepts a date. It cannot be reached from the surface you work on, it cannot name
a future day, and it cannot touch a task whose period is longer than a day. The
narrowness is the entire reason it is acceptable.

---

## Decisions

**Paging reaches as far as you have scheduled, and no further.** `next` is
enabled while something is placed beyond the week on screen and disabled once
nothing is. You can always reach everything you have scheduled, and never page
past the end of it. A fixed horizon would do both wrong at once: it lets you page
through nothing, and it hides a task placed beyond the edge.

The server already knows the answer — `max(planned_date)` over this user's
active tasks — and ships it as `last_placed`.

Two things this does **not** claim, because checking the arithmetic contradicted
the first draft of this paragraph:

- **Empty weeks in between are reachable, and must be.** A task three weeks out
  makes weeks one and two pageable and empty. Bounding by "the next week that has
  something in it" would make the strip skip, which is worse than an empty week.
- **It does not make a future pane always exist.** With nothing placed ahead,
  `last_placed` is null, `next` is disabled, and a Saturday still shows one pane
  and two dead arrows — exactly as now. Paging is for reaching work you have
  scheduled, not for browsing an empty calendar. This matters for the tests
  below.

**Placement does not follow the paging, and `placementMax` does not change.**
This is the trap in this iteration and it is worth being explicit about.

A task may be placed from today to the later of this Saturday or the end of its
own period. Letting that follow whatever week you happen to be looking at would
let a weekly task be placed outside its own week — and
[`period.ts`](../src/server/period.ts) explains what that costs: `effectiveDate`
is backward-only, so such a task would be neither overdue, nor unplaced, nor
done, and its obligation would go unmet every period with nothing on any screen
saying so.

The good news is that nothing has to guard against it. **A task can only appear
on a future pane if it was placed there, and it could only have been placed there
if its own bound reached.** So every row on a paged-to pane belongs to a cadence
that can still move within that range, and Move and Unplan keep working with no
special case. A weekly task simply never appears outside its week.

**`placeable_dates` stops doing double duty.** Today it is derived once and used
twice — the picker's chips and the list of panes — and
[`day.ts`](../src/server/views/day.ts) says so, on the grounds that the two
cannot then disagree. Paging forces them apart: the panes become the viewed
week's days while the chips must stay today through Saturday, because placement
is bounded from *today* whatever you are looking at.

That invariant is retired knowingly, and replaced by a narrower one: the two
fields are derived from the same `weekDates` helper, and only the filtering
differs. The comment in `day.ts` is rewritten rather than deleted, because the
reason it existed is still live — these two are easy to conflate.

**Forward only.** The past belongs to the Tracker, which already shows every
past day and, after this, lets you correct one. A read-only pane that refuses
every gesture would be a second way to look at a day you can already see.

**One dated command, as narrow as it can be.** `set_completion`, taking
`{ task_id, date, done }`:

| | |
|---|---|
| Daily tasks only | `cadence === 'day'`, which is exactly what the grid shows |
| Not in the future | the same bound `historyOptions` already applies to `before` |
| Owned by the caller | `loadTask`, like every other command |

The daily-only bound is what makes this safe rather than a reopening of the
period model. A daily task's period *is* that one day — `periodKey(date, 'day')`
returns the date itself — so a dated completion says exactly one thing and cannot
retroactively satisfy a week, a month or a quarter. Widening it to other cadences
is a different and much larger question, and is not being asked here.

**`set_completion`, not `complete_on` / `uncomplete_on`.** The house style has
both shapes: verbs for the gestures that mean "do this now" (`complete`,
`uncomplete`, `place`), and `set_*` for the ones that write a value at a
coordinate (`set_mood`, `set_log`, `set_task_order`). A grid cell is the second
kind: a task, a date, and whether it is done. One command with a boolean also
means the client never has to decide which verb a cell needs.

**`complete` is NOT replaced by it, and the overlap on today is deliberate.**
Folding the two together would give the everyday tick a date parameter, and a
client that can name the day is exactly what the same-day rule exists to prevent.
So the Tracker's top row and the To do list can both mark today done, by
different commands, and that is the point rather than a redundancy to tidy: one
of them is incapable of naming any other day.

**Cells toggle immediately, with no confirm.** Consistent with every other tick
in the app, including the one on the To do list that already deletes a completion
row without asking, and instantly reversible by clicking the cell again. The
honest cost: the Tracker is a dense grid of past days, so a mis-click destroys an
older record rather than today's. Accepted, because a confirm on a grid cell is
clumsy and because the same gesture behaving differently in two places is worse
than the risk.

**The cells predict, like the ticks do.** The grid holds the state asked for
until the model agrees. A cell that does not fill until a round trip lands is the
exact complaint v15 fixed everywhere else.

**A corrected cell does NOT refetch, and that is a deliberate exception to the
app's data rule.** Everywhere else the client posts a command and refetches the
view wholesale. The Tracker cannot: it is the one screen that *accumulates*, with
`loadEarlier` concatenating older pages onto the rows already on screen. Refetching
the first page after a toggle would throw away every page somebody had paged back
through — correct a cell from six months ago and the grid snaps back to the last
sixty days, losing the place you were looking at.

So the toggle patches the one row it changed and keeps the prediction. The write
is the narrowest in the system — one task, one date, a row that exists or does
not — so there is nothing else a refetch would have told us. On failure the
prediction is dropped and the notice bar says why, which is the behaviour every
other failed command already has.

This is worth writing down because it is the first place the refetch rule bends,
and the reason is a property of this screen rather than a preference.

**The Tracker stops being read-only, and the documents have to say so.** Two
statements retire:

- *"Read-only: nothing in the system writes to a past date, so there is nothing
  here to edit."*
- *"A task done Tuesday but ticked Thursday is recorded on Thursday. The history
  records when things were **marked**."*

The second becomes: the history records when things were marked, **unless you
correct it** — and a corrected cell is indistinguishable from one marked on the
day. That is a real loss of fidelity and it is the price of being able to fix a
day you forgot. It is worth stating plainly rather than discovering later.

Note what does *not* change with it: a task ticked today is still recorded today,
because the everyday tick still cannot name a day. The fidelity that is lost is
only ever lost deliberately, by somebody going to the grid and correcting a
cell.

---

## Server

### `GET /api/day` learns which week

| | |
|---|---|
| `?week=YYYY-MM-DD` | any date inside the week wanted. Absent means this week. |

Validated in `routes.ts`, which is the whole query-string boundary and already
does exactly this shape for History's `before`: reject anything `isISODate` does
not accept, and reject a week that starts before this one — forward only.

`DayView` changes shape:

| before | after |
|---|---|
| `date` | unchanged — still **today**, never the viewed week |
| `tasks` | unchanged — still **today's** list, whatever week is being viewed |
| `week_dates` | the seven days of the **viewed** week rather than always this one |
| `placeable_dates` | unchanged — today through this Saturday, for the picker |
| `placement` | unchanged — bounded from today, never from the viewed week |
| `upcoming` | the viewed week's panes that are not today's |
| — | **`panes: ISODate[]`** — every pane in the viewed week, in order |
| — | **`last_placed: ISODate \| null`** — the furthest `planned_date`, which bounds the strip's `next` |

**`panes` is new and is not `placeable_dates` renamed.** Today the client uses
`placeable_dates` for three jobs at once: the picker's chips, the strip's button
list, and the index the counts align to. Paging splits them — the chips stay
today through Saturday while the panes become the viewed week's — so the strip
gets its own field and stops borrowing one that means something else.

**The today pane stops being unconditional, and that is the largest client
change in this half.** `Day.tsx` renders `pane pane--today` outright and then
maps `upcoming` after it, and the strip's counts are built as
`[outstanding.length, ...upcoming]` on the assumption that today is pane 0. None
of that holds in a later week, where there is no today pane at all. After this
the panes are one list the client walks, with today's rendered where
`pane === view.date` and nowhere else — which is also what keeps "only today can
be ticked" true without a flag.

`tasks` still rides along when a later week is being viewed, unused by the
render. One endpoint answering one question is worth more than the bytes: this is
a household app, and a second endpoint for "just the panes" would be two things
to keep in step.

### `set_completion`

```
set_completion { task_id, date, done }
```

Rejects a non-daily task, a future date, and a task belonging to somebody else.
`done: true` inserts with `onConflictDoNothing`, so a repeat is a no-op exactly
as `complete` is; `done: false` deletes that one row. It does not touch `days`,
and it reads the clock once through `runCommand` like every other command — the
clock is what bounds the date, not what supplies it.

---

## Client

### The viewed week is state, and several things depend on it

Building this as "add a parameter" is how it goes wrong. The week being looked at
is a piece of client state, and three separate things already assume it is always
this week:

| | |
|---|---|
| `refresh()` | calls `getDay()` with no argument, so any command fired from a later pane — an unplan, a move — refetches this week and bounces the view home. `getDay` takes the week and `refresh` passes the one being viewed. |
| `usePagedTrack` | reads its index back off `scrollLeft`. Loading a week replaces the panes while the scroller stays where it was, leaving you mid-week on a stale index. A week change scrolls to the first pane going forward, the last coming back — explicitly, not as a side effect. |
| `DayStrip` | disables prev at `index <= 0` and next at `index >= panes.length - 1`. Both have to consider the week as well: prev at pane 0 must work when a later week is being viewed, and next at the last pane must work while `last_placed` is beyond it. |

`api.ts` gains the parameter on `getDay`, which is its only change.

Thread the viewed week first and these fall out. Retrofit it and it gets added in
three places separately, which is the same mistake in three files.

### The strip pages weeks

The `‹ ›` buttons step through panes as they do now, and stepping past either end
loads the adjacent week — so one control does days and weeks, continuously, and
there is no second pair of arrows. `next` is disabled when the viewed week holds
the last placed task and there is nothing beyond it.

The day strip's labels stay the seven weekday letters; what changes is the date
range under them and which are disabled. Past days of a past week never appear,
because paging is forward only.

**A swipe cannot cross a week boundary, and this is accepted rather than
solved.** The track is `scroll-snap-type: x mandatory` with
`overscroll-behavior-x: contain`, so a swipe at the last pane has nowhere to go
and the gesture simply stops — there is no over-scroll to detect and turn into a
page. On the device this app is mostly used on, that means weeks advance by
button while days advance by either.

The alternatives were weighed and both cost more than the problem: an extra
sentinel pane at the end of the track that loads the next week when you reach it
is a pane that is not a day, and listening for a touch that the scroller has
already refused means reading raw touch events beside a snapping container, which
is the interaction that cost two wrong fixes in v4. If reaching for the arrow
turns out to be the thing that annoys, that is the point to revisit it — with the
annoyance as evidence.

### The Tracker's cells

**The `<td>` does not become the control.** A `td` carrying `role="checkbox"`
stops being a grid cell to a screen reader, which loses the row and column
position that is the only thing making a cell meaningful. The interactive element
goes *inside* the cell — the same shape `ui.tsx`'s `Tick` already uses, and the
same shape the log column already uses for its button.

It carries an accessible name naming both coordinates — *"Feed the dog, Tuesday 8
September"* — because a checkbox in a grid with no name is unreachable by voice
and meaningless in a screen reader's list. Clicking toggles. A future date has no
cell to click, which the grid already satisfies by never rendering rows ahead of
today.

**The cells are square again, and that fix rides along here.** v15 lifted the
Tracker's reading-width cap so the grid could use the window, and gave the table
`width: 100%` so the extra would not sit as blank paper. The table handed that
width to the task columns instead: at six columns on a desktop a cell came out
181px wide and 26px tall, a row of stripes rather than the block of squares the
grid is read as. The table now sizes to its columns and stops at the box, and a
cell is one number in both dimensions.

It is a v15 regression rather than a v16 feature, and it ships here because this
is the iteration that makes a cell something you aim at — the size of the thing
you click is not a detail to settle separately from making it clickable. The
scroll test moves from 24 seeded columns to 60: at 26px a column is small enough
that 24 of them no longer overflow a desktop box, so the old seed proved nothing.

**A cell is 26px square, which is under the house target size.** The
architecture reference says interactive targets are `--tap`, 44px. A clickable
cell breaks that, and enlarging it is not the answer: square means the row height
follows the width, so 44px cells would make a sixty-day grid 2,640px tall instead
of 1,560px, and the whole point of the grid is reading a month at a glance.

So this is an exception, and the reference should say so rather than quietly
stop being true. It is defensible on its own terms: WCAG 2.2 AA asks for 24×24
(SC 2.5.8) and 26px clears it; the 44px figure is the repo's own stricter
convention, set for controls you hit with a thumb while walking. A grid you read
is not that, and AA's minimum is 24px precisely because dense grids exist.

**The predicted state is keyed by cell, not by task.** Day's intent map is
`Map<task_id, boolean>`, which is right where a task appears once. In the grid
the same task appears on every row, so the key is the pair — `task_id` and the
date — or toggling Tuesday would light up Wednesday as well. Same mechanism, a
wider key.

The header's *"A record, not a checklist"* becomes something that says what the
grid now is: a record you can correct. The distinction matters on screen as much
as in the model — this is not where you work, it is where you fix a day you
missed, and the copy should not invite it to be used as a second To do list.

---

## Tests

| | |
|---|---|
| Unit | `set_completion` writes and deletes one row at the named date; refuses a non-daily task, a future date, another user's task; a repeat is a no-op. `buildDayView` for a named week: `date` is still today, `week_dates` is the viewed week, `placeable_dates` is unchanged, `upcoming` is all seven days of a later week. `last_placed` is the furthest planned date and null when nothing is placed. |
| Browser | Paging forward reaches a task placed next month and back again; `next` disables past the last placed task; a weekly task never appears outside its week; a paged-to row still moves and unplans; a Tracker cell toggles and the grid reflects it; a cell reverts on a refusal; the cell's accessible name carries task and date. |

### What inverts rather than moves

`history.spec.ts` has **"the grid is read-only: clicking cells changes nothing"**,
which clicks a filled cell, an empty one, and double-clicks a third, then asserts
the completion count did not move. Its premise is the thing being deleted, so it
cannot be re-anchored — it becomes the positive test for the same three gestures.

Its neighbour, **"the grid stays read-only: opening a log changes nothing"**,
stays exactly as it is and is worth keeping: v16 makes cells writable and leaves
the log alone, so the sheet must still change nothing. The `Read-only — History
never writes` comment on the log sheet in
[`History.tsx`](../src/client/views/History.tsx) stays true for the same reason
and should not be swept up in the rename.

### The Saturday hole closes, but not by deleting the gates

Eight gates in `day.spec.ts` skip when `placeable_dates` is one date, which is
every Saturday — 40 of the 620 browser tests.

The first draft of this section said the gates simply come out. They cannot, and
the reason is the one recorded under the horizon decision: paging is bounded by
`last_placed`, so a future pane exists only when something is placed ahead. On a
Saturday with an empty schedule, there is still one pane.

What actually closes the hole is that the gates stop being *unavoidable*. Every
one of those tests seeds its own data — and today they seed it **from**
`upcoming[0]`, which is why a Saturday defeats them:

```ts
const next = await firstUpcoming(app)
test.skip(next === null, 'needs a future pane; a Saturday has none until v16')
app.seed.task({ name: 'Grocery run', cadence: 'week', planned_date: next! })
```

After this they seed a date of their own — `addDays(app.today, 2)` and its week —
then page to it, which works on any day of the week. That is a rewrite of eight
tests rather than the deletion of eight lines, and it is the real cost of closing
this. A weekly task cannot be placed outside its week, so the seeds move to
cadences whose bound reaches: a monthly, a quarterly, or a one-off.

**`views.test.ts` gets a cleanup the first draft of this section denied.** It
claimed all twelve weekday gates stay, on the grounds that paging does not change
what period a date falls in. Eight of the twelve sit inside the `DayView.upcoming`
block, and once `buildDayView` takes a week a unit test can hand it a future week
outright rather than waiting for the calendar — so six of those gates can go.

The two that stay are the two that are genuinely about the calendar rather than
about reaching a future day: one asserts a task placed EARLIER this week appears
on no pane, which forward paging cannot supply, and one asserts `upcoming` is
empty on a Saturday, which is the behaviour itself. The four `NO_EARLIER_DAY`
gates outside the block stay for the same reason.

---

## Not in this iteration

**Editing anything but a daily task's cell.** A weekly task satisfied once covers
seven cells, so a row of cells would stop meaning one thing per cell. The grid
shows daily tasks and that is why this is narrow enough to do.

**Correcting a day before anything has ever been recorded.** `buildHistoryView`
returns no rows when `earliestRecord` is null, and the grid draws *"Nothing
recorded yet."* — so there are no cells to click, and a brand-new account cannot
backfill. It resolves itself the moment anything is ticked, and building a
cell-less grid a way to grow cells is machinery for the first five minutes of a
household's use.

**Editing a past mood or log.** The same argument would extend to them and the
same command would not — they live in `days`, keyed differently, and nothing has
asked for it.

**Paging To do backwards.** Deferred with v15 and probably for good.

**Recording when a completion was corrected.** A corrected cell is
indistinguishable from one marked on the day. Storing both dates would mean a
column on `completions`, a migration, and a second meaning for every existing
row, to answer a question nobody has asked.

**A cancel on the log, per-user moods, an export UI.** Unchanged and still
deferred.
