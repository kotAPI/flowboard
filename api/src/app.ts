import cors from "@fastify/cors";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import type pg from "pg";
import { z, ZodError, type ZodTypeAny } from "zod";
import { AppError, badRequest, notFound } from "./lib/errors.js";
import { decodeCursor, encodeCursor, page } from "./lib/pagination.js";
import { activityFor } from "./modules/activity.js";
import {
  createField,
  deleteField,
  FIELD_TYPES,
  getFieldDef,
  localFieldDefs,
  resolvedFieldsFor,
  updateField,
} from "./modules/fields.js";
import {
  allLiveNodes,
  archiveNode,
  CHILD_TYPE,
  createNode,
  getNode,
  getWorkspace,
  reorderNode,
  updateNode,
  type Node,
  type NodeType,
} from "./modules/hierarchy.js";
import { authenticate, getUser, issueToken, listUsers, type User } from "./modules/identity.js";
import { authorize, canSee, grantsFor, listGrants } from "./modules/permissions.js";
import {
  createStatus,
  deleteStatus,
  getStatusDefOwner,
  localStatusDefs,
  reorderStatuses,
  resolvedStatusesFor,
  STATUS_CATEGORIES,
  updateStatus,
} from "./modules/statuses.js";
import { createTask, deleteTask, getBoard, getTask, listTasks, moveTask, PRIORITIES, TASK_SORTS, updateTask } from "./modules/tasks.js";
import { newId } from "./lib/ids.js";

declare module "fastify" {
  interface FastifyRequest {
    user: User;
  }
  interface FastifyInstance {
    /** every registered route as "METHOD /path" (used by the docs-match-code test and the CLI) */
    routeList: string[];
  }
}

// ---------------------------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------------------------

function parse<S extends ZodTypeAny>(schema: S, value: unknown): z.infer<S> {
  const result = schema.safeParse(value ?? {});
  if (!result.success) throw zodError(result.error);
  return result.data;
}

function zodError(err: ZodError): AppError {
  return badRequest(
    "VALIDATION_ERROR",
    "The request is invalid",
    err.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
  );
}

const idSchema = z.string().min(1).max(64);
const key = z.string().regex(/^[a-z][a-z0-9_]{0,39}$/, "lowercase letters, digits and _; starts with a letter");
const color = z.string().regex(/^#[0-9a-fA-F]{6}$/, "hex colour like #22c55e");
const isoDateTime = z.string().datetime({ offset: true });
const limit = z.coerce.number().int().min(1).max(200).default(50);
const IdParams = z.object({ id: idSchema });

const ContainerCreate = z.object({ name: z.string().trim().min(1).max(200), visibility: z.enum(["public", "private"]).optional() }).strict();
const ContainerPatch = ContainerCreate.partial().strict();
const Reorder = z
  .object({ beforeId: idSchema.nullish(), afterId: idSchema.nullish() })
  .strict()
  .refine((v) => v.beforeId || v.afterId, "beforeId or afterId is required");

const StatusCreate = z
  .object({
    key,
    name: z.string().trim().min(1).max(60).optional(),
    category: z.enum(STATUS_CATEGORIES).optional(),
    color: color.optional(),
    position: z.number().finite().optional(),
    hidden: z.boolean().optional(),
  })
  .strict();
const StatusPatch = StatusCreate.omit({ key: true, hidden: true }).strict();
const RemapQuery = z.object({ remapTo: key.optional() });

const FieldOptionInput = z.object({ id: z.string().min(1).max(64).optional(), label: z.string().trim().min(1).max(60), color: color.optional() }).strict();
const FieldCreate = z
  .object({
    key,
    name: z.string().trim().min(1).max(60),
    type: z.enum(FIELD_TYPES),
    required: z.boolean().optional(),
    options: z.array(FieldOptionInput).max(100).optional(),
    position: z.number().finite().optional(),
  })
  .strict();
const FieldPatch = FieldCreate.omit({ key: true }).partial().strict();

const customFields = z.record(key, z.unknown());
const TaskCreate = z
  .object({
    title: z.string().trim().min(1).max(500),
    description: z.string().max(20_000).nullish(),
    statusKey: key.optional(),
    priority: z.enum(PRIORITIES).optional(),
    assigneeIds: z.array(idSchema).max(20).optional(),
    dueDate: isoDateTime.nullish(),
    customFields: customFields.optional(),
  })
  .strict();
const TaskPatch = TaskCreate.partial().extend({ version: z.number().int().positive().optional() }).strict();
const TaskMove = z
  .object({
    listId: idSchema.optional(),
    statusKey: key.optional(),
    beforeId: idSchema.nullish(),
    afterId: idSchema.nullish(),
    customFields: customFields.optional(),
    onMissingStatus: z.enum(["map_default", "reject"]).optional(),
    version: z.number().int().positive().optional(),
  })
  .strict();
const TaskListQuery = z.object({
  limit,
  cursor: z.string().optional(),
  sort: z.enum(TASK_SORTS).default("position"),
  order: z.enum(["asc", "desc"]).default("asc"),
  statusKey: key.optional(),
  assigneeId: idSchema.optional(),
});
const PageQuery = z.object({ limit, cursor: z.string().optional() });
const GrantPut = z.object({ mode: z.enum(["allow", "deny"]) }).strict();

/** `cf.<key>=value` query params -> { key: value } */
function customFieldFilters(query: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(query)) {
    if (k.startsWith("cf.") && typeof v === "string") out[k.slice(3)] = v;
  }
  return out;
}

