import { StrictMode, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import './styles.css'
import { onSignedOut } from './api.ts'
import Day from './views/day/Day.tsx'
import History from './views/History.tsx'
import Login from './views/Login.tsx'
import Claim from './views/Claim.tsx'

type Tab = 'day' | 'history'

/**
 * The shell, and the only place that knows whether you are signed in.
 *
 * `api.ts` recognises a 401 — from the first fetch on load, from a command, or
 * from signing out — and calls back here. No view has to think about it, which
 * is the same division the view models already draw: screens render what they
 * are handed and do not derive their own situation.
 */
/**
 * The one piece of routing in the app, and it stays one line because there is
 * one URL that is not the app: `/claim?t=…`. Read once at mount — an invitation
 * is spent once, so nothing here needs to react to navigation.
 */
function claimTokenFromUrl(): string | null {
  if (window.location.pathname !== '/claim') return null
  return new URLSearchParams(window.location.search).get('t')
}

function App() {
  const [claimToken, setClaimToken] = useState(claimTokenFromUrl)
  const [tab, setTab] = useState<Tab>('day')
  const [signedIn, setSignedIn] = useState(true)
  // Bumped on sign-in to remount the views, which is how they refetch. A
  // reload would also work and would cost the bundle again.
  const [session, setSession] = useState(0)

  useEffect(() => {
    onSignedOut(() => setSignedIn(false))
  }, [])

  // An invitation outranks everything: whoever is holding one has no session,
  // and the optimistic render below would just 401 them to the login form.
  if (claimToken !== null) {
    return (
      <Claim
        token={claimToken}
        onClaimed={() => {
          // Off the claim URL, so a refresh does not re-offer a spent token.
          window.history.replaceState(null, '', '/')
          setClaimToken(null)
          setSignedIn(true)
          setSession((n) => n + 1)
        }}
      />
    )
  }

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
