import type { Db } from "../lib/db.js";
import type { DomainEvent } from "./events.js";

interface TaskEventPayload {
  actor?: { id: string; name: string };
  task?: { id: string; title: string; listId: string; statusName?: string };
  from?: { listId?: string; statusKey?: string; statusName?: string };
  changes?: string[];
  statusMapped?: { from: string; to: string } | null;
}

/** Human-readable line for the activity feed. Only task events are projected; others are skipped. */
export function summarise(event: Pick<DomainEvent<TaskEventPayload>, "type" | "payload">): string | null {
  const { actor, task, changes, statusMapped } = event.payload;
  const who = actor?.name ?? "Someone";
  const what = task ? `"${task.title}"` : "a task";
  switch (event.type) {
    case "task.created":
      return `${who} created ${what}`;
    case "task.status_changed":
      return `${who} moved ${what} to ${task?.statusName ?? "a new status"}`;
    case "task.moved":
      return `${who} moved ${what} to another list${statusMapped ? ` (status mapped to ${task?.statusName})` : ""}`;
    case "task.updated":
      return `${who} updated ${changes?.length ? changes.join(", ") : "details"} on ${what}`;
    case "task.reordered":
      return null; // too noisy for a feed
    case "task.deleted":
      return `${who} deleted ${what}`;
    default:
      return null;
  }
}

/**
 * Project one event into the activity table. Idempotent: event_id is UNIQUE, so a redelivered
 * event (worker crashed after insert but before marking processed) is a no-op.
 */
export async function projectActivity(db: Db, event: DomainEvent<TaskEventPayload>): Promise<void> {
  const summary = summarise(event);
  if (!summary) return;
  await db.query(
    `INSERT INTO activity (event_id, task_id, list_id, actor_id, type, summary, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (event_id) DO NOTHING`,
    [event.eventId, event.payload.task?.id ?? event.aggregateId, event.payload.task?.listId ?? null, event.payload.actor?.id ?? null, event.type, summary, event.occurredAt],
  );
}

export async function activityFor(db: Db, by: { taskId?: string; listId?: string }, limit: number) {
  const { rows } = await db.query(
    `SELECT id, event_id AS "eventId", task_id AS "taskId", list_id AS "listId", actor_id AS "actorId", type, summary,
       created_at AS "createdAt"
     FROM activity WHERE ${by.taskId ? "task_id = $1" : "list_id = $1"} ORDER BY id DESC LIMIT $2`,
    [by.taskId ?? by.listId, limit],
  );
  return rows;
}
