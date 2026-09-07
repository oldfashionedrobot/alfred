# alfred

A household task tracker. Replaces a spreadsheet that lost its history every week, and a set of Google Keep lists.

Two kinds of document live in [`.plan/`](.plan/).

**[`deployment.md`](.plan/deployment.md)** is the deployment: how it is containerised, hosted and released, and what the measurements turned out to be once it was running.

**[`changes.md`](.plan/changes.md) is the running log and the authoritative one.** Every change since the first build is recorded there in order, including the decisions that were reversed and why.

**[`.plan/design/`](.plan/design/) holds the original design, frozen.** It was checked against the code and corrected before being frozen, so it is an accurate snapshot rather than a stale one — but it is no longer maintained, and `changes.md` wins where they differ. Its value is the reasoning: why the model is period-based, why nothing writes to a past date, what was rejected and on what grounds.

| Frozen doc | What it settles |
|---|---|
| [`data-model.md`](.plan/design/data-model.md) | The four tables, and how every state is derived rather than stored |
| [`views.md`](.plan/design/views.md) | The screens and every gesture on them |
| [`tech-stack.md`](.plan/design/tech-stack.md) | Stack choices, and what was rejected |
| [`api.md`](.plan/design/api.md) | The server/client contract |
| [`review-findings.md`](.plan/design/review-findings.md) | What the first build got wrong, and why the Routine panel exists |

---

## Running it

