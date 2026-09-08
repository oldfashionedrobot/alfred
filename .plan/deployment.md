# alfred — Deployment

Live at **https://alfred.goodghost.com**. The application itself is described in
[`architecture.md`](architecture.md).

---

## Shape

```
  git push to main
     │
     ├─ GitHub Actions ── tsc → bun test → playwright → docker build
     │                              │
     │                      if green, on main
     │                              ↓
     │                        flyctl deploy → smoke test
     │
  Fly machine, iad (sleeps when idle)
     ├─ TLS terminated by Fly
     └─ alfred ── bun src/server/index.ts   (oven/bun:1.3.14-slim, 256 MB)
             ├─ /data/alfred.db   replica, on a 1 GB Fly volume
             └─ Turso ─────────── the durable copy, AWS US East (N. Virginia)
```

Three moving parts: a repository, one Fly app, one Turso database.

---

## The database

Turso holds the database. The Fly machine keeps a **complete copy as an ordinary
SQLite file** on its volume and syncs with Turso every 60 seconds.

Reads are served from the local file. Writes go to Turso and come straight back
down, so a write is visible on that machine immediately.

**Turso is the source of truth.** Losing the machine or the volume loses nothing;
a fresh machine rebuilds the file on boot. Changes made in Turso's dashboard
appear on the running machine within the sync interval.

Sync is billed in 4 kB frames. At current size a day's changes are a few dozen
frames, roughly 2 MB a month against a 3 GB allowance.

**Region.** Fly `iad` and Turso's AWS US East (N. Virginia) are the same metro.
The two must match: every write is a round trip.

**Backups.** Turso's free tier gives one day of point-in-time restore. Nothing
else is in place.

---

## The container

`oven/bun:1.3.14-slim`. No build stage: the client is bundled by `Bun.serve` on
the first request.

```dockerfile
FROM oven/bun:1.3.14-slim
WORKDIR /app

# libSQL verifies TLS when it syncs with Turso, and this image ships no root
# certificates.
RUN apt-get update -qq \
    && apt-get install -qq --no-install-recommends ca-certificates \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY src ./src
COPY drizzle ./drizzle
COPY tsconfig.json ./

ARG BUILD_SHA=dev
ENV BUILD_SHA=$BUILD_SHA NODE_ENV=production
CMD ["bun", "src/server/index.ts"]
```

`node_modules` is installed inside the image and never copied in: libSQL ships a
native binary per platform. `.dockerignore` enforces that.

`tsconfig.json` is a runtime input, because the client is bundled inside the
container. `drizzle/` is too — `initDb()` migrates from `./drizzle`, relative to
the working directory.

Runs as root. The Fly volume mounts root-owned at `/data`.

---

## fly.toml

