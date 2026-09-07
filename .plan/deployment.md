# alfred — Deployment

Status: **deployed and running** at **https://alfred.goodghost.com** (and at `gg-alfred.fly.dev`, which is the platform name underneath) — one machine in `iad`, against a Turso database in AWS US East (N. Virginia). CI deploys every push to `main` and smoke-tests the result.
Companion to [`changes.md`](changes.md), [`changes-v8.md`](changes-v8.md) and [`changes-v9.md`](changes-v9.md). The frozen originals are in [`design/`](design/).

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
     └─ alfred ── bun src/server/index.ts   (oven/bun:1.3.14-slim, 256 MB)
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

Fine for years at realistic use — but both terms only ever grow, and the failure mode when the allowance runs out is that syncs stop, which breaks writes. With a volume the replica persists across sleeps, so a wake syncs only the delta. Turso bills sync in **4 kB frames**, so seventeen completions in a day is seventeen frames rather than the few hundred bytes they weigh — about 2 MB a month against a 3 GB allowance. The frame accounting makes the number sixty times larger than a naive byte count and it is still nowhere near the ceiling. The growth term disappears.

The earlier reasoning was not wrong about the database being small. It missed that the relevant quantity is *small database times many wakes*, and that scale-to-zero multiplies the second term.

**The volume is still an optimisation, not a safety measure.** Deleting it loses nothing at all — Turso holds the data, and a fresh machine rebuilds the file on boot.

**Creating it prints a warning, and half of it applies.** Fly says to run two or
more volumes per app, because "volumes don't have built-in replication between
them, so your application must handle data synchronization". This one does — that
is what Turso is — so the data-loss half does not apply, and two volumes is not
available to us anyway: a volume attaches to one machine, and two machines is the
arrangement *Exactly one machine* rules out.

The availability half is real and was under-weighted here. If the drive fails the
machine goes down and **Fly does not move it**; recovery is manual — destroy the
machine and volume, create another, redeploy — and the replica rebuilds from
Turso. Minutes of work, no data lost, but down until somebody notices. A
single-machine app also has a brief outage on each deploy.

Which leaves a fair question: is the volume worth having? Its only job is to stop
each wake re-bootstrapping the database against a 3 GB monthly sync allowance.
Measured, the replica is **131 KB**, so twenty wakes a day is about 78 MB a
month — 2.6%. Keeping it, because the headroom is the term that only shrinks and
a pinned host costs a rare afternoon rather than any data. Dropping it is
deleting `[mounts]` and the `DB_PATH` line, if the pinning ever bites.

### Backups

Turso's free tier includes **one day of point-in-time restore**. That covers the realistic accident: a bad bulk action or a mistaken archive, noticed the same day.

It does not cover *"I deleted something last week."* If that matters, the answer is a periodic `turso db dump` to somewhere **off Fly** — a copy on the machine is not a backup, because the machine is disposable by design.

---

## The app on Fly

### It sleeps when idle, and waking costs seven seconds

`auto_stop_machines` on, `min_machines_running = 0`. The machine stops when no requests arrive and starts again on the next one.

**Measured against the deployed app** by stopping the machine, confirming it
reached `stopped`, and timing the request that wakes it:

| | |
|---|---|
| Fly machine start — Firecracker, volume fsck and mount | ~1.4 s |
| **Our own boot** — `Preparing to run` to `alfred → localhost:8080` | **~5.1 s** |
| **Total, first tap after idle** | **~7 s** |
| Every request after that | 80–190 ms |

An earlier version of this table said 80 ms of boot and "one to two seconds"
overall. That was wrong, and the way it was wrong is the part worth keeping: 80 ms
was measured by timing a request against a server that was *already running*,
which measures the request and not the boot at all.

