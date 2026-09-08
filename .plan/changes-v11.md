# Household Tracker — Changes v11

Continues [`changes-v10.md`](changes-v10.md).

**Nothing here is built yet.** This is the plan for the iteration, written and
agreed before any of it is implemented — six items, each with what it costs and
what was rejected. Entries become records as they land.

---

## 1. Timezone belongs to the user — BUILT

**What.** `users.timezone`, an IANA name defaulting to `America/New_York`
(migration `0004`). `today(zone)` derives the date in it, via
`Intl.DateTimeFormat('en-CA', { timeZone })` — `en-CA` formats as YYYY-MM-DD,
which is the only reason that locale is there. No `TZ` variable, no dependency.

**The three deletions promised, all delivered.**

- **`fly.toml` lost its `TZ`.** v10 added it because the container ran UTC and
  called 8pm Monday "Tuesday". With the zone on the user, the container's own
  zone stopped mattering; the process runs UTC and its logs are the better for it.
- **The test/clock split is gone.** Each suite now names its zone — `const ZONE
  = 'UTC'`, chosen because it has no DST, so no test lands on a day that is 23 or
  25 hours long. Nothing reads the process's `TZ` any more.
- **The regression test exists**, in `period.test.ts`: at `2026-09-08T02:35:00Z`,
  `UTC` says the 8th and `America/New_York` says the 7th. That is the exact hour
  the deployed app was a day ahead of the household.

**Three things the plan did not anticipate.**

**A `Viewer` type, rather than a second parameter.** `{ id, timezone }`, defined
beside `today()`. The alternative was passing `userId` and `zone` side by side
through every builder and command — two values that must always agree, and
eventually would not. `UserRow` satisfies it structurally, so `routes.ts` passes
the row it already has.

**The clock is read once per command, not per call.** `runCommand` derives the
date at the top and passes it down. This was going to be five call sites each
calling `today(viewer.timezone)`; it became one, and that is a correctness
improvement rather than a tidy-up — `uncomplete` read the clock *twice* in a
single call path, and two reads either side of midnight would delete a
completion for a day the check never considered.

**`today(zone, now?)`.** The instant is an optional argument, defaulting to the
clock. No caller passes it; it exists so the regression test can name an instant
instead of stubbing the global `Date`, which was the first attempt and did not
typecheck. This is still the only place a date is read from the clock.

**Cost, against the estimate.** The plan said nineteen call sites; the compiler
found fifteen, across five server files and four test files. Mechanical
throughout, as predicted.

---

## 2. `/api/status` drops `date`, gains `database` — BUILT

**What.** `{ ok, date, sha }` became `{ ok, sha, database }`, where `database` is
`'local'` or `'replica'`.

**Checked before changing it**, because it is a wire contract: the client never
calls `/api/status` at all, and CI's smoke test reads only `.sha`. The single
consumer was the browser fixture.

**The fixture now learns "today" from `/api/day`, after signing in** — which is
the only point at which "today" means anything, since it is now a property of a
user. A `signedIn: false` test gets an empty string.

**The plan said the fixture's types should say so rather than hand back something
empty, and they do not.** `today` stays `string`. Making it `string | null` would
force a null check at roughly forty use sites to guard a case no test reaches:
`auth.spec.ts` is the only `signedIn: false` suite and never touches `app.today`.
The comment says what the empty string means. Recorded as a deviation rather than
quietly done.

**The guard now asks the server.** `harness.spec.ts` asserted the *absence* of a
libSQL `-info` file beside the database — true at the time, an implementation
detail that could change without anybody noticing the guard had stopped guarding,
and the only thing standing between us and a repeat of the afternoon the suite
wrote 206 rows into production. It reads `database === 'local'` now.

---

## 3. `Day.tsx` becomes a folder

**What.** `src/client/views/day/` holding `Day.tsx`, `CaptureSheet.tsx`,
`TaskRow.tsx`, `DayStrip.tsx`, `DragBand.tsx`, `MoodRow.tsx` and `day.css`.

**Why.** 1133 lines, more than a quarter of the client, holding seven distinct
things. It is the file most likely to become unpleasant to work in, and this
iteration adds to it.

**The rule that keeps this honest**, so the pattern does not spread on aesthetics:
a component earns its own file when it is used elsewhere, or when the file it
lives in has become hard to navigate. `History.tsx` (202 lines) and `Todo.tsx`
(394) stay single files until one of those is true of them.

**Cost.** Pure churn — no behaviour changes, and the browser suite is the proof.
Worth doing in the same iteration that adds to the file, and not worth doing on
its own.

---

## 4. The asset paths — no fix at this Bun version. Deferred to the upgrade

