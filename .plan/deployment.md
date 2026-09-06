# alfred — Deployment

Status: design, not yet built
Companion to [`changes.md`](changes.md) and [`changes-v8.md`](changes-v8.md). The frozen originals are in [`design/`](design/).

The app has run on a laptop until now. This is the plan for putting it somewhere a phone can reach, and it is deliberately the smallest arrangement that is not fragile.

An earlier draft of this document targeted AWS Lightsail. It was replaced because Fly handles, as configuration, four things that plan had to assemble: TLS and certificate renewal, the deploy mechanism, the registry, and the machine itself. What survived the switch is everything about *this app* — the database design, the auth spec, CI. What went was infrastructure.

---

## Shape

```
  git push
     │
     ├─ GitHub Actions ── tsc → bun test → playwright (mobile + desktop)
     │                              │
     │                      on main, if green
     │                              ↓
     │                        flyctl deploy  →  smoke test
     │
  Fly Machine (sleeps when idle)
     ├─ TLS terminated by Fly at <app>.fly.dev
     └─ alfred ── bun src/server/index.ts
             ├─ /data/alfred.db   replica, on a Fly volume
             └─ Turso ─────────── the durable copy
```

Three moving parts: a repository, one Fly app, one Turso database. No load balancer, no reverse proxy, no registry, no server to patch.

---

## The database

### What an embedded replica is

Turso keeps a **complete copy of the database as an ordinary SQLite file on the machine's disk**.

```
READ   →  the local file                       microseconds, no network
WRITE  →  sent to Turso, applied there,        one network round trip
          then pulled straight back down
```

Reads are nearly everything this app does — every screen is derived on read — so they run at the speed they do on a laptop. Writes (a tick, a mood, a placement) pay one hop.

This is what makes hosting tolerable without giving up the premise `design/tech-stack.md` was built on: *"single-user, local file, microsecond queries."* A conventional hosted database would have turned every view builder's three-to-six queries into three-to-six network round trips.

### What follows from it

**Turso is the source of truth; the local file is a cache.** Losing the machine loses nothing. That retires the failure mode `design/tech-stack.md` called the dangerous one — *"a month of data lost at a deploy and noticed later"* — because no copy of the data exists only on the server any more.

**Read-your-writes holds.** A write is applied locally as it lands, so nothing is ever ticked and then seen unticked.

**Changes made elsewhere arrive on the sync interval**, currently 60 seconds. This matters for exactly one thing: `README.md` tells you to edit the mood set directly in the database. Done through Turso's dashboard, the running app will not see it for up to a minute.

**Lock-in is near zero**, which is worth noticing because it was not designed for. The replica is a complete, ordinary SQLite file. Migrating off Turso is: stop setting `TURSO_URL`.

### Region

The Fly app and the Turso database go in the **same region**. Every write pays a round trip; colocated that is single-digit milliseconds, mismatched it is 100ms+ on every tick. Easy to get right once, annoying to discover later.

### The replica gets a Fly volume

A 1 GB volume mounted at `/data`, about $0.15/month.

This reverses the position taken twice in the earlier draft, and the reason is a number rather than an opinion. Turso's free tier allows **3 GB of syncs per month**. Without a volume, every wake re-bootstraps the whole database, and the cost is *database size × wake frequency* against a fixed allowance:

| data | db size | 5 wakes/day | 10/day | 20/day | 50/day |
|---|---|---|---|---|---|
| 1 year | 0.54 MB | 3% | 5% | 11% | 26% |
| 5 years | 2.55 MB | 12% | 25% | 50% | 124% |
| 10 years | 5.05 MB | 25% | 49% | 99% | 247% |

Fine for years at realistic use — but both terms only ever grow, and the failure mode when the allowance runs out is that syncs stop, which breaks writes. With a volume the replica persists across sleeps, so a wake syncs only the delta: a day's changes are seventeen completions, well under a kilobyte. The growth term disappears.

The earlier reasoning was not wrong about the database being small. It missed that the relevant quantity is *small database times many wakes*, and that scale-to-zero multiplies the second term.

**The volume is still an optimisation, not a safety measure.** Deleting it loses nothing at all — Turso holds the data, and a fresh machine rebuilds the file on boot.

### Backups

Turso's free tier includes **one day of point-in-time restore**. That covers the realistic accident: a bad bulk action or a mistaken archive, noticed the same day.

It does not cover *"I deleted something last week."* If that matters, the answer is a periodic `turso db dump` to somewhere **off Fly** — a copy on the machine is not a backup, because the machine is disposable by design.

---

