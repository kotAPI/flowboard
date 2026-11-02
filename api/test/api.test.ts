import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { alice, ctx, SEED, useTestApp } from "./helpers.js";

useTestApp();

describe("API conventions", () => {
  it("every error uses { error: { code, message, details? } }", async () => {
    const samples = [
      await alice.get("/v1/tasks/tsk_missing"),
      await alice.post(`/v1/lists/${SEED.lists.backlog}/tasks`, { title: "" }),
      await alice.post(`/v1/lists/${SEED.lists.backlog}/tasks`, { title: "x", unknownProp: 1 }),
      await alice.get("/v1/does-not-exist"),
    ];
    for (const res of samples) {
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(Object.keys(res.body)).toEqual(["error"]);
      expect(res.body.error).toEqual(expect.objectContaining({ code: expect.any(String), message: expect.any(String) }));
    }
  });

  it("archived containers 404 and disappear from the tree; their tasks go with them", async () => {
    expect((await alice.delete(`/v1/folders/${SEED.folders.q2}`)).status).toBe(204);
    expect((await alice.get(`/v1/lists/${SEED.lists.backlog}/board`)).status).toBe(404);
    expect(JSON.stringify((await alice.get("/v1/tree")).body.data)).not.toContain("Q2 Launch");
    const { rows } = await ctx.pool.query("SELECT count(*)::int AS n FROM tasks WHERE list_id = $1 AND archived_at IS NULL", [SEED.lists.backlog]);
    expect(rows[0].n).toBe(0);
  });

  it("hierarchy rules: lists only inside folders, folders only inside spaces", async () => {
    // the route shape already prevents most of this; reorder across parents is rejected too
    const res = await alice.post(`/v1/lists/${SEED.lists.backlog}/reorder`, { beforeId: SEED.lists.launch });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("INVALID_POSITION");
  });

  it("reorders siblings", async () => {
    await alice.post(`/v1/lists/${SEED.lists.incidents}/reorder`, { beforeId: SEED.lists.backlog });
    const lists = (await alice.get(`/v1/folders/${SEED.folders.q2}/lists`)).body.data.map((l: any) => l.id);
    expect(lists).toEqual([SEED.lists.incidents, SEED.lists.backlog, SEED.lists.sprint]);
  });

  it("README API table lists every registered route (docs match the running code)", () => {
    const readme = readFileSync(new URL("../../README.md", import.meta.url), "utf8");
    const documented = new Set(
      [...readme.matchAll(/^\| `(GET|POST|PATCH|PUT|DELETE)` \| `([^`]+)`/gm)].map((m) => `${m[1]} ${m[2]}`),
    );
    const routes = ctx.app.routeList.filter((r) => r.split(" ")[1]!.startsWith("/v1/"));
    expect(routes.length).toBeGreaterThan(40);
    const missing = routes.filter((r) => !documented.has(r));
    expect(missing).toEqual([]);
  });
});
