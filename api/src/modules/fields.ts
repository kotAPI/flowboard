import type { Db } from "../lib/db.js";
import { tx } from "../lib/db.js";
import { badRequest, conflict, notFound, type ErrorDetail } from "../lib/errors.js";
import { newId } from "../lib/ids.js";
import { STEP } from "../lib/positions.js";
import { emit } from "./events.js";
import { descendantIds, getChain, getNode, subtreeListIds, type Node, type NodeType } from "./hierarchy.js";
import type { User } from "./identity.js";

export const FIELD_TYPES = ["text", "number", "single_select", "multi_select", "date", "checkbox"] as const;
export type FieldType = (typeof FIELD_TYPES)[number];
const SELECT_TYPES: FieldType[] = ["single_select", "multi_select"];
export const FIELD_OWNER_TYPES: NodeType[] = ["space", "folder", "list"];
const MAX_TEXT = 10_000;

export interface FieldOption {
  id: string;
  label: string;
  color?: string;
}

export interface FieldDef {
  id: string;
  ownerId: string;
  key: string;
  name: string;
  type: FieldType;
  required: boolean;
  options: FieldOption[];
  position: number;
}

export interface ResolvedField extends FieldDef {
  ownerType: NodeType;
  inherited: boolean;
}

export type CustomValues = Record<string, unknown>;

/**
 * Resolution: the schema of a container is the union of the definitions on its ancestors and itself,
 * ordered by depth (space fields first) then position. Keys are unique along any root-to-leaf path:
 * creating a field whose key exists above or below the owner is rejected with 409 FIELD_KEY_CONFLICT,
 * so there is never an override/shadowing question and a payload key always means one definition.
 */
export function resolveFields(levels: { node: Pick<Node, "id" | "type">; defs: FieldDef[] }[], targetId?: string): ResolvedField[] {
  const leafId = targetId ?? levels[levels.length - 1]?.node.id;
  const out: ResolvedField[] = [];
  for (const { node, defs } of levels) {
    for (const def of [...defs].sort((a, b) => a.position - b.position || a.key.localeCompare(b.key))) {
      out.push({ ...def, ownerType: node.type, inherited: node.id !== leafId });
    }
  }
  return out;
}

const DEF_COLUMNS = `id, owner_id AS "ownerId", key, name, type, required, options, position`;

export async function resolvedFieldsFor(db: Db, nodeId: string, chain?: Node[]): Promise<ResolvedField[]> {
  const nodes = chain ?? (await getChain(db, nodeId));
  const { rows } = await db.query(
    `SELECT ${DEF_COLUMNS} FROM field_defs WHERE owner_id = ANY($1) AND archived_at IS NULL`,
    [nodes.map((n) => n.id)],
  );
  return resolveFields(
    nodes.map((node) => ({ node, defs: (rows as FieldDef[]).filter((d) => d.ownerId === node.id) })),
    nodeId,
  );
}

export async function localFieldDefs(db: Db, ownerId: string): Promise<FieldDef[]> {
  const { rows } = await db.query(
    `SELECT ${DEF_COLUMNS} FROM field_defs WHERE owner_id = $1 AND archived_at IS NULL ORDER BY position, key`,
    [ownerId],
  );
  return rows;
}

export async function getFieldDef(db: Db, id: string): Promise<FieldDef> {
  const { rows } = await db.query(`SELECT ${DEF_COLUMNS} FROM field_defs WHERE id = $1 AND archived_at IS NULL`, [id]);
  if (!rows[0]) throw notFound("Field");
  return rows[0];
}

// ---------------------------------------------------------------------------------------------
// Value validation (pure)
// ---------------------------------------------------------------------------------------------

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

/** JS date parsing rolls 2026-02-30 over to March 2; reject impossible calendar dates explicitly. */
function realCalendarDate(value: string): boolean {
  const [y, m, d] = value.slice(0, 10).split("-").map(Number) as [number, number, number];
  if (m < 1 || m > 12 || d < 1) return false;
  return d <= new Date(Date.UTC(y, m, 0)).getUTCDate();
}

