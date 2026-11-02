import { describe, expect, it } from "vitest";
import { alice, bob, ctx, orphanTasks, SEED, useTestApp } from "./helpers.js";

useTestApp();

const L = SEED.lists;
const valid = { title: "New task", customFields: { component: "opt_api" } };

async function taskIn(listId: string, statusKey: string) {
  const res = await alice.get(`/v1/lists/${listId}/tasks?statusKey=${statusKey}&limit=1`);
  return res.body.data[0];
}

describe("Status validation", () => {
  it("create with unknown statusKey -> 400 INVALID_STATUS", async () => {
    const res = await alice.post(`/v1/lists/${L.backlog}/tasks`, { ...valid, statusKey: "in_review" }); // only exists in Sprint 12
    expect(res.status).toBe(400);
    expect(res.body.error).toMatchObject({ code: "INVALID_STATUS", details: [{ path: "statusKey" }] });
  });

  it("update with unknown statusKey -> 400", async () => {
    const t = await taskIn(L.backlog, "todo");
    const res = await alice.patch(`/v1/tasks/${t.id}`, { statusKey: "scheduled" });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("INVALID_STATUS");
  });

  it("create without statusKey lands in the list's default (first not_started) status", async () => {
    const res = await alice.post(`/v1/lists/${L.sprint}/tasks`, valid);
    expect(res.status).toBe(201);
    expect(res.body.data.statusKey).toBe("todo"); // shown as "Ready" in Sprint 12
  });

  it("status change appends the card to the end of the new column", async () => {
    const t = await taskIn(L.backlog, "todo");
    const res = await alice.patch(`/v1/tasks/${t.id}`, { statusKey: "done" });
    const board = (await alice.get(`/v1/lists/${L.backlog}/board`)).body.data;
    const doneCol = board.columns.find((c: any) => c.statusKey === "done").taskIds;
    expect(doneCol[doneCol.length - 1]).toBe(res.body.data.id);
  });
});

