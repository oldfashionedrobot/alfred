# Household Tracker — Views

Status: draft v5 — category and the Backlog panel
Companion to `data-model.md`.

v2 pinned down the gestures the v1 draft left implicit, and narrowed Day and Week to the present: Day is today, Week is this week, and nothing writes to a past date.

v3 adds the **To do panel** and removes two things. The panel is a complete inventory of every active task, hosted by both Day and Week, and it exists because the first build made a real problem visible: a period task you never placed appeared on no screen you look at daily, so skipping one planning session made a weekly task vanish for a week. The panel absorbs Week's Overdue, Unplaced and Backlog sections, which are now three views of a list it already holds. The mood manager is removed entirely.

---

## Three views

| View | Purpose | Frequency |
|---|---|---|
| **Day** | Doing | Constantly |
| **Week** | Planning | Weekly, plus whenever a plan collapses |
| **History** | Looking back | Rarely |

Plus one panel, hosted by two of them:

| Panel | Purpose | Where |
|---|---|---|
| **To do** | Everything that recurs | Inside Day and inside Week |
| **Backlog** | Everything that does not | Inside Day and inside Week |

Things that are deliberately *not* views: the To do panel is a panel, not a fourth destination. Task editing opens from the To do panel — tap a name there. Capture is a button, not a destination. The mood set is not editable in the app at all.

**All three views are anchored to now.** Day is today, Week is the current week, History is a read-only record. Nothing navigates to another day or another week, and nothing writes to a past date. Falling behind is handled by overdue items surfacing on today's list, not by going back to fix yesterday.

---

## Ordering

One function, used everywhere a list of tasks is rendered. It runs on the server: every task array in a view model arrives already ordered, and the client renders it as given without sorting or regrouping. See `api.md`.

```
sort(tasks, day):
  band 1  →  is_baseline
  band 2  →  everything else
  within a band  →  days.task_order if present, else name, alphabetical
```

Baseline is always the top band. Name prefixes like `Dog: Feed Barney 1` group naturally within a band at zero cost.

The same function runs over the active list and the completed list independently. Completed items are not re-sorted or flattened — they keep the same arrangement inside their own section.

---

## Day

The doing surface, and 95% of usage.

**Today only.** There is no date navigation. The view is always today, every completion is written with today's date, and mood and log are recorded live or not at all. Anything unfinished from an earlier day arrives here as an overdue item asking for a decision, which is the whole catch-up mechanism — see *Recording is same-day only* in `data-model.md`.

### Layout, top to bottom

**1. Date header.**

**2. Mood and log — compact.** A single row of mood glyphs — one tap each, one selectable at a time — and a collapsed one-line log field that expands on tap. Tapping the selected mood clears it. Never prompted, never required, editable at any point in the day. It sits above the tasks, so it must stay small; a block you scroll past every time would be friction on the most-used screen.

The row renders every `active` mood in `sort_order`. There is no way to edit the mood set from the app — see *Moods are data, not a feature* below.

**3. Active tasks.** One flat list, `sort()` applied. Baseline first. **Nothing on a row opens a form** — the tick completes it, and the name is text. Editing is a tap in the To do panel below.

Every row carries a left stripe whose pattern is its cadence, and a baseline task with a colour set paints that stripe and its own name in that colour. See *Colour* under **To do**.

A **reorder toggle** puts the list into an edit state where rows are **dragged** into place. The whole row is the handle: in this state nothing else on a row is interactive — no tick, no name — so there is nothing for a drag to be confused with, and no small grip to aim at on a phone. The reordering happens locally while the edit state is open; this is the one moment the client rearranges a list rather than rendering the order it was given. Leaving the edit state writes `days.task_order` for today.

**Baseline and non-baseline are separate bands and nothing crosses between them.** Each band is its own drag context, so crossing is not a move that gets rejected — it is a move that cannot be expressed. That is what the flag means, made structural.

Reordering is keyboard-operable: focus a row, space to lift, arrows to move, space to drop. This is the same code path a pointer drag runs, not a parallel one.