**It is not the Turso sync**, which was the obvious suspect. Timing `initDb()`
directly gives ~1.3 s against a warm replica, ~1.4 s against a cold one, and
~1.2 s with no Turso configured at all. The sync is not the term. What costs is
module loading plus `migrate()`, and a shared vCPU turns a ~1.7 s laptop boot
into ~5 s.

**Left as it is, deliberately.** Seven seconds on the first tap of the day is
worse than this document claimed and better than it sounds: it happens once, and
everything after is under 200 ms. The fixes are known and none is free:

- `min_machines_running = 1` removes the cold start outright, for roughly $2/month and the end of scale-to-zero.
- Serving before `initDb()` completes only moves the wait, unless the first request is allowed to answer from an unmigrated file.
- Trimming module load means giving up the no-build-step decision that the rest of this project rests on.

Worth revisiting if the first tap of the morning starts to annoy. Not worth pre-empting.

### Fly Doctor says the app is not listening, and it is wrong

The dashboard reports *"App is not listening to the expected port... make sure
your app is listening to 0.0.0.0 and not localhost"*. The app is fine, and the
suggested fix would break it.

`Bun.serve` binds the IPv6 wildcard `::`, which Linux serves for both address
families. Checked from inside the machine: `127.0.0.1:8080` and `[::1]:8080`
both answer 200, while `/proc/net/tcp` shows no IPv4 listener at all — normal
dual-stack behaviour, and apparently not what Doctor looks for.

**Setting `hostname: '0.0.0.0'` would bind IPv4 only**, and Fly's proxy reaches
machines over the private IPv6 network. Taking Doctor's advice would turn a
working app into a 502.

What most likely triggered it: `auto_stop_machines` means a probe often arrives
at a stopped machine, and the seven-second boot above widens the window in which
one arrives before Bun has bound. A second, smaller reason to care about boot
time eventually.

### The client still bundles at startup

`Bun.serve` builds it from `index.html` on the first request. Pre-building into the image was considered and rejected: it would save the ~42 ms measured above, at the cost of a build step that `design/tech-stack.md` deliberately avoided. The measurement is recorded here so nobody reopens it on a hunch.

### The bundle is 270 KB, and Fly compresses it

Measured against `NODE_ENV=production`, then re-measured over the wire once
deployed:

| | |
|---|---|
| Client JS, as the app serves it | 270,714 bytes |
| **Over the wire, `Accept-Encoding: gzip`** | **120,013 bytes** |
| `Content-Encoding` from Fly Proxy | **gzip**, on JS and CSS alike |
| Saved on a cold visit | ~150 KB, 56% |

`Bun.serve`'s HTML bundler does not negotiate compression, so this document
spent some time treating the uncompressed size as the largest term in the first
tap after idle, and held open a decision about writing a `Bun.build` step to fix
it. **Fly Proxy compresses on the way out, so that decision is closed and no
build step is needed.** One `curl` settled what a fortnight of reasoning could
not, which is the argument for deploying before optimising.

Note the local gzip measurement said 85 KB and the wire says 120 KB — the proxy
is compressing at a lower level than a laptop's default `gzip`. Still 56% off.

**Caching is the part that remains.** Bun fingerprints the asset paths, so they
are safe to cache forever, but nothing sets `Cache-Control`. What Bun does send
is an `ETag`, and it honours `If-None-Match` with a 304 — so a returning visitor
pays one round trip rather than re-downloading 120 KB. That is cheap enough that
it is not worth code, and it is recorded so nobody reopens it on a hunch.

**The asset paths come out as `/../../chunk-y0m076hy.js`.** Browsers normalise
that to `/chunk-y0m076hy.js` per the URL spec and it loads correctly — verified
against the deployed app. Requested literally, without normalisation, that path
falls through to the `/*` route and returns the HTML shell with a 200, which
would be a confusing thing to debug. It is cosmetic today and worth knowing
before it is not.

### No health check

`fly.toml` has no `[checks]` section.

