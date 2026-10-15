import './notes.css'
import { useEffect, useId, useRef, useState, type CSSProperties } from 'react'
import type { Note, NotesView } from '../../../shared/types.ts'
import { errorText, getNotes } from '../../api.ts'
import { NoticeBar, type Notice } from '../../ui.tsx'
import { NoteCard } from './NoteCard.tsx'
import { NotePanel, type Enqueue } from './NotePanel.tsx'

/*
 * Notes — a board of cards. Tap one and it opens over the board; type, and it
 * saves; close it, and you are back where you were.
 *
 * Data rule, as everywhere: fetch the model, render it, post commands, refetch
 * and replace wholesale. The board arrives ordered and, when searched, filtered;
 * nothing here sorts or filters. The open note's text is a form draft, held by
 * the panel and never re-read from a refetch.
 */

/** The note open over the board. `key` remounts the panel for each opening. */
type Open = { key: number; id: number | null; snapshot: Note | null }

export default function Notes() {
  const pinnedId = useId()
  const othersId = useId()
  const [view, setView] = useState<NotesView | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [reloads, setReloads] = useState(0)
  const [notice, setNotice] = useState<Notice>(null)
  const [archived, setArchived] = useState(false)
  /** What is in the box, and what the server was asked — a moment behind it. */
  const [typed, setTyped] = useState('')
  const [q, setQ] = useState('')
  const [open, setOpen] = useState<Open | null>(null)
  const openings = useRef(0)

  useEffect(() => {
    const t = setTimeout(() => setQ(typed.trim()), 250)
    return () => clearTimeout(t)
  }, [typed])

  // Guarded by `alive`, so a response that lost a race to a newer one — a slow
  // search overtaken by the next keystroke's — is dropped rather than drawn.
  useEffect(() => {
    let alive = true
    setLoadError(null)
    getNotes({ archived, q })
      .then((v) => {
        if (alive) setView(v)
      })
      .catch((e: unknown) => {
        if (alive) setLoadError(errorText(e))
      })
    return () => {
      alive = false
    }
  }, [archived, q, reloads])

  const refresh = () => setReloads((n) => n + 1)

  /*
   * THE ONE CHAIN. Every note command runs after the one before it — saves,
   * colours, pins, archives, deletes. One note is ever open, so one chain is
   * enough, and it is what stops a slow first save being overtaken by the next,
   * or a `create_note` being sent twice.
   *
   * A ref, not state: nothing renders from it. A failure shows a notice; the next
   * save carries the whole text and heals it.
   */
  const chain = useRef<Promise<unknown>>(Promise.resolve())
  const enqueue: Enqueue = (job) => {
    const ran = chain.current.then(job).then(
      () => true,
      (e: unknown) => {
        setNotice({ tone: 'error', text: `Not saved. ${errorText(e)}` })
        return false
      },
    )
    chain.current = ran
    return ran
  }

  /*
   * BACK CLOSES A NOTE. Opening one pushes a history entry WITHOUT a URL, so the
   * phone's Back gesture pops it instead of leaving the app; closing any other
   * way steps back over the entry this session pushed. There is no URL to reload,
   * link to, or confuse with an invitation. The cost is one Back press that does
   * nothing after a reload.
   */
  const pushed = useRef(false)
  /*
   * A `history.back()` closing asked for, not landed yet. It lands
   * asynchronously, so a note opened in between — Escape, then Enter on the card
   * — would otherwise have its OWN entry popped by it and close at once. Its
   * popstate is ours, not a Back press, and is passed over; the new note keeps
   * its entry, one step further on, and Back still closes it.
   */
  const backing = useRef(false)
  useEffect(() => {
    const onPop = () => {
      if (backing.current) {
        backing.current = false
        return
      }
      if (!pushed.current) return
      pushed.current = false
      setOpen(null)
    }
    window.addEventListener('popstate', onPop)
    return () => {
      window.removeEventListener('popstate', onPop)
      // Leaving the tab with a note open: take its entry back off the stack.
      if (pushed.current) {
        pushed.current = false
        window.history.back()
      }
    }
  }, [])

  const openNote = (snapshot: Note | null) => {
    setOpen({ key: openings.current++, id: snapshot?.id ?? null, snapshot })
    if (!pushed.current) {
      window.history.pushState({ note: true }, '')
      pushed.current = true
    }
  }
  const closeNote = () => {
    setOpen(null)
    if (pushed.current) {
      pushed.current = false
      backing.current = true
      window.history.back()
    }
  }

  if (!view) {
    if (loadError) {
      return (
        <div className="notes state state--error">
          <p>Could not load your notes. {loadError}</p>
          <button className="btn" onClick={refresh}>
            Try again
          </button>
        </div>
      )
    }
    return <div className="notes state">Loading notes…</div>
  }

  const live =
    open?.id == null
      ? null
      : ([...view.pinned, ...view.others].find((n) => n.id === open.id) ?? null)
  const nothing = view.pinned.length === 0 && view.others.length === 0
  const grid = (list: Note[]) => (
    <div className="notes-grid">
      {list.map((note) => (
        <NoteCard key={note.id} note={note} onOpen={() => openNote(note)} />
      ))}
    </div>
  )

  return (
    <div className="notes">
      <div className="notes-bar">
        <h1 className="notes-h1">{archived ? 'Archived' : 'Notes'}</h1>
        <div className="notes-tools">
          <input
            type="search"
            className="input notes-search"
            aria-label={archived ? 'Search archived notes' : 'Search notes'}
            placeholder="Search"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
          />
          <button
            className="btn btn--small btn--quiet"
            aria-pressed={archived}
            onClick={() => setArchived((a) => !a)}
          >
            Archived
          </button>
          {!archived && (
            <button className="btn btn--small" onClick={() => openNote(null)}>
              New note
            </button>
          )}
        </div>
      </div>

      {nothing ? (
        <p className="notes-empty">
          {q ? `Nothing matches “${q}”.` : archived ? 'Nothing archived.' : 'No notes yet.'}
        </p>
      ) : (
        // As wide as the larger section's cards, so both sections share columns.
        <div
          className="notes-board"
          style={{ '--cards': Math.max(view.pinned.length, view.others.length) } as CSSProperties}
        >
          {view.pinned.length > 0 ? (
            <>
              <section aria-labelledby={pinnedId}>
                <h2 className="notes-h2" id={pinnedId}>
                  Pinned
                </h2>
                {grid(view.pinned)}
              </section>
              {view.others.length > 0 && (
                <section aria-labelledby={othersId}>
                  <h2 className="notes-h2" id={othersId}>
                    Others
                  </h2>
                  {grid(view.others)}
                </section>
              )}
            </>
          ) : (
            grid(view.others)
          )}
        </div>
      )}

      <NoticeBar notice={notice} onDismiss={() => setNotice(null)} />

      {open && (
        <NotePanel
          key={open.key}
          note={open.snapshot}
          live={live}
          archivedView={archived}
          timezone={view.timezone}
          today={view.date}
          enqueue={enqueue}
          onSaved={refresh}
          onCreated={(id) => setOpen((o) => (o && o.key === open.key ? { ...o, id } : o))}
          onClose={closeNote}
        />
      )}
    </div>
  )
}