An earlier version of this document rejected drag-and-drop as "a large amount of fragile code for a small gain", with ↑/↓ buttons instead. That was written before the gesture existed and turned out to be wrong in both halves: a library carries the fragile parts, and moving a task more than one position with buttons is worse than it sounds on a seventeen-item list.

**4. Completed.** A section at the bottom. Struck through, `sort()` applied within the section. Tapping a completed item unticks it and returns it to the active list.

**A completed task stays here for the day you ticked it, and no longer.** A weekly task ticked Wednesday is gone from Day by Thursday; a yearly task ticked in January is gone by the next day. It has not disappeared — the To do panel shows it struck through for the rest of its period, which is where the question "is this week's vacuuming done?" is now answered. Keeping it in Day's completed section for a whole period was considered and rejected: it is correct for a weekly task and absurd for a yearly one, and no cadence-dependent cap is worth a branch in the one calculation `data-model.md` keeps branch-free.

Unticking is why this matters structurally rather than cosmetically. A task that is not on the screen cannot be corrected, and Week cannot correct it either — the day it was placed on is in the past, and past days are read-only. That is the whole reason *anything ticked today* is a membership rule below.

**5. To do and Backlog panels.** Both collapsed by default — see *To do*. On Day they are deliberately secondary: the list above them is arranged for doing, and they are there for the moment you ask "what else is there?"

**6. Capture.** A `+` that creates a backlog item — no cadence, no date — from anywhere in the view. This is the replacement for the Keep lists, and it has to be one tap or things will pile up somewhere else instead.

### What appears

Four rules. Every active task that matches any of them:

- `cadence = day`
- `effective_date` is today
- **overdue** — `effective_date` in the past and not done
- **completed today** — a completion row dated today

The fourth rule is small and load-bearing. Without it, ticking an overdue task removes it from the screen: it is no longer overdue *because* it is done, its date is not today, and it is not daily — so it matches nothing and vanishes, with no row left to tap to untick it. That is not hypothetical; it is what the first build did. Adding "anything you ticked today" fixes it in one clause, and keeps a mis-tap recoverable for the rest of the day.

A date in the future is not a member: tomorrow's plan is not today's business.

Note what is *not* here: a period task with no day. "Grocery run" with no date appears on no day's list, by design — but it is always in the To do panel, which is what stops it going a week unseen.

Overdue items fold into the same flat list — not hidden, not moved to a separate screen — but visually marked, asking for a decision. Three resolutions, each one action: complete it, reschedule it, or unplan it.

**Reset to backlog** lives in the To do panel, and only there — one control, reachable from both hosts. It clears `planned_date` on every overdue item at once, and never touches days still ahead. It was briefly on both Day and Week as two separate controls, which is one more than a bulk destructive action should have.

---

## Week

The planning surface. Seven day sections plus the backlog.

**The current week only.** Sunday to Saturday of the week containing today, with no navigation to other weeks. Nothing can be placed outside the current week, so there is nothing to see in the next one; and nothing writes to a past date, so there is nothing to do in the last one.

**Responsive, not two views.** Vertical stack of seven day sections on narrow screens, columns on wide. The vertical form is the same shape as the Keep lists already in use.

### Contents

Two things, and nothing else:

- **The seven days** — whatever has been placed on each.
- **The To do panel** — everything there is. Expanded by default here, because on this screen it *is* the planning surface.

**Daily tasks never appear in the seven days.** They are implicit on every day and would be pure noise in a plan. They do appear in the panel, which is how you can still tick one off without leaving this screen.

Days already past in the current week render read-only. They are context for the planning session — what the week was supposed to look like — not a surface to tick from.

**Overdue, Unplaced and Backlog used to be sections here.** They are gone, and nothing was lost: each was a filtered view of a list the panel now holds in full, and keeping them alongside the panel would have shown every one of those tasks twice on one screen. "Unplaced" survives as vocabulary in `data-model.md`; it no longer needs a section, because in the panel a task with no day is simply a task with no day shown against it.

