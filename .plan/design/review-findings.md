# Household Tracker — Build Review Findings


> **Frozen.** This describes the design as built, and is no longer maintained.
> It was checked against the code and corrected on 2026-09-05, so it is accurate
> as of that date — but anything decided since lives in
> [`../changes.md`](../changes.md), which is authoritative where the two differ.

Status: v1 — findings recorded, remedies in progress · frozen after v6
Date: 2026-09-05
Companion to `data-model.md`, `views.md`, `tech-stack.md` and `api.md`.

---

## What this is

The first implementation was built by five agents working in parallel from the four design documents, then integrated. This records what that produced — every defect found in review, every simplification identified, and the decisions taken in response.

It exists because the defects cluster in a way that is worth naming. Parallel authorship from a shared spec does not produce randomly distributed bugs. It produces **seams**: two authors reading the same paragraph and encoding different halves of it, and the same primitive built twice because neither author could see the other's copy. Both patterns show up below, and both were invisible to the authors themselves — every agent reported its own work as complete and passing.

Three review passes fed this: a server review, a client review, and a Playwright suite written against the documents rather than the code. The most serious defect was found independently by all three.

---

## Decisions taken

Two questions in the findings could not be answered from the documents, because the documents disagreed with themselves. Both are now settled and the relevant docs are updated.

**1. How long a completed non-daily task stays on the Day screen.** Settled at the time as **the whole period**. **Reversed later in the same session** — see `../changes.md`. Once the Routine panel existed it answered "is this week's vacuuming done?" better than Day's completed section could, and the whole-period rule was absurd at the long cadences: a yearly task ticked in January sat on the daily screen until December. A completed task now stays on Day for the day it was ticked and no longer.

**2. A completed *unplaced* period task in Week.** Settled at the time as **stays visible, struck through**. **Void rather than wrong:** Week has no Unplaced section any more — it was absorbed into the Routine panel — so there is no longer a place for this case to arise. See the *Remedies* section below.

---

## Defects

### D1 — Completing a non-daily task removes it from the Day view entirely
**Severity: high. Confirmed three times independently.**

`src/server/views/day.ts`. Membership was decided by:

```ts
if (task.cadence === 'day') state = 'daily'
else if (isOverdue(task, own, date)) state = 'overdue'
else if (effective === date) state = 'planned'
else continue
```

`isOverdue` returns false when a task is done. So a non-daily task whose effective date is in the past **and which has been completed** matches no arm and is dropped — from `active` *and* from `completed`.

The user-visible failure: **tap an overdue task to complete it and it disappears from the screen.** It does not move to the struck-through completed section, so there is no row to tap to untick it. Week cannot untick it either, because it renders under a past day and past days are read-only. A mis-tap is unrecoverable through the interface.

This also made the `uncomplete` command unreachable for the exact case `api.md` invents it for — "unticking a weekly task on Wednesday that was completed Tuesday deletes Tuesday's row."

**This is the seam.** The client author read `api.md` ("`completed` holds everything in that membership set where `is_done` is true") and built a completed section that renders period-satisfied tasks. The view-builder author read `views.md`'s three-bullet "What appears" list and used `isOverdue` as a membership test. Each was locally reasonable. Neither could see the other. The Playwright agent, writing from the documents rather than either implementation, wrote the test that fails.

**Remedy as shipped:** separate membership from state labelling. Membership is a **union of four rules** — `cadence === 'day'`, `effective_date === today`, overdue, or *a completion dated today*. This document originally proposed `cadence === 'day' || effective_date <= today`, which is not what was built: that version both admits a past-placed task that is done and drops a task ticked today that was never placed. The fourth rule is what keeps a mis-tap undoable. State is labelled independently, after the set is decided. `views.md` and `api.md` are updated to state the rule in one unambiguous sentence rather than two compatible-sounding lists.

### D2 — Completing an unplaced period task removes it from every view
**Severity: medium. Confirmed.**