## The app on Fly

### It sleeps when idle

`auto_stop_machines` on, `min_machines_running = 0`. The machine stops when no requests arrive and starts again on the next one.

The cost, measured rather than estimated:

Re-measured after v8, three runs, on this machine:

| | |
|---|---|
| Boot → answering `/api/day` | **~80 ms** |
| First HTML request, which bundles the client | **~42 ms** |
| Fly machine start | ~0.5–1 s |
| Replica delta sync (with the volume) | negligible |

So roughly **one to two seconds of server time on the first tap after idle**, then instant until it sleeps again. In exchange the machine bills only for the minutes it is awake.

**That table is only the server's half, and the other half is bigger.** See the next section.

### The client still bundles at startup

`Bun.serve` builds it from `index.html` on the first request. Pre-building into the image was considered and rejected: it would save the ~42 ms measured above, at the cost of a build step that `design/tech-stack.md` deliberately avoided. The measurement is recorded here so nobody reopens it on a hunch.

### The bundle is 269 KB and is not compressed

Measured against `NODE_ENV=production`:

| | |
|---|---|
| Client JS, as served | **269 KB** |
| The same bytes, gzipped | **85 KB** |
| `Content-Encoding` on the response | **none**, even when the request asks for gzip |
| CSS, four files | ~22 KB total |

`Bun.serve`'s HTML bundler does not negotiate compression, so a cold visitor downloads about three times more than they need to. On a phone that is very likely the **largest single term in the first tap after idle** — larger than the machine start this document has been treating as the headline number — and it is absent from the table above because that table only measures the server.

Three things are unresolved and are worth settling before the first deploy rather than after:

1. **Whether Fly Proxy compresses on the way out.** If it does, this costs nothing and the note stands only as a record. Not assumed either way here.
2. **If it does not**, the fix is a response wrapper that gzips text assets — real code, against `design/tech-stack.md`'s standing objection to build steps and middleware, but 184 KB per cold visit is a real number to weigh it against.
3. **Caching.** Bun fingerprints the asset paths (`index-00000000ab17d8e9.js`), so they are safe to cache forever — but only if something sets `Cache-Control`. Nothing does. A returning visitor re-downloads the bundle on every cold start, which makes item 2 worse in proportion.

None of this blocks a deploy. It is recorded because "one to two seconds" is the claim this document makes about the experience, and on a phone that claim is currently wrong by the download.

### No health check

`fly.toml` has no `[checks]` section.

A check would not buy crash recovery — Fly restarts a machine whose process exits regardless — and it does nothing while the machine is stopped. Its one real value would be **deploy gating**: catching a release that boots but cannot serve, which for this app means `initDb()` throwing on a bad Turso token, a failed migration, or the missing-`APP_PASSWORD` guard.

The CI smoke test below does that job better, and removes a question the Fly documentation does not answer: whether health-check traffic counts as traffic for autostop. It is run over the private network rather than through Fly Proxy, which suggests it does not — but "suggests" is not a foundation, and deleting the check deletes the question.

---

## Deploying

CI runs `flyctl deploy` with a `FLY_API_TOKEN` repository secret, deploy-scoped and revocable.

**This reverses a position from the earlier draft and should not pass quietly.** That plan refused to put any credential in CI — no SSH key, no open port — and had the machine poll a registry instead. A Fly deploy token is a credential in CI.

The distinction is real: a deploy token grants no shell and opens no inbound port, and is revoked with one command. But it is a weaker position than "no secrets at all", and the earlier objection was to *SSH keys and open ports* specifically, not to credentials in general.

---

## Knowing what is deployed

**The app reports the commit SHA it was built from.** Passed in at image build time, served on a trivial endpoint.

**CI smoke-tests the deploy**: after `flyctl deploy`, request the public URL and assert the app answers *and* reports the SHA just deployed.

Three lines that fold in three things — deploy verification, version confirmation, and the deletion of the health-check question. Without it, `flyctl deploy` reports success for a release that cannot serve, so the smoke test is not optional.

---

## Auth

A **shared password and a session cookie**. `design/tech-stack.md` asked for *"a single shared password in an env var, checked in middleware"*; this is that, with a cookie so a phone is not re-prompted.

### The cookie is stateless

```
value   <expiry-ms>.<hmac>
hmac    HMAC-SHA256(key, expiry-ms)
key     derived from APP_PASSWORD
```

Verifying means recomputing the HMAC, comparing in constant time, and checking the expiry. **No sessions table, no in-memory map, no cleanup, and it survives a restart** — which matters more now that the machine restarts several times a day. A session table would have been a fifth table in a model that argued its way down to four, and the only one holding something that is not an observation about the household.

