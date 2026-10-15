import type { ReactNode } from 'react'
import type { JSONContent } from '@tiptap/core'
import { Tick } from '../../ui.tsx'

/**
 * A note's document drawn as plain React — for the cards, which show many notes
 * at once and mount no editor.
 *
 * Never `innerHTML`: every string reaches the page as a React text child, so
 * whatever is in a note is text. And nothing in here is interactive — a card is
 * one button, so a link is drawn as text and a checkbox as `Tick`'s static form.
 * Open the note to follow one or tick one.
 *
 * Headings are styled paragraphs, not headings: a board of cards with a heading
 * level inside each would be heading soup to a screen reader, and the card's
 * button already names it. Any level the parser produces is drawn — `### x` can
 * arrive as a third level even though the toolbar offers two.
 *
 * A ticked item mirrors the editor's own markup — `li[data-checked]` around a
 * `div` around the paragraph — so one CSS rule strikes it in both places.
 */
export function NoteBody({ doc }: { doc: JSONContent }) {
  return <>{nodes(doc.content)}</>
}

function nodes(list: JSONContent[] | undefined): ReactNode[] {
  return (list ?? []).map(node)
}

function node(n: JSONContent, key: number): ReactNode {
  const children = nodes(n.content)
  switch (n.type) {
    case 'paragraph':
      return <p key={key}>{children}</p>
    case 'heading':
      return (
        <p key={key} className={`note-heading note-heading--${n.attrs?.level === 1 ? 1 : 2}`}>
          {children}
        </p>
      )
    case 'bulletList':
      return <ul key={key}>{children}</ul>
    case 'orderedList':
      return (
        <ol key={key} start={typeof n.attrs?.start === 'number' ? n.attrs.start : undefined}>
          {children}
        </ol>
      )
    case 'listItem':
      return <li key={key}>{children}</li>
    case 'taskList':
      return (
        <ul key={key} data-type="taskList">
          {children}
        </ul>
      )
    case 'taskItem': {
      const done = n.attrs?.checked === true
      return (
        <li key={key} data-type="taskItem" data-checked={done ? 'true' : 'false'}>
          <Tick done={done} disabled label="" onToggle={() => undefined} />
          <div>{children}</div>
        </li>
      )
    }
    case 'codeBlock':
      return (
        <pre key={key}>
          <code>{children}</code>
        </pre>
      )
    case 'horizontalRule':
      return <hr key={key} />
    case 'hardBreak':
      return <br key={key} />
    case 'text':
      return <Marked key={key} text={n.text ?? ''} marks={n.marks ?? []} />
    default:
      // Anything the schema grows later still shows its text.
      return children.length ? <span key={key}>{children}</span> : null
  }
}

function Marked({ text, marks }: { text: string; marks: { type: string }[] }) {
  return marks.reduce<ReactNode>((inner, mark) => {
    switch (mark.type) {
      case 'bold':
        return <strong>{inner}</strong>
      case 'italic':
        return <em>{inner}</em>
      case 'link':
        return <span className="note-link">{inner}</span>
      default:
        return inner
    }
  }, text)
}

/**
 * The first line of text in a document — what an untitled note's card is named
 * by. Empty when there is none.
 */
export function firstLine(doc: JSONContent): string {
  for (const block of doc.content ?? []) {
    const text = textOf(block).trim()
    if (text) return text
  }
  return ''
}

function textOf(n: JSONContent): string {
  if (n.type === 'text') return n.text ?? ''
  // A block's first line, not its whole text: a list is many lines.
  const parts: string[] = []
  for (const child of n.content ?? []) {
    const t = textOf(child)
    if (t.trim()) {
      parts.push(t)
      if (child.type !== 'text') break
    }
  }
  return parts.join('')
}
