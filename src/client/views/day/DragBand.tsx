import type { CSSProperties } from 'react'
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core'
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import type { DayTask } from '../../../shared/types.ts'
// --- drag reordering --------------------------------------------------------

/**
 * One band of the active list, made draggable.
 *
 * Each band gets its OWN DndContext, which is how "bands never mix" is enforced:
 * a baseline task and a non-baseline one are never in the same drag context, so
 * crossing the boundary is not a move that can be expressed rather than a move
 * that has to be rejected. The band boundary is the meaning of the
 * baseline flag; this makes it structural.
 *
 * The whole row is the handle — still, now that v15 has put two buttons on it.
 * The original reason (nothing else on a row is interactive, so a drag has
 * nothing to be confused with) is gone, but the half that mattered is not: on a
 * phone a grip is a worse target than a row. So the buttons stop the drag rather
 * than the row giving up the listeners — `stopPropagation` on `pointerdown`,
 * because `PointerSensor`'s activator checks only `isPrimary` and `button` and
 * will happily start a drag from a tap on a child. The keyboard sensor needs no
 * such guard: it already refuses a keydown whose target is not the row itself.
 */
export function DragBand({
  tasks,
  onReorder,
  onMoveToTop,
  onMoveToBottom,
}: {
  tasks: DayTask[]
  onReorder: (from: number, to: number) => void
  /**
   * The two ends of THIS band. The row knows only its own id — which band it
   * belongs to, and therefore what "the top" means, is Day's to answer, the same
   * way the drag's `from`/`to` are indexes within the band it was raised from.
   */
  onMoveToTop: (id: number) => void
  onMoveToBottom: (id: number) => void
}) {
  const sensors = useSensors(
    // A short distance before a drag starts, so a tap or a scroll on a dense
    // list is not read as the beginning of a drag.
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )

  const ids = tasks.map((t) => t.id)

  const onDragEnd = (e: DragEndEvent) => {
    const { active, over } = e
    if (!over || active.id === over.id) return
    const from = ids.indexOf(Number(active.id))
    const to = ids.indexOf(Number(over.id))
    if (from < 0 || to < 0) return
    onReorder(from, to)
  }

  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
      <SortableContext items={ids} strategy={verticalListSortingStrategy}>
        <ul className="day-list day-list--reorder">
          {tasks.map((task) => (
            <DragRow
              key={task.id}
              task={task}
              onMoveToTop={onMoveToTop}
              onMoveToBottom={onMoveToBottom}
            />
          ))}
        </ul>
      </SortableContext>
    </DndContext>
  )
}

export function DragRow({
  task,
  onMoveToTop,
  onMoveToBottom,
}: {
  task: DayTask
  onMoveToTop: (id: number) => void
  onMoveToBottom: (id: number) => void
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: task.id,
  })

  // Named, not positional: "to the top" is the whole gesture, and a screen
  // reader gets no help from an arrow. Reused as the tooltip so the visible
  // label is contained in the accessible one (WCAG 2.5.3) rather than nearly so.
  const toTop = `Move ${task.name} to the top`
  const toBottom = `Send ${task.name} to the bottom`

  return (
    <li
      ref={setNodeRef}
      className="day-row day-row--reordering"
      data-dragging={isDragging || undefined}
      data-colour={task.color ? '' : undefined}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        ...(task.color ? ({ '--task-colour': task.color } as CSSProperties) : {}),
      }}
      {...attributes}
      {...listeners}
    >
      <div className="day-row-main">
        <span className="day-row-grip" aria-hidden="true">
          ≡
        </span>
        <span className="day-name">
          <span className="day-name-text">{task.name}</span>
        </span>
        {/* Both ends of the band in one tap, for the list long enough that
            dragging to its end means dragging past a screen edge.

            Each stops `pointerdown` from reaching the row. The row is the drag
            handle and 6px of slack is not enough for a thumb, so without this a
            sloppy tap on a button is read as the start of a drag instead. */}
        <span className="day-row-move">
          <button
            type="button"
            className="btn btn--icon"
            aria-label={toTop}
            title={toTop}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => onMoveToTop(task.id)}
          >
            <span aria-hidden="true">⤒</span>
          </button>
          <button
            type="button"
            className="btn btn--icon"
            aria-label={toBottom}
            title={toBottom}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => onMoveToBottom(task.id)}
          >
            <span aria-hidden="true">⤓</span>
          </button>
        </span>
      </div>
    </li>
  )
}
