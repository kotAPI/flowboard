import type { Db } from "../lib/db.js";
import { forbidden, notFound } from "../lib/errors.js";
import { getChain, getNode, type Node } from "./hierarchy.js";
import type { User } from "./identity.js";

export type GrantMode = "allow" | "deny";
export type Grants = Map<string, GrantMode>;

/**
 * What a caller wants to do with a container:
 *  - read:      see it and its tasks
 *  - write:     create/edit/move tasks in it (members: any list they can see)
 *  - configure: change containers, statuses, custom fields, grants (admins only in the MVP)
 */
export type Action = "read" | "write" | "configure";

export async function grantsFor(db: Db, userId: string): Promise<Grants> {
  const { rows } = await db.query("SELECT node_id, mode FROM grants WHERE user_id = $1", [userId]);
  return new Map(rows.map((r) => [r.node_id, r.mode]));
}

/**
 * Visibility rule, evaluated on every container from the space down to the target:
 *   1. an explicit `deny` grant hides the container (and so everything below it);
 *   2. a private container needs an explicit `allow` grant;
 *   3. a public container is visible.
 * A node is visible only if every container on its path is visible. Admins bypass all of it.
 * Pure function so the tree endpoint can evaluate the whole workspace with one grants query.
 */
export function canSee(user: User, chain: Pick<Node, "id" | "type" | "visibility">[], grants: Grants): boolean {
  if (user.role === "admin") return true;
  for (const node of chain) {
    if (node.type === "workspace") continue;
    const grant = grants.get(node.id);
    if (grant === "deny") return false;
    if (node.visibility === "private" && grant !== "allow") return false;
  }
  return true;
}

export function can(user: User, action: Action, chain: Node[], grants: Grants): boolean {
  if (user.role === "admin") return true;
  if (action === "configure") return false;
  return canSee(user, chain, grants);
}

/**
 * The single enforcement point every route goes through: 404 if the container doesn't exist
 * (or is archived), 403 if it exists but the caller may not perform `action` on it.
 */
export async function authorize(db: Db, user: User, nodeId: string, action: Action, type?: Node["type"]): Promise<Node[]> {
  await getNode(db, nodeId, type); // 404 first
  const chain = await getChain(db, nodeId);
  if (chain.some((n) => n.archivedAt)) throw notFound("Container"); // archived ancestor
  const grants = user.role === "admin" ? new Map() : await grantsFor(db, user.id);
  if (!can(user, action, chain, grants)) {
    throw action === "configure" && canSee(user, chain, grants)
      ? forbidden("Only workspace admins can change configuration")
      : forbidden();
  }
  return chain;
}

export async function listGrants(db: Db, nodeId: string) {
  const { rows } = await db.query(
    `SELECT id, node_id AS "resourceId", user_id AS "userId", mode, created_at AS "createdAt"
     FROM grants WHERE node_id = $1 ORDER BY user_id`,
    [nodeId],
  );
  return rows;
}