**The plan said `<base href="/" />`. That was wrong, and testing it is how we
know.** In production `Bun.serve` emits `/../../chunk-x.js` — already absolute, so
a `<base>` tag never applies to it. The workaround in
[oven-sh/bun#22690](https://github.com/oven-sh/bun/issues/22690) is for
`Bun.build` output, which emits *relative* `./chunk-x.js`. Different code path,
same-looking bug.

**What the prefix actually tracks is the HTML file's own location.** Measured,
serving the same app three ways in production mode:

| `index.html` at | emitted |
|---|---|
| `src/client/` (today) | `/../../chunk-x.js` |
| project root | `/chunk-x.js` |

So there is a fix available: move the entrypoint to the repository root. It is
declined. That separates `index.html` from the code it loads, puts a build
artifact's neighbour in the root directory, and buys a cosmetic improvement —
browsers normalise the path and the app has always worked.

**What is actually wrong is small and worth stating precisely.** Requested
*literally*, without normalisation, `/../../chunk-x.js` falls through to the `/*`
route and returns the HTML shell with a **200**. Anything that normalises — every
browser, and `curl` without `--path-as-is` — never sees it. The exposure is a
confusing five minutes for whoever meets it first, not a defect users can reach.

**So it waits for the Bun upgrade**, where it may simply be gone, and where the
browser suite is the check. Item 5 stops being unscheduled and becomes the home
for this.

## 5. The Bun upgrade is its own work, and not yet

**What.** Stay on 1.3.14 for now. Revisit deliberately.

**Why not now**, having been tempted to make it the fix for item 4. Bun 1.4 is
the **first release of the Rust rewrite**. It documents no change to HTML asset
resolution, so there is no evidence it fixes item 4 at all, and it carries
regression reports of its own (#32728, #32686). Bun's own release post says to
test `Bun.serve` HTML routing thoroughly before upgrading.

Upgrading a deployed app onto the first release of a rewrite, to fix a cosmetic
path issue that a one-line `<base>` tag fixes, is the wrong trade. It is worth
doing later, on its own, with the browser suite as the check — and 1.4 has things
worth having: `Bun.serve` routes can serve a directory with ETag, Range and 304
handled, and production HTML routes stop serving sourcemaps.

---

## 6. Cross-browser, and the honest limits of it

**What.** WebKit in CI, and a checked-in `Dockerfile.test` so it can be run
locally. No manual test plan.

**What emulation gives.** Playwright ships 207 device profiles; `iPhone 15` sets
the user agent, a 393×659 viewport, `deviceScaleFactor: 3`, `isMobile`,
`hasTouch` and `defaultBrowserType: 'webkit'`. That catches engine differences —
CSS anchor positioning, popover support, layout and touch.

**What it does not give, and this is the part that matters here.** Playwright
cannot drive Safari on a physical iPhone: Apple does not permit third-party
automation, so real-device iOS is cloud services only. Emulated WebKit is
*desktop WebKit in a mobile viewport*, not iOS Safari.

The bug this project already shipped is exactly in that gap: `popover="auto"`
treated the browser's own calendar chrome as a click outside, so changing month
dismissed the picker and placed a task. The iOS date picker is OS chrome. No
emulation reaches it.

So the coverage is honest about its shape: **WebKit in CI** for the engine, and
**nothing automated** for the native picker or anything else the OS draws.
BrowserStack is not worth buying for a household app.

**And no written checklist for that gap either**, which is a deliberate choice
rather than an omission. This app has one household and is opened on the same
phone every day; the person who would write the checklist is the person who would
notice within a day of shipping. A test plan nobody runs is worse than admitting
there isn't one, because it reads like coverage.

The residual risk is stated rather than papered over: an iOS-only regression in
the parts Safari draws itself — the date picker especially, which has bitten this
project once — ships, and is found by using the app. For a household tracker that
is an acceptable trade. It would not be for anything with users who are not you.

**The local container is the enabling piece.** Playwright 1.63 pins macOS 14 to
WebKit 2251 while its driver targets 2359, so WebKit cannot run on this laptop at
all — every test dies in fixture setup before reaching the app (v10 records the
detail). The Linux image carries the matching revision. Without a container there
is no way to reproduce a WebKit CI failure locally, which would make WebKit in CI
a red light nobody can investigate.

**Android, asked about and deliberately thin.** Playwright can drive real Chrome
on an Android device or emulator, and ships Pixel profiles. But an emulated
Android profile is Chromium with a mobile viewport and touch — which is exactly
what the existing `mobile` project already runs. A separate Android suite would
re-run the same engine at a different user-agent string. Real Android automation
needs a device or an emulator in CI and buys coverage of an engine we already
test. So: no Android suite. If somebody in the household ends up on Android, the
gap that matters is Chrome-on-Android's own quirks, and the answer then is the
same manual checklist, on that phone.

**The shape this leaves.** Four browser projects — `mobile` and `desktop` on
Chrome, `mobile-webkit` and `desktop-webkit` on WebKit. That is every layer
automation can honestly reach here, and the layer beneath it is daily use.

**Known before starting: the app fails a lot of WebKit.** A partial run reached
8 passed against 24 failed, as real in-test failures rather than protocol errors.
That is the actual work of this item — triage, not configuration.

---

## Order

1 and 2 landed together, as planned — the `/api/status` shape depends on the
timezone decision.

4 was meant to go with them and did not: the fix in the plan turned out not to
work, and the fix that does work costs more than the problem. It is folded into 5.

3 follows, so a folder move never appears in the same diff as a behaviour change.
6 is last and largest, because its failure count is unknown until the harness
runs — and is known to be substantial.