A check would not buy crash recovery — Fly restarts a machine whose process exits regardless — and it does nothing while the machine is stopped. Its one real value would be **deploy gating**: catching a release that boots but cannot serve, which for this app means `initDb()` throwing on a bad Turso token or a failed migration.

The CI smoke test below does that job better, and removes a question the Fly documentation does not answer: whether health-check traffic counts as traffic for autostop. It is run over the private network rather than through Fly Proxy, which suggests it does not — but "suggests" is not a foundation, and deleting the check deletes the question.

---

## The container

### One constraint decides the shape of it

**libSQL ships a native binary per platform.** A development machine has
`@libsql/darwin-arm64`; a Linux container needs `@libsql/linux-x64-gnu`. So
`node_modules` is installed *inside* the image and never copied in from
anywhere. Everything else about the Dockerfile follows from that and from there
being no build step to run.

```dockerfile
FROM oven/bun:1.3.14-slim
WORKDIR /app

# Dependencies first, so editing a view does not reinstall them.
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# Everything read at runtime. `drizzle/` is not optional: initDb() runs the
# migrations from './drizzle', relative to the working directory.
COPY src ./src
COPY drizzle ./drizzle
COPY tsconfig.json ./

ARG BUILD_SHA=dev
ENV BUILD_SHA=$BUILD_SHA NODE_ENV=production
CMD ["bun", "src/server/index.ts"]
```

**No build stage**, because the client is bundled on the first request rather
than compiled ahead of time — the same decision `design/tech-stack.md` made and
the cold-start measurements above re-confirmed.

**`tsconfig.json` is a runtime input here**, which it would not be for an app
that compiled ahead of time. The client is bundled by `Bun.serve` on the first
request *inside the container*, and Bun reads tsconfig for `jsx: react-jsx` and
`moduleResolution: bundler`. Bun's own defaults may well cover both — the line
costs nothing and removes the question, and a local `docker build` settles
whether it was ever needed.

**`-slim` rather than `-alpine` or `-distroless`.** All three exist for 1.3.14
on amd64 and arm64 (checked against the registry, not remembered). Alpine is
musl, which libSQL does ship for, so it would work; distroless is smaller still.
Turso's own Fly guide says to install `ca-certificates`, and this image already
has them: the final stage of bun's Dockerfile installs them explicitly, noting
that the Debian base ships none. Nothing to add, and one more reason not to
reach for distroless, which would need them copied in by hand.

Slim keeps glibc and, more usefully, keeps a shell — `fly ssh console` on a
machine with no shell is a bad evening.

A `.dockerignore` excludes `node_modules`, `data`, `.git`, `test-results` and
`e2e-report`. The first entry is the one that matters: copying a host
`node_modules` in would put the wrong platform's binary on top of the right one.

### Running it locally is optional, and CI is where it belongs

The platform-binary constraint does not force local Docker — Fly's remote builder
handles the architecture. But that is a different question from whether the image
should be tested, and it should be.

**The image builds in CI**, on every push. That catches the mistakes a Dockerfile
actually makes — a forgotten `COPY`, a runtime dependency that `--production`
drops — before a deploy is attempted, and needs nothing installed on anybody's
laptop. GitHub Actions has Docker and is free on a public repository.

**Locally it is convenience, not necessity.** It shortens the loop from a
minutes-long deploy to seconds, and on an Apple Silicon machine it builds and
runs `linux/arm64` natively — which tests the Dockerfile's logic even though Fly
runs amd64 by default. `colima` is the light way to get it on macOS; Docker
Desktop is not required.

## fly.toml

```toml
app = "alfred-XXXX"          # must be globally unique under fly.dev
primary_region = "iad"       # the same region as the Turso database

[env]
  PORT = "8080"
  DB_PATH = "/data/alfred.db"

[http_service]
  internal_port = 8080
  force_https = true
  auto_stop_machines = "stop"
  auto_start_machines = true
  min_machines_running = 0

[mounts]
  source = "alfred_data"
  destination = "/data"

[[vm]]
  size = "shared-cpu-1x"
  memory = "256mb"
```

