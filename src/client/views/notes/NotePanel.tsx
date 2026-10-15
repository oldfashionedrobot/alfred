import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { EditorContent, useEditor, useEditorState, type Editor } from '@tiptap/react'
import {
  NOTE_COLORS,
  isBlankNote,
  type ISODate,
  type Note,
  type NoteColor,
} from '../../../shared/types.ts'
import { command, createNote } from '../../api.ts'
import { editedLabel } from '../../dates.ts'
import { Confirm, Popover, Sheet } from '../../ui.tsx'
import { noteExtensions } from './noteExtensions.ts'

/** The board's one command chain, every note command in order. See `Notes`. */
export type Enqueue = (job: () => Promise<void>) => void

type Draft = { title: string; body: string }

/**
 * The open note: its title, the editor, the toolbar, colour, pin, and the way
 * out — archive, or restore and delete forever when it is archived.
 *
 * THERE IS NO SAVE BUTTON. A note saves a second after you stop typing, when the
 * app is hidden, and when it closes.
 *
 * - A new note is created by its first save with something in it — text, a
 *   colour or a pin — so one opened and closed blank never reaches the server.
 *   `create_note` answers with the id every later save needs.
 * - Every save sends the whole title and body, and only when they differ from
 *   what was last sent. All of them run on the board's one chain, so a slow
 *   first save can be neither overtaken nor sent twice.
 * - The panel seeds its text ONCE and never re-reads it. The board refetches
 *   after every save, as it does after every command here, and a refetch must not
 *   overwrite what is being typed.
 * - Closing — by Close, Escape, a tap outside, Back, a tab switch or signing out
 *   — saves from this component's unmount, the way the day's log already does:
 *   one path for all of them. A note emptied here and closed is saved empty and
 *   then deleted.
 *
 * The unsaved text is a form draft, the same kind the log, the task editor and
 * capture already hold.
 */