`src/server/views/week.ts` filtered `unplaced` on `!done`. A weekly task with no `planned_date` that has been completed this week appeared in nothing: not `unplaced`, not `days[]` (it has no date), not `overdue` (done), not `backlog` (not a one-off), and not Day (unplaced period tasks are not Day members). Same untickable dead-end as D1.

`data-model.md` specifies the drop-on-completion rule for the **backlog** only — "a backlog item is finished when it has at least one completion row." Nothing extended that to `unplaced`; the implementation did.

**Remedy:** drop the not-done filter. Per the decision above, the row stays and renders struck through.

### D3 — Day caches Week's view model to get `placeable_dates`
**Severity: medium. Confirmed.**

`src/client/views/Day.tsx` called `getWeek()` from the Day screen and cached the result in a `useRef` that nothing ever invalidates. Three rules broken at once: a view fetching another view's model, a cache in a client `api.md` says has none, and derived state held rather than rendered.

The irony is on the page. The code carries this comment:

> `// Never computed here: `place` rejects anything outside placeable_dates with a 409, so the picker and the rule cannot disagree.`

— immediately above the cache that makes them disagree. After midnight, or after any command that changes the week, the picker offers dates the server now rejects. `api.md`'s stated reason for shipping `placeable_dates` at all is "the picker and the `409` on `place` can never disagree."

**Remedy:** `DayView` gains `placeable_dates`. The client reads it from the model it already has. ~30 lines of caching machinery deleted.

### D4 — White on accent fails contrast in dark mode
**Severity: medium. Confirmed by calculation.**

`#fff` hardcoded on `var(--accent)` for the primary button and the capture FAB. In dark mode `--accent` is `#6b93f0`; white on it is **2.98:1**, against the 4.5:1 floor. These are the most-tapped controls in the app. They are also the only hardcoded colours in the codebase apart from three shadows that bypass the `--shadow` token.

**Remedy:** an `--on-accent` token, light and dark.

### D5 — Reordering silently discards the arrangement if the write fails
**Severity: medium. Confirmed.**

`Day.tsx` cleared the local order state *before* awaiting the command. On failure the user sees an error and the list snaps back to server order with the arrangement gone. **Remedy:** clear only after the command succeeds.

### D6 — Long task names can scroll the page sideways
**Severity: medium. Confirmed.**

`.day-name` is `flex: 1 1 auto` with no `min-width: 0`, and `.day-name-text` has no `overflow-wrap`. A captured item containing a long unbroken token — a URL, a product code — widens the row and the body scrolls horizontally at 390px. Notably every *other* flex child in the codebase handles this correctly; this is the one miss.

### D7 — Smaller confirmed defects

| | |
|---|---|
| Bottom nav not pinned | `position: sticky` only pins while the container overflows; on short pages the nav floats mid-screen and the fixed FAB hovers over blank space. Needs `position: fixed`. |
| `88vh` on sheets | iOS Safari's `vh` is the *large* viewport, so a sheet can extend under browser chrome and hide its own submit button. History already uses `dvh` correctly. |
| No scroll lock behind sheets | Scrolling past the end of a sheet scrolls the page behind it. `overscroll-behavior: contain` exists in History and is missing here. |
| Past-day completion state hidden from screen readers | Week's static tick is `aria-hidden`, erasing the only signal of whether a past task was done. |
| Reorder can drop rows | The mood row stays live during reorder; a mood tap refetches, and the order list is then reconciled by silently dropping and omitting ids. |
| A failed *refetch* reports as a failed *command* | Day shares one catch for both, so a network hiccup after a successful write says the write did not happen. Week already handles this correctly. |
| `bun run test` is broken | It globs `e2e/*.spec.ts`, and Playwright's `test()` throws under Bun's runner. Must name the directory. |
| History accepts a future `before` | Reachable only by hand-crafted URL, but it emits future-dated rows, which contradicts "all three views are anchored to now". |

