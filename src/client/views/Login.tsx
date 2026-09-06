import { useState } from 'react'
import { login } from '../api.ts'
import './login.css'

/**
 * The signed-out screen.
 *
 * It was a server-rendered HTML string until v9's second pass. The argument for
 * that was that a password should not pass through the client bundle, which does
 * not survive contact: both paths send it over TLS to the same server, and
 * anyone who can alter the bundle owns the app either way. What the string
 * actually cost was seventeen lines restating colour tokens, inputs and buttons —
 * a second style system, which is the exact thing `ui.tsx` exists to prevent.
 *
 * So this is an ordinary view using the ordinary primitives: `.field`, `.input`,
 * `.btn--primary`, straight out of `styles.css`. When they change, it changes.
 */
export default function Login({ onSignedIn }: { onSignedIn: () => void }) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const ready = username.trim() !== '' && password !== '' && !busy

  return (
    <main className="login">
      <form
        className="login__form form form--stack"
        onSubmit={async (e) => {
          e.preventDefault()
          if (!ready) return
          setBusy(true)
          setError(null)
          const failed = await login(username.trim(), password)
          setBusy(false)
          if (failed === null) {
            onSignedIn()
            return
          }
          // The password is cleared and the name is not: whatever went wrong,
          // retyping the name is friction and retyping the password is the point.
          setError(failed)
          setPassword('')
        }}
      >
        <h1 className="login__title">alfred</h1>

        {error !== null && (
          <p className="login__error" role="alert">
            {error}
          </p>
        )}

        <label className="field">
          <span className="field-label">Name</span>
          <input
            className="input"
            autoFocus
            autoComplete="username"
            autoCapitalize="none"
            spellCheck={false}
            value={username}
            onChange={(e) => setUsername(e.target.value)}
          />
        </label>

        <label className="field">
          <span className="field-label">Password</span>
          <input
            className="input"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>

        <button className="btn btn--primary" type="submit" disabled={!ready}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </main>
  )
}
