# Household Tracker — Changes v12

Continues [`changes-v11.md`](changes-v11.md).

**Nothing here is built yet.** Written and agreed before implementation, like v11 —
each item with what it costs and what it rejects.

One substantive piece of work, one thing that turned out to need no code at all,
and three deferrals. A short iteration, deliberately — v10 and v11 were both
larger than intended, and each grew because something found mid-flight got
absorbed rather than scheduled.

---

## 1. Accessibility — WCAG 2.2 Level A and AA, and no further

**The target is basic conformance.** Not an exemplary experience: the success
criteria at Level A and AA, checked, with the gaps closed. Anything at AAA is out
of scope and is named below so the line is visible rather than implied.

**The honest starting position.** This app is not careless about accessibility.
`--tap: 44px` is defined as a minimum touch target, `aria-` attributes appear
across every view, visually-hidden `.sr` spans carry labels, and `:focus-visible`
outlines exist. The intent is in the code. What is missing is that **none of it
has ever been checked** — and this is the one area where "seems fine on my phone"
proves nothing, because the person who built it knows where everything is and
reads it in the light he designed it in.

**What is in scope, by criterion.**

| Criterion | Level | Status going in |
|---|---|---|
| 1.1.1 Non-text Content | A | `aria-` labels exist throughout; never verified for accuracy |
| 1.3.1 Info and Relationships | A | semantic elements used; headings and list structure unverified |
| 2.1.1 Keyboard | A | drag reorder has a keyboard path already, tested |
| 4.1.2 Name, Role, Value | A | needs a read of every control's accessible name |
| **1.4.3 Contrast (Minimum)** | AA | **never measured, in either theme** |
| **1.4.11 Non-text Contrast** | AA | **never measured** — borders, the tick, the colour stripes |
| **2.4.7 Focus Visible** | AA | **defined in two files only**, not globally |
| 2.5.8 Target Size (Minimum) | AA | requires 24×24 CSS px; `--tap` is 44px, so this is a verification that it reaches every control |

**The one known gap is focus.** `:focus-visible` is styled on the History
scroller and a reordering row. Every other control falls back to whatever the UA
draws on a custom-styled button, which is often nothing. That is a straight AA
failure and the clearest thing to fix.

**Contrast is the bulk of the work**, and it is mechanical rather than a matter of
taste: every foreground/background token pair against 4.5:1 for text and 3:1 for
UI, in light *and* dark. The dark theme has never been measured at all.

**Explicitly out of scope, at AAA:**

- **2.3.3 Animation from Interactions (AAA)** — `prefers-reduced-motion`. There is
  none anywhere in the app, so the carousel, drags and sheets animate regardless.
  An earlier draft of this plan listed that as a gap; **it is not a conformance
  gap at AA**, and it is recorded here because the correction is the point. It is
  about five lines of CSS if it is ever wanted for its own sake rather than for a
  standard.
- 1.4.6 Contrast (Enhanced), 2.4.8 Location, and the rest of AAA.

**Rejected: `@axe-core/playwright`.** It would catch a subset — missing labels,
contrast, ARIA misuse — inside the existing suite. It is a new dependency in a
project that has resisted them, it cannot judge whether a label reads sensibly
aloud, and adding a tool before doing the pass outsources the thinking. Worth
reconsidering **after**, if the pass finds enough that is worth guarding against
regression.

**Not scope creep, but worth one look:** a VoiceOver pass on the actual phone.
Not a formal audit — reading the day screen top to bottom once, to check the
labels say what they mean. The app is small enough that this is minutes.

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
