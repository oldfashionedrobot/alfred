import type { ISODate } from '../shared/types.ts'

/**
 * Today, for a person.
 *
 * This is the ONLY place in the codebase that reads the clock for a date.
 * Nothing else constructs today's date, and no endpoint accepts a date meaning
 * "the day to render" — which is what makes same-day-only recording structural
 * rather than a rule the UI is trusted to follow.
 *
 * The zone comes from the USER, not from the server and not from the device.
 * That is the whole point: a laptop in London and a phone in Atlanta must not
 * disagree about what day it is for the same person, or the same task could be
 * ticked twice, on two different todays. A day belongs to a person.
 *
 * It used to read the process's local date, and said so: "one process, one
 * machine, one household — there is no timezone to reconcile." True on a laptop
 * in the household; false the moment it ran in Ashburn on UTC and started
 * calling 8pm Monday "Tuesday".
 *
 * `en-CA` formats as YYYY-MM-DD, which is why it is here rather than a locale
 * anybody reads. No `TZ` environment variable and no dependency.
 *
 * `now` defaults to the clock and no caller passes it — it exists so a test can
 * name an instant instead of stubbing the global `Date`. This is still the only
 * place a date is read from the clock.
 */
export function today(zone: string, now: Date = new Date()): ISODate {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now) as ISODate
}

/**
 * Who a request is for, and when their day turns over.
 *
 * One value rather than a loose `userId` and `zone` travelling together,
 * because two parameters that must always agree eventually will not. Every view
 * builder and every command takes this, and `routes.ts` is the only place it is
 * constructed — from `currentUser`, which is the only place a request becomes an
 * identity.
 */
export type Viewer = { id: number; timezone: string }
