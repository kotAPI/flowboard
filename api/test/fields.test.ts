import { describe, expect, it } from "vitest";
import { alice, ctx, SEED, useTestApp } from "./helpers.js";

useTestApp();

const L = SEED.lists;

describe("Field definitions and resolution", () => {
  it("resolved schema = space + folder + list fields, in that order", async () => {
    const keys = (await alice.get(`/v1/lists/${L.sprint}/resolved-fields`)).body.data.map((f: any) => f.key);
    expect(keys).toEqual(["component", "story_points", "target_release", "needs_qa"]);
    const backlog = (await alice.get(`/v1/lists/${L.backlog}/resolved-fields`)).body.data.map((f: any) => f.key);
    expect(backlog).toEqual(["component", "story_points", "target_release"]);
  });

  it("key collisions on the same path are rejected in both directions", async () => {
    // ancestor already has it
    const down = await alice.post(`/v1/lists/${L.backlog}/fields`, { key: "component", name: "C", type: "text" });
    expect(down.status).toBe(409);
    expect(down.body.error).toMatchObject({ code: "FIELD_KEY_CONFLICT", details: [{ ownerId: SEED.spaces.eng }] });
    // descendant already has it
    const up = await alice.post(`/v1/spaces/${SEED.spaces.eng}/fields`, { key: "needs_qa", name: "QA", type: "checkbox" });
    expect(up.status).toBe(409);
    // same key on a different branch is fine
    const other = await alice.post(`/v1/lists/${L.backlog}/fields`, { key: "needs_qa", name: "QA", type: "checkbox" });
    expect(other.status).toBe(201);
  });

  it("select fields need unique options; non-select fields take none", async () => {
    expect((await alice.post(`/v1/lists/${L.backlog}/fields`, { key: "sev", name: "Sev", type: "single_select" })).status).toBe(400);
    expect((await alice.post(`/v1/lists/${L.backlog}/fields`, { key: "sev", name: "Sev", type: "single_select", options: [{ label: "A" }, { label: "a" }] })).status).toBe(400);
    expect((await alice.post(`/v1/lists/${L.backlog}/fields`, { key: "sev", name: "Sev", type: "number", options: [{ label: "A" }] })).status).toBe(400);
    const ok = await alice.post(`/v1/lists/${L.backlog}/fields`, { key: "sev", name: "Sev", type: "single_select", options: [{ label: "S1" }, { label: "S2" }] });
    expect(ok.status).toBe(201);
    expect(ok.body.data.options.every((o: any) => o.id.startsWith("opt_"))).toBe(true);
  });

  it("type is immutable", async () => {
    const res = await alice.patch(`/v1/fields/cfd_story_points`, { type: "text" });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("FIELD_TYPE_IMMUTABLE");
  });

  it("removing a select option that tasks use -> 409; renaming it is fine", async () => {
    const options = [{ id: "opt_api", label: "API" }, { id: "opt_web", label: "Web" }, { id: "opt_infra", label: "Infra" }]; // drop opt_mobile
    const res = await alice.patch(`/v1/fields/cfd_component`, { options });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("FIELD_OPTION_IN_USE");
    const renamed = await alice.patch(`/v1/fields/cfd_component`, { options: [...options, { id: "opt_mobile", label: "iOS + Android" }] });
    expect(renamed.status).toBe(200);
  });

  it("removing a multi_select option in use -> 409", async () => {
    const res = await alice.patch(`/v1/fields/cfd_channel`, { options: [{ id: "opt_email", label: "Email" }, { id: "opt_blog", label: "Blog" }, { id: "opt_ads", label: "Ads" }] });
    expect(res.status).toBe(409);
  });

  it("deleting a field strips its values from every task under the owner", async () => {
    const res = await alice.delete(`/v1/fields/cfd_story_points`);
    expect(res.status).toBe(200);
    expect(res.body.data.strippedFromTasks).toBeGreaterThan(0);
    const { rows } = await ctx.pool.query("SELECT count(*)::int AS n FROM tasks WHERE custom_fields ? 'story_points'");
    expect(rows[0].n).toBe(0);
    // and the key can be reused with another type
    expect((await alice.post(`/v1/spaces/${SEED.spaces.eng}/fields`, { key: "story_points", name: "Size", type: "text" })).status).toBe(201);
  });
});
