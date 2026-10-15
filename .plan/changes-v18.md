# v18 — Notes

A third tab. **Notes** is a board of cards, newest edit first, with the pinned
ones above the rest. Tap a card and the note opens over the board; type, and it
saves; close it, and you are back where you were.

It stands alone. Notes do not point at tasks and tasks do not point at notes —
but the format a note is saved in leaves room for that, and that is a reason the
format was chosen.

One migration: a `notes` table, and no change to any table that exists. One new
dependency, the editor, which is most of this iteration's cost and is measured
below.

---

## What a note is

A title, a body, a colour, a pin, an archived flag, and the time it was last
edited. It belongs to one account.

| | |
|---|---|
| `title` | free text, may be empty |
| `body` | **Markdown** — the note as you wrote it, formatting included |
| `color` | a palette name, or null for the default |
| `pinned` | sits in the section above the rest |
| `archived` | off the board; the only kind of deleted there is, short of forever |
| `updated_at` | epoch ms. The last time the title or the body changed. |

---

## Decisions

**Notes belong to one account**, like every task does. Nobody sees anybody else's,
`loadNote` is the single point where ownership is enforced as `loadTask` is for
tasks, and the isolation suite grows to say so. Sharing a note with the rest of
the household was offered and declined.

**The body is Markdown.** A note is stored as the text you would have typed in
any Markdown editor:

```
Ingredients

- [ ] flour
- [x] sugar
- [ ] eggs
  - [ ] free-range

Then bake at 180.
```

That buys three things. A note reads as text in the database and in anything
exported from it. Any Markdown tool can open it if the editor is ever replaced.
And when notes come to point at tasks, the pointer can be an ordinary link —
`[Feed the dog](task:12)` — rather than a node type invented for the purpose.

What it costs, checked by round-tripping each kind of content through the
editor's own serialiser rather than assumed:

| | |
|---|---|
| **No underline** | Markdown has none; the editor would store `++text++`, which nothing else reads. So underline is **switched off in the editor**, not just left off the toolbar — StarterKit registers it, and ⌘U would still make one. Strike, inline code and quotes go the same way, for the same reason: each has its own shortcut. |
| **The text is escaped** | `snake_case` is stored as `snake\_case`, `&` as `&amp;`, a blank line as `&nbsp;`. It reads, but it is not byte-for-byte what you typed — which is why search unescapes before it matches. |
| **Some lines change form** | `1) x` comes back a numbered list, `### x` a heading, and a line followed by a Shift-Enter break and `---` or `===` turns into a heading. Nothing is lost; it is reshaped. |

Two kinds of line would have been **lost**: a line that is only `---`, and a line
indented four spaces — which a paste produces easily. Both vanished on reload
with horizontal rules and code blocks switched off. So both stay **in the
editor's schema and off the toolbar**: a `---` line comes back as a rule and an
indented one as a code block, which is what Markdown says they are. The cost is
that typing `---` or three backticks makes one.

Everything the toolbar offers survives the round trip: headings, bold, italic,
links, bullet and numbered lists nested or not, checklists mixed with ordinary
text, line breaks, and blank lines.

**Tiptap is the editor**, with its official `@tiptap/markdown` extension. Both
are MIT, at 3.32.0. They go into `dependencies`, pinned exactly with
`bun add -E`: Tiptap releases often and has open iOS regressions, and a caret on
the version would take them on unasked. `dependencies` and not `devDependencies`
is load-bearing — the image installs `--production` and bundles the client on the
first request, so an editor in the wrong list would build green and fail on the
first page load.

Nothing would notice, either: CI's post-deploy smoke test asks only
`/api/status`, which answers without bundling anything. It gains one more step —
fetch `/`, then the script that page names — so a client that cannot bundle in
production fails the deploy rather than the first person to open the app. It
checks the script's content type, not just its status: deployment.md records
that an asset path the server does not recognise falls through to the HTML shell
with a 200, so a status check alone would pass on exactly the failure it is for.

Chosen over eleven others because it does checklists mixed with text with real
checkboxes, supports React 19, and is mid-weight. In a line each:

| | |
|---|---|
| Lexical | heavier, still 0.x, a checkbox that cannot be tapped without CSS of our own, an open iOS dictation bug |
| BlockNote | three times the size, and it brings a component library |
| Milkdown | Markdown-native, but 185 KB compressed and 199 packages |
| Quill | no release since November 2024 |
| Plate, Slate, Yoopta | Slate calls its own mobile support beta |
| MDXEditor | Lexical and CodeMirror and Radix together |
| Novel | abandoned since January 2025 |
| Raw ProseMirror | the engine under Tiptap at 70 KB compressed — but the checklist, the list keys and paste handling would be ours to write. **It is the exit:** it reads the same stored Markdown. |

