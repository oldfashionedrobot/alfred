# Household Tracker — Changes

An iteration log, oldest first — it reads as the project's history in order.

**This is the maintained document.** [`design/`](design/) holds the original plan, frozen and no longer updated; where the two disagree, this one is right. From here on a change is recorded here and nowhere else. Each entry records what changed, why, and what it cost — including decisions it reverses, so a later reader can tell a deliberate reversal from a drift.

`design/data-model.md`, `design/views.md`, `design/tech-stack.md` and `design/api.md` are always current; this file is how they got that way. `design/review-findings.md` is separate — it records defects found in the first build rather than intentional changes.

---

## v4 — Task colour, and one input path instead of two

### Baseline tasks can be assigned a colour

**What.** A nullable `color` on `tasks`, set in the task editor with a native colour picker or a pasted hex. Where it is set, it paints a left border on the task row and the task's name, on Day and in the Routine panel.

**Why.** Day's list already distinguishes the baseline band with a tint and a rule at the band boundary, because `sort()` puts baseline first and the boundary is a real thing to see. The Routine panel has no such boundary — baseline tasks sit in the *Today* group among every other daily task, and nothing marks them. A colour is a mark that works in both places without either screen needing to know about bands.

**Baseline only.** The input appears in the editor only when Baseline is ticked, and the colour is ignored on anything else. The stored value survives unticking Baseline rather than being cleared — re-ticking restores it, which is the least destructive behaviour and consistent with a model where nothing is ever deleted. The server enforces this: it ships `color` as null for a non-baseline task, so the client renders what it is given and the rule lives in one place.

**The colour is used exactly as picked**, for both the border and the text. No contrast adjustment. A dark navy on the dark theme or a pale yellow on the light one will be hard to read — that is visible immediately and fixed by picking another colour, and the alternative is a contrast-nudging helper whose output nobody asked for and which makes the swatch a lie.

**Cost.** One nullable column, one field in one form, and a rendering rule. It is the first field in the model that is purely presentational — `design/data-model.md`'s standard is that every field earns its place by appearing on a screen, which this does, but it is worth noticing that it is the first one whose *only* job is to appear.

### Capture gains the full set of fields

**What.** The capture sheet now carries the same inputs as the editor — name, plus cadence, baseline and colour in a collapsed *More* section. Name alone still works and is still the default path: one tap in, one tap out.

**Why.** Sometimes you already know the thing you are capturing is weekly. Retyping it later in the editor is worse than a disclosure triangle you can ignore.

**This reverses a decision, deliberately.** `design/views.md` held that the two input paths "must not share a screen — a deliberate form on the fast path is a form you stop bothering with", and `design/api.md` kept `capture` as a separate command specifically so that the fast path could not grow fields. The collapsed section is the answer to the original worry: the fast path is unchanged in tap count, and the deliberate fields cost nothing until opened.

**Consequence: the `capture` command is deleted.** Its whole justification was one-field discipline, and `create_task` with a name and nothing else already produces exactly a backlog item — no cadence, no date, not baseline. Two commands that now do the same thing is one too many. The capture sheet posts `create_task`.

### Baseline tasks sort to the top of their group in the Routine panel

Ordering inside a panel group was `overdue → placed → unplaced → done`, then name. Baseline is now a key between the band and the name, so baseline tasks head their group.

**Inside the band, not above it.** A *done* baseline task still sinks with the other done ones — a struck-through row at the top of the list is not what "the bare minimum to function" should look like. In practice the two readings agree wherever it matters: baseline is a flag on daily tasks, dailies are never placed and never overdue, so the whole *Today* group sits in one band and baseline-within-band is baseline-at-the-top.

### Drag and drop on the Day list

The reorder edit state now drags instead of stepping with ↑/↓. `@dnd-kit` supplies the sensors; the whole row is the handle, because in that state nothing else on a row is interactive.

