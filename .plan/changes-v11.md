# Household Tracker — Changes v11

Continues [`changes-v10.md`](changes-v10.md).

**Nothing here is built yet.** This is the plan for the iteration, written and
agreed before any of it is implemented — six items, each with what it costs and
what was rejected. Entries become records as they land.

---

## 1. Timezone belongs to the user

**What.** `users.timezone`, an IANA name, defaulting to `America/New_York`.
`today()` takes that zone and derives the date in it.

```ts
new Intl.DateTimeFormat('en-CA', {
  timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
}).format(new Date())
```

`en-CA` yields `YYYY-MM-DD` directly. Checked, not assumed: run in a process
whose own local date was already `2026-09-08`, that returns `2026-09-07` for New
York. No `TZ` environment variable, no dependency.

**Why now, when there is one user.** v10 set `TZ=America/New_York` in
`fly.toml` — correct while everyone shares a zone, and silently wrong the moment
somebody does not. It is also small, and doing it now means three things get
*deleted* rather than added:

- **The `fly.toml` `TZ` line goes.** Once the zone comes from the user, the
  container's own zone is irrelevant. A feature that removes deployment coupling.
- **The test/clock split goes.** [`changes.md`](changes.md) records that
  `bun test` runs `TZ=UTC` while the browser suite runs local, so the two
  disagree about what day it is and the skip count moves with the clock. With an
  explicit zone parameter, nothing depends on process `TZ`.
- **The missing regression test becomes trivial.** Nothing today would catch `TZ`
  being dropped from `fly.toml`. "A user in `America/New_York` sees `2026-09-07`
  when the instant is `02:35Z`" is a pure unit test — deterministic, no wall
  clock, which was the objection to testing it through the deployed app.

**Cost.** Nineteen `today()` call sites across five server files and five test
files. `currentUser` already resolves the user in `routes.ts`, and every builder
and command already takes a `userId`, so the zone travels the path the user id
already travels. Mechanical, not hard.

**Rejected: the client sends its timezone, or its date.** Sending a *date*
dissolves the invariant the model rests on — `today.ts`: *no endpoint accepts a
date meaning "the day to render", which is what makes same-day-only recording
structural rather than a rule the UI is trusted to follow.* Overdue, period
satisfaction and the History grid all stand on it.

Sending a *zone* is much weaker and genuinely defensible. It is refused for a
different reason: it makes the day boundary a property of the **device**. A
laptop in London and a phone in Atlanta would disagree about what day it is for
the same person, and the same task could be ticked twice on two different todays.
A day belongs to a person.

**Not a trigger: travel.** A week away does not move somebody's tasks to another
day. The zone is where you live, not where you are standing.

---

## 2. `/api/status` drops `date`, and gains the database it is talking to

**What.** `{ ok, date, sha }` becomes `{ ok, sha, database }`, where `database`
is `'local'` or `'replica'`.

**Why `date` goes.** It is ungated, so with per-user zones there is no user to
derive a date for. A health endpoint should not claim to know what today is for
somebody it has not identified. It was only ever there because the browser
fixture needed a date before signing in.

**Why `database` arrives.** This is the durable fix for the guard added in v10.
That guard infers "local file" from the *absence* of a `-info` file beside the
database — true today, and an implementation detail of libSQL rather than a
contract. It is also the only thing standing between us and a repeat of the
afternoon the suite wrote 206 rows into production, so it should not rest on a
detail that can change without notice. Asking the server what it is connected to
is a contract, and it cannot drift.

Exposing it publicly is deliberate: it reveals that the app runs against a
replica, which is already written down in a public repository, and the value of a
guard that reads the same field the fixture does outweighs it.

**Cost.** The fixture reads `app.today` from `/api/status` today; it moves to
reading from `/api/day` after signing in. Tests constructed with
`signedIn: false` therefore have no `today`, which is correct — an unauthenticated
client has no day — but the fixture's types should say so rather than hand back
something empty.

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

## 4. The asset paths get a `<base>` tag

**What.** `<base href="/" />` in `src/client/index.html`.

**Why this and not the alternatives.** Bun computes chunk paths from the location
of the file that *imports* the HTML — `src/server/index.ts` — so it emits
`/../../chunk-y0m076hy.js`. Browsers normalise that to `/chunk-…` and the app
works; requested literally it falls through to the `/*` route and returns the
**HTML shell with a 200**, which is a memorable thing to debug at 2am.

This is [oven-sh/bun#22690](https://github.com/oven-sh/bun/issues/22690), closed
as a duplicate of #18809 and still open upstream. Two workarounds are documented:
`<base href="/">`, or `publicPath: "/"`. `publicPath` is confirmed to work in
`Bun.build` — it emits `/chunk-x.js` — but is not exposed on `Bun.serve`'s HTML
route, which is what this app uses. So the `<base>` tag is the one available.

---

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

1 and 2 are one change and land together — the `/api/status` shape depends on the
timezone decision. 4 is a line and can go with them. 3 is churn and should follow,
so a folder move never appears in the same diff as a behaviour change. 6 is the
largest and is last, because its failure count is unknown until the harness runs.
5 is not scheduled.
