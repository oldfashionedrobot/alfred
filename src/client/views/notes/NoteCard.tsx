import { useMemo } from 'react'
import type { Note } from '../../../shared/types.ts'
import { NoteBody, firstLine } from './NoteBody.tsx'
import { markdown } from './noteExtensions.ts'

/**
 * One note on the board.
 *
 * An `<article>` with ONE button over the whole of it, named by the title or the
 * first line. A whole card inside a `<button>` would put paragraphs and lists
 * inside a button, which is invalid, and make its accessible name the entire
 * note. Nothing inside is interactive — see `NoteBody`.
 *
 * The parse is remembered per body: a refetch hands back the same text for every
 * note but the one just edited, and only that one is parsed again.
 */
export function NoteCard({ note, onOpen }: { note: Note; onOpen: () => void }) {
  const doc = useMemo(() => markdown.parse(note.body), [note.body])
  const name = note.title.trim() || firstLine(doc) || 'Empty note'

  return (
    <article className="note-card" data-color={note.color ?? undefined}>
      {note.title.trim() && <p className="note-card-title">{note.title}</p>}
      <div className="note-doc note-card-body">
        <NoteBody doc={doc} />
      </div>
      <button className="note-card-open" aria-label={name} onClick={onOpen} />
    </article>
  )
}
