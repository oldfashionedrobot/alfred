# Household Tracker — Changes v13

Continues [`changes-v12.md`](changes-v12.md).

**Nothing here is built yet.** One item: a way for a second person to get an
account without you typing their password for them.

---

## Claim-by-token, and no email

**The problem.** Adding somebody today means running `user:add` with their
password on stdin — so you choose it, you see it, and you have to get it to them
somehow. That is fine for `owner` and wrong for anybody else.

**What is already there.** `user:add` creates a user with an *empty*
`password_hash`, and `authenticate` treats that as un-signin-able:

```ts
if (!user || !user.active || user.password_hash === '') return null
```

That is an unclaimed account, and it is how `owner` shipped: the migration created
it empty and it was claimed afterwards. This formalises something the system
already does rather than inventing a state.

### The design

**`bun run user:invite jess`** creates an unclaimed account, generates a token, and
prints a URL:

```
https://alfred.goodghost.com/claim?t=8f3c…
```

**You deliver it.** Text it, hand over the phone, read it out. She opens it, sets
a password, and the token is spent.

**`user:add` is unchanged** and stays what it is: set a password directly, for
yourself, from a laptop with the credentials.

### Why the token and not a username

A first draft of this had the claim form take a *username*, on the reasoning that
an unclaimed name is one only you know. **That is security through obscurity and
it fails on the first guessable name — `jess` is guessable.** Anyone who reached
the form could claim an account that was waiting.

The token fixes that properly: 32 random bytes, single-use, time-limited. And it
removes a second problem for free — **there is no username field to probe**, so
the claim form cannot be used to find out who has an account. `authenticate`
already goes to some trouble to give one answer for every failure precisely so
names cannot be enumerated; a username-based claim form would have undone that.

### Why no email

Email is **delivery**, not security. The token does the security work whichever
way it travels, and for this app email is the most expensive way to move it:

| | |
|---|---|
| Provider | Resend's free tier is 3,000/month; this would send perhaps three, ever |
| DNS | SPF and DKIM on `goodghost.com`, plus DMARC, which Gmail, Outlook and Yahoo increasingly require or filter |
| Secrets | An API key in Fly |
| Failure mode | The mail does not arrive and she is stuck, with nothing to tell you whether it sent |
| Tests | Sending has to be mocked or bypassed |

That is a mail pipeline and a deliverability problem, to hand a link to someone in
the same house. **Handing it over directly is not the cheap compromise — it is
more reliable**, because you can watch it arrive.

If there is ever a user who is not in the house, email becomes a delivery swap
behind the same token rather than a redesign.

### Schema

```
users.claim_token    TEXT     -- 32 random bytes, hex. NULL once spent.
users.claim_expires  INTEGER  -- epoch ms, like the session cookie's expiry
```

Epoch milliseconds rather than the `YYYY-MM-DD` strings used elsewhere, because
this is an instant and not a day — the same distinction `auth.ts` already makes
for cookie expiry and lockout.

### The endpoint

`POST /api/claim` with `{ token, password }`, ungated, beside login and logout.
It succeeds only if **all** of: the token matches a user, it has not expired, and
that user's `password_hash` is still empty. Then it sets the hash, clears the
token, and issues the session cookie — so claiming signs you in, which is the
only reason anybody is on that page.

**One answer for every failure**, as login does. "That link is not valid" covers
expired, spent, wrong, and never-existed. Anything more specific tells an
attacker which of those it was.

**Expiry: 7 days.** Long enough to be handed over at a convenient moment, short
enough that a link left in a message thread stops working.

### Tests

| | |
|---|---|
| unit | claiming sets the hash and clears the token; an expired token is refused; a spent token is refused; a claimed account cannot be re-claimed |
| browser | the flow end to end — invite, open the link, set a password, land signed in |
| isolation | a second claimed user sees their own board and nothing of the first |

The last one is the existing isolation suite, which already covers two users. It
gains nothing new to prove; it should simply keep passing with a user who arrived
this way rather than through `user:add`.

### What this is not

**Not self-registration.** An account must exist before anything can claim it, and
only you can create one. A stranger at `/claim` with no token has nothing to do.

**Not a password reset.** The guard is that the hash is *empty*, which is a
one-way transition. Resetting a claimed account is still `user:add`, from a
laptop, deliberately.
