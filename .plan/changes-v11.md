# Household Tracker — Changes v11

Continues [`changes-v10.md`](changes-v10.md).

**Nothing here is built.** This is a stub: one decision taken, written down while
the reasoning is fresh, to be implemented when the thing that needs it exists.

---

## Per-user timezone — when a second zone exists, not before

**The problem it solves.** v10 set `TZ=America/New_York` in `fly.toml`, which is
exactly correct while everyone using the app shares a zone. It stops being
correct the moment somebody does not: a user in another zone would have their day
roll over on somebody else's schedule, and there is no per-person answer to give
them.

**The shape.**

```
users.timezone   TEXT NOT NULL DEFAULT 'America/New_York'   -- IANA name
```

`today()` takes that zone and derives the date in it. The implementation needs no
`TZ` environment variable and no dependency — checked, not assumed:

```ts
new Intl.DateTimeFormat('en-CA', {
  timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
}).format(new Date())
```

`en-CA` yields `YYYY-MM-DD` directly. Run against a process whose own local date
was already `2026-09-08`, that returns `2026-09-07` for New York.

**What it costs.** Nineteen `today()` call sites across five server files and
five test files. Most are cheap: `currentUser` already resolves the user in
`routes.ts`, and every view builder and command already takes a `userId`, so the
zone travels the same path the user id does. It is a signature change threaded
through the builders and commands rather than a hard problem.

**Why the zone belongs to the user, and not to the device.** The obvious
alternative is for the client to send its own timezone, or its own date. Both
were considered and rejected.

Sending a *date* dissolves the invariant the model rests on. `today.ts` puts it
plainly: *no endpoint accepts a date meaning "the day to render" — which is what
makes same-day-only recording structural rather than a rule the UI is trusted to
follow.* Overdue, period satisfaction and the History grid all stand on that.

Sending a *zone* is much weaker — bounded to about 26 hours, and it cannot
express an arbitrary date — and it is defensible. The reason to refuse it is not
security: it makes the day boundary a property of the **device**. A laptop in
London and a phone in Atlanta would disagree about what day it is for the same
person, so the same task could be ticked twice, on two different todays. A day
belongs to a person.

**Why this is not built yet.** There is one user, in one zone. The one-line fix
is correct for that, and it does not paint anything into a corner: `today()`
stays the only clock read in the codebase, and giving it a parameter is the same
mechanical change whenever it happens.

**What would trigger it.** A second person in a different zone — or the first
person moving. Not travel: a week away does not make somebody's tasks belong to
another day, and a zone that follows the device is the thing this rejects.
