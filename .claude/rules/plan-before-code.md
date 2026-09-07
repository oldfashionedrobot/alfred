# Plan before code

Put the shape of a change in chat and get agreement **before** implementing it,
and before writing it into a changes doc under [.plan/](.plan/).

The changes docs are written as records of settled decisions. Writing one before
the decision has been reviewed presents a choice as already made — which is how
an `AUTH_REQUIRED` flag got built, documented, vetoed on sight, and reverted at
the cost of a full pass over the browser suite.

**How to apply**

- Anything with a real design fork — a schema change, an auth model, a new
  dependency, reversing an earlier decision — gets sketched in chat first:
  options and costs, then ask.
- Then build. Then document.
- Small mechanical work does not need this.
- "go ahead" or an explicit pick is the signal to start.

See also [no-overengineering.md](no-overengineering.md).