describe("Cross-list move", () => {
  it("status missing in destination: maps to the destination default (default policy)", async () => {
    const t = await taskIn(L.sprint, "in_review"); // Backlog has no in_review
    const res = await alice.post(`/v1/tasks/${t.id}/move`, { listId: L.backlog });
    expect(res.status).toBe(200);
    expect(res.body.data.task).toMatchObject({ listId: L.backlog, statusKey: "todo" });
    expect(res.body.data.statusMapped).toEqual({ from: "in_review", to: "todo" });
    expect(await orphanTasks()).toEqual([]);
  });

  it("status missing in destination: rejected with onMissingStatus=reject", async () => {
    const t = await taskIn(L.sprint, "in_review");
    const res = await alice.post(`/v1/tasks/${t.id}/move`, { listId: L.backlog, onMissingStatus: "reject" });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("STATUS_NOT_IN_LIST");
    expect((await alice.get(`/v1/tasks/${t.id}`)).body.data.listId).toBe(L.sprint);
  });

  it("status present in destination is kept", async () => {
    const t = await taskIn(L.backlog, "blocked");
    const res = await alice.post(`/v1/tasks/${t.id}/move`, { listId: L.sprint });
    expect(res.body.data.task.statusKey).toBe("blocked");
    expect(res.body.data.statusMapped).toBeNull();
  });

  it("explicit statusKey in the move payload wins, and is validated against the destination", async () => {
    const t = await taskIn(L.backlog, "todo");
    expect((await alice.post(`/v1/tasks/${t.id}/move`, { listId: L.sprint, statusKey: "in_review" })).body.data.task.statusKey).toBe("in_review");
    const t2 = await taskIn(L.backlog, "todo");
    expect((await alice.post(`/v1/tasks/${t2.id}/move`, { listId: L.sprint, statusKey: "cancelled" })).status).toBe(400); // hidden in Sprint 12
  });

  it("moving into a list with a required field the task lacks -> 400, unless the payload supplies it", async () => {
    const t = await taskIn(L.launch, "todo"); // Marketing task: no 'component'
    const res = await alice.post(`/v1/tasks/${t.id}/move`, { listId: L.backlog });
    expect(res.status).toBe(400);
    expect(res.body.error.details).toEqual([expect.objectContaining({ path: "customFields.component", message: "is required" })]);
    const ok = await alice.post(`/v1/tasks/${t.id}/move`, { listId: L.backlog, customFields: { component: "opt_web" } });
    expect(ok.status).toBe(200);
    // Marketing-only values (channel) are stripped and reported
    expect(ok.body.data.droppedFields).toContain("channel");
    expect(ok.body.data.task.customFields).toEqual({ component: "opt_web" });
  });

  it("dragging within a column places the card between its neighbours", async () => {
    const board = (await alice.get(`/v1/lists/${L.backlog}/board`)).body.data;
    const todo: string[] = board.columns.find((c: any) => c.statusKey === "todo").taskIds;
    expect(todo.length).toBeGreaterThanOrEqual(3);
    const [a, b, c] = todo;
    await alice.post(`/v1/tasks/${c}/move`, { afterId: a, beforeId: b });
    const after = (await alice.get(`/v1/lists/${L.backlog}/board`)).body.data.columns.find((x: any) => x.statusKey === "todo").taskIds;
    expect(after.slice(0, 3)).toEqual([a, c, b]);
  });

  it("dragging to another column at a specific spot", async () => {
    const board = (await alice.get(`/v1/lists/${L.backlog}/board`)).body.data;
    const todoId = board.columns.find((c: any) => c.statusKey === "todo").taskIds[0];
    const doneTop = board.columns.find((c: any) => c.statusKey === "done").taskIds[0];
    const res = await alice.post(`/v1/tasks/${todoId}/move`, { statusKey: "done", beforeId: doneTop });
    expect(res.body.data.task.statusKey).toBe("done");
    const done = (await alice.get(`/v1/lists/${L.backlog}/board`)).body.data.columns.find((c: any) => c.statusKey === "done").taskIds;
    expect(done[0]).toBe(todoId);
  });

  it("neighbour from another column is rejected", async () => {
    const todo = await taskIn(L.backlog, "todo");
    const done = await taskIn(L.backlog, "done");
    const res = await alice.post(`/v1/tasks/${todo.id}/move`, { statusKey: "in_progress", beforeId: done.id });
    expect(res.status).toBe(400);
  });

  it("many inserts at the same spot trigger a rebalance and keep the order correct", async () => {
    const col = (await alice.get(`/v1/lists/${L.backlog}/board`)).body.data.columns.find((c: any) => c.statusKey === "todo").taskIds;
    const [first, second] = col;
    // squeeze 60 times between 'first' and whatever follows it (gap halves each time)
    let mover = col[2];
    for (let i = 0; i < 60; i++) {
      await alice.post(`/v1/tasks/${mover}/move`, { afterId: first });
      mover = mover === col[2] ? second : col[2];
    }
    const final = (await alice.get(`/v1/lists/${L.backlog}/board`)).body.data.columns.find((c: any) => c.statusKey === "todo").taskIds;
    expect(final[0]).toBe(first);
    expect(new Set(final).size).toBe(final.length);
    const { rows } = await ctx.pool.query("SELECT count(DISTINCT position)::int AS d, count(*)::int AS n FROM tasks WHERE list_id = $1 AND status_key = 'todo'", [L.backlog]);
    expect(rows[0].d).toBe(rows[0].n);
  });

  it("optimistic concurrency: a stale version is 409 VERSION_CONFLICT", async () => {
    const t = await taskIn(L.backlog, "todo");
    await alice.patch(`/v1/tasks/${t.id}`, { title: "first edit", version: t.version });
    const res = await bob.patch(`/v1/tasks/${t.id}`, { title: "stale edit", version: t.version });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("VERSION_CONFLICT");
  });
});

