import type { ISODate } from '../shared/types.ts'

/**
 * The server's local date, in the household's zone.
 *
 * That zone is deployment configuration, not app logic: `fly.toml` sets
 * `TZ=America/New_York` and this reads the process's local date. Until the app
 * left a laptop this comment said "one process, one machine, one household —
 * there is no timezone to reconcile", which was true right up until it was
 * running in Ashburn on UTC and calling 8pm Monday "Tuesday".
 *
 * It stays a zero-argument function on purpose. When a second timezone actually
 * exists the zone belongs to the USER, not the server and not the device — see
 * `.plan/changes-v11.md`, which is the shape that change takes.
 *
 * This is the ONLY place in the codebase that reads the clock. Nothing else
 * constructs today's date, and no endpoint accepts a date meaning "the day to
 * render" — which is what makes same-day-only recording structural rather than
 * a rule the UI is trusted to follow. See `.plan/api.md`.
 */
export function today(): ISODate {
  const now = new Date()
  const y = String(now.getFullYear()).padStart(4, '0')
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}
