import { describe, expect, it } from "vitest";
import { alice, columns, ctx, orphanTasks, SEED, useTestApp } from "./helpers.js";

useTestApp();

const L = SEED.lists;

describe("Status resolution", () => {
  it("List A and List B under the same folder resolve different column sets", async () => {
    expect(await columns(L.backlog)).toEqual(["To Do", "In Progress", "Blocked", "Done", "Cancelled"]);
    expect(await columns(L.sprint)).toEqual(["Ready", "In Progress", "Blocked", "In Review", "Done"]);
  });

  it("board columns contain exactly the tasks in each resolved status", async () => {
    for (const listId of [L.backlog, L.sprint]) {
      const { data } = (await alice.get(`/v1/lists/${listId}/board`)).body;
      const placed = data.columns.flatMap((c: { taskIds: string[] }) => c.taskIds);
      expect(placed.sort()).toEqual(data.tasks.map((t: { id: string }) => t.id).sort());
    }
  });

  it("resolved statuses report where each status comes from", async () => {
    const { data } = (await alice.get(`/v1/lists/${L.sprint}/resolved-statuses`)).body;
    const byKey = Object.fromEntries(data.map((s: any) => [s.key, s]));
    expect(byKey.todo).toMatchObject({ name: "Ready", ownerId: L.sprint, originOwnerId: SEED.workspace, inherited: false });
    expect(byKey.blocked).toMatchObject({ ownerType: "space", inherited: true });
    expect(byKey.cancelled).toBeUndefined();
  });

  it("a change at the space level flows down to every list that doesn't override it", async () => {
    const res = await alice.post(`/v1/spaces/${SEED.spaces.eng}/statuses`, { key: "in_progress", name: "Doing" });
    expect(res.status).toBe(201);
    expect(await columns(L.backlog)).toContain("Doing");
    expect(await columns(L.sprint)).toContain("Doing");
    expect(await columns(L.launch)).not.toContain("Doing"); // other space
  });

  it("reordering at a list only affects that list", async () => {
    const res = await alice.post(`/v1/lists/${L.backlog}/statuses/reorder`, { keys: ["done", "todo", "in_progress", "blocked", "cancelled"] });
    expect(res.status).toBe(200);
    expect((await columns(L.backlog))[0]).toBe("Done");
    expect((await columns(L.sprint))[0]).toBe("Ready");
  });

  it("rejects a change that leaves a list without a not_started/active/done status (422)", async () => {
    // Backlog's only not_started status is the inherited 'todo'; hiding it there must fail
    const res = await alice.post(`/v1/lists/${L.backlog}/statuses`, { key: "todo", hidden: true });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe("STATUS_SET_INVALID");
    expect(res.body.error.details[0]).toMatchObject({ nodeId: L.backlog, missing: ["not_started"] });
  });

  it("rejects changing a category such that a descendant breaks", async () => {
    // Recategorising the workspace 'done' to 'closed' would leave every list without a done status
    const res = await alice.patch(`/v1/statuses/sts_ws_done`, { category: "closed" });
    expect(res.status).toBe(422);
  });

  it("hiding requires an inherited key; duplicate local keys are 409", async () => {
    expect((await alice.post(`/v1/lists/${L.backlog}/statuses`, { key: "nope", hidden: true })).body.error.code).toBe("NOTHING_TO_HIDE");
    expect((await alice.post(`/v1/lists/${L.sprint}/statuses`, { key: "in_review", name: "x", category: "active" })).status).toBe(409);
  });
});

describe("Config safety: removing a status tasks still use", () => {
  it("rejects with 409 STATUS_IN_USE listing affected lists and counts", async () => {
    // 'blocked' is added at Engineering; Backlog, Sprint 12 have blocked tasks
    const res = await alice.delete(`/v1/statuses/sts_eng_blocked`);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("STATUS_IN_USE");
    const lists = res.body.error.details.map((d: any) => d.listId).sort();
    expect(lists).toEqual([L.backlog, L.sprint].sort());
    expect(res.body.error.details.every((d: any) => d.statusKey === "blocked" && d.taskCount >= 1)).toBe(true);
    // nothing changed
    expect(await columns(L.backlog)).toContain("Blocked");
    expect(await orphanTasks()).toEqual([]);
  });

  it("with remapTo, removes the status and moves its tasks in one transaction", async () => {
    const res = await alice.delete(`/v1/statuses/sts_eng_blocked?remapTo=in_progress`);
    expect(res.status).toBe(204);
    expect(await columns(L.backlog)).not.toContain("Blocked");
    const { rows } = await ctx.pool.query("SELECT count(*)::int AS n FROM tasks WHERE status_key = 'blocked' AND archived_at IS NULL");
    expect(rows[0].n).toBe(0);
    expect(await orphanTasks()).toEqual([]);
  });

  it("hiding an in-use inherited status at a list is held to the same rule", async () => {
    const hide = await alice.post(`/v1/lists/${L.backlog}/statuses`, { key: "cancelled", hidden: true });
    expect(hide.status).toBe(409);
    const remap = await alice.post(`/v1/lists/${L.backlog}/statuses?remapTo=done`, { key: "cancelled", hidden: true });
    expect(remap.status).toBe(201);
    expect(await orphanTasks()).toEqual([]);
  });

  it("remapTo must exist in every affected list's new set", async () => {
    // in_review exists in Sprint 12 only; Backlog can't take it
    const res = await alice.delete(`/v1/statuses/sts_eng_blocked?remapTo=in_review`);
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe("INVALID_REMAP");
    expect(await columns(L.backlog)).toContain("Blocked");
  });

  it("deleting an override reverts to the inherited status, no remap needed", async () => {
    const res = await alice.delete(`/v1/statuses/sts_sprint_todo`);
    expect(res.status).toBe(204);
    expect((await columns(L.sprint))[0]).toBe("To Do");
    expect(await orphanTasks()).toEqual([]);
  });

  it("renaming/recolouring an in-use status never touches tasks", async () => {
    const before = (await ctx.pool.query("SELECT id, status_key, version FROM tasks ORDER BY id")).rows;
    expect((await alice.patch(`/v1/statuses/sts_eng_blocked`, { name: "Stuck", color: "#000000" })).status).toBe(200);
    const after = (await ctx.pool.query("SELECT id, status_key, version FROM tasks ORDER BY id")).rows;
    expect(after).toEqual(before);
  });
});