export function NotePanel({
  note,
  live,
  archivedView,
  timezone,
  today,
  enqueue,
  onSaved,
  onCreated,
  onClose,
}: {
  /** As it was when opened; null for a new note. Read once. */
  note: Note | null
  /** The model's copy, for the edited time. Null until it exists. */
  live: Note | null
  archivedView: boolean
  timezone: string
  today: ISODate
  enqueue: Enqueue
  onSaved: () => void
  onCreated: (id: number) => void
  onClose: () => void
}) {
  const [title, setTitle] = useState(note?.title ?? '')
  const [color, setColor] = useState<NoteColor | null>(note?.color ?? null)
  const [pinned, setPinned] = useState(note?.pinned ?? false)
  const [picking, setPicking] = useState(false)

  const id = useRef<number | null>(note?.id ?? null)
  const sent = useRef<Draft>({ title: note?.title ?? '', body: note?.body ?? '' })
  const draft = useRef<Draft>({ ...sent.current })
  /** Colour and pin, for a note that does not exist yet and is about to. */
  const extras = useRef({ color, pinned })
  /** Edited in this sitting — so only a note emptied HERE is deleted on close. */
  const touched = useRef(false)
  /** Archived or deleted from here: nothing more of it to save. */
  const gone = useRef(false)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  // The board's callbacks change identity with every render of the board; the
  // unmount save below needs the ones current when it runs.
  const props = useRef({ enqueue, onSaved, onCreated })
  props.current = { enqueue, onSaved, onCreated }

  const save = () => {
    clearTimeout(timer.current)
    if (gone.current) return
    props.current.enqueue(async () => {
      const d = draft.current
      if (id.current === null) {
        if (isBlankNote(d)) return
        id.current = await createNote({ ...d, ...extras.current })
        props.current.onCreated(id.current)
      } else if (d.title !== sent.current.title || d.body !== sent.current.body) {
        await command('update_note', { id: id.current, ...d })
      } else {
        return
      }
      sent.current = d
      props.current.onSaved()
    })
  }
  const saveNow = useRef(save)
  saveNow.current = save

  const edit = (patch: Partial<Draft>) => {
    draft.current = { ...draft.current, ...patch }
    touched.current = true
    clearTimeout(timer.current)
    timer.current = setTimeout(() => saveNow.current(), 1000)
  }

  const editor = useEditor({
    extensions: noteExtensions,
    content: note?.body ?? '',
    contentType: 'markdown',
    editorProps: { attributes: { class: 'note-doc note-editor', 'aria-label': 'Note text' } },
    onUpdate: ({ editor }) => edit({ body: editor.getMarkdown() }),
  })

  /*
   * A tick is applied here, not by Tiptap. Its checkbox handler focuses the
   * editor and then dispatches the change in one chain — and on a touch device
   * the focus dispatches a transaction of its own first, so the chain's arrives
   * against a document that has moved on and throws "Applying a mismatched
   * transaction" (found by the phone-emulated suite). Focusing on every tick
   * would also raise a phone's keyboard each time. So the change is caught on
   * the way down, before it reaches Tiptap's listener on the box, and the item's
   * `checked` is set directly — no focus, and no keyboard.
   */
  useEffect(() => {
    if (!editor) return
    const dom = editor.view.dom
    const onChange = (e: Event) => {
      const box = e.target
      if (!(box instanceof HTMLInputElement) || box.type !== 'checkbox') return
      e.stopPropagation()
      const content = box.closest('li')?.querySelector(':scope > div')
      if (!content) return
      const { view } = editor
      const $pos = view.state.doc.resolve(view.posAtDOM(content, 0))
      for (let d = $pos.depth; d > 0; d--) {
        const item = $pos.node(d)
        if (item.type.name !== 'taskItem') continue
        view.dispatch(
          view.state.tr.setNodeMarkup($pos.before(d), undefined, {
            ...item.attrs,
            checked: box.checked,
          }),
        )
        return
      }
    }
    dom.addEventListener('change', onChange, true)
    return () => dom.removeEventListener('change', onChange, true)
  }, [editor])

  // When the app is hidden — a phone switching apps may never come back to it.
  useEffect(() => {
    const onHide = () => {
      if (document.visibilityState === 'hidden') saveNow.current()
    }
    document.addEventListener('visibilitychange', onHide)
    return () => document.removeEventListener('visibilitychange', onHide)
  }, [])

  // Closing, by any route.
  useEffect(
    () => () => {
      clearTimeout(timer.current)
      if (gone.current) return
      saveNow.current()
      // Emptied here: saved empty first, on the same chain, because the server
      // deletes a live note only once it IS empty — then deleted. The id is read
      // when the delete runs, so a first save still in flight is waited for.
      if (touched.current && isBlankNote(draft.current)) {
        gone.current = true
        props.current.enqueue(async () => {
          if (id.current === null) return
          await command('delete_note', { id: id.current })
          props.current.onSaved()
        })
      }
    },
    [],
  )

  /** A colour or a pin: written at once, creating the note if it has to. */
  const setExtra = (patch: { color?: NoteColor | null; pinned?: boolean }) => {
    if (patch.color !== undefined) setColor(patch.color)
    if (patch.pinned !== undefined) setPinned(patch.pinned)
    extras.current = { ...extras.current, ...patch }
    props.current.enqueue(async () => {
      if (id.current === null) {
        id.current = await createNote({ ...draft.current, ...extras.current })
        sent.current = draft.current
        props.current.onCreated(id.current)
      } else {
        await command('update_note', { id: id.current, ...patch })
      }
      props.current.onSaved()
    })
  }

  /**
   * Archive, restore or delete forever — each closes the note. Whatever was typed
   * is saved first, on the same chain, and the id is read when the gesture runs,
   * so a first save still in flight is waited for rather than missed.
   */
  const finish = (gesture: 'archive' | 'restore' | 'delete') => {
    save()
    gone.current = true
    props.current.enqueue(async () => {
      const target = id.current
      if (target === null) return
      if (gesture === 'delete') await command('delete_note', { id: target })
      else await command('update_note', { id: target, archived: gesture === 'archive' })
      props.current.onSaved()
    })
    onClose()
  }

  const colourName = color === null ? 'Default' : capitalise(color)

  return (
    <Sheet
      // The dialog's name — never the editor's, or a screen reader hears two
      // things called the same.
      title={note === null ? 'New note' : note.title.trim() || 'Note'}
      variant="panel"
      color={color}
      onClose={onClose}
      actions={
        <>
          {!archivedView && (
            <button
              className="btn btn--small btn--quiet"
              aria-pressed={pinned}
              onClick={() => setExtra({ pinned: !pinned })}
            >
              {pinned ? 'Pinned' : 'Pin'}
            </button>
          )}
          <button
            className="btn btn--small btn--quiet pop-anchor"
            style={{ '--pop-anchor': '--note-colour' } as CSSProperties}
            aria-expanded={picking}
            onClick={() => setPicking(true)}
          >
            <span className="note-swatch-dot" data-color={color ?? undefined} aria-hidden="true" />
            Colour<span className="sr">: {colourName}</span>
          </button>
          {picking && (
            <Popover anchor="--note-colour" onClose={() => setPicking(false)}>
              <div className="note-palette" role="group" aria-label="Note colour">
                {[null, ...NOTE_COLORS].map((c) => (
                  <button
                    key={c ?? 'default'}
                    className="note-swatch"
                    data-color={c ?? undefined}
                    aria-label={c === null ? 'Default' : capitalise(c)}
                    title={c === null ? 'Default' : capitalise(c)}
                    aria-pressed={color === c}
                    onClick={() => {
                      setExtra({ color: c })
                      setPicking(false)
                    }}
                  />
                ))}
              </div>
            </Popover>
          )}
        </>
      }
    >
      <input
        className="note-title"
        aria-label="Title"
        placeholder="Title"
        value={title}
        // A new note only: iOS raises the keyboard for a focus made during the
        // tap, which a native input's autofocus is and the editor's own is not.
        autoFocus={note === null}
        onChange={(e) => {
          setTitle(e.target.value)
          edit({ title: e.target.value })
        }}
      />
      {editor && <Toolbar editor={editor} />}
      <EditorContent editor={editor} />
      <div className="note-foot">
        <span className="note-edited">
          {live ? editedLabel(timezone, today, live.updated_at) : ''}
        </span>
        {archivedView ? (
          <span className="note-foot-actions">
            <button className="btn btn--small" onClick={() => finish('restore')}>
              Restore
            </button>
            <Confirm
              label="Delete forever"
              question="Delete this note forever?"
              confirmLabel="Delete forever"
              tone="danger"
              onConfirm={() => finish('delete')}
            />
          </span>
        ) : (
          <button className="btn btn--small btn--quiet" onClick={() => finish('archive')}>
            Archive
          </button>
        )}
      </div>
    </Sheet>
  )
}

