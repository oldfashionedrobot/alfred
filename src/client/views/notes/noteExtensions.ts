import { TaskItem, TaskList } from '@tiptap/extension-list'
import { Markdown, MarkdownManager } from '@tiptap/markdown'
import StarterKit from '@tiptap/starter-kit'

/**
 * What a note can contain — ONE list, shared by the editor and the cards, so the
 * two cannot disagree about it.
 *
 * Switched OFF, not merely left off the toolbar: underline, which Markdown cannot
 * hold (the editor would write `++text++`, which nothing else reads), and strike,
 * inline code and quotes — each has a keyboard shortcut and an input rule of its
 * own, so leaving out the button would still let ⌘U make one.
 *
 * Kept ON and off the toolbar: the horizontal rule and the code block. With them
 * switched off, a line that is only `---`, or one indented four spaces — which a
 * paste produces easily — VANISHED on reload. In the schema, they come back as a
 * rule and a code block, which is what Markdown says they are.
 *
 * Links make themselves: a typed or pasted address becomes one, and words
 * selected with an address pasted onto them become the link. There is no button.
 */
const schema = [
  StarterKit.configure({
    underline: false,
    strike: false,
    code: false,
    blockquote: false,
    heading: { levels: [1, 2] },
    link: { autolink: true, linkOnPaste: true, defaultProtocol: 'https' },
  }),
  TaskList,
  // Nested, so a checklist item can hold its own sub-items.
  TaskItem.configure({ nested: true }),
]

/** The editor's extensions: the schema, and Markdown in and out. */
export const noteExtensions = [...schema, Markdown]

/**
 * The cards' parser, built from the same schema. A card is drawn from the parsed
 * document without mounting an editor — the board shows many notes at once.
 */
export const markdown = new MarkdownManager({ extensions: schema })
