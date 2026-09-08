# alfred

A household task tracker. Live at **[alfred.goodghost.com](https://alfred.goodghost.com)**.

Two documents describe it, both current rather than historical:

| | |
|---|---|
| [`.plan/architecture.md`](.plan/architecture.md) | what the application is — data model, derivation, server, client |
| [`.plan/deployment.md`](.plan/deployment.md) | how it is hosted and released |

Work in flight lives in `.plan/changes-v*.md` and folds into those two once it
has landed.

---

## Running it

Requires [Bun](https://bun.sh). This runs against a local file, with no network
and no Turso account.

```sh
bun install
bun run db:generate     # only after changing src/server/schema.ts
bun run dev             # → http://localhost:3000
```

`bun run dev` runs migrations on startup and seeds the eight starting moods if
the `moods` table is empty. Nothing else is seeded.

| Command | |
|---|---|
| `bun run dev` | server + client, hot reloading |
| `bun run start` | no hot reload |
| `bun test` | 193 unit tests |
| `bun run e2e` | 278 browser tests on Chrome, mobile and desktop viewports |
| `bun run e2e:all` | all 556, both engines — WebKit does not run on macOS 14 |
| `bun run e2e:docker` | the WebKit half, in Linux |
| `bun run e2e:ui` | Playwright's UI mode, Chrome only |
| `bun run e2e:report` | open the last HTML report |
| `bun run db:generate` | new migration from a schema change |
| `bun run db:studio` | browse the database |
| `bun run user:add <name>` | set a password directly, on stdin |
| `bun run user:invite <name>` | create an unclaimed account, print a claim link |
| `bun run user:disable <name>` | revoke access, keep the data |
| `bun run user:enable <name>` | restore it |

| Variable | |
|---|---|
| `DB_PATH` | the database file, `./data/alfred.db` by default. With `TURSO_URL` set it is the local **replica** file instead. |
| `TURSO_URL` | unset for local development; set to run as a Turso embedded replica |
| `TURSO_AUTH_TOKEN` | required whenever `TURSO_URL` is set |
| `APP_URL` | what `user:invite` prints in the claim link. Defaults to `http://localhost:3000`. |
| `PORT` | defaults to 3000 |
| `NODE_ENV` | anything but `production` puts `Bun.serve` in development mode |

Turso credentials live in `.env.turso`, not `.env`, and nothing loads that file
unless asked. See [`.env.example`](.env.example).

### Accounts

Tasks, completions and journal entries belong to a user. There is no
self-registration; an account exists because somebody made one.

```sh
bun run user:invite jess
```

That prints a single-use link, valid for seven days, carrying a 32-byte token.
Send it however suits. Opening it asks for a password and a timezone — prefilled
from that device — and signs them in.

**Against the deployed app**, run these on the machine, where the credentials
already are:

```sh
fly ssh console -a gg-alfred -C "sh -c 'bun run user:invite jess'"
```

`user:add` also sets an existing user's password, which invalidates that user's
sessions. `owner` is user 1 and owns everything written before accounts existed.

Signing in is always required, in development as much as anywhere else.

### Regenerating the icons

`assets/alfred.png` is the source; `src/client/icons/` holds the sizes the page
links. Bun bundles them from `index.html`.

```sh
for size in 32 180; do
  sips -z $size $size assets/alfred.png --out src/client/icons/icon-$size.png
done
```

### Changing the moods

The mood set is a table, edited directly. It is shared by every user.

```sh
bun run db:studio                        # browse and edit
sqlite3 data/alfred.db "UPDATE moods SET active = 0 WHERE slug = 'fiending';"
sqlite3 data/alfred.db "INSERT INTO moods (slug, emoji, label, sort_order, active) VALUES ('wired', '⚡', 'wired', 8, 1);"
```

**Retire, never delete.** `days.mood` points at the slug, so `active = 0` drops a
mood from the picker while past days keep rendering it. The slug is immutable in
practice. The seed only fires when the table is empty.

---

## Things that will look like bugs

Each of these is deliberate. See [`.plan/architecture.md`](.plan/architecture.md)
for the model they come from.

- **Day is today, and the rest of this week beside it.** Swipe or use the strip to see what is placed on a later day; only today can be ticked.
- **Your day rolls over in your own timezone.** It is set per user, when the account is claimed, and decides when "today" changes for that person.
- **A missed daily task can never be caught up.** Daily tasks are never placed, so they are never overdue. The gap in the History grid is permanent.
- **A task done Tuesday but ticked Thursday is recorded on Thursday.** The history records when things were *marked*.
- **"Done" means the period is satisfied, not that it happened today.** A weekly task ticked on Monday stays done all week.
- **Overdue means "needs a new day", not "late".**
- **Nothing is ever deleted.** Removal is `active = false`, on tasks and moods alike. The one row that is deleted is a completion, when something is unticked.
- **A completed task leaves the Day screen the next day**, but stays struck through in the Routine panel for the rest of its period.
- **The moods are not editable in the app**, and are shared by every user.
- **A category renders nothing.** It is a sort key: it clusters same-category tasks inside a group and shows no heading or label. Baseline outranks it.
- **`Dog` and `dog` are two categories.** Free text, matched exactly.
- **How far ahead a task can be placed depends on the task.** A one-off is unbounded. A recurring task reaches to the end of its own period or this Saturday, whichever is further. Backward is never allowed. Day shows only this week; a further placement appears as a date stamp in the panels.

---

## Export

There is no export UI. The development database is a file:

```sh
sqlite3 data/alfred.db .dump > backup.sql
sqlite3 data/alfred.db "SELECT * FROM completions ORDER BY completed_on DESC LIMIT 20;"
```

In production the durable copy is Turso's and the file on the Fly volume is a
replica, so a dump comes from Turso's dashboard or from a local replica opened
with `TURSO_URL` set.
