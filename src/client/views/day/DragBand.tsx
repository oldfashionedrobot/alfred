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
 * that has to be rejected. `views.md` calls the band boundary the meaning of the
 * baseline flag; this makes it structural.
 *
 * The whole row is the handle. In this mode nothing else on a row is
 * interactive — no tick, no name button — so there is nothing for a drag to be
 * confused with, and no separate grip to aim at on a phone.
 */
export function DragBand({
  tasks,
  onReorder,
}: {
  tasks: DayTask[]
  onReorder: (from: number, to: number) => void
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
            <DragRow key={task.id} task={task} />
          ))}
        </ul>
      </SortableContext>
    </DndContext>
  )
}

export function DragRow({ task }: { task: DayTask }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: task.id,
  })

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
      </div>
    </li>
  )
}