function checkValue(field: FieldDef, value: unknown): { ok: true; value: unknown } | { ok: false; message: string } {
  switch (field.type) {
    case "text":
      if (typeof value !== "string") return { ok: false, message: "expected a string" };
      if (value.length > MAX_TEXT) return { ok: false, message: `must be at most ${MAX_TEXT} characters` };
      if (field.required && value.trim() === "") return { ok: false, message: "is required and cannot be empty" };
      return { ok: true, value };
    case "number":
      if (typeof value !== "number" || !Number.isFinite(value)) return { ok: false, message: "expected a finite number" };
      return { ok: true, value };
    case "checkbox":
      if (typeof value !== "boolean") return { ok: false, message: "expected true or false" };
      return { ok: true, value };
    case "date": {
      if (typeof value !== "string" || !(ISO_DATE.test(value) || ISO_DATETIME.test(value)) || !realCalendarDate(value) || Number.isNaN(Date.parse(value))) {
        return { ok: false, message: "expected an ISO date (YYYY-MM-DD) or datetime" };
      }
      return { ok: true, value: ISO_DATE.test(value) ? value : new Date(value).toISOString() };
    }
    case "single_select": {
      if (typeof value !== "string") return { ok: false, message: "expected an option id" };
      if (!field.options.some((o) => o.id === value)) return { ok: false, message: `'${value}' is not an option of this field` };
      return { ok: true, value };
    }
    case "multi_select": {
      if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) return { ok: false, message: "expected an array of option ids" };
      const unknown = value.filter((v) => !field.options.some((o) => o.id === v));
      if (unknown.length) return { ok: false, message: `not options of this field: ${unknown.join(", ")}` };
      if (new Set(value).size !== value.length) return { ok: false, message: "contains duplicate options" };
      if (field.required && value.length === 0) return { ok: false, message: "is required and cannot be empty" };
      return { ok: true, value };
    }
  }
}

/**
 * Validate `input` (a partial map of key -> value, null meaning "clear") against a resolved schema
 * and merge it onto `existing`.
 *
 *  - unknown keys, wrong types and unknown select options are errors with path `customFields.<key>`;
 *  - clearing a required field is an error;
 *  - with `requireAll` (create, and move into another list) every required field must end up set;
 *  - values whose key is not in the schema are dropped from the result (used on move: values for
 *    fields the destination list doesn't have are stripped).
 */
export function validateCustomValues(
  schema: FieldDef[],
  input: CustomValues | undefined,
  opts: { existing?: CustomValues; requireAll: boolean; pathPrefix?: string },
): { values: CustomValues; errors: ErrorDetail[]; dropped: string[] } {
  const prefix = opts.pathPrefix ?? "customFields";
  const errors: ErrorDetail[] = [];
  const byKey = new Map(schema.map((f) => [f.key, f]));
  const values: CustomValues = {};
  const dropped: string[] = [];
  for (const [key, value] of Object.entries(opts.existing ?? {})) {
    if (byKey.has(key)) values[key] = value;
    else dropped.push(key);
  }
  for (const [key, value] of Object.entries(input ?? {})) {
    const field = byKey.get(key);
    if (!field) {
      errors.push({ path: `${prefix}.${key}`, message: "is not a field of this list" });
      continue;
    }
    if (value === null) {
      if (field.required) errors.push({ path: `${prefix}.${key}`, message: "is required and cannot be cleared" });
      else delete values[key];
      continue;
    }
    const result = checkValue(field, value);
    if (result.ok) values[key] = result.value;
    else errors.push({ path: `${prefix}.${key}`, message: result.message });
  }
  if (opts.requireAll) {
    for (const field of schema) {
      if (field.required && values[field.key] === undefined && !errors.some((e) => e.path === `${prefix}.${field.key}`)) {
        errors.push({ path: `${prefix}.${field.key}`, message: "is required" });
      }
    }
  }
  return { values, errors, dropped };
}

// ---------------------------------------------------------------------------------------------
// Definition mutations
// ---------------------------------------------------------------------------------------------

export interface FieldInput {
  key: string;
  name: string;
  type: FieldType;
  required?: boolean;
  options?: { id?: string; label: string; color?: string }[];
  position?: number;
}

function normaliseOptions(type: FieldType, options: FieldInput["options"], path = "options"): FieldOption[] {
  if (!SELECT_TYPES.includes(type)) {
    if (options?.length) throw badRequest("VALIDATION_ERROR", `A ${type} field has no options`, [{ path, message: "only select fields take options" }]);
    return [];
  }
  if (!options?.length) throw badRequest("VALIDATION_ERROR", "Select fields need at least one option", [{ path, message: "required" }]);
  const labels = options.map((o) => o.label.trim().toLowerCase());
  if (new Set(labels).size !== labels.length) throw badRequest("VALIDATION_ERROR", "Option labels must be unique", [{ path, message: "duplicate label" }]);
  const ids = options.filter((o) => o.id).map((o) => o.id);
  if (new Set(ids).size !== ids.length) throw badRequest("VALIDATION_ERROR", "Option ids must be unique", [{ path, message: "duplicate id" }]);
  return options.map((o) => ({ id: o.id ?? newId("opt"), label: o.label.trim(), ...(o.color ? { color: o.color } : {}) }));
}