**This reverses a rejection.** `design/tech-stack.md` had drag-and-drop down as "fragile touch-event code on a seventeen-item list, for a gesture used occasionally", and that was wrong in both halves: the fragile parts are the library's problem, not ours, and moving a task several positions one tap at a time is worse than it sounded when the alternative was hypothetical.

**Bands are enforced structurally rather than by a guard.** Each band is its own `DndContext`, so a baseline task and a non-baseline one are never in the same drag context — crossing the boundary is not a move that gets rejected, it is a move that cannot be expressed. The old `canMove`/`move` pair, which checked the band on every step, is deleted.

Keyboard reordering comes with it — focus a row, space to lift, arrows to move, space to drop — running the same code a pointer drag runs. It replaces the ↑/↓ buttons' accessibility rather than dropping it.

One thing worth knowing for tests: dnd-kit puts `role="button"` on a draggable row, so a sortable row is **not** matched by `getByRole('listitem')`. The suite addresses them by `aria-roledescription="sortable"`.

### Colour stripe no longer indents the row; baseline reads heavier

Two fixes to the v4 rendering.

**Alignment.** The stripe was a `border-left` plus `padding-left`, both of which change the row's box — so a coloured row sat ~11px right of its uncoloured neighbours and the list lost its left edge. It is now an inset `box-shadow`, which paints the same 3px stripe and occupies no space. The overdue mark had already solved this the same way; the colour rule simply did not follow it. A test now asserts that a coloured row and a plain one share an x-coordinate, and so do their ticks.

**Weight.** Baseline tasks render at `font-weight: 600` wherever they appear — Day's list and the Routine panel. The band tint on Day and the panel's ordering both say "these come first"; the weight says it without depending on position, which is what the panel needs.


### The left stripe carries the cadence

Every task row now has a 3px left stripe, on Day and in the Routine panel. Its **colour** says whose row it is; its **pattern** says how often the task recurs:

| Cadence | Stripe |
|---|---|
| day (and every baseline task) | solid |
| week | 2 dashes |
| month | 3 |
| quarter | 4 |
| year | 5 |
| one-off | one short mark |

A one-off is deliberately off the "more dashes = longer period" axis, because it has no period. One mark, meaning once.

**It is not a `border`, and not `border-style: dashed`.** A border changes the row's box, so a striped row would sit indented from an unstriped one — the bug fixed one entry above. And `dashed` gives no control over how many dashes appear, which is the whole signal here. It is a repeating background gradient with the tile sized to `100% / n`, so exactly *n* dashes fall out at any row height. The row's own background had to move from the `background` shorthand to `background-color`, since the shorthand resets `background-image`.

**Overdue recolours the stripe** rather than adding a second mark beside it, replacing the separate inset shadow it used to draw. A row now says one thing in one place: cadence by pattern, ownership by colour.

Colour precedence is baseline colour → overdue → default border.

### e2e/ was never typechecked

`tsconfig.json`'s `include` listed `src`, `tests` and `drizzle.config.ts` — not `e2e`. So `bunx tsc --noEmit` reported clean while the Playwright suite contained a **syntax error** and five type errors, and the only symptom was Playwright saying "No tests found".

Adding `e2e` to `include` found, immediately:

- a duplicate `const` in `day.spec.ts` that stopped the whole file loading;
- `todo.spec.ts` carrying hand-written `TodoTaskLite` / `TodoGroupLite` / `TodoLite` structural copies of the wire types, which had **drifted**: `planned_date` was renamed `effective_date` on the server and the copies kept the old name. The tests passed by reading `undefined` and comparing it to `undefined`.

The copies are now aliases of the real `TodoTask` / `TodoGroup` / `TodoView`, so the next rename is a compile error in the tests rather than a silent mismatch. This is the same lesson as the `groupFor` helper in `views.test.ts`: a hand-written duplicate of a contract is a copy that will drift, and a test that drifts stops testing without failing.

### The drag test helper was waiting on the wrong thing

Keyboard-drag tests failed intermittently on the desktop viewport, and the fix went through two wrong stops worth recording.