function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

/**
 * Ours, about nine buttons — Tiptap is headless, and a toolbar from a component
 * library would bring the library. One row that scrolls sideways on a narrow
 * phone, checklist first. No link button: links make themselves.
 */
function Toolbar({ editor }: { editor: Editor }) {
  // Re-rendered as the selection moves, so each button can say whether it is on.
  const on = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      checklist: e.isActive('taskList'),
      bold: e.isActive('bold'),
      italic: e.isActive('italic'),
      h1: e.isActive('heading', { level: 1 }),
      h2: e.isActive('heading', { level: 2 }),
      bullets: e.isActive('bulletList'),
      numbers: e.isActive('orderedList'),
      undo: e.can().undo(),
      redo: e.can().redo(),
    }),
  })
  const run = () => editor.chain().focus()
  const tool = (
    label: string,
    glyph: string,
    action: () => void,
    pressed?: boolean,
    disabled?: boolean,
  ) => (
    <button
      type="button"
      className="btn btn--icon note-tool"
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      disabled={disabled}
      // Keeps the editor's selection on a desktop: a mousedown would move focus.
      onMouseDown={(e) => e.preventDefault()}
      onClick={action}
    >
      <span aria-hidden="true">{glyph}</span>
    </button>
  )

  return (
    <div className="note-toolbar" role="toolbar" aria-label="Formatting">
      {tool('Checklist', '☑', () => run().toggleTaskList().run(), on.checklist)}
      {tool('Bold', 'B', () => run().toggleBold().run(), on.bold)}
      {tool('Italic', 'I', () => run().toggleItalic().run(), on.italic)}
      {tool('Heading', 'H1', () => run().toggleHeading({ level: 1 }).run(), on.h1)}
      {tool('Subheading', 'H2', () => run().toggleHeading({ level: 2 }).run(), on.h2)}
      {tool('Bulleted list', '•', () => run().toggleBulletList().run(), on.bullets)}
      {tool('Numbered list', '1.', () => run().toggleOrderedList().run(), on.numbers)}
      {tool('Undo', '↶', () => run().undo().run(), undefined, !on.undo)}
      {tool('Redo', '↷', () => run().redo().run(), undefined, !on.redo)}
    </div>
  )
}
