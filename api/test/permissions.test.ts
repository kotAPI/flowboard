import { describe, expect, it } from "vitest";
import { alice, as, bob, carol, SEED, useTestApp } from "./helpers.js";

useTestApp();

const L = SEED.lists;

function listIds(node: { type: string; id: string; children: any[] }): string[] {
  return [...(node.type === "list" ? [node.id] : []), ...node.children.flatMap(listIds)];
}

describe("Permissions", () => {
  it("tree hides private and denied nodes for Bob; Alice sees all", async () => {
    const forAlice = listIds((await alice.get("/v1/tree")).body.data);
    const forBob = listIds((await bob.get("/v1/tree")).body.data);
    expect(forAlice.sort()).toEqual([L.backlog, L.incidents, L.launch, L.sprint].sort());
    // Incident Review is private (no grant for Bob), Marketing is denied for Bob
    expect(forBob.sort()).toEqual([L.backlog, L.sprint].sort());
    expect(JSON.stringify((await bob.get("/v1/tree")).body.data)).not.toContain("Marketing");
  });

  it("Bob and Carol have different grants", async () => {
    const forCarol = listIds((await carol.get("/v1/tree")).body.data);
    expect(forCarol.sort()).toEqual([L.backlog, L.incidents, L.launch, L.sprint].sort());
  });

  it("denied list -> 403 on task read (direct task URL and list endpoints)", async () => {
    const launchTask = (await alice.get(`/v1/lists/${L.launch}/tasks?limit=1`)).body.data[0];
    const incidentTask = (await alice.get(`/v1/lists/${L.incidents}/tasks?limit=1`)).body.data[0];
    for (const url of [`/v1/tasks/${launchTask.id}`, `/v1/tasks/${incidentTask.id}`, `/v1/lists/${L.launch}/board`, `/v1/lists/${L.incidents}/tasks`]) {
      const res = await bob.get(url);
      expect(res.status, url).toBe(403);
      expect(res.body.error.code).toBe("FORBIDDEN");
    }
    expect((await carol.get(`/v1/tasks/${incidentTask.id}`)).status).toBe(200);
  });

  it("members cannot write tasks into, or move tasks to, a list they cannot see", async () => {
    const t = (await bob.get(`/v1/lists/${L.backlog}/tasks?limit=1`)).body.data[0];
    expect((await bob.post(`/v1/lists/${L.incidents}/tasks`, { title: "x", customFields: { component: "opt_api" } })).status).toBe(403);
    expect((await bob.post(`/v1/tasks/${t.id}/move`, { listId: L.incidents })).status).toBe(403);
  });

  it("members can edit tasks in visible lists but not change configuration", async () => {
    const t = (await bob.get(`/v1/lists/${L.backlog}/tasks?limit=1`)).body.data[0];
    expect((await bob.patch(`/v1/tasks/${t.id}`, { priority: "urgent" })).status).toBe(200);
    const res = await bob.post(`/v1/lists/${L.backlog}/statuses`, { key: "qa", name: "QA", category: "active" });
    expect(res.status).toBe(403);
    expect(res.body.error.message).toMatch(/admins/);
    expect((await bob.post(`/v1/spaces`, { name: "Mine" })).status).toBe(403);
  });

  it("a new allow grant makes a private list appear for Bob", async () => {
    expect((await alice.put(`/v1/lists/${L.incidents}/grants/usr_bob`, { mode: "allow" })).status).toBe(200);
    expect(listIds((await bob.get("/v1/tree")).body.data)).toContain(L.incidents);
  });

  it("role is resolved server-side: a forged role claim in the body changes nothing", async () => {
    const res = await bob.post(`/v1/spaces`, { name: "Sneaky", role: "admin" });
    expect([400, 403]).toContain(res.status);
  });
});

describe("Auth boundary", () => {
  it("no identity -> 401 with the standard error shape", async () => {
    const res = await as(null).get("/v1/tree");
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: { code: "UNAUTHENTICATED", message: expect.any(String) } });
  });

  it("unknown user -> 401", async () => {
    const res = await (async () => {
      const { ctx } = await import("./helpers.js");
      return ctx.app.inject({ method: "GET", url: "/v1/tree", headers: { "x-user-id": "mallory" } });
    })();
    expect(res.statusCode).toBe(401);
  });

  it("JWT: token from /v1/auth/token works; tampered token is 401", async () => {
    const { ctx } = await import("./helpers.js");
    const issued = await ctx.app.inject({ method: "POST", url: "/v1/auth/token", payload: { userId: "bob" } });
    const { token } = issued.json().data;
    const ok = await ctx.app.inject({ method: "GET", url: "/v1/me", headers: { authorization: `Bearer ${token}` } });
    expect(ok.json().data).toMatchObject({ id: "usr_bob", role: "member" });
    const bad = await ctx.app.inject({ method: "GET", url: "/v1/me", headers: { authorization: `Bearer ${token.slice(0, -2)}xx` } });
    expect(bad.statusCode).toBe(401);
  });
});