describe("Custom fields on tasks", () => {
  it("wrong type -> 400 with the field path in details", async () => {
    const res = await alice.post(`/v1/lists/${L.backlog}/tasks`, { title: "x", customFields: { component: "opt_api", story_points: "five" } });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatchObject({ code: "VALIDATION_ERROR", details: [{ path: "customFields.story_points" }] });
  });

  it("select value not in options -> 400", async () => {
    const res = await alice.post(`/v1/lists/${L.backlog}/tasks`, { title: "x", customFields: { component: "opt_desktop" } });
    expect(res.status).toBe(400);
    expect(res.body.error.details[0].path).toBe("customFields.component");
  });

  it("field from another branch of the tree -> 400 (not part of this list's schema)", async () => {
    const res = await alice.post(`/v1/lists/${L.backlog}/tasks`, { title: "x", customFields: { component: "opt_api", needs_qa: true } });
    expect(res.status).toBe(400);
    expect(res.body.error.details[0]).toMatchObject({ path: "customFields.needs_qa", message: "is not a field of this list" });
  });

  it("accepts a valid payload across all inherited levels (space + folder + list)", async () => {
    const res = await alice.post(`/v1/lists/${L.sprint}/tasks`, {
      title: "All levels",
      customFields: { component: "opt_web", story_points: 3, target_release: "2026-12-01", needs_qa: true },
    });
    expect(res.status).toBe(201);
    expect(res.body.data.customFields).toEqual({ component: "opt_web", story_points: 3, target_release: "2026-12-01", needs_qa: true });
  });

  it("set and clear values with PATCH (merge semantics)", async () => {
    const t = await taskIn(L.backlog, "todo");
    const set = await alice.patch(`/v1/tasks/${t.id}`, { customFields: { story_points: 13 } });
    expect(set.body.data.customFields).toMatchObject({ component: expect.any(String), story_points: 13 });
    const cleared = await alice.patch(`/v1/tasks/${t.id}`, { customFields: { story_points: null } });
    expect(cleared.body.data.customFields.story_points).toBeUndefined();
    const required = await alice.patch(`/v1/tasks/${t.id}`, { customFields: { component: null } });
    expect(required.status).toBe(400);
  });
});

describe("Required fields", () => {
  it("create without a required custom field -> 400", async () => {
    const res = await alice.post(`/v1/lists/${L.backlog}/tasks`, { title: "No component" });
    expect(res.status).toBe(400);
    expect(res.body.error.details).toEqual([{ path: "customFields.component", message: "is required" }]);
  });

  it("making a field required applies to new tasks, not retroactively", async () => {
    await alice.patch(`/v1/fields/cfd_story_points`, { required: true });
    const t = (await alice.get(`/v1/lists/${L.backlog}/tasks?statusKey=cancelled`)).body.data[0]; // has no story_points
    expect((await alice.patch(`/v1/tasks/${t.id}`, { title: "still editable" })).status).toBe(200);
    expect((await alice.post(`/v1/lists/${L.backlog}/tasks`, valid)).status).toBe(400);
  });
});

describe("List endpoint: sorting, filtering, pagination", () => {
  it("sorts by priority and due date with nulls last, and pages with a cursor", async () => {
    const all: any[] = [];
    let cursor: string | null = null;
    do {
      const res = await alice.get(`/v1/lists/${L.backlog}/tasks?sort=dueDate&limit=2${cursor ? `&cursor=${cursor}` : ""}`);
      expect(res.body.page.limit).toBe(2);
      all.push(...res.body.data);
      cursor = res.body.page.nextCursor;
    } while (cursor);
    expect(all).toHaveLength(7);
    const dues = all.map((t) => t.dueDate);
    const withDue = dues.filter(Boolean);
    expect(withDue).toEqual([...withDue].sort());
    expect(dues.slice(withDue.length).every((d) => d === null)).toBe(true);

    const byPriority = (await alice.get(`/v1/lists/${L.backlog}/tasks?sort=priority`)).body.data.map((t: any) => t.priority);
    expect(byPriority[0]).toBe("urgent");
    expect(byPriority[byPriority.length - 1]).toBe("none");
  });

  it("filters by a custom field value (single and multi select)", async () => {
    const api = (await alice.get(`/v1/lists/${L.backlog}/tasks?cf.component=opt_api`)).body.data;
    expect(api.length).toBeGreaterThan(0);
    expect(api.every((t: any) => t.customFields.component === "opt_api")).toBe(true);
    const social = (await alice.get(`/v1/lists/${L.launch}/tasks?cf.channel=opt_social`)).body.data;
    expect(social.map((t: any) => t.title).sort()).toEqual(["Paid social campaign", "Product Hunt listing"]);
    expect((await alice.get(`/v1/lists/${L.backlog}/tasks?cf.nope=1`)).status).toBe(400);
  });

  it("rejects a malformed cursor", async () => {
    const res = await alice.get(`/v1/lists/${L.backlog}/tasks?cursor=garbage`);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("INVALID_CURSOR");
  });
});