Requires [Bun](https://bun.sh). This runs the app against a local file, with no network and no Turso account.

```sh
bun install
bun run db:generate     # only after changing src/server/schema.ts
bun run dev             # → http://localhost:3000
```

`bun run dev` runs migrations on startup and seeds the eight starting moods if the `moods` table is empty. Nothing else is seeded — the ~30 tasks are entered by hand, which `views.md` treats as a feature rather than a gap.

### Accounts

Tasks, completions and journal entries belong to a user. There is no signup page and no plan for one; accounts are made one at a time:

```sh
echo 'a-long-enough-password' | bun run user:add sanjeev
```

The same command sets an existing user's password — which also invalidates their existing sessions, because a session cookie is signed with the user's password hash.

`owner` is user 1, created by the migration, and owns everything written before accounts existed — so setting its password is how you claim your own data.

**Signing in is always required**, in development as much as anywhere else. There is no flag, which means there is no way to run this with the door open and no guard needed to make sure nobody did. The browser suite signs in from its fixture rather than skipping the step.

### Regenerating the icons

`assets/alfred.png` is the source; `src/client/icons/` holds the sizes the page links. Bun bundles them from `index.html`, so nothing needs copying into place.

```sh
for size in 32 180; do
  sips -z $size $size assets/alfred.png --out src/client/icons/icon-$size.png
done
```

Two sizes rather than one: a 32px tab icon rendered by downscaling a 180px image loses the pixel art's edges, and a 180px Apple touch icon upscaled from 32px is worse still.

### Changing the moods

There is no mood editor in the app, deliberately — eight rows revised twice a year did not justify a form on the most-used screen. Edit the table directly:

```sh
bun run db:studio                        # browse and edit
sqlite3 data/alfred.db "UPDATE moods SET active = 0 WHERE slug = 'fiending';"
sqlite3 data/alfred.db "INSERT INTO moods (slug, emoji, label, sort_order, active) VALUES ('wired', '⚡', 'wired', 8, 1);"
```

**Retire, never delete.** `days.mood` rows point at the slug, so `active = 0` drops a mood from the picker while past days keep rendering it in History. Deleting the row orphans that history. For the same reason the slug is immutable in practice — a different slug is a different mood.

The seed only fires when the table is empty, so a restart never resurrects a retired mood or undoes a rename.

| Command | |
|---|---|
| `bun run dev` | server + client, hot reloading |
| `bun run start` | no hot reload |
| `bun test` | 180 unit tests: periods, ordering, placement, view builders, command writes, per-user isolation |
| `bun run e2e` | 270 browser tests, mobile and desktop viewports |
| `bun run db:generate` | new migration from a schema change |
| `bun run db:studio` | browse the database |

| Variable | |
|---|---|
| `DB_PATH` | local libSQL file. Defaults to `./data/alfred.db` |
| `TURSO_URL` | unset for local development; set to run as a Turso **embedded replica** |
| `TURSO_AUTH_TOKEN` | required whenever `TURSO_URL` is set |
| `PORT` | defaults to 3000 |
| `NODE_ENV` | anything but `production` puts `Bun.serve` in development mode |

With `TURSO_URL` unset the app is a plain local libSQL file — which is how development and the whole test suite run, so neither needs a network or a Turso account. Set it and that same file becomes a replica synced from Turso: reads stay local and fast, writes go to Turso, and the durable copy is the one in the cloud.

**The Turso credentials do not live in `.env`.** Bun loads `.env` in every process started here, so anything in it reaches the app, the test suite and every throwaway script alike — which is how the browser suite once wrote ~200 rows into production. They live in the gitignored `.env.turso`, and reaching the real database is an explicit `bun --env-file=.env.turso ...`. See [`changes-v10.md`](.plan/changes-v10.md).

---

## Shape

One Bun process serves the API and the bundled client. There is no Vite, no Next, and no separate build step — `Bun.serve` bundles from `src/client/index.html`.

```
src/
  shared/types.ts      the wire contract, imported by both sides
  server/
    schema.ts          drizzle tables
    db.ts              libSQL: a local file, or a Turso replica when TURSO_URL is set
    auth.ts            argon2id, and a session cookie signed with the password hash
    period.ts          all period derivation
    sort.ts            the one ordering function
    today.ts           the only clock read in the codebase
    views/             one builder per screen, plus the Routine panel
    commands.ts        every named gesture
    routes.ts          GET a view model, POST a command
  client/
    icons/             generated favicons, bundled from index.html
    api.ts             typed fetch, the client's only I/O
    dates.ts           the one date formatter
    ui.tsx             shared primitives: button, tick, day picker, notice
    TaskFields.tsx     the task definition fields, shared by capture and the editor
    TaskEditor.tsx     the editor itself, opened from Day rows and from the panel
    views/             Day, History, Login, and the Routine and Backlog panels Day hosts
assets/                source art, not bundled
tests/                 period logic, view builders, command writes, per-user isolation
e2e/                   Playwright, one server + one database per test
drizzle/               generated migrations
```

**The server derives everything.** The client renders arrays that arrive already ordered and sectioned, and posts named commands back. It holds no model logic: it does not know what a period is, does not compute overdue, and does not sort. If you find yourself deriving something in a component, it belongs in a view builder.

**Two endpoint kinds, no CRUD.** `GET /api/{day,todo,history}` returns a view model. `POST /api/commands/<name>` returns `{ ok: true }` and the client refetches. There is no `GET /api/tasks`.

**The Routine and Backlog panels are one view, drawn twice.** Day fetches its own model plus `/api/todo`. Together they are the complete inventory — every active task, grouped by cadence, each group labelled with its current period. **Routine** draws the five recurring groups and **Backlog** the one-offs; it is one component rendered twice, and the endpoint knows nothing about the split. It exists because a period task you never placed used to appear on no screen you look at daily.

**A row's left stripe says whose row it is** — the border grey by default, the overdue colour when a task needs a new day, and a baseline task's own colour when it has one. It briefly encoded the cadence as a dash count too; that was removed, because a pattern has to be counted before it means anything.

---

## Things that will look like bugs

Each of these is deliberate and argued in `.plan/`. Read before "fixing".

- **Day is today, and the rest of this week beside it.** Swipe or use the strip to see what is placed on a later day; only today can be ticked, because nothing writes to a past or future date.
- **A missed daily task can never be caught up.** Daily tasks are never placed, so they are never overdue, so there is nothing to resolve. The gap in the History grid is permanent and correct.
- **A task done Tuesday but ticked Thursday is recorded on Thursday.** The history records when things were *marked*.
- **"Done" means the period is satisfied, not that it happened today.** A weekly task placed today but ticked on Monday still shows as completed. It leaves the Day screen the next day; the Routine panel carries it for the rest of its period.
- **Overdue means "needs a new day", not "late".** Nothing in this system is late.
- **Nothing is ever deleted.** Removal is `active = false`, on tasks and on moods alike. The one row that is deleted is a completion, when something is unticked.
- **A completed task leaves the Day screen the next day**, but stays struck through in the Routine panel for the rest of its period. Day answers "what now?"; the panel answers "is this month's deep clean done?"
- **The moods are not editable in the app.** That is a decision, not an omission — see above.
- **A category renders nothing.** It is a sort key: it clusters same-category tasks inside a group and shows no heading, chip or label. Baseline outranks it, so baseline tasks sort above their own category rather than with it.
- **`Dog` and `dog` are two categories.** Category is free text matched exactly; the editor suggests existing ones so picking beats retyping, but nothing normalises them.
- **How far ahead a task can be placed depends on the task.** A one-off is unbounded — any future date. A recurring task reaches to the end of *its own period* or this Saturday, whichever is further, so a monthly task can be placed three weeks out and a daily one never leaves the week. Backward is never allowed. The Day screen still shows only this week; a placement beyond it is visible as a date stamp in the Routine and Backlog panels.

---

## Export

There is no export UI, by design — the database is a file, so a terminal dump covers it.

```sh
sqlite3 data/alfred.db .dump > backup.sql
sqlite3 data/alfred.db "SELECT * FROM completions ORDER BY completed_on DESC LIMIT 20;"
```

That is the development database. In production the durable copy is Turso's and the file on the Fly volume is a replica, so a dump is taken either from Turso's dashboard or against a local replica with `TURSO_URL` set. Losing the volume loses nothing.

---

## Deployed

Live at **[alfred.goodghost.com](https://alfred.goodghost.com)** — one Fly machine in `iad` that sleeps when idle, against a Turso database in AWS US East. `gg-alfred.fly.dev` is the platform name underneath and still answers. Every push to `main` runs the suite, builds the image, deploys, and then asks `/api/status` whether the running build reports the commit it just shipped.

[`deployment.md`](.plan/deployment.md) holds the whole of it, including the parts that did not go to plan: a seven-second cold start that the design predicted at one to two, a Fly Doctor warning that is a false positive whose suggested fix would break the app, and the CA certificates the container needed that the base image was assumed to have.

Accounts are made against the deployed database from a laptop, with no SSH:

```sh
DB_PATH=/tmp/alfred-admin.db bun --env-file=.env.turso run user:add owner
```

With `TURSO_URL` in `.env` that opens a throwaway replica, writes through to Turso, and the running machine picks it up inside its sixty-second sync. The `DB_PATH` override matters — without it you would be setting a password in the development database.

**Still not covered: Safari.** The browser suite runs Chrome only, and Safari is the browser this is actually used in.