export async function createField(db: Db, actor: User, ownerId: string, input: FieldInput): Promise<FieldDef> {
  return tx(db, async (c) => {
    const owner = await getNode(c, ownerId);
    if (!FIELD_OWNER_TYPES.includes(owner.type)) {
      throw badRequest("INVALID_OWNER", "Custom fields can be defined on a space, folder or list");
    }
    await c.query("SELECT id FROM nodes WHERE id = $1 FOR UPDATE", [ownerId]);
    // key must be free on the whole path: ancestors + self (resolved) and every descendant
    const above = (await resolvedFieldsFor(c, ownerId)).find((f) => f.key === input.key);
    const below = await c.query(
      "SELECT owner_id FROM field_defs WHERE key = $1 AND archived_at IS NULL AND owner_id = ANY($2) LIMIT 1",
      [input.key, await descendantIds(c, ownerId)],
    );
    const clash = above?.ownerId ?? below.rows[0]?.owner_id;
    if (clash) {
      throw conflict("FIELD_KEY_CONFLICT", `Field key '${input.key}' is already defined on ${clash}, which shares this hierarchy path`, [
        { path: "key", message: "already used on this path", ownerId: clash },
      ]);
    }
    const options = normaliseOptions(input.type, input.options);
    const position = input.position ?? ((await localFieldDefs(c, ownerId)).reduce((m, f) => Math.max(m, f.position), 0) + STEP);
    const { rows } = await c.query(
      `INSERT INTO field_defs (id, owner_id, key, name, type, required, options, position)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING ${DEF_COLUMNS}`,
      [newId("cfd"), ownerId, input.key, input.name, input.type, input.required ?? false, JSON.stringify(options), position],
    );
    await emit(c, "field.created", rows[0].id, { actor: actor.id, ownerId, key: input.key });
    return rows[0];
  });
}

/** Count live tasks under the owner whose value references any of the given option ids. */
async function optionUsage(db: Db, def: FieldDef, optionIds: string[]): Promise<number> {
  if (!optionIds.length) return 0;
  const listIds = await subtreeListIds(db, def.ownerId);
  const { rows } = await db.query(
    def.type === "single_select"
      ? `SELECT count(*)::int AS n FROM tasks WHERE list_id = ANY($1) AND archived_at IS NULL AND custom_fields->>$2 = ANY($3)`
      : `SELECT count(*)::int AS n FROM tasks WHERE list_id = ANY($1) AND archived_at IS NULL AND (custom_fields->$2) ?| $3`,
    [listIds, def.key, optionIds],
  );
  return rows[0].n;
}

/**
 * Update a definition. The type is immutable (create a new field instead): changing it would
 * silently invalidate stored values. Removing a select option that tasks still use is rejected
 * with 409 FIELD_OPTION_IN_USE; renaming/recolouring an option is free because tasks store its id.
 * Turning `required` on is allowed: it applies to new tasks, moves into the list, and any update
 * that touches the field; existing tasks are not retroactively invalid.
 */
export async function updateField(
  db: Db,
  actor: User,
  id: string,
  patch: { name?: string; required?: boolean; options?: FieldInput["options"]; position?: number; type?: FieldType },
): Promise<FieldDef> {
  return tx(db, async (c) => {
    const def = await getFieldDef(c, id);
    if (patch.type && patch.type !== def.type) {
      throw badRequest("FIELD_TYPE_IMMUTABLE", "A field's type cannot change; create a new field and migrate values", [{ path: "type", message: "immutable" }]);
    }
    let options = def.options;
    if (patch.options) {
      options = normaliseOptions(def.type, patch.options);
      const removed = def.options.filter((o) => !options.some((n) => n.id === o.id)).map((o) => o.id);
      const used = await optionUsage(c, def, removed);
      if (used) {
        throw conflict("FIELD_OPTION_IN_USE", `${used} task(s) use options you are removing; change those tasks first`, [
          { path: "options", message: "options in use", optionIds: removed, taskCount: used },
        ]);
      }
    }
    const { rows } = await c.query(
      `UPDATE field_defs SET name = COALESCE($2, name), required = COALESCE($3, required), options = $4,
         position = COALESCE($5, position), updated_at = now()
       WHERE id = $1 RETURNING ${DEF_COLUMNS}`,
      [id, patch.name ?? null, patch.required ?? null, JSON.stringify(options), patch.position ?? null],
    );
    await emit(c, "field.updated", id, { actor: actor.id, patch });
    return rows[0];
  });
}

/**
 * Delete = archive the definition and strip its values from every task under the owner, in one
 * transaction. No orphan values are left behind, so the key can later be reused with another type.
 */
export async function deleteField(db: Db, actor: User, id: string): Promise<{ strippedFromTasks: number }> {
  return tx(db, async (c) => {
    const def = await getFieldDef(c, id);
    await c.query("UPDATE field_defs SET archived_at = now(), updated_at = now() WHERE id = $1", [id]);
    const listIds = await subtreeListIds(c, def.ownerId);
    const { rowCount } = await c.query(
      `UPDATE tasks SET custom_fields = custom_fields - $2, version = version + 1, updated_at = now()
       WHERE list_id = ANY($1) AND custom_fields ? $2`,
      [listIds, def.key],
    );
    await emit(c, "field.deleted", id, { actor: actor.id, key: def.key, strippedFromTasks: rowCount ?? 0 });
    return { strippedFromTasks: rowCount ?? 0 };
  });
}
