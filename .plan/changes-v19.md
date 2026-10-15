# v19 — Notes loads when you open it

Today the whole client is one 778 KB script, and every page pays for all of it —
the To do list you open all day included, though two thirds of the bytes are the
notes editor. `Bun.serve` bundles the client from `index.html` on the first
request and always emits a single script: its own documentation says it
*"Combines all `<script>` tags into a single `<script>`"*, it has no splitting
option, and a lazy `import()` was tried twice in v18 and inlined both times.

v19 builds the client in the Dockerfile instead, with code splitting, and the
server serves the built files. The Notes tab becomes its own chunk, fetched the
first time it is opened.

No migration, no new dependency. It reverses one decision —
*"No build step"* in the architecture reference — and the measurements below are
why.

---

## What it buys

Measured on a copy of this repository with the change made, built by the same
command the Dockerfile runs; the memory figures re-measured on the change as
built. Script time is Chrome's own `ScriptDuration`
with the CPU slowed four times, which is roughly a phone; median of seven loads.

| | Today | v19 |
|---|---|---|
| To do and Tracker download | 778 KB, 246 KB gzipped | 288 KB, 92 KB gzipped |
| Script time on loading them | 94 ms | 42 ms |
| The first Notes visit after a deploy | — | 490 KB more, 155 KB gzipped, and 21 ms |
| Server memory after the first page, locally | 69 MB → 140 MB | 69 MB → 70 MB |
| First page and its script, locally | 41–45 ms | 17–19 ms |

The memory is the number that was not expected. Bundling at the first request
roughly doubles the process — the bundler's working set stays resident — on a
machine that has 256 MB. Built ahead, nothing bundles on the machine at all. The
local figures are a laptop's; Fly's shared CPU will make today's bundling slower
than 40 ms, and both are re-measured on Fly after the deploy.

Fly's proxy compresses responses itself — zstd, then Brotli, then gzip, whichever
the browser accepts — so the gzipped sizes above overstate what crosses the wire.
The live app's current bundle went 283 KB → 106 KB with zstd.

---

## Decisions

**The client is built in the Dockerfile.** One `RUN bun run build:client` after
the source is copied, writing `dist/`. Fly builds the image on its remote
builder — *"Perform builds on a remote builder instance … This is the default"* —
so the build never runs on the 256 MB machine. It takes about 45 ms here. CI
already builds the image on every push to catch a Dockerfile mistake, so a client
that will not build fails there first.

```
bun build ./src/client/index.html --outdir dist --splitting --production --target browser --public-path=/assets/
```

`--production` minifies and inlines `NODE_ENV=production`, so the bundle carries
production React, as `Bun.serve` gave it before.

**Development does not change.** `bun run dev` keeps the HTML import, hot reload
and the error overlay. The server serves the built files only when
`CLIENT_DIST` names a directory, and the Dockerfile sets it.

It is its own switch rather than `NODE_ENV`, deliberately. `NODE_ENV=production`
also marks the session cookie `Secure`, which the browser suite cannot use on
`http://localhost`. Tying "how the client is served" to "how the cookie is set"
would make the built client impossible to test without production cookies.

**Files are flat in `dist/` and served under `/assets/`.** `index.html` is at the
root of `dist/`; everything else — the entry script, the chunks, the CSS, the
icons — is `/assets/<name>-<hash>.<ext>`, and `--public-path=/assets/` makes every
reference say so.

The obvious layout, an `assets/` directory in Bun's naming templates, was tried
first and is wrong: the directory is dropped from the import paths, so the entry
script imported `/Notes-….js` while the file sat at `assets/Notes-….js`. Every
reference was checked in the flat layout — the HTML's, the entry's and the
chunks' — and all of them point at a file that exists.

The `/../../chunk-….js` paths `deployment.md` records go with the HTML import.

**Hashed files are cached forever; the page is never cached.** Every asset is
`Cache-Control: public, max-age=31536000, immutable` — its name changes when its
contents do, so a returning browser does not ask at all, where today it asks and
gets a 304. `index.html` is `no-cache`, so every load checks it, and a deploy is
picked up on the next one. Fly's proxy does not cache anything in front of the
app — no Fly document describes a cache or a CDN there — so these headers are the
whole of the caching.

**An unknown `/assets/` path is a 404.** Today any unrecognised path returns the
HTML shell with a 200, which `deployment.md` records and v18's smoke test had to
work around. Under `/assets/` that would hand a browser HTML where it asked for
JavaScript. Everything outside `/assets/` and `/api/` is still the page, which is
what keeps `/claim?t=…` working.

**The routes are built from the directory, once, at boot.** One exact route per
file in `dist/`, read when the server starts; nothing in a request ever reaches
the filesystem, so there is no path to sanitise and no traversal to guard. A
`CLIENT_DIST` that is missing or empty stops the boot with an error — Fly's
deploy check stops a release whose machine crash-loops in its first ten seconds,
so a broken image is refused rather than served as a site of 404s.

