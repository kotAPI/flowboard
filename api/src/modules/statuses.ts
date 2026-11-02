import type { Db } from "../lib/db.js";
import { tx } from "../lib/db.js";
import { badRequest, conflict, notFound, unprocessable, type ErrorDetail } from "../lib/errors.js";
import { newId } from "../lib/ids.js";
import { STEP } from "../lib/positions.js";
import { emit } from "./events.js";
import { descendantIds, getChain, getNode, subtreeListIds, type Node, type NodeType } from "./hierarchy.js";
import type { User } from "./identity.js";

export const STATUS_CATEGORIES = ["not_started", "active", "done", "closed"] as const;
export type StatusCategory = (typeof STATUS_CATEGORIES)[number];
/** Every resolved set must keep at least one status in each of these, or a board can't be worked. */
export const REQUIRED_CATEGORIES: StatusCategory[] = ["not_started", "active", "done"];

export interface StatusDef {
  id: string;
  ownerId: string;
  key: string;
  name: string | null;
  category: StatusCategory | null;
  color: string | null;
  position: number | null;
  hidden: boolean;
}

export interface ResolvedStatus {
  /** id of the most specific definition that shaped this status */
  id: string;
  key: string;
  name: string;
  category: StatusCategory;
  color: string;
  position: number;
  /** container that most recently defined/overrode this status */
  ownerType: NodeType;
  ownerId: string;
  /** container where the key was first introduced */
  originOwnerId: string;
  /** false when the queried container itself defines or overrides it */
  inherited: boolean;
}

/**
 * Resolution algorithm: "merge by key", walking root -> leaf.
 *
 *   resolved = {}
 *   for level in [workspace, space, folder, list]:
 *     for def in level.defs (by position):
 *       if def.hidden:        remove resolved[def.key]            (hide an inherited status)
 *       elif def.key in resolved: overwrite name/category/color/position (override)
 *       else:                 resolved[def.key] = def              (add)
 *   return resolved sorted by (position, depth of origin, key)
 *
 * A key hidden at one level can be re-added further down. Tasks store the stable `key`, so
 * renaming/recolouring/reordering at any level never touches task rows.
 */
export function resolveStatuses(levels: { node: Pick<Node, "id" | "type">; defs: StatusDef[] }[], targetId?: string): ResolvedStatus[] {
  const resolved = new Map<string, ResolvedStatus & { depth: number }>();
  const leafId = targetId ?? levels[levels.length - 1]?.node.id;
  levels.forEach(({ node, defs }, depth) => {
    const ordered = [...defs].sort((a, b) => (a.position ?? 0) - (b.position ?? 0) || a.key.localeCompare(b.key));
    for (const def of ordered) {
      if (def.hidden) {
        resolved.delete(def.key);
        continue;
      }
      const existing = resolved.get(def.key);
      resolved.set(def.key, {
        id: def.id,
        key: def.key,
        name: def.name!,
        category: def.category!,
        color: def.color!,
        position: def.position!,
        ownerType: node.type,
        ownerId: node.id,
        originOwnerId: existing?.originOwnerId ?? node.id,
        inherited: node.id !== leafId,
        depth: existing?.depth ?? depth,
      });
    }
  });
  return [...resolved.values()]
    .sort((a, b) => a.position - b.position || a.depth - b.depth || a.key.localeCompare(b.key))
    .map(({ depth: _depth, ...s }) => s);
}

export function missingCategories(statuses: Pick<ResolvedStatus, "category">[]): StatusCategory[] {
  return REQUIRED_CATEGORIES.filter((cat) => !statuses.some((s) => s.category === cat));
}

/** Default status for new tasks / remaps: the first not_started status in board order. */
export function defaultStatus(statuses: ResolvedStatus[]): ResolvedStatus {
  return statuses.find((s) => s.category === "not_started") ?? statuses[0]!;
}

const DEF_COLUMNS = `id, owner_id AS "ownerId", key, name, category, color, position, hidden`;

async function defsByOwner(db: Db, ownerIds: string[]): Promise<Map<string, StatusDef[]>> {
  const { rows } = await db.query(
    `SELECT ${DEF_COLUMNS} FROM status_defs WHERE owner_id = ANY($1) AND archived_at IS NULL`,
    [ownerIds],
  );
  const map = new Map<string, StatusDef[]>();
  for (const row of rows as StatusDef[]) map.set(row.ownerId, [...(map.get(row.ownerId) ?? []), row]);
  return map;
}

/** Resolved status set for any container (used by the board, validators and the config UI). */
export async function resolvedStatusesFor(db: Db, nodeId: string, chain?: Node[]): Promise<ResolvedStatus[]> {
  const nodes = chain ?? (await getChain(db, nodeId));
  const defs = await defsByOwner(db, nodes.map((n) => n.id));
  return resolveStatuses(nodes.map((node) => ({ node, defs: defs.get(node.id) ?? [] })), nodeId);
}