### Actions

Placing and unplanning happen in the panel, alongside every other task action. What is left on the seven days themselves:

- **Unplan** — clear the date, taking a task off that day.
- **Reschedule** — move it to another day this week.
- **Complete** — ticking on today's section, writing a completion dated today. Past days are read-only.

Two constraints the interface must enforce, because the model does not derive them: daily tasks are never placed, and no date is ever set beyond the current week. The day picker offers today through Saturday and nothing else — and it offers exactly what the server says, never a range the client worked out for itself.

---

## To do

The complete inventory. One panel, hosted by both Day and Week, identical in both — same contents, same actions, same order. Collapsed by default on Day, expanded on Week, side by side with its host on wide screens.

It exists because of a hole the first build made obvious. Day shows what is on today; Week shows what is placed on a day. A weekly task you never placed was therefore on neither, and skipping one planning session made it disappear for a week. The panel is the answer to "what else is there?", and it is the only screen in the system where nothing is hidden.

### Two panels, one model

The panel is rendered twice from one `GET /api/todo`:

| Panel | Groups |
|---|---|
| **To do** | Today, This week, This month, This quarter, This year |
| **Backlog** | One-off |

Same component, same rows, same actions, same ordering — they differ only in which groups they draw, and they collapse independently. The split exists because six groups in one column is hard to read; nothing about the model changed.

### Grouped by cadence, each labelled with its current period

| Group | Label shows | Holds |
|---|---|---|
| **Today** | `Sat 5 Sep` | every active daily task |
| **This week** | `30 Aug – 5 Sep 2026` | every active weekly task |
| **This month** | `September 2026` | every active monthly task |
| **This quarter** | `Jul – Sep 2026` | every active quarterly task |
| **This year** | `2026` | every active yearly task |
| **One-off** | *(no period)* | one-offs — see below. Drawn in **Backlog** |

The labels are the point, not decoration. This model's whole premise is that recurrence is period-based rather than interval-based, and the periods are otherwise invisible — nothing else on any screen tells you where a month or a quarter currently starts and ends. Naming the period next to the tasks it governs makes "due once per period" legible instead of something you have to trust.

**The week is shown as a date range, never a week number.** `data-model.md` rejects ISO week numbers outright — they are Monday-based and cannot express a Sunday-start week without breaking at the turn of the year. A range cannot be wrong.

Period boundaries are computed on the server like every other derivation, and shipped as dates. The client formats them; it never works out where a quarter begins.

### What each group holds

**Every active task of that cadence, always** — placed or not, done or not. A group's membership does not change as the week goes on; only the marks on its rows do. That stability is deliberate: a list that empties as you work it gives you no way to answer "is the monthly deep clean done?", which is the question this panel exists for.

**One-offs are the exception**, because they are not recurring and would otherwise accumulate forever. The group holds one-offs that are not done, plus those completed **this week**, struck through. A one-off completed before this week is gone — it is finished, and `data-model.md` already has it leaving the backlog on its first completion.

### Colour

A baseline task may carry a colour, set in the task editor. Where it is set it paints **a left stripe on the row and the task's name**, on Day and here. Nothing else uses it: no background fill, no badge, no dot.

The stripe must not move the row. It is drawn inside the row's own box, so a coloured row and a plain one share the same left edge and the list still reads as a column — a stripe that indents the rows it marks is worse than no stripe.

**Every row has a stripe, and its pattern is the cadence**: solid for a daily task, two dashes for weekly, three monthly, four quarterly, five yearly, and a single short mark for a one-off, which has no period to count. So the stripe says two things at once — what a row recurs as, in its pattern, and whose it is, in its colour. An overdue row recolours the same stripe rather than adding a second mark beside it.

**Baseline tasks are also set in a heavier weight**, colour or no colour. Day marks the band by position and a tint; the panel has no bands, so weight is what carries "the bare minimum to function" there.