One list of editor extensions, `noteExtensions.ts`, is shared by the editor and
the cards, so the two cannot disagree about what a note can contain.

**The editor loads with the app, and is downloaded once per deploy.** Measured
against a production build:

| | Before | After |
|---|---|---|
| JavaScript, raw | 283 KB | 778 KB |
| gzip, locally | 91 KB | 246 KB |
| server memory after bundling, locally | 85 MB | 123 MB |
| first bundled response | 25–31 ms | 30–33 ms |

Over the wire it will be more than the local gzip: the last reading from Fly
compressed the current bundle to 120 KB where local gzip gives 91, and the same
ratio puts the new one near 320 KB. Fly's memory ran 16 MB above local last time,
which would put it near 139 MB of the machine's 256.

Bun answers a returning browser's `If-None-Match` with a 304 — checked, not
assumed — so a phone downloads the bundle once after each deploy. The 304 saves
the download, not the parse: the extra code is still compiled on every cold
load, and that was not measured. Splitting the editor into a chunk of its own was
tried — `lazy(import())` under `Bun.serve` still emits one chunk — and would need
the build step the Dockerfile deliberately does not have. Not done.

The browser suite cannot drive the iOS keyboard, autocorrect or dictation.
**Thirty minutes on a real iPhone comes before the editor ships**, and nothing
else stands in for it. That half hour includes opening the app cold, ticking a
checkbox — which should no longer raise the keyboard (see below) — typing
Backspace at the start of a list item, and selecting words and pasting a
link.

**Checklists are part of the text**, not a kind of note. `[] ` starts one
anywhere, between paragraphs or under a heading — the thing Keep cannot do and the
complaint about it most often made.

Ticking happens in the open note. A ticked item is struck through and dimmed and
stays where it is; nothing moves. The editor writes `data-checked="true"` or
`"false"` on every item — and marks the list, not the item, with `data-type` —
so the rule is `ul[data-type="taskList"] > li[data-checked="true"]` on the
item's own paragraph, never the whole item, which would strike its unticked
children too. A card draws ticked items with the same markup and does not let
you tick them — open the note.

**A tick is applied by us, not by Tiptap.** Its checkbox handler focuses the
editor and dispatches the change in one chain, and on a touch device the focus
dispatches a transaction of its own first: the change then arrives against a
document that has moved on, and throws *"Applying a mismatched transaction"*.
The phone-emulated browser suite found it. The change is caught on its way down
to Tiptap's listener and the item's `checked` set directly — about twenty lines,
and ticking no longer focuses the editor, so it no longer raises a phone's
keyboard for every tick either.

**Links make themselves.** There is no link button. A typed or pasted address
becomes a link, and selecting words and pasting an address onto them makes the
words the link — both verified in the editor. Typing or pasting Markdown's own
`[words](address)` does **not**: Tiptap has no rule for it and it stays text. A
rule could be written; selecting and pasting already does the job, so it is not.

**Archive is the delete.** On the board, the one way to remove a note is to
archive it, which closes the panel and takes the note off the board.
**Archived** is a second view of the same page, where a note can be restored or
deleted forever, from the open note's footer and never from a card; forever is
behind `Confirm`. An archived note opens and edits like any other — a read-only
mode would be code to prevent something nobody needs prevented. A pin survives
archiving, so a restored note comes back where it was.

**Ordered by the last edit, pinned first.** Within each section the note edited
most recently leads, and a tie goes to the newer note. Only a change to the title
or the body counts as an edit: pinning, colouring and archiving do not move a
note, or pinning would reshuffle the very section you were looking at.

This makes `updated_at` the first instant stored as data. Until now the only
instants in the system were the session's expiry, the login lockout and an
invitation's expiry; *"No times are stored anywhere"* in the architecture
reference stops being true and is corrected there when this ships. It is a
deliberate reversal — you asked to see when a note was edited, and a date without
a time could not tell this morning's edit from last night's.

The clock is still read **once per command**. `runCommand` takes one instant and
derives today's date from it as it does now, and the note commands are handed the
same instant for `updated_at` — so a command cannot straddle midnight with two
different answers, and a test controls it the way it controls the date.

