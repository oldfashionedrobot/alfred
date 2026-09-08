# Don't overengineer

Alfred is a personal household tracker with one household and a database
measured in kilobytes. Build for that, not for a scale it will never see.

Every field earns its place by appearing on a screen. The infrastructure
equivalent: every moving part should prevent a failure that would otherwise
actually happen. Machinery added on spec is the thing to leave out.

**How to apply**

- Prefer deleting to adding.
- Say plainly when something is *not* being built, and why.
- Give a recommendation and its cost, not a survey of options.
- Check claims instead of asserting them: measure the bundle, run the migration
  against a copy of the real database, mutation-test the isolation suite, verify
  the Docker tag exists, read Fly's current config reference. This has repeatedly
  turned up assumptions that were wrong.

See also [plan-before-code.md](plan-before-code.md).