const CONTAINER_PATHS: Record<string, Exclude<NodeType, "workspace">> = { spaces: "space", folders: "folder", lists: "list" };

// ---------------------------------------------------------------------------------------------

export function buildApp(pool: pg.Pool, opts: { logger?: boolean } = {}): FastifyInstance {
  const app = Fastify({
    logger: opts.logger ? { level: process.env.LOG_LEVEL ?? "info" } : false,
    genReqId: () => newId("req"),
  });

  const routeList: string[] = [];
  app.decorate("routeList", routeList);
  app.addHook("onRoute", (r) => {
    for (const m of [r.method].flat()) if (m !== "HEAD" && m !== "OPTIONS") routeList.push(`${m} ${r.url}`);
  });

  app.register(cors, {
    origin: (process.env.CORS_ORIGINS ?? "http://localhost:5173,http://localhost:8080").split(","),
    allowedHeaders: ["content-type", "authorization", "x-user-id"],
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof AppError) {
      return reply.status(err.status).send({ error: { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) } });
    }
    if (err instanceof ZodError) {
      const e = zodError(err);
      return reply.status(400).send({ error: { code: e.code, message: e.message, details: e.details } });
    }
    const fe = err as { statusCode?: number; code?: string; message: string };
    if (fe.statusCode && fe.statusCode < 500) {
      return reply.status(fe.statusCode).send({ error: { code: fe.code ?? "BAD_REQUEST", message: fe.message } });
    }
    req.log.error(err);
    return reply.status(500).send({ error: { code: "INTERNAL", message: "Something went wrong", details: [{ message: `request id ${req.id}` }] } });
  });

  app.setNotFoundHandler((req, reply) =>
    reply.status(404).send({ error: { code: "ROUTE_NOT_FOUND", message: `${req.method} ${req.url} is not an API route` } }),
  );

  // ---- auth boundary: everything under /v1 except token issuance needs a resolved user ----
  const PUBLIC = new Set(["POST /v1/auth/token"]);
  app.addHook("onRequest", async (req) => {
    if (!req.url.startsWith("/v1/")) return;
    if (PUBLIC.has(`${req.method} ${req.routeOptions.url}`)) return;
    req.user = await authenticate(pool, req.headers);
  });

  app.get("/health", async () => {
    await pool.query("SELECT 1");
    return { status: "ok" };
  });

  // ---- identity ----
  app.post("/v1/auth/token", async (req) => {
    const { userId } = parse(z.object({ userId: idSchema }).strict(), req.body);
    const user = await getUser(pool, userId.startsWith("usr_") ? userId : `usr_${userId}`);
    if (!user) throw badRequest("UNKNOWN_USER", "No such user");
    return { data: { ...(await issueToken(user)), user } };
  });
  app.get("/v1/me", async (req) => ({ data: req.user }));
  app.get("/v1/users", async () => ({ data: await listUsers(pool) }));

  // ---- hierarchy ----
  app.get("/v1/workspace", async () => ({ data: await getWorkspace(pool) }));

  /** Whole visible tree in one call (sidebar). Hidden subtrees are pruned, not just flagged. */
  app.get("/v1/tree", async (req) => {
    const nodes = await allLiveNodes(pool);
    const grants = req.user.role === "admin" ? new Map() : await grantsFor(pool, req.user.id);
    type TreeNode = Pick<Node, "id" | "type" | "name" | "position" | "visibility" | "parentId"> & { children: TreeNode[] };
    const byParent = new Map<string | null, Node[]>();
    for (const n of nodes) byParent.set(n.parentId, [...(byParent.get(n.parentId) ?? []), n]);
    const build = (node: Node): TreeNode => ({
      id: node.id,
      type: node.type,
      name: node.name,
      position: node.position,
      visibility: node.visibility,
      parentId: node.parentId,
      children: (byParent.get(node.id) ?? []).filter((c) => canSee(req.user, [c], grants)).map(build),
    });
    const root = nodes.find((n) => n.type === "workspace");
    if (!root) throw notFound("Workspace");
    return { data: build(root) };
  });

  async function visibleChildren(req: FastifyRequest, parent: Node, chain: Node[]) {
    const q = parse(PageQuery, req.query);
    const grants = req.user.role === "admin" ? new Map() : await grantsFor(pool, req.user.id);
    // Sibling sets are small (tens), so filter in memory and apply the keyset after filtering;
    // that keeps pages full and cursors stable for members.
    const all = (await allLiveNodes(pool)).filter((n) => n.parentId === parent.id && canSee(req.user, [...chain, n], grants));
    const after = q.cursor ? (decodeCursor(q.cursor) as [number, string]) : null;
    const rows = all
      .sort((a, b) => a.position - b.position || a.id.localeCompare(b.id))
      .filter((n) => !after || n.position > after[0] || (n.position === after[0] && n.id > after[1]))
      .slice(0, q.limit + 1);
    return page(rows, q.limit, (n) => encodeCursor(n.position, n.id));
  }

  app.get("/v1/spaces", async (req) => {
    const ws = await getWorkspace(pool);
    return visibleChildren(req, ws, [ws]);
  });
  app.post("/v1/spaces", async (req, reply) => {
    const ws = await getWorkspace(pool);
    await authorize(pool, req.user, ws.id, "configure");
    const body = parse(ContainerCreate, req.body);
    return reply.status(201).send({ data: await createNode(pool, req.user, { type: "space", parentId: ws.id, ...body }) });
  });

  for (const [path, type] of Object.entries(CONTAINER_PATHS)) {
    app.get(`/v1/${path}/:id`, async (req) => {
      const { id } = parse(IdParams, req.params);
      await authorize(pool, req.user, id, "read", type);
      return { data: await getNode(pool, id, type) };
    });
    app.patch(`/v1/${path}/:id`, async (req) => {
      const { id } = parse(IdParams, req.params);
      await authorize(pool, req.user, id, "configure", type);
      return { data: await updateNode(pool, req.user, id, parse(ContainerPatch, req.body)) };
    });
    app.delete(`/v1/${path}/:id`, async (req, reply) => {
      const { id } = parse(IdParams, req.params);
      await authorize(pool, req.user, id, "configure", type);
      await archiveNode(pool, req.user, id);
      return reply.status(204).send();
    });
    app.post(`/v1/${path}/:id/reorder`, async (req) => {
      const { id } = parse(IdParams, req.params);
      await authorize(pool, req.user, id, "configure", type);
      return { data: await reorderNode(pool, req.user, id, parse(Reorder, req.body)) };
    });

    const childType = CHILD_TYPE[type];
    if (childType) {
      const childPath = `${childType}s`;
      app.get(`/v1/${path}/:id/${childPath}`, async (req) => {
        const { id } = parse(IdParams, req.params);
        const chain = await authorize(pool, req.user, id, "read", type);
        return visibleChildren(req, chain[chain.length - 1]!, chain);
      });
      app.post(`/v1/${path}/:id/${childPath}`, async (req, reply) => {
        const { id } = parse(IdParams, req.params);
        await authorize(pool, req.user, id, "configure", type);
        const body = parse(ContainerCreate, req.body);
        return reply.status(201).send({ data: await createNode(pool, req.user, { type: childType as "folder" | "list", parentId: id, ...body }) });
      });
    }

    // ---- grants (admin) ----
    app.get(`/v1/${path}/:id/grants`, async (req) => {
      const { id } = parse(IdParams, req.params);
      await authorize(pool, req.user, id, "configure", type);
      return { data: await listGrants(pool, id) };
    });
    app.put(`/v1/${path}/:id/grants/:userId`, async (req) => {
      const { id, userId } = parse(z.object({ id: idSchema, userId: idSchema }), req.params);
      await authorize(pool, req.user, id, "configure", type);
      const { mode } = parse(GrantPut, req.body);
      if (!(await getUser(pool, userId))) throw badRequest("UNKNOWN_USER", "No such user");
      await pool.query(
        `INSERT INTO grants (id, node_id, user_id, mode) VALUES ($1, $2, $3, $4)
         ON CONFLICT (node_id, user_id) DO UPDATE SET mode = EXCLUDED.mode`,
        [newId("grt"), id, userId, mode],
      );
      return { data: await listGrants(pool, id) };
    });
    app.delete(`/v1/${path}/:id/grants/:userId`, async (req, reply) => {
      const { id, userId } = parse(z.object({ id: idSchema, userId: idSchema }), req.params);
      await authorize(pool, req.user, id, "configure", type);
      await pool.query("DELETE FROM grants WHERE node_id = $1 AND user_id = $2", [id, userId]);
      return reply.status(204).send();
    });
  }

  // ---- status + field config, available on the workspace and every container ----
  const configBases: { path: string; type: NodeType }[] = [
    { path: "/v1/workspace", type: "workspace" },
    ...Object.entries(CONTAINER_PATHS).map(([p, type]) => ({ path: `/v1/${p}/:id`, type })),
  ];
  for (const { path, type } of configBases) {
    const ownerId = async (req: FastifyRequest) =>
      type === "workspace" ? (await getWorkspace(pool)).id : parse(IdParams, req.params).id;

    app.get(`${path}/statuses`, async (req) => {
      const id = await ownerId(req);
      const chain = await authorize(pool, req.user, id, "read", type);
      return { data: { local: await localStatusDefs(pool, id), resolved: await resolvedStatusesFor(pool, id, chain) } };
    });
    app.get(`${path}/resolved-statuses`, async (req) => {
      const id = await ownerId(req);
      const chain = await authorize(pool, req.user, id, "read", type);
      return { data: await resolvedStatusesFor(pool, id, chain) };
    });
    app.post(`${path}/statuses`, async (req, reply) => {
      const id = await ownerId(req);
      await authorize(pool, req.user, id, "configure", type);
      const { remapTo } = parse(RemapQuery, req.query);
      const def = await createStatus(pool, req.user, id, parse(StatusCreate, req.body), remapTo);
      return reply.status(201).send({ data: def });
    });
    app.post(`${path}/statuses/reorder`, async (req) => {
      const id = await ownerId(req);
      await authorize(pool, req.user, id, "configure", type);
      const { keys } = parse(z.object({ keys: z.array(key).min(1) }).strict(), req.body);
      return { data: await reorderStatuses(pool, req.user, id, keys) };
    });
    app.get(`${path}/fields`, async (req) => {
      const id = await ownerId(req);
      const chain = await authorize(pool, req.user, id, "read", type);
      return { data: { local: await localFieldDefs(pool, id), resolved: await resolvedFieldsFor(pool, id, chain) } };
    });
    app.get(`${path}/resolved-fields`, async (req) => {
      const id = await ownerId(req);
      const chain = await authorize(pool, req.user, id, "read", type);
      return { data: await resolvedFieldsFor(pool, id, chain) };
    });
    if (type !== "workspace") {
      app.post(`${path}/fields`, async (req, reply) => {
        const id = await ownerId(req);
        await authorize(pool, req.user, id, "configure", type);
        return reply.status(201).send({ data: await createField(pool, req.user, id, parse(FieldCreate, req.body)) });
      });
    }
  }

  app.patch("/v1/statuses/:id", async (req) => {
    const { id } = parse(IdParams, req.params);
    await authorize(pool, req.user, await getStatusDefOwner(pool, id), "configure");
    return { data: await updateStatus(pool, req.user, id, parse(StatusPatch, req.body)) };
  });
  app.delete("/v1/statuses/:id", async (req, reply) => {
    const { id } = parse(IdParams, req.params);
    await authorize(pool, req.user, await getStatusDefOwner(pool, id), "configure");
    const { remapTo } = parse(RemapQuery, req.query);
    await deleteStatus(pool, req.user, id, remapTo);
    return reply.status(204).send();
  });
  app.patch("/v1/fields/:id", async (req) => {
    const { id } = parse(IdParams, req.params);
    await authorize(pool, req.user, (await getFieldDef(pool, id)).ownerId, "configure");
    return { data: await updateField(pool, req.user, id, parse(FieldPatch, req.body)) };
  });
  app.delete("/v1/fields/:id", async (req) => {
    const { id } = parse(IdParams, req.params);
    await authorize(pool, req.user, (await getFieldDef(pool, id)).ownerId, "configure");
    return { data: await deleteField(pool, req.user, id) };
  });

  // ---- tasks ----
  app.get("/v1/lists/:id/board", async (req) => {
    const { id } = parse(IdParams, req.params);
    const chain = await authorize(pool, req.user, id, "read", "list");
    return { data: await getBoard(pool, chain[chain.length - 1]!, chain) };
  });
  app.get("/v1/lists/:id/tasks", async (req) => {
    const { id } = parse(IdParams, req.params);
    await authorize(pool, req.user, id, "read", "list");
    const q = parse(TaskListQuery, req.query);
    return listTasks(pool, id, { ...q, cf: customFieldFilters(req.query as Record<string, unknown>) });
  });
  app.post("/v1/lists/:id/tasks", async (req, reply) => {
    const { id } = parse(IdParams, req.params);
    await authorize(pool, req.user, id, "write", "list");
    return reply.status(201).send({ data: await createTask(pool, req.user, id, parse(TaskCreate, req.body)) });
  });
  app.get("/v1/lists/:id/activity", async (req) => {
    const { id } = parse(IdParams, req.params);
    await authorize(pool, req.user, id, "read", "list");
    return { data: await activityFor(pool, { listId: id }, parse(PageQuery, req.query).limit) };
  });

  const taskWithAccess = async (req: FastifyRequest, action: "read" | "write") => {
    const { id } = parse(IdParams, req.params);
    const task = await getTask(pool, id);
    await authorize(pool, req.user, task.listId, action);
    return task;
  };
  app.get("/v1/tasks/:id", async (req) => ({ data: await taskWithAccess(req, "read") }));
  app.patch("/v1/tasks/:id", async (req) => {
    const task = await taskWithAccess(req, "write");
    return { data: await updateTask(pool, req.user, task.id, parse(TaskPatch, req.body)) };
  });
  app.post("/v1/tasks/:id/move", async (req) => {
    const task = await taskWithAccess(req, "write");
    const body = parse(TaskMove, req.body);
    if (body.listId && body.listId !== task.listId) await authorize(pool, req.user, body.listId, "write", "list");
    return { data: await moveTask(pool, req.user, task.id, body) };
  });
  app.delete("/v1/tasks/:id", async (req, reply) => {
    const task = await taskWithAccess(req, "write");
    await deleteTask(pool, req.user, task.id);
    return reply.status(204).send();
  });
  app.get("/v1/tasks/:id/activity", async (req) => {
    const task = await taskWithAccess(req, "read");
    return { data: await activityFor(pool, { taskId: task.id }, parse(PageQuery, req.query).limit) };
  });

  return app;
}