It exists because these two screens mark the baseline band differently — Day sorts it to the top and rules a line under it, the panel does not band at all — so a task that is "the bare minimum to function" is invisible as such in the panel. A colour is one mark that reads the same in both.

The colour renders exactly as chosen. A colour that is hard to read against one theme is a colour to change; the app does not second-guess the picker, because a swatch that renders as something else is worse than a bad swatch.

Non-baseline tasks never show a colour, even if one is stored against them.

### Marks

Each row carries at most three, all read off fields the server ships:

- **Struck through** — done for its current period. For a daily that means today; for a monthly, this month.
- **A day** — the date it is placed on, when it has one. This is the "assigned to a day" highlight.
- **Needs a day** — overdue: placed on a date now past, still not done. The tone is the same as everywhere else in the system: it wants a decision, not an apology.

### Categories

A task may carry a **category** — free text, set in the task editor and suggested from those already in use. Inside a period group, tasks cluster under a category sub-heading.

**Headings appear only where categories are used.** A group in which nothing is categorised renders no headings at all, so the feature stays invisible until it is used — the panel looks exactly as it did before rather than growing a heading over an untouched list.

Once a group does use categories, the uncategorised rows are gathered under **Other**. They sort last, so without a heading of their own they fall under the previous category's and read as belonging to it — an uncategorised task appearing under `House` is worse than an extra heading.

Categories do not replace name prefixes. `Dog: Feed Barney 1` still orders alphabetically inside its category — a prefix groups within one list, a category groups across the six.

The Day list ignores categories entirely. It is arranged for doing, by `sort()` and `days.task_order`; a second hierarchy on the screen you tick things off on would be noise.

### Order

One rule, applied inside every group:

```
band 1  →  needs a day (overdue)
band 2  →  placed on a day
band 3  →  no day
band 4  →  done
within a band  →  baseline first
                  then category, uncategorised last
                  then name, alphabetical
```

Things wanting a decision rise; finished things sink.

**Baseline outranks category**, so baseline tasks form an unheaded block at the top of a group and category headings begin below them. This is a real trade, not an oversight: a baseline task never appears under its own category, so a category heading does not show everything in that category. Sorting by category first scattered the baseline tasks and lost the block that "the bare minimum to function" depends on, which was the worse loss.

This is *not* `sort()`. There is no `days.task_order` here — that belongs to Day's list — and the baseline band means something different in each: Day rules a line under it, the panel just leads with it.

### Actions

Every task action in the system lives here, and every one is available from both hosts:

- **Complete / untick** — always writes today, from either screen. Ticking a daily off the panel while looking at Week is legitimate and works.
- **Place** — assign a day, from the picker the server supplies.
- **Unplan** — clear the date.
- **Reset to backlog** — clear `planned_date` on every overdue item at once, including one-off ones. Overdue only; never days still ahead. It lives in the **To do** panel and nowhere else, even though it reaches tasks drawn in Backlog: one bulk destructive action, one home.
- **Edit** — tap a name to open the task editor. **This is the only place a task is edited.** Name, cadence, baseline flag, and Archive.

  Editing lives here rather than on Day's list because the two lists answer different questions. Day's list is for *doing*: every tap on it is made mid-task, one-handed, while working through the day, and the whole surface is tuned so a tap is cheap. Opening a definition form from a mis-tap on that surface is the opposite of cheap — it is a modal sheet in the way of the thing you were doing. The panel is where you go to think about what the tasks *are*, so the editor belongs to it. It also comes free on Week, since the panel is hosted there too.

---

## History

The grid the current spreadsheet does well, and the main thing every off-the-shelf tool would have taken away.

**v1 is deliberately minimal:**

- Dates down, most recent first; every `active` daily task across; filled cells for completions
- A mood column showing that day's emoji, blank where none was recorded
- Read-only — nothing in the system writes to a past date, so there is nothing here to edit
- Scrolls back through whatever exists; no filters, no range picker, no streak counts