export async function localStatusDefs(db: Db, ownerId: string): Promise<StatusDef[]> {
  const { rows } = await db.query(
    `SELECT ${DEF_COLUMNS} FROM status_defs WHERE owner_id = $1 AND archived_at IS NULL ORDER BY position NULLS LAST, key`,
    [ownerId],
  );
  return rows;
}

async function getDef(db: Db, id: string): Promise<StatusDef> {
  const { rows } = await db.query(`SELECT ${DEF_COLUMNS} FROM status_defs WHERE id = $1 AND archived_at IS NULL`, [id]);
  if (!rows[0]) throw notFound("Status");
  return rows[0];
}

/** Resolved set the owner inherits from its parent (what a local def would override or hide). */
async function inheritedFor(db: Db, owner: Node): Promise<ResolvedStatus[]> {
  return owner.parentId ? resolvedStatusesFor(db, owner.parentId) : [];
}

/**
 * Every status config mutation runs through here so the "no orphaned board state" invariant holds:
 *
 *  1. snapshot the resolved set of every list under the owner;
 *  2. apply the mutation;
 *  3. re-resolve the owner and every container below it; each must still have a not_started,
 *     an active and a done status (422 STATUS_SET_INVALID otherwise);
 *  4. for each list, any key that dropped out of its resolved set and is still used by live tasks
 *     -> 409 STATUS_IN_USE, unless the caller passed `remapTo`, in which case those tasks are moved
 *     to that key (it must exist in the list's new set) in the same transaction.
 *
 * Everything is one transaction, so a rejected change leaves no trace.
 */
async function withStatusSafety<T>(
  db: Db,
  actor: User,
  ownerId: string,
  remapTo: string | undefined,
  mutate: (c: Db) => Promise<T>,
): Promise<T> {
  return tx(db, async (c) => {
    // Serialise config changes per owner so two admins can't race each other past the check.
    await c.query("SELECT id FROM nodes WHERE id = $1 FOR UPDATE", [ownerId]);
    const listIds = await subtreeListIds(c, ownerId);
    const before = new Map<string, Set<string>>();
    for (const id of listIds) before.set(id, new Set((await resolvedStatusesFor(c, id)).map((s) => s.key)));

    const result = await mutate(c);

    const invalid: ErrorDetail[] = [];
    for (const id of [ownerId, ...(await descendantIds(c, ownerId))]) {
      const missing = missingCategories(await resolvedStatusesFor(c, id));
      if (missing.length) invalid.push({ path: id, message: `would have no ${missing.join(", ")} status`, nodeId: id, missing });
    }
    if (invalid.length) {
      throw unprocessable("STATUS_SET_INVALID", "Every resolved status set needs at least one not_started, active and done status", invalid);
    }

    const inUse: ErrorDetail[] = [];
    const remapped: { listId: string; from: string; to: string; taskCount: number }[] = [];
    for (const listId of listIds) {
      const after = await resolvedStatusesFor(c, listId);
      const afterKeys = new Set(after.map((s) => s.key));
      const dropped = [...before.get(listId)!].filter((k) => !afterKeys.has(k));
      if (!dropped.length) continue;
      const { rows } = await c.query(
        `SELECT status_key, count(*)::int AS n FROM tasks
         WHERE list_id = $1 AND status_key = ANY($2) AND archived_at IS NULL GROUP BY status_key`,
        [listId, dropped],
      );
      for (const row of rows) {
        if (!remapTo) {
          inUse.push({ path: listId, message: `${row.n} task(s) in this list use status '${row.status_key}'`, listId, statusKey: row.status_key, taskCount: row.n });
        } else if (!afterKeys.has(remapTo)) {
          throw unprocessable("INVALID_REMAP", `remapTo '${remapTo}' is not a status of list ${listId} after this change`, [
            { path: "remapTo", message: "not in the resulting status set", listId },
          ]);
        } else {
          await c.query(
            `UPDATE tasks SET status_key = $3, version = version + 1, updated_at = now()
             WHERE list_id = $1 AND status_key = $2 AND archived_at IS NULL`,
            [listId, row.status_key, remapTo],
          );
          remapped.push({ listId, from: row.status_key, to: remapTo, taskCount: row.n });
        }
      }
    }
    if (inUse.length) {
      throw conflict("STATUS_IN_USE", "This change removes statuses that tasks still use. Pass remapTo=<statusKey> to move those tasks.", inUse);
    }
    await emit(c, "status_config.changed", ownerId, { actor: actor.id, remapped });
    return result;
  });
}

export interface StatusInput {
  key: string;
  name?: string;
  category?: StatusCategory;
  color?: string;
  position?: number;
  hidden?: boolean;
}

/**
 * Create a local definition on a container. Depending on the key it is:
 *  - an override (key is inherited): unspecified attributes are copied from the inherited status,
 *  - a hide row (`hidden: true`, key must be inherited),
 *  - a new status (key not inherited): name and category are required.
 */
