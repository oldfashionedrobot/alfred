# alfred — Deployment

Status: design, not yet built
Companion to [`changes.md`](changes.md). The frozen originals are in [`design/`](design/).

The app has run on a laptop until now. This is the plan for putting it somewhere a phone can reach, and it is deliberately the smallest arrangement that is not fragile.

---

## Shape

```
  git push
     │
     ├─ GitHub Actions ── tsc ─→ bun test ─→ playwright (mobile + desktop)
     │                                            │
     │                                    on main, if green
     │                                            ↓
     │                              docker build → ghcr.io/<you>/alfred:<sha>
     │
  Lightsail instance ── systemd timer, every 5 min: compose pull && up -d
     │
     ├─ caddy      ── Let's Encrypt TLS, reverse proxy to alfred:3000
     └─ alfred     ── bun src/server/index.ts
             │
             ├─ /data/alfred.db   embedded replica, on a bind-mounted host dir
             └─ Turso             the durable copy
```

Four moving parts: a repository, a registry, one instance, one hosted database. No load balancer, no orchestrator, no secrets in CI.

---

## The database

### What an embedded replica is

Turso keeps a **complete copy of the database as an ordinary SQLite file on the instance's disk**.

```
READ   →  the local file                       microseconds, no network
WRITE  →  sent to Turso, applied there,        one network round trip
          then pulled straight back down
```

Reads are nearly everything this app does — every screen is derived on read — so they run at the speed they do on a laptop. Writes (a tick, a mood, a placement) pay one hop.

This is what makes hosting tolerable without giving up the premise `design/tech-stack.md` was built on: *"single-user, local file, microsecond queries."* A conventional hosted database would have turned every view builder's three-to-six queries into three-to-six network round trips.

### What follows from it

**Turso is the source of truth; the local file is a cache.** Losing the instance loses nothing. That retires the failure mode `design/tech-stack.md` flagged as the dangerous one — *"a month of data lost at a deploy and noticed later"* — because there is no longer a copy that only exists on the server.

**Read-your-writes holds.** A write is applied locally as it lands, so nothing is ever ticked and then seen unticked.

**Changes made elsewhere arrive on the sync interval**, currently 60 seconds. This matters for exactly one thing: `README.md` tells you to edit the mood set directly in the database. Done through Turso's dashboard, the running app will not see it for up to a minute. Restarting is the impatient fix.

### The replica gets a bind-mounted directory

`/var/lib/alfred` on the host, mounted at `/data` in the container.

This costs nothing — the instance's SSD is included in its plan, and the database is **about 174 KB after a year and under 2 MB after ten**. Without the mount, every container restart re-syncs the whole database from Turso, which is *safe* but pointless work. With it, a restart resumes from the local file.

Worth stating plainly: **the mount is an optimisation, not a safety measure.** Deleting `/var/lib/alfred` loses nothing at all.

### Migrations

`initDb()` runs the drizzle migrations at startup, as it does locally. Through a replica, those writes go to Turso like any other. One instance means no concurrent-migration race to design around.

### Backups

Turso's free tier includes **one day of point-in-time restore**. That covers the realistic accident — a bad bulk action, a mistaken archive noticed the same day.

It does not cover *"I deleted something last week"*. The cheap answer is already sitting there: the replica is a real SQLite file, so a nightly `cp /var/lib/alfred/alfred.db` into a dated file gives weeks of history for nothing. Seven daily copies of a 200 KB file is under 2 MB.

---

## The container

A single stage on `oven/bun:1-slim`, running `bun src/server/index.ts`.

The client is **not** pre-built. `Bun.serve` bundles it from `index.html` at startup, which is a one-off cost of a second or two on a long-lived instance. Pre-building would matter on a platform that cold-starts per request; here it would add a build step to save nothing. This is the same reasoning that kept Vite out in the first place.

`NODE_ENV=production` turns off Bun's development mode.

---

## Deploying: the instance pulls

A systemd timer runs `docker compose pull && docker compose up -d` every five minutes.