**`auto_stop_machines` is a string**, not the boolean it used to be. Checked
against Fly's current configuration reference rather than written from memory,
because the failure mode of getting it wrong is a machine that never sleeps and
a bill that says so.

**256 MB is measured, not guessed**: 67 MB at boot, 101 MB once the client has
been bundled, flat thereafter. That is the smallest size Fly offers and it leaves
about 2.5× headroom.

**No `[checks]`** — see *No health check* above.

### Exactly one machine

`fly deploy --ha=false`, then `fly scale count 1` to confirm. **The `--ha` flag
defaults to true** — checked against `flyctl deploy --help` rather than
remembered — so the default behaviour is to create spare machines, and all three
reasons here point the other way.

The volume attaches to exactly one machine, so a spare either fails to start or
comes up with no database file. Each machine keeps *its own replica* on a
sixty-second sync, so a tick on one is invisible on the other for up to a minute
— which on a single-writer app reads as data loss rather than as staleness. And
high availability buys nothing that is not already here: Fly restarts a machine
whose process exits, and with scale-to-zero a cold start is the normal path
rather than a failure.

Cheaper, too — one machine's minutes instead of two.

## Getting there

### Tooling

Installed and verified on the development machine: `flyctl` 0.4.99, `colima`
0.10.3, `docker` 29.8.0. Colima is not started — `colima start` pulls a VM
image, worth doing when there is actually an image to build.

**No Turso CLI.** Homebrew's core `turso` is a different tool, the local SQL
shell for their new engine rather than the cloud CLI, and the real one lives in
`tursodatabase/tap` — which Homebrew requires an explicit `brew trust` to load.
That is a decision about running a third party's formula code, and it is not one
to make in passing for a tool that is not needed: creating one database,
choosing its region and generating one token are all dashboard operations. The
CLI earns its place only if `turso db dump` backups are wanted later.

### Turso first, because Fly needs its credentials as secrets

From the dashboard: create the database in the chosen region, take its URL
(`TURSO_URL`), generate a token (`TURSO_AUTH_TOKEN`).

**Then boot the real server against it, before building anything.** This is the
one step in this plan that nothing local can stand in for, and it needs no
container:

```sh
TURSO_URL=libsql://... TURSO_AUTH_TOKEN=... DB_PATH=/tmp/alfred-check.db \
  bun src/server/index.ts
```

That runs the production path — `client.sync()`, then `migrate()`, then the mood
seed — through a real embedded replica. Whether drizzle's migrator can write
*through* a replica was the one claim here that no amount of local testing could
settle.

**Done, and it passed.** The server booted, migrated, seeded and answered
`/api/status`. The proof that the writes reached Turso rather than only the local
file is a second replica from a clean path: it synced down all five tables plus
`__drizzle_migrations`, eight moods already seeded (so the seed's only-when-empty
guard held across processes), and one user — `owner`, active, password hash of
length zero, exactly as migration 0003 intends.

**So the migrations are already applied.** The first deploy will find them
applied rather than run them, which removes the most interesting way a first
deploy could fail.

### Then Fly

```sh
fly auth login
fly apps create gg-alfred
fly volumes create alfred_data --size 1 --region iad -a gg-alfred
fly secrets import -a gg-alfred < secrets.txt   # NAME=VALUE pairs on stdin
fly deploy --ha=false --build-arg BUILD_SHA=$(git rev-parse HEAD)
```

**`fly secrets import` rather than `fly secrets set`**, because `set` takes the
values as arguments and a Turso write token does not belong in a shell history
file. `import` reads `NAME=VALUE` pairs from stdin.

Then CI needs a deploy token of its own — scoped to this app, granting no shell,
opening no port, and revocable without touching anything else:

```sh
fly tokens create deploy -a gg-alfred | gh secret set FLY_API_TOKEN
```

