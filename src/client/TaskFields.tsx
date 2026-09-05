import { CADENCES, type Cadence } from '../shared/types.ts'

/**
 * The task definition fields, shared by the editor (To do panel) and the capture
 * sheet (Day). One definition, because the two forms now carry the same inputs —
 * `views.md`, "Input". Capture collapses everything below the name.
 */

export type TaskDraft = {
  name: string
  cadence: Cadence | ''
  is_baseline: boolean
  color: string | null
  category: string
}

/** What the server treats as a plain backlog item: a name and nothing else. */
export const emptyDraft = (): TaskDraft => ({
  name: '',
  cadence: '',
  is_baseline: false,
  color: null,
  category: '',
})

/** The first colour offered when one is added. Any hex is accepted. */
const DEFAULT_COLOR = '#3d6ee0'

export function TaskFields({
  draft,
  onChange,
  categories = [],
  collapseExtras = false,
  autoFocusName = false,
}: {
  draft: TaskDraft
  onChange: (next: TaskDraft) => void
  /** Categories already in use, suggested so that picking beats retyping. */
  categories?: string[]
  /** Capture hides everything but the name behind a disclosure. */
  collapseExtras?: boolean
  autoFocusName?: boolean
}) {
  const set = (patch: Partial<TaskDraft>) => onChange({ ...draft, ...patch })

  const extras = (
    <>
      <label className="field">
        <span className="field-label">Cadence</span>
        <select
          className="input"
          value={draft.cadence}
          aria-label="Cadence"
          onChange={(e) => set({ cadence: e.target.value as Cadence | '' })}
        >
          <option value="">one-off</option>
          {CADENCES.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      </label>

      {/* Free text with suggestions: exact-match grouping means `Dog` and `dog`
          are two categories, so making the existing one easy to pick is the
          whole defence against drift. */}
      <label className="field">
        <span className="field-label">Category</span>
        <input
          className="input"
          list="task-categories"
          value={draft.category}
          aria-label="Category"
          placeholder="none"
          onChange={(e) => set({ category: e.target.value })}
        />
        <datalist id="task-categories">
          {categories.map((c) => (
            <option key={c} value={c} />
          ))}
        </datalist>
      </label>

      <label className="check">
        <input
          type="checkbox"
          checked={draft.is_baseline}
          onChange={(e) => set({ is_baseline: e.target.checked })}
        />
        <span>
          Baseline
          <span className="hint"> — the bare minimum to function. Sorts to the top.</span>
        </span>
      </label>

      {/* Colour is a baseline-only mark, so the input only exists when the flag
          is on. An existing colour is kept in the draft rather than cleared, so
          unticking and re-ticking does not lose it. */}
      {draft.is_baseline && (
        <div className="field">
          <span className="field-label">Colour</span>
          {draft.color === null ? (
            <button
              type="button"
              className="btn btn--small btn--quiet"
              onClick={() => set({ color: DEFAULT_COLOR })}
            >
              Add a colour
            </button>
          ) : (
            <div className="colour">
              <input
                type="color"
                className="colour__swatch"
                value={draft.color}
                aria-label="Colour"
                onChange={(e) => set({ color: e.target.value })}
              />
              <input
                className="input colour__hex"
                value={draft.color}
                aria-label="Colour hex"
                spellCheck={false}
                placeholder="#rrggbb"
                onChange={(e) => set({ color: e.target.value })}
              />
              <button
                type="button"
                className="btn btn--small btn--quiet"
                onClick={() => set({ color: null })}
              >
                Clear
              </button>
            </div>
          )}
          <span className="hint">Paints the row’s left edge and its name. Used exactly as picked.</span>
        </div>
      )}
    </>
  )

  return (
    <>
      <label className="field">
        <span className="field-label">Name</span>
        <input
          className="input"
          value={draft.name}
          autoFocus={autoFocusName}
          aria-label="Task name"
          placeholder="What is it?"
          onChange={(e) => set({ name: e.target.value })}
        />
      </label>

      {collapseExtras ? (
        <details className="more">
          <summary className="more__toggle">More</summary>
          <div className="more__body">{extras}</div>
        </details>
      ) : (
        extras
      )}
    </>
  )
}

/**
 * The command body. `color` is sent only when the task is baseline — the server
 * stores whatever it is given, and a colour on a non-baseline task would be a
 * value no view will ever render.
 */
export function draftToPatch(draft: TaskDraft): Record<string, unknown> {
  return {
    name: draft.name.trim(),
    cadence: draft.cadence === '' ? null : draft.cadence,
    is_baseline: draft.is_baseline,
    color: draft.is_baseline ? draft.color : null,
    category: draft.category.trim() === '' ? null : draft.category.trim(),
  }
}

/** True when the draft is valid enough to send. */
export const draftIsValid = (draft: TaskDraft): boolean =>
  draft.name.trim().length > 0 && (draft.color === null || /^#[0-9a-fA-F]{6}$/.test(draft.color))