dnd-kit previews a drag with **CSS transforms** — the DOM order does not change until the drop. So waiting for the row *order* to change while the row is lifted can never succeed, and waiting for nothing at all lets the arrow and the drop land in the same frame, silently committing an unchanged order. The signal that the arrow was processed is the lifted row acquiring a non-identity `transform`, which is what the helper now polls.

Both earlier attempts made the suite report "the drag did nothing" — which reads as a product bug and is not one.

---

## v5 — Category, and the Backlog panel

### A `category` field

**What.** A nullable free-text `category` on `tasks`, set in the task editor. In the Routine panel, tasks cluster under a category sub-heading inside their period group. The Day list is untouched — it keeps `sort()` exactly as it is.

**This reverses a rejection.** `design/data-model.md` had: *"Category (`category`) — Rejected. Name prefixes carry default grouping."* That argument was that `Dog: Feed Barney 1` groups alphabetically at zero cost in fields, and it is still true as far as it goes. What it missed is that a prefix groups only *within one list*: it does nothing across the six period groups of the Routine panel, where a category is exactly the thing that spans them. Prefixes stay — they still order tasks inside a category — so the two mechanisms coexist rather than one replacing the other. No task is renamed.

**Free text, with suggestions.** The editor offers a `datalist` of categories already in use, so the ordinary path is picking an existing one and typing is reserved for a genuinely new category. This is the cheap half of a categories table: it prevents most of the `Dog` / `dog` / `Dogs` drift that free text invites, without a fifth table for something described as a text field. Matching is by exact string, so drift remains possible — it is just no longer the path of least resistance.

**Ordering inside a period group** is now: band → baseline → category → name.

Baseline outranks category, which is a deliberate answer to a genuine collision between two requests. Baseline tasks form an unheaded block at the top of the group, exactly as before; category headings begin below them. The cost, stated plainly: **a baseline task never appears under its own category**, so a category heading does not show everything in that category. The alternative — category first — scattered the baseline tasks and lost the "bare minimum to function" block that Day and the panel both lean on.

**Headings appear only where categories are used.** A group with nothing categorised renders none at all, which keeps the feature invisible until it is used.

Once a group does use categories, uncategorised rows are gathered under **Other**. The first attempt gave them no heading on the reasoning that they should simply follow — and rendering it showed why that is wrong: they sort last, so with no heading of their own they sit beneath the previous category's and read as belonging to it. "Dishes" appeared under `House`. An extra heading is cheaper than a task filed in a category it is not in.

### The Backlog panel

One-offs move out of the Routine panel into a panel of their own, titled **Backlog**. Both panels are hosted by Day and by Week, both collapse independently.

It is the same component rendered twice, differing only in which groups it draws — the five period groups, or the one-off group. Splitting was asked for because a single column holding six groups is hard to read; nothing about the model changed, and `GET /api/todo` still returns all six groups in one response.

**Reset to backlog stays in the Routine panel only**, keyed off the view's global `has_overdue`. It clears every overdue task including one-off ones. One bulk destructive action, one home — the same reasoning that took it off Day in v3.

### Fixes found by splitting the panel

**The reset bar counted the wrong half.** `reset_overdue` clears every overdue task in the database, and the control appears whenever the view's global `has_overdue` is set — but after the split, the number printed beside it was tallied over *the groups that panel draws*. Since one-offs are drawn in Backlog, two overdue one-offs made the Routine panel offer "Reset to backlog" beneath "0 items are waiting for a day", ask "Clear the day from 0 overdue items?", and then clear both.

A bulk destructive action has to name its own reach. The overdue count is now taken over the whole view, exactly as `has_overdue` already was; the header's "not done" count stays panel-scoped, because that one really does label its own panel. The two counts have different scopes on purpose, and the code says why.

**"Other" heading, per group.** See the correction above — found by rendering the panel rather than by reading the model.

