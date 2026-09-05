import type { ISODate } from '../shared/types.ts'

/**
 * The server's local date. One process, one machine, one household — there is
 * no timezone to reconcile.
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
