import { StrictMode, useCallback, useEffect, useRef, useState, type CSSProperties } from 'react'
import { createRoot } from 'react-dom/client'
import './styles.css'
import { logout, onSignedOut } from './api.ts'
import { Popover } from './ui.tsx'
import Day from './views/day/Day.tsx'
import History from './views/History.tsx'
import Login from './views/Login.tsx'
import Claim from './views/Claim.tsx'
import Settings from './views/Settings.tsx'

type Tab = 'day' | 'history' | 'settings'

/** The two tabs the bar shows. Settings is reached from the menu, not from here. */
const TABS = ['day', 'history'] as const

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
  const [menuOpen, setMenuOpen] = useState(false)
  // Bumped on sign-in to remount the views, which is how they refetch. A
  // reload would also work and would cost the bundle again.
  const [session, setSession] = useState(0)
  const menuButton = useRef<HTMLButtonElement>(null)

  // Focus goes back where it came from: a menu that closes into nowhere strands
  // anybody driving this from a keyboard.
  const closeMenu = useCallback(() => {
    setMenuOpen(false)
    menuButton.current?.focus()
  }, [])

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
      {/* Tabs and the account menu in one bar. Sign out lives in the menu rather
          than inside a view, so it is reachable from all of them. */}
      <header className="topbar">
        <nav className="topbar__tabs">
          {TABS.map((t) => (
            <button key={t} onClick={() => setTab(t)} aria-current={tab === t ? 'page' : undefined}>
              {t[0]!.toUpperCase() + t.slice(1)}
            </button>
          ))}
        </nav>

        <button
          ref={menuButton}
          className="topbar__menu pop-anchor"
          style={{ '--pop-anchor': '--account-menu' } as CSSProperties}
          onClick={() => (menuOpen ? closeMenu() : setMenuOpen(true))}
          aria-expanded={menuOpen}
          aria-label="Account menu"
        >
          <span aria-hidden="true">☰</span>
        </button>

        {menuOpen && (
          <Popover anchor="--account-menu" onClose={closeMenu}>
            <div className="menu">
              <button
                className="menu__item"
                onClick={() => {
                  setTab('settings')
                  closeMenu()
                }}
              >
                Settings
              </button>
              <button className="menu__item" onClick={() => void logout()}>
                Sign out
              </button>
            </div>
          </Popover>
        )}
      </header>

      <main className="app" key={session}>
        {tab === 'day' && <Day />}
        {tab === 'history' && <History />}
        {tab === 'settings' && <Settings />}
      </main>
    </>
  )
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