Deriving the key from the password gives revocation for nothing: change `APP_PASSWORD` and every existing cookie stops verifying.

### Two insertion points

- `/api/*` → `401` without a valid cookie, except `POST /api/login`.
- `/*` → serve the login page *instead of* the app.

The second is easy to omit and worth doing. Without it an unauthenticated visitor downloads the whole client bundle and then watches it fail on `/api/day`; with it they get a form and nothing else.

### Cookie flags

`HttpOnly` so script cannot read it. `Secure` in production only, since local development is plain `http://localhost`. `Path=/`. `Max-Age` of 90 days — being logged out weekly on the screen you tick seventeen times a day is exactly the friction this design keeps refusing.

**`SameSite=Lax` is the one doing quiet work.** It withholds the cookie from cross-site POSTs, and since every mutation here is a POST, that is CSRF protection without a token scheme.

### Brute force

The password is the only thing between a stranger and the journal, on a public URL. Two guards:

- **The server refuses to start if `APP_PASSWORD` is shorter than 16 characters.** The same fail-loudly pattern as the production guard below; it makes guessing impractical by construction rather than by policy.
- **The login endpoint rate-limits** — a short delay and a lockout after a handful of failures. One machine, so an in-memory counter is sufficient and needs no storage.

### The login page is server-rendered

About thirty lines of HTML returned as a `Response`, with its own inline styles. Not a React view: that would ship the bundle to unauthenticated visitors, which is what gating `/*` exists to prevent. It does not need to look like the app.

### The password stays plaintext in the env var

Compared in constant time, not stored as a hash. Hashing would mean generating a hash to configure the app — ceremony against a threat that does not exist for one shared password on a host only you can reach.

### Off when `APP_PASSWORD` is unset

The same pattern as `TURSO_URL`: development and all 392 tests run unchanged, with no login step threaded through every fixture.

With one guard: **the server refuses to start when `NODE_ENV=production` and `APP_PASSWORD` is unset.** A misconfigured deploy should fail loudly rather than quietly serve a household journal to the internet.

### A footgun this creates, and its fix

**Bun auto-loads `.env`, for `bun test` as well as for the app.** Verified. So an `APP_PASSWORD` in a developer's local `.env` would silently switch auth on for the browser suite, and every test would fail on a `401` — for a reason nowhere near the failure.

The fix belongs in the harness, not in a convention nobody will remember: `e2e/fixtures.ts` passes `APP_PASSWORD: ''` explicitly when spawning each server — **already done**, ahead of the auth code — and will take an option to set it for the tests that exercise the login flow.

A second harness hazard was found and fixed the same way, and is worth recording here because CI is where it would have bitten hardest. The fixture used to ask the OS for a free port, close the socket, and hand the number to bun: a race that four parallel workers lose occasionally, and whose bad outcome is silent — the readiness probe gets a 200 from *another test's* server and the test runs against a foreign database. A shared CI runner is busier than a laptop. `PORT=0` now lets bun choose and the fixture reads the port back off the line the server prints.

`.env` and `.env.*` are gitignored; `.env.example` is tracked as the template.

### What it costs

Roughly sixty lines of server code — sign, verify, the login route, the gate, the page — five in `api.ts` to send a `401` to the login page, and tests for no cookie, wrong password, right password, expired cookie, and lockout.

Rejected: **HTTP Basic**, at about fifteen lines. Same protection, but the browser's own dialog is the login screen, Safari re-prompts, and there is no logout.

---

## Migrations are forward-only

`initDb()` runs the drizzle migrations at startup. **Rolling back the image does not roll back the schema.**

For an app whose entire value is accumulated history, this is the most dangerous thing in the design, and it deserves stating rather than discovering. There is no clever deploy strategy that fixes it at this size — the honest mitigation is that **Turso's 1-day point-in-time restore is the undo**, which means a bad migration has to be noticed the same day.

Practically: migrations are reviewed before merge like any other change, and a release that changes the schema is one to open the app after.

---

## CI

One workflow, on every push and pull request:

| Step | |
|---|---|
| `bunx tsc --noEmit` | includes `e2e/`, which is how the CSS declaration gap surfaced |
| `bun test` | 156 unit tests over the period logic, ordering, placement and view builders |
| `bunx playwright test` | 236 browser tests across mobile and desktop viewports |
| `flyctl deploy` | `main` only, after the above are green |
| smoke test | request the public URL, assert the deployed SHA |

