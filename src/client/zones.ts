/**
 * IANA zones for the two forms that offer them: claiming an account, and
 * changing it later.
 *
 * A zone is stored against the user, so their day boundary follows them rather
 * than whatever device they are holding. `deviceZone` is therefore only ever a
 * DEFAULT for somebody who has never chosen — the settings form prefills from
 * the stored value instead, because there the stored value is the thing being
 * corrected.
 */

const FALLBACK = 'America/New_York'

/** What the browser thinks it is, offered as a default rather than imposed. */
export function deviceZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || FALLBACK
  } catch {
    return FALLBACK
  }
}

/** Every IANA zone the browser knows, so nobody types one by hand. */
export function zones(): string[] {
  try {
    const all = Intl.supportedValuesOf('timeZone')
    return all.length > 0 ? all : [deviceZone()]
  } catch {
    return [deviceZone()]
  }
}