**The app is `gg-alfred`**, because `alfred` itself is taken: it resolves to a
Fly IP where an invented control name does not, so that is a real app rather
than a DNS wildcard. This is only the default URL — a custom domain can front it
later, so it was not worth deliberating over.

**The app comes up locked**, because `owner` exists with no password: the login
form is there and nothing verifies against it. Setting that password is the last
step, and it is easier from a laptop than over SSH. Note the `DB_PATH` override —
without it this opens the development database instead of a throwaway replica:

```sh
DB_PATH=/tmp/alfred-admin.db bun run user:add owner
```

That opens a throwaway local replica, writes through to Turso, and the machine
picks it up inside its sixty-second sync.

**Region is the one thing to get right before any of it.** Every write is a round
trip to Turso: colocated that is single-digit milliseconds, mismatched it is
100 ms+ on every tick. Free to get right
now, annoying to change later.

**The two providers no longer name regions the same way.** Fly uses its own
three-letter codes; Turso Cloud now offers cloud-provider regions, so the pair
that colocates is Fly `iad` with Turso's **AWS US East (N. Virginia)**. Confirmed
by resolving the database's hostname rather than by reading the names: it
answers from an Amazon address in Ashburn, Virginia, which is where `iad` is.

**`iad`.** Fly no longer has Atlanta or Miami — the whole US list is `dfw`,
`ewr`, `iad`, `lax`, `ord` and `sjc`, read out of the region table rather than
remembered, and an earlier draft of this line recommended `atl` on exactly the
memory that turned out to be stale. For the US southeast `iad` is what is on
offer, and Turso has it too.

Note which distance actually matters, because it is not the obvious one: a phone
is one round trip from the app on the initial load, while a Fly/Turso mismatch is
one round trip on *every tick*. Matching the two providers to each other beats
shortening the last mile.

## Deploying

CI runs `flyctl deploy` with a `FLY_API_TOKEN` repository secret, deploy-scoped and revocable.

**This reverses a position from the earlier draft and should not pass quietly.** That plan refused to put any credential in CI — no SSH key, no open port — and had the machine poll a registry instead. A Fly deploy token is a credential in CI.

The distinction is real: a deploy token grants no shell and opens no inbound port, and is revoked with one command. But it is a weaker position than "no secrets at all", and the earlier objection was to *SSH keys and open ports* specifically, not to credentials in general.

---

## Knowing what is deployed

**The app reports the commit SHA it was built from.** `GET /api/status` returns
`{ ok, date, sha }` and is **already built** — it arrived with accounts, because
the browser fixture needed something answerable without a session. It is one of
three endpoints before the auth gate, and the only one that reads.

The `sha` is `BUILD_SHA`, baked in by the Dockerfile's `ARG`; it reads `dev` when
nothing sets it, which is what a laptop sees.

**CI smoke-tests the deploy**: after `flyctl deploy`, request the public URL and assert the app answers *and* reports the SHA just deployed.

Three lines that fold in three things — deploy verification, version confirmation, and the deletion of the health-check question. Without it, `flyctl deploy` reports success for a release that cannot serve, so the smoke test is not optional.

---

## Auth — built, and not as designed here

**[`changes-v9.md`](changes-v9.md) replaced this section wholesale.** What is
built is accounts, not the shared password this document specified: a `users`
table, `user_id` on `tasks` and `days`, argon2id via `Bun.password`, and a
stateless cookie keyed off the user's own password hash. Signing in is always
required — there is no flag, so there is no misconfigured deploy to guard
against and the production startup check this document called for does not exist.

Three things from the original design survived and still hold:

- **The cookie is stateless.** No sessions table, nothing to clean up, and it
  survives the restarts scale-to-zero causes several times a day.
- **`SameSite=Lax`** withholds it from cross-site POSTs, and every mutation here
  is a POST — CSRF protection without a token scheme.