---

## Duplication

Every item here is the same shape: two agents built the same thing from the same paragraph, and neither could see the other's copy.

### Client — ~1,250 of ~3,450 lines are removable

| | Now | Target |
|---|---|---|
| Three button systems (`day-btn`, `week-btn`, `hist-more`) | ~95 | ~28 |
| Two day pickers, two visual designs | ~150 | ~60 |
| Three notice bars, three CSS blocks, one job | ~110 | ~30 |
| Three date-helper blocks | ~145 | ~25 |
| Two hand-rolled checkboxes | ~71 | ~25 |
| Two reset-to-backlog confirms | ~70 | ~25 |

CSS is where the bloat concentrates: **1,541 lines → roughly 800**. Almost none of it is gratuitous polish; it is the same thing written twice.

The date helpers are not merely duplicated but **inconsistent**: Day formats with `toLocaleDateString` while Week and History hardcode English month and weekday names, so the same date renders differently on different screens.

### Server

- **Grouping completions by `task_id`** written verbatim twice, and the two copies disagree on scope: the shared loader bounds its read to the earliest current period start, while `reset_overdue` reads *every completion ever* for every planned task.
- **"This week's last placeable day"** derived independently in `commands.ts` and `week.ts`. `api.md`'s stated reason for `placeable_dates` is that the picker and the 409 cannot disagree — but right now they agree by coincidence of two separate derivations rather than by construction.
- **Limit validation** in both `routes.ts` and `history.ts`.

(Three copies of `addDays` and two of the completions loader were already consolidated during integration, before this review.)

---

## Overengineering

Judged against the documents' own standard — "no metadata that isn't used by a view", "every field earns its place by appearing on a screen".

**`Day.tsx` at ~1,100 lines is not the problem it looked like.** `views.md` specifies nine distinct surfaces on that screen. At ~120 lines each with no abstraction overhead, that is close to the floor. No state library, no router, no component library, no configuration. The architecture held; the fat is in CSS and cross-view copy-paste, above.

The server fat concentrates in `commands.ts` (434 lines, about a third of the server), and it is all defensive:

- `onlyFields` rejecting unknown keys on all sixteen commands — not in `api.md`'s 400 list, and the client is written by the same person
- a dead `new_slug` guard whose only effect is a nicer message than the check on the next line
- an unreachable null check on `periodStart(today, 'week')`, which returns null only for a null cadence
- a transaction wrapping a single `UPDATE`
- a compound condition guarding a state the model forbids

And the input boundary is **split across three files by three authors** who each added a layer: limit validation happens twice, and there are five error classes serving a four-row error table — `routes.ts` adds `NotAPath` and `WrongMethod` locally, the latter emitting a 405 that `api.md`'s error table does not contain.

---

## Tests

The 75 unit tests are good where it matters. All five rows of `data-model.md`'s behaviour table are transcribed as named tests, the month-boundary regression is explicit and correctly reasoned, the year-boundary week and the leap day are covered, and there is a real property test asserting `periodStart` is never after today.

But the count is inflated by tests that cannot fail: assertions that a function returns a string rather than a `Date` (the return type says so), a test asserting `isUnplaced(t,d) === (effectiveDate(t,d) === null)` which is the literal body of `isUnplaced`, a `today()` test that rebuilds the expectation with the same five lines as the implementation, and a sort test computing its expectation with `localeCompare` — the thing under test.

**The coverage gap cost something real.** `tests/` covers `period.ts` and `sort.ts` and nothing else. `period.ts` is correct. D1 and D2 are both one layer up, in the view builders that compose those primitives — and `tech-stack.md` explicitly claimed that layer needed no tests:

> "This is the only part of the system with tests, and it is the only part that needs them."