Bun answers `HEAD` on these routes itself, sets `Content-Type` from the file and
adds `Last-Modified`. A `POST` to an asset gets Bun's 400 rather than this app's
404 convention for wrong methods; that is accepted rather than written around.

**What splits is the whole Notes tab.** It is loaded with `React.lazy`, showing
*"Loading notes…"* while the chunk arrives. Not just the open note: the cards
parse Markdown with the editor's own parser, so the board needs most of the
editor's code too. Nothing else is worth splitting — the next largest view, the
Tracker, is 4 KB.

Bun also emits a separate Notes stylesheet, but includes the same rules in the
main one and never requests the separate file. Notes' CSS therefore arrives with
everything else — 6 KB, already loaded when the tab opens — and the extra file
costs 6 KB of disk and nothing on the wire.

**A tab open across a deploy asks for a chunk that is gone.** Its old script
names the old Notes chunk, the new image does not have it, and the import fails.
To do and the Tracker are unaffected — their code is already loaded. Notes shows
*"Notes could not load — Alfred has probably been updated since this page was
opened"* with a Reload button,
from an error boundary around the lazy tab; reloading fetches the new page,
which `no-cache` guarantees, and the new chunk with it. The boundary catches any
failure to render Notes, so a genuine error there gets a way out too.

**Nothing is prefetched.** The first Notes visit after a deploy costs a download
and 21 ms; prefetching would move that onto every cold load of To do, which is
the cost being removed.

---

## Files

| | |
|---|---|
| `package.json` | `build:client`, the one build command — the Dockerfile and the browser suite both run it. It empties `dist/` first, so a local build never serves a stale chunk. `bun run e2e` gains the `built` project. |
| `Dockerfile` | `RUN bun run build:client`, and `ENV CLIENT_DIST=/app/dist` |
| `src/server/client.ts` | new. `builtClient(dir)`: the routes for a built client, from its directory |
| `src/server/index.ts` | `builtClient(CLIENT_DIST)` when it is set; the HTML import otherwise |
| `src/client/main.tsx` | Notes through `React.lazy`, inside `Suspense` and the boundary, `NotesFailed` |
| `e2e/build-client.ts` | Playwright's global setup: `bun run build:client`, once per run |
| `e2e/fixtures.ts`, `playwright.config.ts` | a `builtClient` option, and the `built` project that sets it |
| `.gitignore`, `.dockerignore`, `.prettierignore` | `dist/`. The image builds its own and must never be handed a local one. |
| `.github/workflows/ci.yml` | the smoke test checks the deployed page's script is JavaScript **with** the immutable header, and that the Notes chunk the script names is there too |

The smoke test grows because it is the only real check a deploy gets: without
`[checks]`, `fly deploy` waits for the machine to start and watches it for ten
seconds for a crash loop, and nothing else. A wrong public path — the mistake
made once already while planning this — would ship a To do list that works and a
Notes tab that never loads; fetching the chunk the entry names catches exactly
that. And whether `Cache-Control` survives Fly's proxy is not something its
documentation says outright, so the smoke test checks it on the real thing.

---

## Tests

### Unit — `tests/client.test.ts`

Against a server built from a temporary `dist/`: each file is served under
`/assets/` with the immutable header and its content type; `/`, `/claim?t=x` and
any other path are the page, `no-cache`; an unknown `/assets/` path is a 404 and
not the page, and the page is not also an asset; `HEAD` is answered; `/api/`
still reaches the API; a missing or empty directory throws at boot.

### Browser — a `built` project

The main suite stays on the development client. It runs development React,
whose warnings — duplicate keys, mostly — are what the console-error tests are
there to catch, and production React strips them.

A fourth Chrome project, `built`, runs `e2e/built.spec.ts` against the built
client: Playwright builds it once before the run, and the fixture starts the
server with `CLIENT_DIST`. `bun run e2e` includes it.

| | |
|---|---|
| Notes waits | To do loads without requesting the Notes chunk; opening Notes requests it once, and a note can be written and saved — the editor working under the production build |
| Headers | the page is `no-cache`; its script and the Notes chunk are immutable; an unknown asset is a 404 |
| A stale tab | with the Notes chunk answering 404, the tab shows the update message; Reload brings Notes up |

---

## Not in this iteration

**Fly's `[[statics]]`.** Its files are served from inside the running machine,
not the edge — *"Your machine must be running for static files to be served"* —
a request for one wakes a stopped machine like any other, and *"You cannot set
`Cache-Control` or any other headers on assets."* It would lose the immutable
caching and save nothing.

**Compressing in Bun.** Fly's proxy already does, with zstd where the browser
offers it, and passes through anything that arrives already compressed.

**Prefetching Notes**, argued above.

**Running the whole browser suite against the built client**, argued above.

**Splitting anything else.** Nothing else is big enough to be worth a request.
