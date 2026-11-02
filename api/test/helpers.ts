import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import type pg from "pg";
import { afterAll, beforeAll, beforeEach } from "vitest";
import { buildApp } from "../src/app.js";
import { createPool } from "../src/lib/db.js";
import { migrate } from "../src/lib/migrate.js";
import { resetDatabase, SEED } from "../src/seed.js";

export { SEED };
export const ctx = {} as { pool: pg.Pool; app: FastifyInstance };

/** Boot the app against the test database; every test starts from a fresh seed. */
export function useTestApp() {
  beforeAll(async () => {
    ctx.pool = createPool();
    await migrate(ctx.pool, () => {});
    ctx.app = buildApp(ctx.pool);
    await ctx.app.ready();
  });
  beforeEach(async () => {
    await resetDatabase(ctx.pool);
  });
  afterAll(async () => {
    await ctx.app?.close();
    await ctx.pool?.end();
  });
}

type Method = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
export interface Res<T = any> {
  status: number;
  body: T;
  raw: LightMyRequestResponse;
}

/** Request as a seeded user via the X-User-Id header ("alice" | "bob" | "carol"). */
export function as(user: "alice" | "bob" | "carol" | null) {
  const call = async (method: Method, url: string, payload?: unknown): Promise<Res> => {
    const raw = await ctx.app.inject({
      method,
      url,
      headers: user ? { "x-user-id": user } : {},
      ...(payload !== undefined ? { payload: payload as object } : {}),
    });
    return { status: raw.statusCode, body: raw.body ? raw.json() : undefined, raw };
  };
  return {
    get: (url: string) => call("GET", url),
    post: (url: string, body?: unknown) => call("POST", url, body ?? {}),
    patch: (url: string, body: unknown) => call("PATCH", url, body),
    put: (url: string, body: unknown) => call("PUT", url, body),
    delete: (url: string) => call("DELETE", url),
  };
}

export const alice = as("alice");
export const bob = as("bob");
export const carol = as("carol");

export async function columns(listId: string, user = alice): Promise<string[]> {
  const res = await user.get(`/v1/lists/${listId}/board`);
  return res.body.data.statuses.map((s: { name: string }) => s.name);
}

/** Every live task's status must exist in its list's resolved set (no orphan board state). */
export async function orphanTasks(): Promise<{ id: string; listId: string; statusKey: string }[]> {
  const { rows: tasks } = await ctx.pool.query("SELECT id, list_id, status_key FROM tasks WHERE archived_at IS NULL");
  const out = [];
  const cache = new Map<string, Set<string>>();
  for (const t of tasks) {
    if (!cache.has(t.list_id)) {
      const res = await alice.get(`/v1/lists/${t.list_id}/resolved-statuses`);
      cache.set(t.list_id, new Set(res.body.data.map((s: { key: string }) => s.key)));
    }
    if (!cache.get(t.list_id)!.has(t.status_key)) out.push({ id: t.id, listId: t.list_id, statusKey: t.status_key });
  }
  return out;
}
