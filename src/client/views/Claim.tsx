import { useState } from 'react'
import { claim } from '../api.ts'
import './login.css'

/**
 * Spending an invitation, reached at `/claim?t=…`.
 *
 * The token is in the URL and is never shown or typed. That is deliberate: the
 * form takes a token rather than a username, so there is nothing here to guess
 * and no way to find out who has an account — which a username field would have
 * handed back after `authenticate` went to some trouble to prevent it.
 *
 * Shares `login.css` and the ordinary primitives, for the reason `Login.tsx`
 * gives: a second style system is exactly what `ui.tsx` exists to prevent.
 */

/** What the browser thinks it is, offered as a default rather than imposed. */
function deviceZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/New_York'
  } catch {
    return 'America/New_York'
  }
}

/** Every IANA zone the browser knows, so nobody types one by hand. */
function zones(): string[] {
  try {
    const all = Intl.supportedValuesOf('timeZone')
    return all.length > 0 ? all : [deviceZone()]
  } catch {
    return [deviceZone()]
  }
}

export default function Claim({ token, onClaimed }: { token: string; onClaimed: () => void }) {
  const [password, setPassword] = useState('')
  const [timezone, setTimezone] = useState(deviceZone)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const ready = password.length >= 12 && !busy

  return (
    <main className="login">
      <form
        className="login__form form form--stack"
        onSubmit={async (e) => {
          e.preventDefault()
          if (!ready) return
          setBusy(true)
          setError(null)
          const failed = await claim(token, password, timezone)
          setBusy(false)
          if (failed === null) {
            onClaimed()
            return
          }
          setPassword('')
          setError(failed)
        }}
      >
        <h1 className="login__title">Set up your account</h1>

        <label className="field">
          <span className="field-label">Choose a password</span>
          <input
            className="input"
            type="password"
            autoComplete="new-password"
            aria-label="Choose a password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <span className="hint">At least 12 characters.</span>
        </label>

        <label className="field">
          <span className="field-label">Your timezone</span>
          <select
            className="input"
            aria-label="Your timezone"
            value={timezone}
            onChange={(e) => setTimezone(e.target.value)}
          >
            {zones().map((z) => (
              <option key={z} value={z}>
                {z}
              </option>
            ))}
          </select>
          <span className="hint">
            This decides when your day rolls over. Taken from this device — change it if it is wrong.
          </span>
        </label>

        {error !== null && (
          <p className="login__error" role="alert">
            {error}
          </p>
        )}

        <button className="btn btn--primary" type="submit" disabled={!ready}>
          {busy ? 'Setting up…' : 'Set up'}
        </button>
      </form>
    </main>
  )
}