The open note shows it at the foot: *"Edited 3:42pm"* today, *"Edited 12 Oct"*
before that, in the account's stored zone — v11's rule that a day belongs to a
person and not to the device they are holding. One helper in `dates.ts` formats
an instant in a zone; v17's now-line and this label both use it, in the same
style as v17's `9am`.

**Search matches words, not typos.** A note matches when every word you type
appears somewhere in its title or its text, in any order, ignoring case and
accents — *"dog vet"* finds *"Vet appointment for the dog"*. *"Vetrinary"* does
not find *"veterinary"*; typo tolerance is a library or a good deal of code, and
was declined.

It searches whichever view you are on, the board or Archived, and it runs on the
server, as every other filter here does — the client renders what it is handed.
The box waits a moment after you stop typing before it asks.

Matching runs over the note as plain text: one server function, `plain()`,
undoes Markdown's backslash escapes and its entities, so `snake_case`, `AT&T` and
`1 < 2` are found. It is about ten lines and does not import the editor. The same
function answers "is this note empty". What it leaves in is accepted: a ticked
item's `[x]`, a link's address and a heading's `#` are still text, so searching
`x` finds every note with something ticked.

**The grid is as wide as its cards.** Cards are a fixed width, about 240px. The
board is capped at as many card widths as its larger section has cards, and
centred; inside it, both sections fill the same columns. So two notes on a wide
screen are two columns in the middle, and a lone pinned note sits in the first
column of the board below it rather than centred over it on its own. Under about
540px it is one column, full width.

`auto-fit` on each section's grid was the first version. It centres each
section by itself, so a single pinned card sat in the middle of the screen over
three cards that started further left — the screenshots showed it. The cap is a
CSS variable set from the counts the view already carries; nothing is measured.

It packs cards masonry-style where the browser can — `display: grid-lanes`,
unflagged only in Safari 26.4 and later — and lines rows up where it cannot.
Phones get one column, where packing makes no difference, so in practice this is
a desktop question, and a desktop Chrome shows short gaps under the shorter cards
in a row. A card's height is capped, which bounds the gaps. A script that packs
cards everywhere would be about thirty lines; it is not being written until the
gaps are seen to bother anyone.

**A card is one button.** An `<article>` holding the rendered note, with a single
button covering it, named by the title or the first line. The open note's dialog
is named the same way, and its editor *"Note text"* — never the same name as
the dialog, or a screen reader hears two things called one thing. A whole card inside a
`<button>` would put paragraphs and lists inside a button, which is invalid, and
make its accessible name the entire note. Nothing inside a card is interactive:
links draw as text, and checkboxes as `Tick`'s static form.

**Colours are named, not hex.** The palette is Keep's: Coral, Peach, Sand, Mint,
Sage, Fog, Storm, Dusk, Blossom, Clay and Chalk, and the default. A note stores
the name, so each colour has a light shade and a dark one and the theme picks.

Measured against this app's tokens: every one of the 22 shades holds 4.5:1 for
body text. Dimmed text, the accent and control borders fail on most of them. So
a coloured surface sets those three tokens to the body text colour — on a
coloured note a ticked item is struck through rather than dimmed, and that is the
cost. The colour paints the open note as well as its card.

The picker is the chip pattern `ui.tsx` already has, inside `Popover`. Each
swatch is named by its colour, carries a control border — six of the light
shades are barely distinguishable from white — and shows the chosen one with a
ring, not by colour alone.

A task's colour stays a free `#rrggbb`. That is a different field with a
different purpose, and unifying the two would change tasks to tidy notes.

**A note opens over the board.** Full screen on a phone, a centred panel on
anything wider — Keep's small fixed overlay on the web is one of the things
people complain about. It is a variant of `Sheet`, not a new component, and
honours the safe area at the top as the top bar does. It closes on Close, on
Escape, on a tap outside, and on the phone's Back gesture.

Back is the one that costs anything. Opening a note pushes a history entry
**without changing the URL**; Back pops it and closes the note, and closing any
other way steps back over the entry this session pushed. There is no URL to
reload, link to or confuse with an invitation. The cost is one Back press that
does nothing after a reload.

Escape is ignored while an input method is composing. Escape inside the colour
popover closes only the popover: `Popover` stops the key going further, one line,
and no popover sits inside a sheet today, so nothing else changes.

Opening an existing note does not focus anything. A new note focuses its title —
a native input, focused inside the tap, because iOS only raises the keyboard for
focus that happens during the gesture and Tiptap's own autofocus runs just after
it. `Sheet` returns focus to whatever opened it when it closes, which every sheet
gains.