Gaps are real and permanent. A daily task not ticked on the day it was due stays empty forever, because it can never be caught up. That is the grid doing its job — it is a record, not a checklist.

**Daily tasks only.** Weekly and monthly tasks don't grid meaningfully — one filled cell in seven reads as noise rather than signal.

Everything else the grid could show is derivable later from data that is accumulating from day one. Nothing is foreclosed by keeping v1 thin.

---

## Input

Two paths with opposite requirements. They must not share a screen — a deliberate form on the fast path is a form you stop bothering with.

**Capture** is fast and thoughtless, done mid-day. The `+` takes a name, and a name alone still creates a backlog item with no cadence and no date. One tap in, one tap out.

Beneath the name is a collapsed **More** section carrying the same fields as the editor — cadence, baseline, colour. Closed by default and costing nothing when ignored.

This reverses the original rule that the two paths must not share a screen, and the reversal is deliberate. The worry was that a deliberate form on the fast path is a form you stop bothering with; a section that is closed until you open it is not on the fast path. And the case it answers is real: when you already know the thing is weekly, retyping it in the editor later is worse than a disclosure triangle you can ignore.

**Task definition** is slow and deliberate, done once. Name, cadence, baseline flag, and **Archive** — the only removal. Archiving retires a task from every current view and keeps its completions. There is no delete, so the action means the same thing on every row and never needs a confirmation that explains which of two things is about to happen. Reached by tapping a name **in the To do panel** rather than by a separate creation flow — which is also how a captured one-off graduates into a routine once you notice you keep re-adding it.

The two input paths therefore live on two different surfaces: capture is a `+` on Day, definition is a name-tap in the panel. That separation is the same one this section opens with — a deliberate form on the fast path is a form you stop bothering with, and a fast path on the deliberate surface is a definition you change by accident.

### Moods are data, not a feature

**The mood set is not editable in the app.** It is a table, seeded on first run, and changed by editing the database — `bun run db:studio`, or `sqlite3`. There is no manager, no add form, no reorder control.

This was built once and then removed. The set is eight rows that will be revised perhaps twice a year, and the panel to manage them was a meaningful fraction of the most-used screen in the app. `data-model.md`'s reason for putting moods in a table rather than a code constant still holds exactly as written — revising them must not require a deploy — and a database edit satisfies that just as well as a form does, at no cost on screen.

Retiring a mood is still `active = false` rather than a delete, because past days point at its slug. History resolves retired moods and renders them normally.

Archived tasks and retired moods are not browsable in v1. Nothing surfaces them, and unarchiving is a database edit. If it turns out archiving-by-accident happens, a list is a later addition; guessing at the recovery UI before the mistake has happened once is the kind of speculative surface the rest of this document rejects.

No bulk import. Initial setup is roughly thirty tasks entered by hand, which is an afternoon, and the typing is itself a filter for which ones survive the move from the spreadsheet.

### Editing is unversioned

Tap a name in the To do panel to edit it. Completions point at the task row, so edits are retroactive: renaming `Vacuum` to `Vacuum downstairs` silently makes every past completion downstairs, and changing a cadence re-slices every past period so the grid changes shape.

This is accepted rather than solved. History is interpreted through current definitions. The alternative is task versioning — a whole extra table for a correctness problem that does not arise in practice here.

### Export

No export UI. The database is reachable directly, so a terminal dump covers it.

This assumes local SQLite. It would not hold in an environment where storage sits behind the app rather than under it.

---

## Not in v1

Task colours on anything but baseline. A palette or theme editor. Priorities. Time estimates. Subtasks. Tags. Notifications. Streak counts. Time tracking. Search. Gamification. Multi-user. Date navigation on Day. Week navigation. Backfilling a past date. Drag-and-drop reordering. Multiple moods per day. An archive browser. Deleting anything. Editing moods in the app. A fourth destination in the nav. Reordering the completed list, or the To do panel.

Each is a thing that made the surveyed apps too heavy. Each can be added in week three if it turns out to be missed — and most will not be.
