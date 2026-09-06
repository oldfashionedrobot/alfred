import { StrictMode, useState } from 'react'
import { createRoot } from 'react-dom/client'
import './styles.css'
import Day from './views/Day.tsx'
import History from './views/History.tsx'

type Tab = 'day' | 'history'

function App() {
  const [tab, setTab] = useState<Tab>('day')

  return (
    <>
      <main className="app">
        {tab === 'day' && <Day />}
        {tab === 'history' && <History />}
      </main>
      <nav className="nav">
        {(['day', 'history'] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            aria-current={tab === t ? 'page' : undefined}
          >
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