**A dnd-kit race in the test helper, not the app.** `KeyboardSensor.attach()` registers its keydown listener inside a `setTimeout`, while `aria-pressed="true"` commits in the same task as the Space press. So waiting on `aria-pressed` was not enough: the arrow key could land before the listener existed and be dropped in complete silence — no transform, no announcement, no error. The helper now waits for the listener count on `document` to rise before pressing the arrow.

This matters beyond the flake: in the `expectMove: false` case an unreceived arrow would have "proved" the band boundary held when nothing had been tested at all. A test that passes because its input was silently discarded is worse than one that fails.

### The stripe's gaps are painted

The space between dashes was `transparent`, so it showed the row's own background and the stripe read as a broken line rather than as alternating bands — which is what makes the dash count easy to see at a glance.

The two tones ended up as: **dash** = `color-mix(in srgb, var(--text) 40%, var(--surface))`, **gap** = `var(--border)`. So the stripe is a continuous line with alternating weight rather than a line with holes in it.

It took three passes, and the discards are the useful part:

1. *Gap mixed to sit between the dash and the surface.* Needed no second value, but sitting between two close greys is barely an alternation.
2. *Gap fixed brighter than the border — `#ccc`-ish.* Reads well on dark, where it clears the `#2e343a` border by 8.2:1. Nearly invisible on light, where the border is already `#dededa` and the same grey gives 1.2:1 — so it needed a different hardcoded value per theme, which is two things to keep in step.
3. *Derive the mark from `--text` and let the border be the gap.* Both ends of the mix flip with the theme, so one definition lands on a mid grey on either ground: dash-to-gap is 2.5:1 on dark and 1.9:1 on light, with nothing hardcoded and nothing per-theme.

`--stripe-colour` remains the dash, so overdue and a baseline task's own colour still override it and inherit the same alternation for free.

The test asserts a contrast ratio between the two tones, not a hex — and deliberately does **not** assert the gap against the row surface. The gap is the border colour, and a border being quiet against a surface is what a border is for.

One thing worth recording for the next person who measures a colour in a test: `color-mix()` resolves to `color(srgb 0-1)`, not `rgb(0-255)`. A parser that assumes the latter silently reports a luminance of zero, which looks exactly like a styling bug and is not one. It cost a wrong conclusion here before the parser was fixed.

### The cadence stripe is removed

Rows keep a plain solid left stripe carrying only whose row it is — border grey, overdue, or a baseline task's colour. The dash-count pattern is gone, along with `--stripe-dashes`, `--stripe-gap`, `--stripe-void`, `--stripe-mark`, the six per-cadence rules and the `data-cadence` attribute.

**Why it went.** A pattern has to be counted before it means anything. Four dashes versus five is a deliberate act of reading, on a list whose whole job is being scanned — and the Routine panel's group headings already name the cadence in words, immediately above the rows they govern. The stripe was restating, in a form that took longer to read, something the screen already said plainly.

The mechanism was sound and the colour work it forced is kept: the stripe is still drawn inside the row's box rather than as a `border`, which is what stops a striped row indenting away from an unstriped one.

Recorded because the path here was three rounds of colour tuning — mix-to-between, fixed-and-brighter, derived-from-text — and none of that was wasted on the wrong question so much as on the wrong feature. The tuning kept improving how legible the dashes were; nobody asked whether counting dashes was worth doing at all.

### Category headings are removed

A category is now a sort key and nothing else — no heading, no chip, no label. It still clusters same-category tasks inside a period group; that clustering is all it does on screen.

The headings failed on two counts, both visible only once there was real data in the app:

- **They repeated per band.** Ordering is band → baseline → category → name, so a category that has both unfinished and completed rows drew its heading twice in one group — `DOG-BARNEY` above the live rows and `DOG-BARNEY` again above the struck-through ones.
- **They restated the heading above them.** A row already sits under *Today* or *This week*; adding *Dog* over it costs a line and says less than the group heading already does.

