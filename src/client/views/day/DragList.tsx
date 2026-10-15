import type { CSSProperties, PointerEvent } from 'react'
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type Announcements,
  type DragEndEvent,
  type UniqueIdentifier,
} from '@dnd-kit/core'
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import type { DayTask } from '../../../shared/types.ts'
import { timeLabel } from '../../dates.ts'

// --- drag reordering --------------------------------------------------------

/**
 * One row of today's list while it is being arranged: a task, or an hour.
 *
 * An hour carries a key the client made up, because the hour itself cannot be
 * its identity — two dividers may hold the same hour — and its position moves
 * during a drag. Keys are strings and task ids are numbers, so the two can never
 * be mistaken for each other by dnd-kit or, once stringified, by React.
 */
export type ArrangeItem =
  { kind: 'task'; task: DayTask } | { kind: 'hour'; key: string; hour: number }

const idOf = (item: ArrangeItem): UniqueIdentifier =>
  item.kind === 'task' ? item.task.id : item.key

/** What a screen reader hears a row called — the same string as its aria-label. */
const nameOf = (item: ArrangeItem): string =>
  item.kind === 'task' ? item.task.name : `${timeLabel(item.hour)} hour`

/**
 * Today's list, made draggable — one list and one drag context.
 *
 * It was two until v17, one per baseline band, which is how "bands never mix"
 * was enforced: crossing was not a move that could be expressed. Baseline is no
 * longer a position, and the hour dividers are rows in the same list, so the
 * bands went and everything moves anywhere.
 *
 * The whole row is the handle — still, now that v15 has put two buttons on it.
 * On a phone a grip is a worse target than a row. So the buttons stop the drag
 * rather than the row giving up the listeners — `stopPropagation` on
 * `pointerdown`, because `PointerSensor`'s activator checks only `isPrimary` and
 * `button` and will happily start a drag from a tap on a child. The keyboard
 * sensor needs no such guard: it already refuses a keydown whose target is not
 * the row itself — which is also what lets an hour's `<select>` take arrow keys.
 */
export function DragList({
  items,
  onMove,
  onRetime,
  onRemove,
}: {
  items: ArrangeItem[]
  /** Every move — a drag, move to top, send to bottom — is one of these. */
  onMove: (from: number, to: number) => void
  onRetime: (key: string, hour: number) => void
  onRemove: (key: string) => void
}) {
  const sensors = useSensors(
    // A short distance before a drag starts, so a tap or a scroll on a dense
    // list is not read as the beginning of a drag.
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )

  const ids = items.map(idOf)
  const last = items.length - 1

  // Read names, not ids. dnd-kit's defaults announce "Picked up draggable item
  // 12" — and an hour's made-up key would have been read out as "item h3".
  const named = (id: UniqueIdentifier): string => {
    const item = items[ids.indexOf(id)]
    return item ? nameOf(item) : 'the row'
  }
  const announcements: Announcements = {
    onDragStart: ({ active }) => `Picked up ${named(active.id)}.`,
    onDragOver: ({ active, over }) =>
      over
        ? `${named(active.id)} is over ${named(over.id)}.`
        : `${named(active.id)} is not over the list.`,
    onDragEnd: ({ active, over }) =>
      over
        ? `${named(active.id)} was dropped at ${named(over.id)}.`
        : `${named(active.id)} was dropped.`,
    onDragCancel: ({ active }) => `Moving ${named(active.id)} was cancelled.`,
  }

  const onDragEnd = (e: DragEndEvent) => {
    const { active, over } = e
    if (!over || active.id === over.id) return
    // Compared as given: a task's id is a number and an hour's key a string, and
    // coercing either would lose the other.
    const from = ids.indexOf(active.id)
    const to = ids.indexOf(over.id)
    if (from < 0 || to < 0) return
    onMove(from, to)
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragEnd={onDragEnd}
      accessibility={{ announcements }}
    >
      <SortableContext items={ids} strategy={verticalListSortingStrategy}>
        <ul className="day-list day-list--reorder">
          {items.map((item, i) =>
            item.kind === 'task' ? (
              <DragRow
                key={item.task.id}
                task={item.task}
                onMoveToTop={() => onMove(i, 0)}
                onMoveToBottom={() => onMove(i, last)}
              />
            ) : (
              <DragHour
                key={item.key}
                item={item}
                onRetime={(hour) => onRetime(item.key, hour)}
                onRemove={() => onRemove(item.key)}
              />
            ),
          )}
        </ul>
      </SortableContext>
    </DndContext>
  )
}

/** Stops a tap on a control inside a row from starting a drag of the row. */
const holdStill = { onPointerDown: (e: PointerEvent) => e.stopPropagation() }

function DragRow({
  task,
  onMoveToTop,
  onMoveToBottom,
}: {
  task: DayTask
  onMoveToTop: () => void
  onMoveToBottom: () => void
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
      // After the spread, which makes the row a button: named by the task alone,
      // rather than by everything inside it, the move buttons' labels included.
      aria-label={task.name}
    >
      <div className="day-row-main">
        <span className="day-row-grip" aria-hidden="true">
          ≡
        </span>
        <span className="day-name">
          <span className="day-name-text">{task.name}</span>
        </span>
        {/* Both ends of the list in one tap, for the list long enough that
            dragging to its end means dragging past a screen edge. The top is
            above every hour — unscheduled — and the bottom is the last hour's
            block.

            Each stops `pointerdown` from reaching the row. The row is the drag
            handle and 6px of slack is not enough for a thumb, so without this a
            sloppy tap on a button is read as the start of a drag instead. */}
        <span className="day-row-move">
          <button
            type="button"
            className="btn btn--icon"
            aria-label={toTop}
            title={toTop}
            {...holdStill}
            onClick={onMoveToTop}
          >
            <span aria-hidden="true">⤒</span>
          </button>
          <button
            type="button"
            className="btn btn--icon"
            aria-label={toBottom}
            title={toBottom}
            {...holdStill}
            onClick={onMoveToBottom}
          >
            <span aria-hidden="true">⤓</span>
          </button>
        </span>
      </div>
    </li>
  )
}

const HOURS = Array.from({ length: 24 }, (_, h) => h)

/**
 * A divider, while the day is being arranged: dragged like a row, re-timed with
 * a native `<select>` — the phone's own wheel, and a keyboard can drive it — and
 * taken out with a button, after which its tasks belong to the block above.
 */
function DragHour({
  item,
  onRetime,
  onRemove,
}: {
  item: Extract<ArrangeItem, { kind: 'hour' }>
  onRetime: (hour: number) => void
  onRemove: () => void
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: item.key,
  })
  const label = timeLabel(item.hour)
  const remove = `Remove the ${label} hour`

  return (
    <li
      ref={setNodeRef}
      className="day-hour day-hour--reordering"
      data-dragging={isDragging || undefined}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      {...attributes}
      {...listeners}
      aria-label={nameOf(item)}
    >
      <span className="day-row-grip" aria-hidden="true">
        ≡
      </span>
      <select
        className="day-hour-select"
        aria-label={`Time of the ${label} divider`}
        value={item.hour}
        {...holdStill}
        onChange={(e) => onRetime(Number(e.target.value))}
      >
        {HOURS.map((h) => (
          <option key={h} value={h}>
            {timeLabel(h)}
          </option>
        ))}
      </select>
      <button
        type="button"
        className="btn btn--icon day-hour-remove"
        aria-label={remove}
        title={remove}
        {...holdStill}
        onClick={onRemove}
      >
        <span aria-hidden="true">×</span>
      </button>
    </li>
  )
}
