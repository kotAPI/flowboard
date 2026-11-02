import type { Db } from "../lib/db.js";
import { tx } from "../lib/db.js";
import { badRequest, conflict, notFound, type ErrorDetail } from "../lib/errors.js";
import { newId } from "../lib/ids.js";
import { decodeCursor, encodeCursor, page } from "../lib/pagination.js";
import { between, needsRebalance, STEP } from "../lib/positions.js";
import { emit } from "./events.js";
import { resolvedFieldsFor, validateCustomValues, type CustomValues, type ResolvedField } from "./fields.js";
import { getChain, getNode, type Node } from "./hierarchy.js";
import type { User } from "./identity.js";
import { defaultStatus, resolvedStatusesFor, type ResolvedStatus } from "./statuses.js";

export const PRIORITIES = ["urgent", "high", "normal", "low", "none"] as const;
export type Priority = (typeof PRIORITIES)[number];
const PRIORITY_RANK: Record<Priority, number> = { urgent: 0, high: 1, normal: 2, low: 3, none: 4 };

export interface Task {
  id: string;
  listId: string;
  title: string;
  description: string | null;
  statusKey: string;
  priority: Priority;
  assigneeIds: string[];
  dueDate: string | null;
  customFields: CustomValues;
  position: number;
  version: number;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

const TASK_COLUMNS = `id, list_id AS "listId", title, description, status_key AS "statusKey", priority,
  assignee_ids AS "assigneeIds", due_date AS "dueDate", custom_fields AS "customFields", position, version,
  created_by AS "createdBy", created_at AS "createdAt", updated_at AS "updatedAt"`;

export async function getTask(db: Db, id: string, opts: { lock?: boolean } = {}): Promise<Task> {
  const { rows } = await db.query(
    `SELECT ${TASK_COLUMNS} FROM tasks WHERE id = $1 AND archived_at IS NULL ${opts.lock ? "FOR UPDATE" : ""}`,
    [id],
  );
  if (!rows[0]) throw notFound("Task");
  return rows[0];
}

function fail(details: ErrorDetail[]): never {
  throw badRequest("VALIDATION_ERROR", "The task payload is invalid", details);
}

function statusFor(statuses: ResolvedStatus[], key: string, path = "statusKey"): ResolvedStatus {
  const status = statuses.find((s) => s.key === key);
  if (!status) {
    throw badRequest("INVALID_STATUS", `'${key}' is not a status of this list`, [
      { path, message: `must be one of: ${statuses.map((s) => s.key).join(", ")}` },
    ]);
  }
  return status;
}

async function checkAssignees(db: Db, ids: string[] | undefined): Promise<void> {
  if (!ids?.length) return;
  const { rows } = await db.query("SELECT id FROM users WHERE id = ANY($1)", [ids]);
  const unknown = ids.filter((id) => !rows.some((r) => r.id === id));
  if (unknown.length) fail([{ path: "assigneeIds", message: `unknown users: ${unknown.join(", ")}` }]);
}

async function endOfColumn(db: Db, listId: string, statusKey: string): Promise<number> {
  const { rows } = await db.query(
    "SELECT max(position) AS max FROM tasks WHERE list_id = $1 AND status_key = $2 AND archived_at IS NULL",
    [listId, statusKey],
  );
  return (rows[0]?.max ?? 0) + STEP;
}

/** Position between two cards of the same column; renumbers the column if the gap is exhausted. */
async function positionBetween(
  db: Db,
  listId: string,
  statusKey: string,
  movingId: string,
  target: { beforeId?: string | null; afterId?: string | null },
): Promise<number> {
  if (!target.beforeId && !target.afterId) return endOfColumn(db, listId, statusKey);
  await db.query("SELECT id FROM tasks WHERE list_id = $1 AND status_key = $2 FOR UPDATE", [listId, statusKey]);
  const neighbour = async (id: string | null | undefined, path: string) => {
    if (!id) return null;
    if (id === movingId) fail([{ path, message: "cannot position a task relative to itself" }]);
    const t = await getTask(db, id).catch(() => null);
    if (!t || t.listId !== listId || t.statusKey !== statusKey) {
      fail([{ path, message: "must be a task in the destination column" }]);
    }
    return t.position;
  };
  const prev = await neighbour(target.afterId, "afterId");
  const next = await neighbour(target.beforeId, "beforeId");
  const adjacent = async (pivot: number, dir: "next" | "prev") => {
    const { rows } = await db.query(
      `SELECT position FROM tasks WHERE list_id = $1 AND status_key = $2 AND archived_at IS NULL AND id <> $3
         AND position ${dir === "next" ? ">" : "<"} $4 ORDER BY position ${dir === "next" ? "ASC" : "DESC"} LIMIT 1`,
      [listId, statusKey, movingId, pivot],
    );
    return (rows[0]?.position as number | undefined) ?? null;
  };
  const lo = prev ?? (next !== null ? await adjacent(next, "prev") : null);
  const hi = next ?? (prev !== null ? await adjacent(prev, "next") : null);
  if (needsRebalance(lo, hi)) {
    await db.query(
      `UPDATE tasks t SET position = r.rn * ${STEP} FROM
         (SELECT id, row_number() OVER (ORDER BY position, id) AS rn FROM tasks
          WHERE list_id = $1 AND status_key = $2 AND archived_at IS NULL) r
       WHERE t.id = r.id`,
      [listId, statusKey],
    );
    return positionBetween(db, listId, statusKey, movingId, target);
  }
  return between(lo, hi);
}

function checkVersion(task: Task, expected: number | undefined) {
  if (expected !== undefined && expected !== task.version) {
    throw conflict("VERSION_CONFLICT", "The task was changed by someone else; reload and retry", [
      { path: "version", message: `expected ${expected}, current is ${task.version}`, currentVersion: task.version },
    ]);
  }
}

function eventView(task: Task, statuses: ResolvedStatus[]) {
  const status = statuses.find((s) => s.key === task.statusKey);
  return { id: task.id, title: task.title, listId: task.listId, statusKey: task.statusKey, statusName: status?.name, version: task.version };
}

// ---------------------------------------------------------------------------------------------

export interface CreateTaskInput {
  title: string;
  description?: string | null;
  statusKey?: string;
  priority?: Priority;
  assigneeIds?: string[];
  dueDate?: string | null;
  customFields?: CustomValues;
}

export async function createTask(db: Db, actor: User, listId: string, input: CreateTaskInput): Promise<Task> {
  return tx(db, async (c) => {
    const chain = await getChain(c, listId);
    const statuses = await resolvedStatusesFor(c, listId, chain);
    const schema = await resolvedFieldsFor(c, listId, chain);
    const status = input.statusKey ? statusFor(statuses, input.statusKey) : defaultStatus(statuses);
    const cf = validateCustomValues(schema, input.customFields, { requireAll: true });
    if (cf.errors.length) fail(cf.errors);
    await checkAssignees(c, input.assigneeIds);
    const priority = input.priority ?? "none";
    const { rows } = await c.query(
      `INSERT INTO tasks (id, list_id, title, description, status_key, priority, priority_rank, assignee_ids, due_date,
         custom_fields, position, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING ${TASK_COLUMNS}`,
      [
        newId("tsk"), listId, input.title, input.description ?? null, status.key, priority, PRIORITY_RANK[priority],
        input.assigneeIds ?? [], input.dueDate ?? null, JSON.stringify(cf.values), await endOfColumn(c, listId, status.key), actor.id,
      ],
    );
    const task = rows[0] as Task;
    await emit(c, "task.created", task.id, { actor: { id: actor.id, name: actor.name }, task: eventView(task, statuses) });
    return task;
  });
}

export interface UpdateTaskInput {
  title?: string;
  description?: string | null;
  statusKey?: string;
  priority?: Priority;
  assigneeIds?: string[];
  dueDate?: string | null;
  customFields?: CustomValues;
  version?: number;
}

/**
 * Partial update. `customFields` is a patch (keys merge, null clears). A status change moves the
 * card to the end of the new column; use POST /tasks/:id/move to drop it at a specific spot.
 */
export async function updateTask(db: Db, actor: User, id: string, input: UpdateTaskInput): Promise<Task> {
  return tx(db, async (c) => {
    const task = await getTask(c, id, { lock: true });
    checkVersion(task, input.version);
    const chain = await getChain(c, task.listId);
    const statuses = await resolvedStatusesFor(c, task.listId, chain);
    const errors: ErrorDetail[] = [];
    let statusKey = task.statusKey;
    let position = task.position;
    if (input.statusKey !== undefined && input.statusKey !== task.statusKey) {
      statusKey = statusFor(statuses, input.statusKey).key;
      position = await endOfColumn(c, task.listId, statusKey);
    }
    let customFields = task.customFields;
    if (input.customFields !== undefined) {
      const cf = validateCustomValues(await resolvedFieldsFor(c, task.listId, chain), input.customFields, {
        existing: task.customFields,
        requireAll: false,
      });
      errors.push(...cf.errors);
      customFields = cf.values;
    }
    if (errors.length) fail(errors);
    await checkAssignees(c, input.assigneeIds);
    const priority = input.priority ?? task.priority;
    const { rows } = await c.query(
      `UPDATE tasks SET title = $2, description = $3, status_key = $4, priority = $5, priority_rank = $6,
         assignee_ids = $7, due_date = $8, custom_fields = $9, position = $10, version = version + 1, updated_at = now()
       WHERE id = $1 RETURNING ${TASK_COLUMNS}`,
      [
        id, input.title ?? task.title, input.description !== undefined ? input.description : task.description, statusKey,
        priority, PRIORITY_RANK[priority], input.assigneeIds ?? task.assigneeIds,
        input.dueDate !== undefined ? input.dueDate : task.dueDate, JSON.stringify(customFields), position,
      ],
    );
    const updated = rows[0] as Task;
    const changed = diffTask(task, updated);
    await emit(c, statusKey !== task.statusKey ? "task.status_changed" : "task.updated", id, {
      actor: { id: actor.id, name: actor.name },
      task: eventView(updated, statuses),
      changes: changed,
      from: statusKey !== task.statusKey ? { statusKey: task.statusKey, statusName: statuses.find((s) => s.key === task.statusKey)?.name } : undefined,
    });
    return updated;
  });
}

/** Which fields actually changed (so the feed and webhooks don't report no-op writes). */
function diffTask(before: Task, after: Task): string[] {
  const out: string[] = [];
  for (const k of ["title", "description", "statusKey", "priority", "dueDate"] as const) {
    if (before[k] !== after[k]) out.push(k);
  }
  if (JSON.stringify(before.assigneeIds) !== JSON.stringify(after.assigneeIds)) out.push("assigneeIds");
  for (const k of new Set([...Object.keys(before.customFields), ...Object.keys(after.customFields)])) {
    if (JSON.stringify(before.customFields[k]) !== JSON.stringify(after.customFields[k])) out.push(`customFields.${k}`);
  }
  return out;
}

export interface MoveTaskInput {
  listId?: string;
  statusKey?: string;
  beforeId?: string | null;
  afterId?: string | null;
  customFields?: CustomValues;
  /** what to do when the task's status doesn't exist in the destination list */
  onMissingStatus?: "map_default" | "reject";
  version?: number;
}

export interface MoveResult {
  task: Task;
  statusMapped: { from: string; to: string } | null;
  droppedFields: string[];
}

/**
 * The single "drag" operation: change list and/or column and/or position.
 *
 * Cross-list policy (status): keep the status if the destination has the same key; otherwise use
 * `statusKey` from the payload if given; otherwise map to the destination's default (first
 * not_started) status, or reject with 409 STATUS_NOT_IN_LIST when onMissingStatus = "reject".
 *
 * Cross-list policy (custom fields): values are re-validated against the destination schema;
 * values for fields the destination doesn't have are dropped (reported in `droppedFields`); a
 * required destination field with no value is a 400 unless the move payload supplies it.
 */
export async function moveTask(db: Db, actor: User, id: string, input: MoveTaskInput): Promise<MoveResult> {
  return tx(db, async (c) => {
    const task = await getTask(c, id, { lock: true });
    checkVersion(task, input.version);
    const destId = input.listId ?? task.listId;
    const crossList = destId !== task.listId;
    const destChain = crossList ? await getChain(c, (await getNode(c, destId, "list")).id) : await getChain(c, task.listId);
    const statuses = await resolvedStatusesFor(c, destId, destChain);

    let statusKey: string;
    let statusMapped: MoveResult["statusMapped"] = null;
    if (input.statusKey) {
      statusKey = statusFor(statuses, input.statusKey).key;
    } else if (statuses.some((s) => s.key === task.statusKey)) {
      statusKey = task.statusKey;
    } else if (input.onMissingStatus === "reject") {
      throw conflict("STATUS_NOT_IN_LIST", `The destination list has no '${task.statusKey}' status; pass statusKey`, [
        { path: "statusKey", message: `choose one of: ${statuses.map((s) => s.key).join(", ")}` },
      ]);
    } else {
      statusKey = defaultStatus(statuses).key;
      statusMapped = { from: task.statusKey, to: statusKey };
    }

    let customFields = task.customFields;
    let droppedFields: string[] = [];
    if (crossList || input.customFields) {
      const schema: ResolvedField[] = await resolvedFieldsFor(c, destId, destChain);
      const cf = validateCustomValues(schema, input.customFields, { existing: task.customFields, requireAll: crossList });
      if (cf.errors.length) fail(cf.errors);
      customFields = cf.values;
      droppedFields = cf.dropped;
    }

    const position = await positionBetween(c, destId, statusKey, id, input);
    const { rows } = await c.query(
      `UPDATE tasks SET list_id = $2, status_key = $3, position = $4, custom_fields = $5, version = version + 1, updated_at = now()
       WHERE id = $1 RETURNING ${TASK_COLUMNS}`,
      [id, destId, statusKey, position, JSON.stringify(customFields)],
    );
    const moved = rows[0] as Task;
    const type = crossList ? "task.moved" : statusKey !== task.statusKey ? "task.status_changed" : "task.reordered";
    await emit(c, type, id, {
      actor: { id: actor.id, name: actor.name },
      task: eventView(moved, statuses),
      from: { listId: task.listId, statusKey: task.statusKey },
      statusMapped,
      droppedFields,
    });
    return { task: moved, statusMapped, droppedFields };
  });
}

export async function deleteTask(db: Db, actor: User, id: string): Promise<void> {
  await tx(db, async (c) => {
    const task = await getTask(c, id, { lock: true });
    await c.query("UPDATE tasks SET archived_at = now(), updated_at = now() WHERE id = $1", [id]);
    await emit(c, "task.deleted", id, { actor: { id: actor.id, name: actor.name }, task: { id, title: task.title, listId: task.listId } });
  });
}

// ---------------------------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------------------------

export const TASK_SORTS = ["position", "dueDate", "priority", "createdAt"] as const;
export type TaskSort = (typeof TASK_SORTS)[number];

export interface ListTasksQuery {
  limit: number;
  cursor?: string;
  sort: TaskSort;
  order: "asc" | "desc";
  statusKey?: string;
  assigneeId?: string;
  /** custom-field equality filters, key -> raw query string value */
  cf?: Record<string, string>;
}

/** Sort expression + the value of that expression for a task (for the keyset cursor). */
function sortSpec(sort: TaskSort, order: "asc" | "desc"): { expr: string; valueOf: (t: Task & { priorityRank?: number }) => unknown } {
  switch (sort) {
    case "dueDate": {
      // nulls always last regardless of direction
      const sentinel = order === "asc" ? "infinity" : "-infinity";
      return { expr: `COALESCE(due_date, '${sentinel}'::timestamptz)`, valueOf: (t) => t.dueDate ?? sentinel };
    }
    case "priority":
      return { expr: "priority_rank", valueOf: (t) => PRIORITY_RANK[t.priority] };
    case "createdAt":
      return { expr: "created_at", valueOf: (t) => t.createdAt };
    default:
      return { expr: "position", valueOf: (t) => t.position };
  }
}

/** Translate `cf.<key>=<value>` query params into JSONB containment (served by the GIN index). */
function customFieldFilter(schema: ResolvedField[], key: string, raw: string): Record<string, unknown> {
  const field = schema.find((f) => f.key === key);
  if (!field) throw badRequest("INVALID_FILTER", `'${key}' is not a field of this list`, [{ path: `cf.${key}`, message: "unknown field" }]);
  switch (field.type) {
    case "number": {
      const n = Number(raw);
      if (!Number.isFinite(n)) throw badRequest("INVALID_FILTER", "expected a number", [{ path: `cf.${key}`, message: "expected a number" }]);
      return { [key]: n };
    }
    case "checkbox":
      return { [key]: raw === "true" };
    case "multi_select":
      return { [key]: [raw] };
    default:
      return { [key]: raw };
  }
}

export async function listTasks(db: Db, listId: string, q: ListTasksQuery) {
  const spec = sortSpec(q.sort, q.order);
  const params: unknown[] = [listId];
  const where = ["list_id = $1", "archived_at IS NULL"];
  if (q.statusKey) {
    params.push(q.statusKey);
    where.push(`status_key = $${params.length}`);
  }
  if (q.assigneeId) {
    params.push(q.assigneeId);
    where.push(`$${params.length} = ANY(assignee_ids)`);
  }
  if (q.cf && Object.keys(q.cf).length) {
    const schema = await resolvedFieldsFor(db, listId);
    for (const [key, raw] of Object.entries(q.cf)) {
      params.push(JSON.stringify(customFieldFilter(schema, key, raw)));
      where.push(`custom_fields @> $${params.length}::jsonb`);
    }
  }
  if (q.cursor) {
    const [value, id] = decodeCursor(q.cursor);
    params.push(value, id);
    where.push(`(${spec.expr}, id) ${q.order === "asc" ? ">" : "<"} ($${params.length - 1}, $${params.length})`);
  }
  params.push(q.limit + 1);
  const dir = q.order === "asc" ? "ASC" : "DESC";
  const { rows } = await db.query(
    `SELECT ${TASK_COLUMNS} FROM tasks WHERE ${where.join(" AND ")} ORDER BY ${spec.expr} ${dir}, id ${dir} LIMIT $${params.length}`,
    params,
  );
  return page(rows as Task[], q.limit, (t) => encodeCursor(spec.valueOf(t), t.id));
}

const BOARD_LIMIT = 2000;

/**
 * Everything the board needs in one round trip: the list, its resolved columns and field schema,
 * and its tasks in column order. Columns come from the resolved set, never from raw parent configs.
 */
export async function getBoard(db: Db, list: Node, chain: Node[]) {
  const [statuses, fields] = await Promise.all([resolvedStatusesFor(db, list.id, chain), resolvedFieldsFor(db, list.id, chain)]);
  const { rows } = await db.query(
    `SELECT ${TASK_COLUMNS} FROM tasks WHERE list_id = $1 AND archived_at IS NULL ORDER BY position, id LIMIT $2`,
    [list.id, BOARD_LIMIT + 1],
  );
  const tasks = rows.slice(0, BOARD_LIMIT) as Task[];
  return {
    list,
    statuses,
    fields,
    columns: statuses.map((s) => ({ statusKey: s.key, taskIds: tasks.filter((t) => t.statusKey === s.key).map((t) => t.id) })),
    tasks,
    truncated: rows.length > BOARD_LIMIT,
  };
}
