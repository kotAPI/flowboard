import {
  closestCorners,
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { ApiError, post } from "../api";
import { keys } from "../hooks";
import type { Board, Task } from "../types";
import { Avatars, FieldValue, formatDate, isOverdue, PriorityBadge } from "./bits";

type Columns = Record<string, string[]>;
const COL = "col:";

function toColumns(board: Board): Columns {
  return Object.fromEntries(board.columns.map((c) => [c.statusKey, c.taskIds]));
}

function columnOf(cols: Columns, id: string): string | undefined {
  if (id.startsWith(COL)) return id.slice(COL.length);
  return Object.keys(cols).find((k) => cols[k]!.includes(id));
}

/**
 * Kanban board. Columns are the list's *resolved* statuses from the API. Dragging is optimistic:
 * the local column state updates immediately, the move is sent as { statusKey, afterId, beforeId },
 * and on failure (e.g. 409 version conflict, 403) the board rolls back and refetches.
 */
export function BoardView({ board, onOpen, onAdd }: { board: Board; onOpen: (id: string) => void; onAdd: (statusKey: string) => void }) {
  const qc = useQueryClient();
  const [cols, setCols] = useState<Columns>(() => toColumns(board));
  const [activeId, setActiveId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dragOrigin, setDragOrigin] = useState<Columns | null>(null);
  const tasks = useMemo(() => new Map(board.tasks.map((t) => [t.id, t])), [board.tasks]);
  const chipField = board.fields.find((f) => f.type === "single_select");

  // server data wins whenever it changes (after a mutation settles or a refetch)
  useEffect(() => {
    if (!activeId) setCols(toColumns(board));
  }, [board, activeId]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const move = useMutation({
    mutationFn: (v: { id: string; statusKey: string; afterId: string | null; beforeId: string | null; version: number }) =>
      post(`/v1/tasks/${v.id}/move`, { statusKey: v.statusKey, afterId: v.afterId, beforeId: v.beforeId, version: v.version }),
    onError: (err, _v) => {
      setError(err instanceof ApiError && err.body.code === "VERSION_CONFLICT" ? "Someone else changed that task. The board was refreshed." : `Move failed: ${(err as Error).message}`);
      if (dragOrigin) setCols(dragOrigin);
    },
    onSettled: () => qc.invalidateQueries({ queryKey: keys.board(board.list.id) }),
  });

  const onDragStart = (e: DragStartEvent) => {
    setError(null);
    setActiveId(String(e.active.id));
    setDragOrigin(cols);
  };

  // moving across columns while dragging, so the drop target shows the card in place
  const onDragOver = ({ active, over }: DragOverEvent) => {
    if (!over) return;
    const from = columnOf(cols, String(active.id));
    const to = columnOf(cols, String(over.id));
    if (!from || !to || from === to) return;
    setCols((prev) => {
      const target = [...prev[to]!];
      const overIndex = String(over.id).startsWith(COL) ? target.length : target.indexOf(String(over.id));
      target.splice(overIndex < 0 ? target.length : overIndex, 0, String(active.id));
      return { ...prev, [from]: prev[from]!.filter((x) => x !== active.id), [to]: target };
    });
  };

  const onDragEnd = ({ active, over }: DragEndEvent) => {
    const id = String(active.id);
    setActiveId(null);
    if (!over) {
      if (dragOrigin) setCols(dragOrigin);
      return;
    }
    const col = columnOf(cols, id)!;
    let list = cols[col]!;
    const overId = String(over.id);
    if (!overId.startsWith(COL) && overId !== id && list.includes(overId)) {
      // reorder within the (possibly new) column
      const fromIdx = list.indexOf(id);
      const toIdx = list.indexOf(overId);
      list = [...list];
      list.splice(fromIdx, 1);
      list.splice(toIdx, 0, id);
    }
    const idx = list.indexOf(id);
    const originCol = dragOrigin ? columnOf(dragOrigin, id) : col;
    const unchanged = originCol === col && dragOrigin?.[col]?.indexOf(id) === idx;
    setCols((prev) => ({ ...prev, [col]: list }));
    if (unchanged) return;
    const task = tasks.get(id)!;
    move.mutate({ id, statusKey: col, afterId: list[idx - 1] ?? null, beforeId: list[idx + 1] ?? null, version: task.version });
  };

  return (
    <>
      {error && <div className="toast error" role="alert" onClick={() => setError(null)}>{error}</div>}
      {board.truncated && <div className="toast">This list has more tasks than the board shows; use the List view to page through all of them.</div>}
      <DndContext sensors={sensors} collisionDetection={closestCorners} onDragStart={onDragStart} onDragOver={onDragOver} onDragEnd={onDragEnd}>
        <div className="board">
          {board.statuses.map((s) => (
            <Column key={s.key} id={s.key} title={s.name} color={s.color} count={cols[s.key]?.length ?? 0} onAdd={() => onAdd(s.key)}>
              <SortableContext items={cols[s.key] ?? []} strategy={verticalListSortingStrategy}>
                {(cols[s.key] ?? []).map((tid) => {
                  const t = tasks.get(tid);
                  return t ? <SortableCard key={tid} task={t} chip={chipField && <FieldValue field={chipField} value={t.customFields[chipField.key]} />} onOpen={onOpen} /> : null;
                })}
              </SortableContext>
            </Column>
          ))}
        </div>
        <DragOverlay>{activeId && tasks.get(activeId) ? <Card task={tasks.get(activeId)!} dragging /> : null}</DragOverlay>
      </DndContext>
    </>
  );
}

function Column({ id, title, color, count, onAdd, children }: { id: string; title: string; color: string; count: number; onAdd: () => void; children: React.ReactNode }) {
  const { setNodeRef, isOver } = useDroppable({ id: `${COL}${id}` });
  return (
    <section className={`column ${isOver ? "over" : ""}`} aria-label={title} data-testid={`column-${id}`}>
      <header className="column-head">
        <span className="dot" style={{ background: color }} />
        <h2>{title}</h2>
        <span className="count">{count}</span>
        <button className="icon-btn" aria-label={`Add task to ${title}`} onClick={onAdd}>+</button>
      </header>
      <div ref={setNodeRef} className="column-body">{children}</div>
    </section>
  );
}

function SortableCard({ task, chip, onOpen }: { task: Task; chip?: React.ReactNode; onOpen: (id: string) => void }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: task.id });
  return (
    <div ref={setNodeRef} style={{ transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.35 : 1 }} {...attributes} {...listeners}>
      <Card task={task} chip={chip} onOpen={onOpen} />
    </div>
  );
}

function Card({ task, chip, onOpen, dragging }: { task: Task; chip?: React.ReactNode; onOpen?: (id: string) => void; dragging?: boolean }) {
  return (
    <article className={`card ${dragging ? "dragging" : ""}`} onClick={() => onOpen?.(task.id)} onKeyDown={(e) => e.key === "Enter" && onOpen?.(task.id)}>
      <div className="card-title">{task.title}</div>
      <div className="card-meta">
        <PriorityBadge priority={task.priority} />
        {chip}
        {task.dueDate && <span className={`due ${isOverdue(task.dueDate) ? "overdue" : ""}`}>{formatDate(task.dueDate)}</span>}
        <span className="spacer" />
        <Avatars ids={task.assigneeIds} />
      </div>
    </article>
  );
}