- **A lockout after repeated failures**, though it is now the second of two
  defences rather than the only one: argon2id costs ~55 ms a verify, which caps
  online guessing at about eighteen attempts a second before any counting.

Two did not:

- **The `/*` gate is impossible.** A Bun route handler can return a `Response`
  but not an `HTMLBundle`, so the app cannot be served conditionally. Verified,
  not assumed. An unauthenticated visitor loads the bundle and the client
  replaces it with the login view on the first 401.
- **The login page is a React view**, not server-rendered HTML. The reasoning
  here — that a password should not pass through the bundle — did not survive
  examination; what the HTML string actually cost was a second style system.

**There is no auth environment variable.** Creating the first account is a
one-off `user:add` against the deployed database — see *Getting there* below.

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
| `bun test` | 171 unit tests over the period logic, ordering, placement, view builders and cross-user isolation |
| `bunx playwright test` | 256 browser tests across mobile and desktop viewports |
| `docker build` | the image, so a Dockerfile mistake fails here rather than on deploy |
| `flyctl deploy` | `main` only, after the above are green |
| smoke test | request the public URL, assert the deployed SHA |

What this suite needs from a runner:

**Chrome.** `playwright.config.ts` pins `channel: 'chrome'` — real Google Chrome, chosen locally to avoid downloading Playwright's browsers. A runner needs `bunx playwright install --with-deps chrome`.

**WebKit, and this is now a real gap rather than a nicety.** v8 put the day picker in a `popover`, positioned with CSS anchor positioning where it exists and falling back to the UA's centred placement where it does not. Two paths cannot be tested Chrome-only: that fallback, and what iOS's native date picker does to an open popover. The second is not hypothetical — the equivalent bug on desktop Chrome was real, shipped, and found by hand: `popover="auto"` treated the browser's own calendar chrome as a click outside, so changing month dismissed the picker and placed a task. Safari is the browser this app will actually be used in.

**Investigated, and deliberately not adopted yet.** "Cheap on a runner" turned out
to be half true, and the half that is false is the interesting part:

- **The config change is small.** One config, four projects. The only thing forcing a split is `channel: 'chrome'` in the top-level `use`, which WebKit inherits and rejects; moved into the two Chrome projects, WebKit projects sit beside them. `isMobile` works in WebKit, so the viewports stay identical.
- **It cannot run on this laptop.** Playwright 1.63 targets WebKit revision 2359, but its `browsers.json` pins `mac14` and `mac14-arm64` to 2251 — an older build that rejects `PushAPIEnabled`, a setting the driver sends on every `newPage()`. Every test dies in fixture setup before reaching the app. 1.63 is the current release, so there is nothing to upgrade to, and Playwright's WebKit is its own build — upgrading Safari changes nothing. macOS 15 would fix it.
- **It runs fine in Linux.** The arm64 `mcr.microsoft.com/playwright:v1.63.0-noble` image carries `webkit-2359`, the matching revision. Adding Bun to that image and shadowing `node_modules` with a container volume gives a working local runner, if one is wanted.
- **The app fails a lot of it.** A partial run reached 8 passed against 24 failed before it was stopped. These were real in-test failures at 10 seconds, not protocol errors — so the number is about the app, not the harness.

That last point is why this is not a config change but a body of work. It stays a
known gap: the browser this is used in is untested, and the estimate for closing
that is now grounded rather than guessed.

**The weekday matrix, weekly rather than per-push.** The suite's behaviour depends on the day: a Saturday offers one placeable date, a Sunday seven, and different tests skip on each. A `TZ` matrix on every push doubles browser minutes for a property that only changes when the scheduling rules change. A weekly scheduled run across both is the better trade — and is where the fixture bugs that bit twice during the build would have been caught.

