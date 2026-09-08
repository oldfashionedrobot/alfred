# Household Tracker — Changes v12

Continues [`changes-v11.md`](changes-v11.md).

**Nothing here is built yet.** Written and agreed before implementation, like v11 —
each item with what it costs and what it rejects.

One substantive piece of work, one thing that turned out to need no code at all,
and three deferrals. A short iteration, deliberately — v10 and v11 were both
larger than intended, and each grew because something found mid-flight got
absorbed rather than scheduled.

---

## 1. Accessibility, which has never been verified

**The honest starting position.** This app is not careless about accessibility —
`--tap: 44px` is defined as a minimum touch target, `aria-` attributes appear
across every view, visually-hidden `.sr` spans carry labels, and `:focus-visible`
outlines exist. The intent is visible in the code.

**None of it has ever been checked.** That is the gap: not neglect, but an
assumption nobody has tested. And it is the one area where "seems fine on my
phone" genuinely proves nothing, because the person who built it knows where
everything is and reads it in the light they designed it in.

**Two gaps are already known**, found while scoping this:

- **No `prefers-reduced-motion` anywhere.** The day carousel scroll-snaps, rows
  animate on drag, and sheets transition. Someone who has asked their OS to stop
  moving things gets all of it anyway.
- **`:focus-visible` is defined in two places** — the History scroller and a
  reordering row — not globally. Every other control falls back to whatever the
  UA draws, which on a custom-styled button is often nothing.

**What the pass covers.**

| | |
|---|---|
| **Contrast** | Every token pair against WCAG AA — 4.5:1 for text, 3:1 for UI and large text — in *both* themes. There is a dark theme, and it has never been measured. Objective and mechanical. |
| **Tap targets** | `--tap: 44px` exists; verify it actually reaches every interactive element rather than the ones it was applied to. Checkable from Playwright with bounding boxes. |
| **Focus** | A global visible focus style, and a tab order that matches reading order — particularly through the carousel, where the panes off-screen are still in the DOM. |
| **Motion** | Honour `prefers-reduced-motion` on the carousel, the drag, and the sheets. |
| **Screen reader** | A VoiceOver pass on the actual phone. The app is small enough to read end to end, and this is the part no tool substitutes for. |

**On automating it.** `@axe-core/playwright` would catch a useful subset — missing
labels, contrast, ARIA misuse — as part of the existing suite. It is a new
dependency in a project that has resisted them, and it cannot judge focus order
or whether a label reads sensibly aloud. Worth adding **only** if the manual pass
finds enough to be worth guarding; not worth adding first, on the theory that a
tool will do the thinking.

---

## 2. Error visibility — nothing to build

**Already instrumented.** Unhandled errors reach `console.error('[api]', err)` in
the route handler, which goes to stderr, which Fly captures. Fly retains logs for
**7 days** and makes them searchable in the dashboard. "Did anything break this
week" is answerable right now, for free, with no work.

**What is actually missing** is smaller than it looked: nothing prompts anybody
to look, and nothing survives past 7 days.

**Both fixes cost more than the problem.** Longer retention means running a log
shipper, which is a second Fly app and therefore real money. Notification means a
scheduled job polling Fly's log API. For one household, neither earns its place.

**So this item is documentation**: where to look, and what `[api]` means when you
find it. If it ever stops being enough, the cheap next step is logging errors to a
table — no dependency, permanent, queryable — and that is a decision to take
against evidence rather than in advance.

---

## Deferred, with what would trigger them

**A way to set a user's timezone.** v11 added `users.timezone` and nothing writes
it. That sounds worse than it is: the column defaults to `America/New_York`, the
migration applied that default, and production's `owner` has it. The gap only
appears when a **second person lives in a different zone** — which is exactly the
trigger. Until then a writer would be a form nobody opens.

**Backups beyond one day.** Turso's free tier gives one day of point-in-time
restore. `deployment.md` already says what that does not cover — *"I deleted
something last week"* — and calls a bad migration the most dangerous thing in the
design, for an app whose entire value is accumulated history.

Four options were costed. A scheduled GitHub Action committing to a **private**
repo is free, needs no new vendor, and gives git history over a 128 KB file —
the whole database today is 47 tasks, 39 completions and 4 days, and
`deployment.md` estimates ~0.5 MB a year. Cloudflare R2's free tier (10 GB,
permanent, zero egress) is the more correct architecture for the same work.
Turso's own API can create branches, which is the simplest to build and the
weakest as a backup, being a copy inside the same provider.

**None of them, for now.** The chosen answer is Turso's **Developer plan at
$4.99/month**, which takes point-in-time restore from 1 day to 10, whenever the
exposure starts to feel real. Zero engineering, no new vendor, no second repo, no
scheduled job to fail silently. It buys ten days rather than forever, and ten days
is the honest requirement here: this guards a mistake noticed late, not an
archival obligation.

**Explicitly rejected: artifacts on a scheduled Action in this repository.** It is
public, and artifacts on a public repository are downloadable. That is the
household's data.

**The seven-second cold start.** Measured and documented in
[`changes-v10.md`](changes-v10.md): Fly's machine start is ~1.4s and our own boot
is ~5.1s, and it is not the Turso sync — `initDb()` costs ~1.3s with no Turso at
all. Every fix costs something real: `min_machines_running = 1` is ~$2/month and
the end of scale-to-zero. **Deferred until there is a second user**, on the
grounds that one person who knows why it is slow tolerates it differently from a
guest who does not.
