import { and, desc, eq } from 'drizzle-orm'
import { plain, type Note, type NotesView } from '../../shared/types.ts'
import type { DB } from '../db.ts'
import { notes, type NoteRow } from '../schema.ts'
import { today, type Viewer } from '../today.ts'

/**
 * The Notes board, or its Archived view.
 *
 * Every note in full, not a preview of each: the board is also where a note is
 * opened from, and a household's notes are measured in kilobytes. A card shows
 * the start of a note and the CSS cuts it off.
 *
 * ORDER is the last edit, newest first, a tie to the newer note — within each
 * section. The board splits off the pinned notes; Archived is one list, with
 * `pinned` empty, because a pin there means only "comes back pinned".
 *
 * SEARCH runs here, as every filter in this app does: the client renders what it
 * is handed. A note matches when every word asked for appears somewhere in its
 * title or its text, in any order, ignoring case and accents. Words, not typos —
 * typo tolerance was declined. Matching runs over `plain()` text, so Markdown's
 * escapes do not hide what was typed.
 */
export async function buildNotesView(
  db: DB,
  viewer: Viewer,
  opts: { archived?: boolean; q?: string } = {},
): Promise<NotesView> {
  const archived = opts.archived ?? false
  const rows = await db
    .select()
    .from(notes)
    .where(and(eq(notes.user_id, viewer.id), eq(notes.archived, archived)))
    .orderBy(desc(notes.updated_at), desc(notes.id))
    .all()

  const words = fold(opts.q ?? '')
    .split(/\s+/)
    .filter(Boolean)
  const found = words.length === 0 ? rows : rows.filter((n) => matches(n, words))
  const all = found.map(toNote)

  return {
    pinned: archived ? [] : all.filter((n) => n.pinned),
    others: archived ? all : all.filter((n) => !n.pinned),
    timezone: viewer.timezone,
    date: today(viewer.timezone),
  }
}

function matches(note: NoteRow, words: string[]): boolean {
  const haystack = fold(`${note.title}\n${plain(note.body)}`)
  return words.every((w) => haystack.includes(w))
}

/** Case and accents folded away, so `Café` and `cafe` are one word. */
function fold(s: string): string {
  return s.normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase()
}

function toNote(row: NoteRow): Note {
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    color: row.color,
    pinned: row.pinned,
    archived: row.archived,
    updated_at: row.updated_at,
  }
}