```toml
app = "gg-alfred"
primary_region = "iad"

[build]

[env]
  PORT = "8080"
  DB_PATH = "/data/alfred.db"
  APP_URL = "https://alfred.goodghost.com"

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

**One machine.** Deploy with `--ha=false`; `--ha` defaults to true. A volume
attaches to a single machine, and a second machine would keep its own replica on
a 60-second lag.

**No `[checks]`.** CI's smoke test covers the same ground and works while the
machine is stopped.

**256 MB** against a measured 67 MB at boot and 101 MB once the client has been
bundled.

**Secrets**, set with `fly secrets import`: `TURSO_URL`, `TURSO_AUTH_TOKEN`.

---

## Behaviour

**It sleeps when idle** and starts on the next request.

| | |
|---|---|
| Fly machine start | ~1.4 s |
| Application boot | ~5.1 s |
| **First request after idle** | **~7 s** |
| Every request after | 80–190 ms |

The boot time is module loading and `migrate()`, not the Turso sync.

**The client bundle** is 270,714 bytes of JavaScript, which Fly Proxy gzips to
about 120,013 over the wire. CSS is compressed too. Nothing sets `Cache-Control`;
Bun sends an `ETag` and honours `If-None-Match`, so a returning visitor pays one
round trip rather than the bundle.

**Asset paths** are emitted as `/../../chunk-<hash>.js`. Browsers normalise that
and the app loads. Requested literally, without normalisation, the path falls
through to the `/*` route and returns the HTML shell with a 200.

**Fly Doctor reports that the app is not listening on the expected port.** It is.
`Bun.serve` binds the IPv6 wildcard, which Linux serves for both families —
`127.0.0.1:8080` and `[::1]:8080` both answer. Setting `hostname: '0.0.0.0'`
would bind IPv4 only and break the proxy, which arrives over IPv6.

---

## CI

One workflow, on every push to `main` and every pull request.

| Step | |
|---|---|
| `bunx tsc --noEmit` | covers `e2e/` too |
| `bun test` | 193 unit tests |
| `bunx playwright install --with-deps chrome webkit` | both engines |
| `bunx playwright test` | 556 browser tests across four projects |
| `docker build` | so a Dockerfile mistake fails before a deploy is attempted |
| `flyctl deploy --ha=false` | `main` only, after the above are green |
| smoke test | asks the public URL for `/api/status` and asserts the deployed SHA |

Playwright retries once in CI and not at all locally; a retried pass is reported
as flaky. The HTML report uploads as an artifact on failure. Actions is free on a
public repository.

A run takes about ten minutes, of which the browser suite is seven and a half.

**`FLY_API_TOKEN`** is a deploy-scoped token in the repository secrets.

---

## Operating it

**Deploy** happens on push. By hand:

```sh
fly deploy --ha=false --build-arg BUILD_SHA=$(git rev-parse HEAD)
```

**Accounts** are managed on the machine, which already has the credentials:

```sh
fly ssh console -a gg-alfred -C "sh -c 'bun run user:invite jess'"
```

**Logs** are live with `fly logs`, and searchable in the Fly dashboard for seven
days. Unhandled errors are logged as `[api]` and return a 500.

**What is deployed**: `GET /api/status` returns `{ ok, sha, database }`. The
`sha` is baked in by the Dockerfile's `ARG` and reads `dev` when nothing sets it.

**Migrations run at startup** and are forward-only. There is no down migration.

---

## Failure modes

| | |
|---|---|
| Machine dies | Fly restarts it. Nothing lost; the volume or a fresh sync rebuilds the replica. |
| Volume lost | Nothing lost. A fresh bootstrap sync rebuilds the file. |
| Turso unreachable | Reads keep working from the replica. Writes fail with a 500. |
| Bad deploy | The smoke test fails. `fly releases` and a redeploy of the previous image roll the code back; the schema does not. |
| Bad migration | Turso point-in-time restore, within one day. |
| Sync allowance exhausted | Writes fail, reads continue. |
| Drive under the volume fails | The machine goes down and Fly does not move it. Recovery is manual: destroy the machine and volume, create another, redeploy. No data lost. |

---

## Cost

| | |
|---|---|
| Fly machine, 256 MB shared-cpu-1x | bills for the minutes it is awake |
| Fly volume, 1 GB | ~$0.15/month |
| `alfred.goodghost.com` and TLS | free |
| Turso | free tier: 500M row reads, 10M writes, 5 GB storage, 3 GB syncs, 1-day PITR |
| GitHub Actions | free, public repository |

Under a dollar a month, dominated by the volume. Fly requires a card on file.

---

## Browsers

| | |
|---|---|
| Required | the Popover API — Chrome 114+, Safari 17+, Firefox 125+ |
| Enhancement | CSS anchor positioning; without it the picker centres in the viewport |
| Assumed | `color-mix()`, `dvh`, `scroll-snap` |

CI runs Chrome and WebKit. WebKit on Linux is not iOS Safari: it does not cover
what iOS draws itself, including the native date picker.

---

## Not in place

Auto-scaling. A staging environment. Blue-green deploys. Metrics or an APM.
Structured log shipping. A health check. Backups beyond Turso's one-day restore.