Two details this suite needs:

**Chrome.** `playwright.config.ts` pins `channel: 'chrome'` — real Google Chrome, chosen locally to avoid downloading Playwright's browsers. A runner needs `bunx playwright install --with-deps chrome`.

**WebKit, and this is now a real gap rather than a nicety.** v8 put the day picker in a `popover`, positioned with CSS anchor positioning where it exists and falling back to the UA's centred placement where it does not. Two paths cannot be tested Chrome-only: that fallback, and what iOS's native date picker does to an open popover. The second is not hypothetical — the equivalent bug on desktop Chrome was real, shipped, and found by hand: `popover="auto"` treated the browser's own calendar chrome as a click outside, so changing month dismissed the picker and placed a task. Safari is the browser this app will actually be used in. Adding `webkit` to the matrix is cheap on a runner and expensive to keep deferring.

**The weekday matrix, weekly rather than per-push.** The suite's behaviour depends on the day: a Saturday offers one placeable date, a Sunday seven, and different tests skip on each. A `TZ` matrix on every push doubles browser minutes for a property that only changes when the scheduling rules change. A weekly scheduled run across both is the better trade — and is where the fixture bugs that bit twice during the build would have been caught.

Actions is free on a public repository.

---

## Browsers this has to work in

Not stated anywhere before, and it should be, because a public URL is opened by whatever is to hand.

| | |
|---|---|
| **Required** | the Popover API — Chrome 114+, Safari 17+, Firefox 125+ |
| **Enhancement** | CSS anchor positioning; without it the picker centres in the viewport, which is a fine menu |
| **Assumed throughout** | `color-mix()`, `dvh`, CSS nesting-free modern syntax, `scroll-snap` |

The floor is the Popover API, which the day picker depends on for correctness rather than polish: it is what keeps the menu out of the day track's overflow. Everything on that list has been baseline for a year or more, so the floor is not a constraint in practice — but it is a thing to have decided rather than discovered from a phone that renders nothing.

---

## Configuration

Nothing sensitive is in the repository or in CI, apart from the deploy token. On Fly, `fly secrets set` stores them encrypted and injects them as environment variables:

```
TURSO_URL=libsql://<db>.turso.io
TURSO_AUTH_TOKEN=...
APP_PASSWORD=...
NODE_ENV=production
```

`DB_PATH=/data/alfred.db` and `PORT` live in `fly.toml`, since they describe the machine's layout rather than a secret.

Locally the same variables go in a gitignored `.env`, which Bun loads automatically. `.env.example` is the tracked template, and documents that every one of them is optional — with none set, the app runs against a local file with no authentication.

---

## Failure modes, and what actually happens

| | |
|---|---|
| **Machine dies** | Fly restarts it. Nothing lost; the volume or a fresh sync rebuilds the replica. |
| **Turso unreachable** | Reads keep working from the replica. Writes fail — a `500`, and the tick does not land. Degraded rather than dead, which is the right way round. |
| **Bad deploy** | The CI smoke test fails, so it is attributed to the change that caused it. `fly releases` and a redeploy of the previous image roll the code back — the schema does not roll back. |
| **Bad migration** | Turso point-in-time restore, same day. See above. |
| **Volume lost** | Nothing lost. A fresh bootstrap sync rebuilds the file. |
| **Sync allowance exhausted** | Writes fail while reads continue. The volume is what keeps this far away. |

---

## Cost

| | |
|---|---|
| Fly machine | pennies — it bills for the minutes it is awake |
| Fly volume, 1 GB | ~$0.15/month |
| `<app>.fly.dev` and TLS | free |
| Turso | free tier: 500M row reads, 10M writes, 5 GB storage, 3 GB syncs, 1-day PITR |
| GitHub Actions | free, public repository |

Call it **under a dollar a month**, dominated by the volume. Verify Fly's current pricing rather than trusting these figures; they restructured their free allowance into a credit model.

---

## Open decisions

**A custom domain, eventually.** Fly issues `<app>.fly.dev` with a working certificate, so nothing is blocked. Adding one later is `fly certs add` plus two DNS records, and changes nothing else here.

---

## Explicitly not doing

Auto-scaling. A staging environment. Blue-green deploys. Container orchestration. Metrics or an APM. Structured log shipping. A health check.

Each is defensible for a service with users. This one has a household, a single writer, and a database measured in kilobytes — and `design/tech-stack.md` set the standard the rest of this project has been held to: *every field earns its place by appearing on a screen*. The infrastructure equivalent is that every moving part should earn its place by preventing a failure that would otherwise happen.