That was wrong by exactly one function. `buildDayView`'s membership rule is derivation, not rendering. A handful of cases against an in-memory SQLite would have caught both defects before a browser ever opened. `tech-stack.md` is updated accordingly.

---

## What the parallel build got right

Worth recording, so the lesson drawn is the right one.

- **`period.ts`, `sort.ts`, `today.ts` and `schema.ts` are almost exactly the spec with no padding.** The genuinely hard parts — Sunday-start weeks, the backward-only `effectiveDate`, `cadence = null` as a non-special case rather than a branch — are all correct and confined to one module.
- **No date can shift by a timezone.** All parsing is confined to `period.ts` and is UTC-only; `today()` is the sole clock read and formats local fields directly without a `Date` round-trip.
- **No N+1 queries anywhere.** Day is 3 queries, Week 2, History 6, all set-based.
- **`cadence != 'day'` correctly handles NULL** in the SQL, with a comment explaining why — the exact footgun that would have silently emptied the backlog.
- **No client-side sorting, filtering or date arithmetic.** The biggest architectural rule held everywhere except D3.
- **Tap targets are correct everywhere** — no interactive element under 44px.

The defects are concentrated at the seams between agents, not inside any one agent's work.

---

## Remedies — the v3 redesign

The findings above were mostly *repairs*. The redesign that followed removes more code than the repairs add, because it deletes surfaces rather than fixing them. Recorded here so the deletions are deliberate and reversible.

### What the Routine panel replaces

| Deleted | Why it goes |
|---|---|
| Week's **Overdue** section | A filter over a list the panel holds in full |
| Week's **Unplaced** section | Same. "Unplaced" stays as model vocabulary; it stops being a screen |
| Week's **Backlog** section | Same |
| **Reset to backlog** on Day | One control in the panel, reachable from both hosts, instead of two |

Week becomes seven day sections plus the panel. Day becomes today's list plus the panel, collapsed.

### What the mood decision deletes

| Deleted | Lines |
|---|---|
| `MoodManager` component in `Day.tsx` | ~227 |
| `create_mood`, `update_mood`, `retire_mood`, `reorder_moods` in `commands.ts` | ~66 plus 4 dispatch entries |
| `GET /api/moods` and `listMoods` | ~12 |
| The mood-manager CSS | — |

`set_mood` stays. `DayView.moods` stays. History's retired-mood resolution stays. Roughly **300 lines removed** for a panel that would have been opened twice a year.

### What the Day membership fix deletes

The stale `placeable_dates` cache in `Day.tsx` — the `useRef`, the `getWeek()` call, the loading and error states around it, and their CSS. About 30 lines, replaced by reading a field the server already ships. The bug it caused is D3.

### Net

The redesign is not additive. The Routine panel is one new view builder, one new endpoint and one new component; against it, three Week sections, a duplicated bulk action, a 227-line manager panel, four commands, an endpoint and a stale cache all go. The client's own review put ~1,250 of ~3,450 lines as removable *before* any of this; the redesign takes a further several hundred, and takes them from the places that were carrying real behaviour rather than duplicated CSS.

### Still to do from the findings above

**All applied.** There is now one `.btn` system, one `DayPicker`, one `NoticeBar`, one `Tick` and one `Confirm` in `ui.tsx`; one date formatter in `dates.ts`, imported by every view; and `errors.ts` holds `ApiFailure` plus three subclasses, with `routes.ts` defining none of its own and answering a wrong method with a `404` rather than the `405` that was never in the taxonomy.

`onlyFields` is the one item deliberately kept — it is five lines plus one call per command, and it makes `capture`'s one-field discipline and `reset_overdue`'s no-arguments rule enforceable rather than aspirational.

### Not doing

`sortTasks()` is **not** being generalised to serve the panel. The panel's order — overdue, placed, unplaced, done — has no baseline band and no `days.task_order`, and folding both rules into one function with flags would produce a worse function than two small ones. This is the case where a little duplication is correct.
