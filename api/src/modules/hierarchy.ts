import type { Db } from "../lib/db.js";
import { tx } from "../lib/db.js";
import { badRequest, notFound } from "../lib/errors.js";
import { newId, PREFIX } from "../lib/ids.js";
import { between, needsRebalance, STEP } from "../lib/positions.js";
import { emit } from "./events.js";
import type { User } from "./identity.js";

export type NodeType = "workspace" | "space" | "folder" | "list";
export type Visibility = "public" | "private";

export interface Node {
  id: string;
  type: NodeType;
  parentId: string | null;
  name: string;
  position: number;
  visibility: Visibility;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** The only legal parent type for each container type. Lists hold tasks, never containers. */
export const PARENT_TYPE: Record<Exclude<NodeType, "workspace">, NodeType> = {
  space: "workspace",
  folder: "space",
  list: "folder",
};
export const CHILD_TYPE: Partial<Record<NodeType, NodeType>> = { workspace: "space", space: "folder", folder: "list" };

const NODE_COLUMNS = `id, type, parent_id AS "parentId", name, position, visibility,
  archived_at AS "archivedAt", created_at AS "createdAt", updated_at AS "updatedAt"`;

export async function getWorkspace(db: Db): Promise<Node> {
  const { rows } = await db.query(`SELECT ${NODE_COLUMNS} FROM nodes WHERE type = 'workspace' LIMIT 1`);
  if (!rows[0]) throw notFound("Workspace");
  return rows[0];
}

/** Live node by id, optionally asserting its type. Archived nodes are 404. */
export async function getNode(db: Db, id: string, type?: NodeType): Promise<Node> {
  const { rows } = await db.query(`SELECT ${NODE_COLUMNS} FROM nodes WHERE id = $1 AND archived_at IS NULL`, [id]);
  const node = rows[0] as Node | undefined;
  if (!node || (type && node.type !== type)) throw notFound(type ? capitalize(type) : "Container");
  return node;
}

/** Ancestors from the workspace down to and including `id` (root first). */
export async function getChain(db: Db, id: string): Promise<Node[]> {
  const { rows } = await db.query(
    `WITH RECURSIVE chain AS (
       SELECT n.*, 0 AS depth FROM nodes n WHERE n.id = $1
       UNION ALL
       SELECT p.*, c.depth + 1 FROM nodes p JOIN chain c ON p.id = c.parent_id
     )
     SELECT ${NODE_COLUMNS} FROM chain ORDER BY depth DESC`,
    [id],
  );
  return rows;
}

/** Ids of every list at or below `id` (archived included: their tasks still reference statuses). */
export async function subtreeListIds(db: Db, id: string): Promise<string[]> {
  const { rows } = await db.query(
    `WITH RECURSIVE sub AS (
       SELECT id, type FROM nodes WHERE id = $1
       UNION ALL
       SELECT n.id, n.type FROM nodes n JOIN sub s ON n.parent_id = s.id
     )
     SELECT id FROM sub WHERE type = 'list'`,
    [id],
  );
  return rows.map((r) => r.id);
}

/** Ids of every container strictly below `id`. */
export async function descendantIds(db: Db, id: string): Promise<string[]> {
  const { rows } = await db.query(
    `WITH RECURSIVE sub AS (
       SELECT id FROM nodes WHERE parent_id = $1
       UNION ALL
       SELECT n.id FROM nodes n JOIN sub s ON n.parent_id = s.id
     )
     SELECT id FROM sub`,
    [id],
  );
  return rows.map((r) => r.id);
}

export async function allLiveNodes(db: Db): Promise<Node[]> {
  const { rows } = await db.query(`SELECT ${NODE_COLUMNS} FROM nodes WHERE archived_at IS NULL ORDER BY position, id`);
  return rows;
}

export async function listChildren(db: Db, parentId: string, limit: number, after?: [number, string]): Promise<Node[]> {
  const params: unknown[] = [parentId, limit + 1];
  let keyset = "";
  if (after) {
    params.push(after[0], after[1]);
    keyset = "AND (position, id) > ($3, $4)";
  }
  const { rows } = await db.query(
    `SELECT ${NODE_COLUMNS} FROM nodes WHERE parent_id = $1 AND archived_at IS NULL ${keyset}
     ORDER BY position, id LIMIT $2`,
    params,
  );
  return rows;
}

export async function createNode(
  db: Db,
  actor: User,
  input: { type: Exclude<NodeType, "workspace">; parentId: string; name: string; visibility?: Visibility },
): Promise<Node> {
  return tx(db, async (c) => {
    const parent = await getNode(c, input.parentId);
    if (parent.type !== PARENT_TYPE[input.type]) {
      throw badRequest("INVALID_PARENT", `A ${input.type} must be created inside a ${PARENT_TYPE[input.type]}, not a ${parent.type}`);
    }
    const { rows: last } = await c.query(
      "SELECT max(position) AS max FROM nodes WHERE parent_id = $1 AND archived_at IS NULL",
      [parent.id],
    );
    const position = (last[0]?.max ?? 0) + STEP;
    const { rows } = await c.query(
      `INSERT INTO nodes (id, type, parent_id, name, position, visibility)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING ${NODE_COLUMNS}`,
      [newId(PREFIX[input.type]), input.type, parent.id, input.name, position, input.visibility ?? "public"],
    );
    const node = rows[0] as Node;
    await emit(c, `${input.type}.created`, node.id, { actor: actor.id, node });
    return node;
  });
}

export async function updateNode(db: Db, actor: User, id: string, patch: { name?: string; visibility?: Visibility }): Promise<Node> {
  return tx(db, async (c) => {
    const node = await getNode(c, id);
    if (node.type === "workspace" && patch.visibility) {
      throw badRequest("INVALID_FIELD", "The workspace has no visibility setting");
    }
    const { rows } = await c.query(
      `UPDATE nodes SET name = COALESCE($2, name), visibility = COALESCE($3, visibility), updated_at = now()
       WHERE id = $1 RETURNING ${NODE_COLUMNS}`,
      [id, patch.name ?? null, patch.visibility ?? null],
    );
    await emit(c, `${node.type}.updated`, id, { actor: actor.id, patch });
    return rows[0];
  });
}

/**
 * Soft delete: the container and everything under it get archived_at, and their tasks too.
 * Nothing is physically removed, so an "undo"/restore endpoint can be added without data loss.
 */
export async function archiveNode(db: Db, actor: User, id: string): Promise<void> {
  await tx(db, async (c) => {
    const node = await getNode(c, id);
    if (node.type === "workspace") throw badRequest("INVALID_OPERATION", "The workspace cannot be deleted");
    const ids = [id, ...(await descendantIds(c, id))];
    await c.query("UPDATE nodes SET archived_at = now(), updated_at = now() WHERE id = ANY($1) AND archived_at IS NULL", [ids]);
    await c.query("UPDATE tasks SET archived_at = now(), updated_at = now() WHERE list_id = ANY($1) AND archived_at IS NULL", [ids]);
    await emit(c, `${node.type}.archived`, id, { actor: actor.id, archivedIds: ids });
  });
}

/**
 * Reorder among siblings. Re-parenting is deliberately not supported in the MVP: moving a list to
 * another folder changes its resolved statuses and field schema, which needs the same
 * validate-and-remap flow as a status deletion (see README, "Trade-offs").
 */
export async function reorderNode(
  db: Db,
  actor: User,
  id: string,
  target: { beforeId?: string | null; afterId?: string | null },
): Promise<Node> {
  return tx(db, async (c) => {
    const node = await getNode(c, id);
    if (!node.parentId) throw badRequest("INVALID_OPERATION", "The workspace cannot be reordered");
    // lock the sibling set so concurrent reorders serialise
    await c.query("SELECT id FROM nodes WHERE parent_id = $1 FOR UPDATE", [node.parentId]);
    const neighbour = async (nid: string | null | undefined) => {
      if (!nid) return null;
      const n = await getNode(c, nid);
      if (n.parentId !== node.parentId || n.id === node.id) {
        throw badRequest("INVALID_POSITION", "beforeId/afterId must be a different sibling of the same parent");
      }
      return n.position;
    };
    // "afterId" = the sibling this node should come after; "beforeId" = the sibling it should come before.
    let prev = await neighbour(target.afterId);
    let next = await neighbour(target.beforeId);
    if (prev === null && next === null) throw badRequest("INVALID_POSITION", "Provide beforeId or afterId");
    if (prev !== null && next === null) next = await siblingPosition(c, node.parentId, prev, "next", id);
    if (next !== null && prev === null) prev = await siblingPosition(c, node.parentId, next, "prev", id);
    if (needsRebalance(prev, next)) {
      await c.query(
        `UPDATE nodes n SET position = r.rn * ${STEP} FROM
           (SELECT id, row_number() OVER (ORDER BY position, id) AS rn FROM nodes WHERE parent_id = $1) r
         WHERE n.id = r.id`,
        [node.parentId],
      );
      return reorderNode(c, actor, id, target);
    }
    const { rows } = await c.query(
      `UPDATE nodes SET position = $2, updated_at = now() WHERE id = $1 RETURNING ${NODE_COLUMNS}`,
      [id, between(prev, next)],
    );
    await emit(c, `${node.type}.reordered`, id, { actor: actor.id });
    return rows[0];
  });
}

async function siblingPosition(db: Db, parentId: string, pivot: number, dir: "next" | "prev", exclude: string) {
  const { rows } = await db.query(
    dir === "next"
      ? "SELECT position FROM nodes WHERE parent_id = $1 AND archived_at IS NULL AND position > $2 AND id <> $3 ORDER BY position LIMIT 1"
      : "SELECT position FROM nodes WHERE parent_id = $1 AND archived_at IS NULL AND position < $2 AND id <> $3 ORDER BY position DESC LIMIT 1",
    [parentId, pivot, exclude],
  );
  return (rows[0]?.position as number | undefined) ?? null;
}

function capitalize(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