export async function createStatus(db: Db, actor: User, ownerId: string, input: StatusInput, remapTo?: string): Promise<StatusDef> {
  return withStatusSafety(db, actor, ownerId, remapTo, async (c) => {
    const owner = await getNode(c, ownerId);
    const inherited = (await inheritedFor(c, owner)).find((s) => s.key === input.key);
    const local = await localStatusDefs(c, ownerId);
    if (local.some((d) => d.key === input.key)) {
      throw conflict("STATUS_KEY_EXISTS", `'${input.key}' is already defined on this container; update it instead`);
    }
    let row: Omit<StatusDef, "id" | "ownerId">;
    if (input.hidden) {
      if (!inherited) throw badRequest("NOTHING_TO_HIDE", `'${input.key}' is not inherited from a parent container`, [{ path: "key", message: "not inherited" }]);
      row = { key: input.key, name: null, category: null, color: null, position: null, hidden: true };
    } else if (inherited) {
      row = {
        key: input.key,
        name: input.name ?? inherited.name,
        category: input.category ?? inherited.category,
        color: input.color ?? inherited.color,
        position: input.position ?? inherited.position,
        hidden: false,
      };
    } else {
      const missing: ErrorDetail[] = [];
      if (!input.name) missing.push({ path: "name", message: "required for a new status" });
      if (!input.category) missing.push({ path: "category", message: "required for a new status" });
      if (missing.length) throw badRequest("VALIDATION_ERROR", "A new status needs a name and a category", missing);
      const all = await resolvedStatusesFor(c, ownerId);
      row = {
        key: input.key,
        name: input.name!,
        category: input.category!,
        color: input.color ?? "#94a3b8",
        position: input.position ?? (all.length ? Math.max(...all.map((s) => s.position)) + STEP : STEP),
        hidden: false,
      };
    }
    const { rows } = await c.query(
      `INSERT INTO status_defs (id, owner_id, key, name, category, color, position, hidden)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING ${DEF_COLUMNS}`,
      [newId("sts"), ownerId, row.key, row.name, row.category, row.color, row.position, row.hidden],
    );
    return rows[0];
  });
}

export async function updateStatus(
  db: Db,
  actor: User,
  id: string,
  patch: Partial<Pick<StatusDef, "name" | "category" | "color" | "position">>,
): Promise<StatusDef> {
  const def = await getDef(db, id);
  if (def.hidden) throw badRequest("INVALID_OPERATION", "A hide rule has no attributes; delete it to un-hide the status");
  return withStatusSafety(db, actor, def.ownerId, undefined, async (c) => {
    const { rows } = await c.query(
      `UPDATE status_defs SET name = COALESCE($2, name), category = COALESCE($3, category),
         color = COALESCE($4, color), position = COALESCE($5, position), updated_at = now()
       WHERE id = $1 RETURNING ${DEF_COLUMNS}`,
      [id, patch.name ?? null, patch.category ?? null, patch.color ?? null, patch.position ?? null],
    );
    return rows[0];
  });
}

/**
 * Remove a local definition (soft: archived_at). Effect on the resolved set:
 * an override reverts to the inherited status, a hide rule un-hides it, an added status disappears.
 * If that removes a key tasks still use, the safety check rejects unless `remapTo` is given.
 */
export async function deleteStatus(db: Db, actor: User, id: string, remapTo?: string): Promise<void> {
  const def = await getDef(db, id);
  await withStatusSafety(db, actor, def.ownerId, remapTo, async (c) => {
    await c.query("UPDATE status_defs SET archived_at = now(), updated_at = now() WHERE id = $1", [id]);
  });
}

/**
 * Reorder the resolved set of a container. Keys this container doesn't define yet get an override
 * row carrying the inherited attributes plus the new position, so the order only applies here
 * and below.
 */
export async function reorderStatuses(db: Db, actor: User, ownerId: string, keys: string[]): Promise<ResolvedStatus[]> {
  return withStatusSafety(db, actor, ownerId, undefined, async (c) => {
    const current = await resolvedStatusesFor(c, ownerId);
    const currentKeys = current.map((s) => s.key).sort();
    if (JSON.stringify([...keys].sort()) !== JSON.stringify(currentKeys)) {
      throw badRequest("VALIDATION_ERROR", "keys must be exactly the resolved status keys of this container", [
        { path: "keys", message: `expected a permutation of ${currentKeys.join(", ")}` },
      ]);
    }
    const local = new Map((await localStatusDefs(c, ownerId)).map((d) => [d.key, d]));
    for (const [i, key] of keys.entries()) {
      const position = (i + 1) * STEP;
      const def = local.get(key);
      if (def) {
        await c.query("UPDATE status_defs SET position = $2, updated_at = now() WHERE id = $1", [def.id, position]);
      } else {
        const s = current.find((x) => x.key === key)!;
        await c.query(
          `INSERT INTO status_defs (id, owner_id, key, name, category, color, position) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [newId("sts"), ownerId, key, s.name, s.category, s.color, position],
        );
      }
    }
    return resolvedStatusesFor(c, ownerId);
  });
}

export async function getStatusDefOwner(db: Db, id: string): Promise<string> {
  return (await getDef(db, id)).ownerId;
}
