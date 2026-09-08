import { useEffect, useRef, useState } from 'react'
import { changePassword, getAccount, setTimezone, type Account } from '../api.ts'
import { zones } from '../zones.ts'
import './settings.css'

/**
 * Your own account: the zone your day rolls over in, and your password.
 *
 * Two independent forms with their own buttons, because they carry different
 * requirements — changing a password needs the current one and changing a zone
 * does not, and a single "save" would imply otherwise.
 *
 * The zone is prefilled from the SERVER, not from the browser. Everywhere else
 * the device's guess is a reasonable default; here the stored value is the thing
 * being corrected, and offering the browser's instead would hide the mismatch
 * this form exists to fix.
 */

/** Matches `MIN_PASSWORD` on the server, which is where it is enforced. */
const MIN_PASSWORD = 12

export default function Settings() {
  const [account, setAccount] = useState<Account | null>(null)
  const [failed, setFailed] = useState(false)
  const alive = useRef(true)

  useEffect(() => {
    alive.current = true
    void (async () => {
      try {
        const a = await getAccount()
        if (alive.current) setAccount(a)
      } catch {
        if (alive.current) setFailed(true)
      }
    })()
    return () => {
      alive.current = false
    }
  }, [])

  if (failed) {
    return (
      <section className="settings">
        <p className="settings__error" role="alert">
          Could not load your account.
        </p>
      </section>
    )
  }
  if (account === null) return <section className="settings" aria-busy="true" />

  return (
    <section className="settings">
      <h1 className="settings__title">Settings</h1>
      <p className="settings__who">
        Signed in as <strong>{account.username}</strong>
      </p>

      <TimezoneForm initial={account.timezone} />
      <PasswordForm />
    </section>
  )
}

function TimezoneForm({ initial }: { initial: string }) {
  const [zone, setZone] = useState(initial)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  return (
    <form
      className="settings__form form form--stack"
      onSubmit={async (e) => {
        e.preventDefault()
        if (busy) return
        setBusy(true)
        setError(null)
        setSaved(false)
        const message = await setTimezone(zone)
        setBusy(false)
        if (message === null) setSaved(true)
        else setError(message)
      }}
    >
      <h2 className="settings__heading">Timezone</h2>

      <label className="field">
        <span className="field-label">Your timezone</span>
        <select
          className="input"
          value={zone}
          onChange={(e) => {
            setZone(e.target.value)
            setSaved(false)
          }}
        >
          {zones().map((z) => (
            <option key={z} value={z}>
              {z}
            </option>
          ))}
        </select>
        <span className="hint">This decides when your day rolls over.</span>
      </label>

      <Result saved={saved} error={error} savedText="Timezone saved." />

      <button className="btn btn--primary" type="submit" disabled={busy || zone === initial}>
        {busy ? 'Saving…' : 'Save timezone'}
      </button>
    </form>
  )
}

function PasswordForm() {
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const ready = current !== '' && next.length >= MIN_PASSWORD && !busy

  return (
    <form
      className="settings__form form form--stack"
      onSubmit={async (e) => {
        e.preventDefault()
        if (!ready) return
        setBusy(true)
        setError(null)
        setSaved(false)
        const message = await changePassword(current, next)
        setBusy(false)
        // Either way the typed passwords go: a failure should not leave the old
        // one sitting in a field, and a success has already spent them.
        setCurrent('')
        setNext('')
        if (message === null) setSaved(true)
        else setError(message)
      }}
    >
      <h2 className="settings__heading">Password</h2>

      <label className="field">
        <span className="field-label">Current password</span>
        <input
          className="input"
          type="password"
          autoComplete="current-password"
          value={current}
          onChange={(e) => setCurrent(e.target.value)}
        />
      </label>

      <label className="field">
        <span className="field-label">New password</span>
        <input
          className="input"
          type="password"
          autoComplete="new-password"
          value={next}
          onChange={(e) => setNext(e.target.value)}
        />
        <span className="hint">At least {MIN_PASSWORD} characters.</span>
      </label>

      <Result
        saved={saved}
        error={error}
        savedText="Password changed. Other devices have been signed out."
      />

      <button className="btn btn--primary" type="submit" disabled={!ready}>
        {busy ? 'Changing…' : 'Change password'}
      </button>
    </form>
  )
}

/** Announced either way: a form that only looks different has not told anybody. */
function Result({
  saved,
  error,
  savedText,
}: {
  saved: boolean
  error: string | null
  savedText: string
}) {
  if (error !== null) {
    return (
      <p className="settings__error" role="alert">
        {error}
      </p>
    )
  }
  if (saved) {
    return (
      <p className="settings__saved" role="status">
        {savedText}
      </p>
    )
  }
  return null
}