**One retry, in CI only** — `retries: process.env.CI ? 1 : 0`. Playwright
reports a test that passes on retry as *flaky* rather than as passed, so a real
race still surfaces in the report instead of being swallowed, while a single
blip does not block a deploy. This is worth stating rather than defaulting into,
because the only flakiness this suite has ever had was a genuine bug — the
harness bound port zero, closed the socket, then handed it over, so a test could
reach another test's database — and a higher retry count would have buried it.
Locally it stays at 0, where a flake is worth stopping for.

**`workers: 4` is left alone** until there is a measurement. Oversubscribing a
runner does not break Playwright, it only runs slower, and the first CI run
reports both the core count and the wall time. Tuning before that is guessing.

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
NODE_ENV=production
```

**There is no auth variable.** Accounts live in the database and signing in is
always required — see [`changes-v9.md`](changes-v9.md), which replaced this
document's shared-password design. Creating the first account is a one-off
`bun run user:add <name>` against the deployed database.

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
| Fly machine, 256 MB shared-cpu-1x | pennies — it bills for the minutes it is awake |
| Fly volume, 1 GB | ~$0.15/month |
| `<app>.fly.dev` and TLS | free |
| Turso | free tier: 500M row reads, 10M writes, 5 GB storage, 3 GB syncs, 1-day PITR — confirmed current, September 2026, and it needs no card |
| GitHub Actions | free, public repository |

Call it **under a dollar a month**, dominated by the volume — but **Fly requires a
credit card on file** from the start. There is no free tier for new organisations
any more, and no stated minimum spend either: a stopped machine bills only its
rootfs storage. Turso's free plan needs no card. Both figures checked against the
providers' own pricing pages in September 2026 rather than carried forward.

---

## Open decisions

**Answered — Fly Proxy compresses.** This sat at the top of this list as the
only thing standing between here and a decision about a build step. It gzips:
270,714 bytes down to 120,013 over the wire, JS and CSS alike. No build step, no
response wrapper, nothing to write. See *The bundle is 270 KB* above.

**Turso now points new projects at "Turso Sync" rather than embedded replicas.**
Embedded replicas remain documented and supported, with a Fly guide of their own,
and the verification above ran against them successfully — so nothing here is
urgent and redesigning now would be building against a rumour. It is recorded
because a recommendation like that tends to become a migration in a year, and the
time to have noticed is before, not during.

**Done — the app is at `alfred.goodghost.com`.** It needed `fly certs add`, an
AAAA record to the app's dedicated IPv6, an A record to its shared IPv4, and a
`_fly-ownership` TXT record; Fly wants at least one of the AAAA, the TXT, or an
`_acme-challenge` CNAME, and two of the three is fine. **Nothing in the app
changed** — there are no hardcoded hostnames, the session cookie is host-only, and
`force_https` was already set.

Two things to know if it is ever done again. `fly certs list` reporting *Issued*
while `fly certs check` reports *Not verified* is not a contradiction: the list
column means a certificate record exists, and the dashboard's "Issuing…" is the
honest status. And issuance takes a while after the DNS is right — the way to
tell a slow issue from a broken one is [Let's Debug](https://letsdebug.net/),
which Fly's own documentation recommends and which answered `ok` here well before
the certificate appeared.

The CI smoke test still asks `gg-alfred.fly.dev`, deliberately: that name is
guaranteed by the platform and does not depend on a registrar, so it tests the
deploy rather than the DNS.

**Where `user:add` is run from, long term.** The bootstrap is documented above.
Adding a second person later is the same command against Turso, which is fine
but is a laptop with a write token — worth revisiting if that ever stops feeling
proportionate.

---

## Explicitly not doing

Auto-scaling. A staging environment. Blue-green deploys. Container orchestration. Metrics or an APM. Structured log shipping. A health check.

Each is defensible for a service with users. This one has a household, a single writer, and a database measured in kilobytes — and `design/tech-stack.md` set the standard the rest of this project has been held to: *every field earns its place by appearing on a screen*. The infrastructure equivalent is that every moving part should earn its place by preventing a failure that would otherwise happen.