The "Other" heading went with them, and so did the rule it existed for — with nothing rendered, an uncategorised row can no longer be misread as belonging to the category above it.

Worth noting what this cost: the "Other" heading was itself a fix, added an hour earlier because uncategorised rows were falling under the previous category's heading. Both the problem and the fix disappeared when the feature they belonged to did. The clustering — the thing actually wanted — needed no rendering at all.
## v6 — History gains a log, and colour survives completion

### History columns share the Routine panel's order

Columns were `baseline → name`; they are now `baseline → category → name`, from one comparator (`byBaselineCategoryName` in `sort.ts`) that the Routine panel also uses for its tie-break.

One implementation rather than two, because a column in the grid and a row in the panel are the same task seen twice. Two orderings that are each defensible alone still read as a bug when the same tasks appear in different sequences on two screens. A unit test asserts the two agree, so they cannot drift.

### A log column, opening into a sheet

`HistoryRow` gains `log`. The column shows a control on days that have an entry and **nothing** on days that do not — the absence is the information, and a disabled control would say less while taking the same space.

The entry opens in a sheet rather than inlining: it is prose and will not fit a grid cell. Line breaks are preserved, because they belong to whoever wrote them. History stays read-only; the sheet reads and closes, and a test asserts the whole model is byte-identical afterwards.

Empty strings are already stored as `null` by `set_log`, so an "empty entry" is not a state the column has to render.

### A completed task keeps its colour

Both the tick and the name now stay in a baseline task's colour once ticked, instead of dropping to the dim text colour.

The strike-through and the filled box already say "done" twice over. Dimming the name as well removed the colour at exactly the point the completed section is longest and the grouping cue most useful — the colour was doing its most work precisely where it was being taken away.

### A favicon

`assets/alfred.png` is the source art; `src/client/icons/` holds the two sizes the page links — 32px for the browser tab, 180px for an iOS home screen. Bun bundles both from `index.html` and serves them with hashed URLs, so there is no static directory and no route to add.

Two sizes rather than one, because scaling in either direction costs something on pixel art: a 32px tab icon downscaled from 180px loses the hard edges that make it legible at that size, and a 180px touch icon upscaled from 32px is worse.

The source is kept out of `src/client/` on purpose. It is 348KB and nothing references it, and anything sitting in the client tree invites being imported by accident.

### History cells wear the task's colour

A filled cell now takes its column's colour where that column is a baseline task with one set, and the neutral done colour otherwise. `HistoryColumn` carries `color`, nulled for anything not baseline — the same rule the other views apply, so the decision stays on the server and in one place.

This is where a colour earns most. The grid is the only screen showing every daily task at once, and a coloured column is findable in a wall of identical squares in a way a name rotated ninety degrees is not.

It completes the set: a colour now follows a task through the Day row, the Routine panel, its tick once ticked, and the grid — so the same task looks like itself everywhere, which is the entire reason for assigning one.

### CSS imports were never typechecked

`bun-types` declares `*.txt`, `*.toml`, `*.yaml`, `*.json5`, `*.html` and more — but not `*.css`. So every `import './day.css'` was a module TypeScript could not resolve, in all five view files.

Nothing said so, because those are **side-effect imports** and TypeScript does not check them unless `noUncheckedSideEffectImports` is set. `bunx tsc --noEmit` was clean the whole time; an editor with the flag on reported `ts(2882)` on every view. The compiler and the editor disagreed, and the editor was right.

Fixed with `src/client/css.d.ts` declaring `*.css` with an empty body — Bun bundles the file and links it into the page, so there is no value to import, and an empty module makes `import styles from './day.css'` an error rather than silently `any`. The flag is now on in `tsconfig.json` so the CLI and the editor agree.

Worth being precise about what that buys, because it is less than it sounds: the wildcard matches *any* `.css` path, so a mistyped filename still typechecks. Only an extension nothing declares is caught. A missing stylesheet surfaces as an unstyled screen, which the browser suite notices and the compiler cannot.