**Why not have Actions push.** The obvious design is for CI to SSH in and restart. That needs a private key stored in GitHub and an SSH port reachable from the internet — a standing credential and a standing attack surface, so that a deploy lands in seconds rather than minutes. For an app one household uses, that is a bad trade.

**What polling actually costs.** Each check is one HTTPS request for the image manifest — a few kilobytes. If the digest is unchanged, `pull` does nothing and `up -d` is a no-op. That is roughly 288 requests a day and a few megabytes a month. Nothing.

**There is no "wait until a new image appears" command.** Docker has no blocking watch; `compose pull` is one-shot. So the choice is between polling and something push-based, and polling is the one that needs no inbound access and no secrets in CI. If instant deploys ever matter, the upgrade is a small authenticated webhook on the instance — not SSH keys.

Rejected: **Watchtower**, which does exactly this with more moving parts and its own opinions about restarts. A five-line timer is easier to reason about at 2am.

---

## TLS

**Caddy**, in a container in front of the app. It obtains and renews Let's Encrypt certificates automatically given a domain name; the configuration is about five lines.

Rejected: **Lightsail's load balancer**, which does TLS termination for roughly $18/month — four times the instance it would be protecting.

---

## Auth

A **shared password and a session cookie**. `design/tech-stack.md` asked for *"a single shared password in an env var, checked in middleware"*; this is that, with a cookie so a phone is not re-prompted.

### The cookie is stateless

```
value   <expiry-ms>.<hmac>
hmac    HMAC-SHA256(key, expiry-ms)
key     derived from APP_PASSWORD
```

Verifying means recomputing the HMAC, comparing it in constant time, and checking the expiry. **No sessions table, no in-memory map, no cleanup, and it survives a restart.** A session table would have been a fifth table in a model that argued its way down to four, and the only one holding something that is not an observation about the household.

Deriving the key from the password gives revocation for nothing: change `APP_PASSWORD` and every existing cookie stops verifying.

### Two insertion points

The server has two route groups and both need gating:

- `/api/*` → `401` without a valid cookie, except `POST /api/login`.
- `/*` → serve the login page *instead of* the app.

The second is easy to omit and worth doing. Without it an unauthenticated visitor downloads the whole client bundle and then watches it fail on `/api/day`; with it they get a form and nothing else.

### Cookie flags

`HttpOnly` so script cannot read it. `Secure` in production only, since local development is plain `http://localhost`. `Path=/`. `Max-Age` of 90 days — being logged out weekly on the screen you tick seventeen times a day is exactly the friction this design keeps refusing.

**`SameSite=Lax` is the one doing quiet work.** It stops the cookie riding along on cross-site POSTs, and since every mutation here is a POST, that is CSRF protection without a token scheme. The cookie approach does not drag one in.

### The login page is server-rendered

About thirty lines of HTML returned as a `Response`, with its own inline styles. Not a React view: that would mean shipping the bundle to unauthenticated visitors, which is the thing gating `/*` exists to prevent. It does not need to look like the app.

### The password stays plaintext in the env var

Compared in constant time, not stored as a hash. Hashing would mean generating a hash to configure the app — ceremony against a threat that does not exist for one shared password on a box only you can reach.

### Off when `APP_PASSWORD` is unset

The same pattern as `TURSO_URL`: development and all 251 tests run unchanged, with no login step threaded through every fixture.

With one guard — **the server refuses to start when `NODE_ENV=production` and `APP_PASSWORD` is unset.** A misconfigured deploy should fail loudly rather than quietly serve a household journal to the internet.

### A footgun this creates, and its fix

**Bun auto-loads `.env`, for `bun test` as well as for the app.** Verified. So an `APP_PASSWORD` in a developer's local `.env` would silently switch auth on for the browser suite, and every test would fail on a `401` — for a reason nowhere near the failure.

The fix belongs in the test harness, not in a convention nobody will remember: `e2e/fixtures.ts` passes `APP_PASSWORD: ''` explicitly when spawning each server, and takes an option to set it for the tests that exercise the login flow. A local `.env` then cannot reach the suite.

