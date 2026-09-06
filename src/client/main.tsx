import { StrictMode, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import './styles.css'
import { onSignedOut } from './api.ts'
import Day from './views/Day.tsx'
import History from './views/History.tsx'
import Login from './views/Login.tsx'

type Tab = 'day' | 'history'

/**
 * The shell, and the only place that knows whether you are signed in.
 *
 * `api.ts` recognises a 401 — from the first fetch on load, from a command, or
 * from signing out — and calls back here. No view has to think about it, which
 * is the same division the view models already draw: screens render what they
 * are handed and do not derive their own situation.
 */
function App() {
  const [tab, setTab] = useState<Tab>('day')
  const [signedIn, setSignedIn] = useState(true)
  // Bumped on sign-in to remount the views, which is how they refetch. A
  // reload would also work and would cost the bundle again.
  const [session, setSession] = useState(0)

  useEffect(() => {
    onSignedOut(() => setSignedIn(false))
  }, [])

  // Optimistic: the app renders, its first fetch answers, and a 401 replaces it.
  // The alternative is a blank screen while we ask whether we are allowed in,
  // for a request the views are about to make anyway.
  if (!signedIn) {
    return (
      <Login
        onSignedIn={() => {
          setSignedIn(true)
          setSession((n) => n + 1)
        }}
      />
    )
  }

  return (
    <>
      <main className="app" key={session}>
        {tab === 'day' && <Day />}
        {tab === 'history' && <History />}
      </main>
      <nav className="nav">
        {(['day', 'history'] as const).map((t) => (
          <button key={t} onClick={() => setTab(t)} aria-current={tab === t ? 'page' : undefined}>
            {t[0]!.toUpperCase() + t.slice(1)}
          </button>
        ))}
      </nav>
    </>
  )
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