**There is no Save button.** A note saves a second after you stop typing, when
you switch away from the app, and when it closes.

- A new note is created by its first save that has something in it — text, a
  colour or a pin. `create_note` is the **one command that answers with
  something**: the new note's id, which every save after it needs. Every other
  command still answers `{ ok: true }` and nothing else.
- So a note opened and closed blank never reaches the server, and discarding it
  costs nothing. A saved note emptied here and closed is saved empty and then
  deleted, on the same chain: the server deletes a live note only once it IS
  empty, and checks what is stored, not what the client says.
- Every save sends the whole title and body, and only when they differ from what
  was last sent. All of a note's commands run one after another on one chain, so
  a slow first save cannot be overtaken — and cannot be sent twice.
- After each save the board is refetched, as after every command here. The open
  panel seeds its text once and never re-reads it, so a refetch cannot overwrite
  what you are typing. Behind the panel, the edited card moves to the front.
- Closing saves from the panel's unmount, the way the log already does — one path
  for Close, Escape, a tap outside, Back, a tab switch and signing out.
- A failed save shows a notice, and the next save, carrying the whole text, heals
  it. A failed save on close loses that last second; so does being signed out
  mid-edit. Both accepted.

**A new note opens the same panel, empty.** Keep's expanding *"Take a note…"* bar
is a second editing surface with its own rules, and one is enough.

---

## Server

### `notes`

| Column | |
|---|---|
| `id` | integer, autoincrement |
| `user_id` | owner. Indexed. Every query filters on it. |
| `title` | text, not null, default `''` |
| `body` | text, not null, default `''`. Markdown. |
| `color` | text, one of the palette names, or null |
| `pinned` | boolean, default false |
| `archived` | boolean, default false |
| `updated_at` | integer, epoch ms |

One generated migration, `0006`, with its snapshot and journal entry. Generated
and applied to a copy of the development database: it creates `notes` and its
index and nothing else, in 3 ms, with every existing row count unchanged.

The body is not validated beyond being a string. Markdown has no invalid
documents, and the one writer is the person whose note it is. Nor is it capped,
for the same reason the day's log is not. Title and body take a validator that
accepts the empty string — `reqName` refuses it.

### `GET /api/notes`

`NotesView`: `pinned` and `others`, each already ordered, plus the viewer's
`timezone` and today's `date` for the edited label. `?archived=true` answers the
Archived view in the same shape, with `pinned` empty. `?q=` filters either.
`routes.ts` reads both parameters as strictly as it reads `week`.

The board carries every note in full rather than a preview of each, because the
board is also where a note is opened from, and a household's notes are measured
in kilobytes. A card shows the start of the note and the CSS cuts it off.

### Commands

| | |
|---|---|
| `create_note` | a new note, and its id |
| `update_note` | any of `title`, `body`, `color`, `pinned`, `archived`. Sets `updated_at` only when the title or body actually changes. |
| `delete_note` | forever. Refused with a 409 unless the note is archived **or empty** — the first so that forever lives in Archived, the second so that an emptied note can be discarded on close. |

Each takes `onlyFields`. `runCommand` returns the id when there is one, the route
spreads it into `{ ok: true }`, and `api.ts` gains `createNote()` beside
`command()`.

---

## Client

| | |
|---|---|
| `main.tsx` | a third tab, keyed `notes`, labelled **Notes**. Three tabs and the menu fit a 320px phone with 18px to spare. |
| `views/notes/Notes.tsx` | the board: search, the Archived switch, the two sections, the grid, the open note, and the one chain every note command runs on |
| `views/notes/NoteCard.tsx` | one card. Parses the Markdown with the shared extensions, remembering the result per body |
| `views/notes/NoteBody.tsx` | the parsed document walked into React for a card — never `innerHTML`, nothing interactive |
| `views/notes/NotePanel.tsx` | the open note: title, editor, toolbar, colour, pin, archive, the edited time; restore and delete forever when archived |
| `views/notes/noteExtensions.ts` | the one extension list |
| `views/notes/notes.css` | the grid, the cards, the palette in both themes, the struck-through ticked item |
| `ui.tsx` | `Sheet` gains the panel variant and returns focus on close; `Popover` keeps Escape to itself |
| `api.ts` | `getNotes()` and `createNote()` |