`.env` and `.env.*` are gitignored; `.env.example` is tracked as the template.

### What it costs

Roughly sixty lines of server code — sign, verify, the login route, the gate, the page — five in `api.ts` to send a `401` to the login page, and a handful of tests: no cookie, wrong password, right password, expired cookie.

Rejected: **HTTP Basic**, at about fifteen lines. It buys the same protection, but the browser's own dialog is the login screen, Safari re-prompts, and there is no logout.

## CI

One workflow, on every push and pull request:

| Step | |
|---|---|
| `bunx tsc --noEmit` | now includes `e2e/`, which is how the CSS declaration gap surfaced |
| `bun test` | 141 unit tests over the period logic, ordering and view builders |
| `bunx playwright test` | 110 browser tests across mobile and desktop viewports |
| build + push image | on `main` only, after the above are green |

Two details this suite needs:

**Chrome.** `playwright.config.ts` pins `channel: 'chrome'` — real Google Chrome, chosen locally to avoid downloading Playwright's browsers. A runner needs `bunx playwright install --with-deps chrome`.

**The weekday matrix, deliberately not run.** The suite's behaviour depends on the day: a Saturday offers one placeable date, a Sunday seven, and different tests skip on each. Running a `TZ` matrix would cover both on every push, and it doubles the browser minutes for a property that only changes when the scheduling rules change. A **weekly scheduled run** across both timezones is the better trade, and is where the fixture bugs that bit twice during the build would have been caught.

Actions is free on a public repository.

---

## Configuration

Nothing sensitive is in the repository or in CI. On the instance, a root-owned `/etc/alfred.env` at mode 600:

```
TURSO_URL=libsql://<db>.turso.io
TURSO_AUTH_TOKEN=...
APP_PASSWORD=...
PORT=3000
NODE_ENV=production
```

Locally the same variables go in a gitignored `.env`, which Bun loads automatically. `.env.example` is the tracked template and documents that every one of them is optional — with none set, the app runs against a local file with no authentication.

`DB_PATH=/data/alfred.db` is set in the compose file, since it describes the container's layout rather than a secret.

Unset `TURSO_URL` is what makes local development and the test suite work with no network and no Turso account — the same code path, pointed at a plain file.

---

## Failure modes, and what actually happens

| | |
|---|---|
| **Instance is destroyed** | Nothing lost. Turso holds the data; a new instance re-syncs. |
| **Turso is unreachable** | Reads keep working from the local replica. Writes fail — a `500`, and the tick does not land. Degraded rather than dead, which is the right way round for this app. |
| **A bad image is deployed** | Pin the previous tag in the compose file and wait five minutes. Images are tagged by commit SHA precisely so this is possible. |
| **The disk fills** | The database cannot grow meaningfully; logs can. `docker compose` needs log rotation configured. |
| **Certificate renewal fails** | Caddy retries; the site is unreachable over HTTPS until it succeeds. Worth an alert eventually, not on day one. |

---

## Cost

| | |
|---|---|
| Lightsail instance | ~$3.50–5/month, includes the SSD and transfer allowance |
| Turso | free tier, 1-day point-in-time restore |
| GitHub Actions | free, public repository |
| ghcr.io | free, public image |
| Domain | whatever you already pay, or ~$12/year |

Call it **$4–5 a month**, all of it the instance.

---

## Open decisions

1. **Domain name.** Caddy needs one for certificates. A subdomain of something you own is fine.
2. **Instance size and architecture.** The smallest plan is almost certainly enough; ARM (Graviton) is cheaper if the image is built for it, which means a `linux/arm64` build in CI.

## Explicitly not doing

Auto-scaling. A staging environment. Blue-green deploys. Container orchestration. A managed load balancer. Metrics or an APM. Structured log shipping.

Each is defensible for a service with users. This one has a household, a single writer, and a database measured in kilobytes — and `design/tech-stack.md` set the standard the rest of this project has been held to: *every field earns its place by appearing on a screen*. The infrastructure equivalent is that every moving part should earn its place by preventing a failure that would otherwise happen.