The Notes view opts out of `.app`'s 720px reading width the way the Tracker does,
off `.app:has(> …)`.

The toolbar is ours, one row, scrolling sideways on a narrow phone with the
checklist first: checklist, bold, italic, two heading sizes, bullet list,
numbered list, undo, redo. Tiptap is headless, and a toolbar from a component
library would bring the library.

Parsing on the card was measured: 200 notes of realistic length parse and render
in about 53 ms on a laptop, and a phone might be two to four times that — once,
since each card remembers its result. The card draws any heading level the
parser produces, since `### x` can arrive as a third level.

The open note's unsaved text is not a new kind of client state. The log, the task
editor and the capture form already hold drafts the same way, and architecture.md's
count of what the client holds leaves all of them out; it gains one row for form
drafts, covering all four.

---

## When this ships, these stop being true

The architecture reference and the code comments that say so are corrected:
*"No times are stored anywhere"*; that nothing is ever deleted — the comments in
`commands.ts`, `TaskEditor.tsx` and `schema.ts`, and *"no delete API"* in
`playwright.config.ts`; *"never a timestamp"* in `types.ts` and `schema.ts`; five
tables, which become six; thirteen commands, which become sixteen; and that every
command answers with nothing.

---

## Tests

### Unit

| | |
|---|---|
| `commands.test.ts` | `create_note` stamps the caller, sets `updated_at`, and is the only command that returns an id. `updated_at` moves on a title or body change, not on the same text resent, a pin, a colour or an archive. The body is stored byte for byte — leading spaces and a line of only spaces survive. An unknown colour is a 400, `null` clears one; an unknown field or a wrong type is a 400. `delete_note` refuses a live note with text and leaves it, deletes an archived one, deletes a live empty one. |
| `views.test.ts` | pinned before others, each by `updated_at` and then id, newest first. The board leaves archived notes out; Archived holds only them, with `pinned` empty; a restored note keeps its pin. The view carries `timezone`, and `date` is today in it. Search matches every word in any order, ignores case and accents both ways, finds `snake_case`, `AT&T` and `1 < 2`, finds a word only in the title, fails on a missing word, stays inside the view asked for, and treats a blank `q` as none. |
| `isolation.test.ts` | the board, Archived, and a `q` matching both accounts' notes all return only the caller's; `update_note` and `delete_note` on another account's note are a 404 and change nothing; `create_note` stamps the caller |

`fixtures.ts` and `seed-cli.ts` gain a `note` seed.

### Browser — `notes.spec.ts`

| | |
|---|---|
| Create | a note is created, and found after a reload |
| Autosave | an edit survives a reload without the panel closing — waiting on the `update_note` response, never a timer |
| One note, not two | typing on while `create_note` is held back with `page.route` still produces exactly one note |
| Discard | a blank new note sends no request; an emptied note is deleted |
| Pin, colour | pinning moves the card to the pinned section; a colour shows on the card and its swatch is pressed |
| Archive, restore, forever | archiving closes the panel and leaves the board; restoring puts the note back; delete forever sits behind `Confirm` and is not offered on a live note |
| Search | on the board and in Archived |
| Closing | Back closes the panel and the URL does not change; Escape and a tap outside close it; Escape with the colour popover open closes only the popover; focus returns to the card; a new note focuses its title |
| Ticked items | struck through by computed style, staying in place, a nested unticked child not struck, and the editor not focused by the tick; a card holds no checkbox or link roles |
| Checklists | `[] ` starts one under a paragraph, the paragraph staying a paragraph |
| Links | an address typed into a note becomes a link |
| Edited | *"Edited h:mmam"* for today, the date for a seeded older note |
| Geometry | one column on a phone; two or more on a desktop, with two cards centred — the gap left equal to the gap right; the page never scrolls sideways. A geometry assertion, because the suite reads roles and names and would pass a grid with no CSS at all. |

Input rules need `keyboard.type`: `fill()` does not fire them, so `[] ` would never
become a checkbox.

---

## Not in this iteration

Offered from Keep and declined: labels, dragging cards into an order, a grid/list
switch, selecting several notes, making a copy, keyboard shortcuts, sharing,
images, background images, link previews, version history, reminders, drawings,
voice notes, AI, and offline editing.

Also not here: **underline**, which Markdown cannot hold; **a link button** —
links make themselves, and selected words take a pasted address; **typo-tolerant
search**; **ticking from a card**, or ticked items moving to the bottom; and
**links between notes and tasks** — the reason for Markdown, and a later
iteration.
