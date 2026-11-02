import { describe, expect, it } from "vitest";
import { validateCustomValues, type FieldDef } from "../src/modules/fields.js";
import { canSee } from "../src/modules/permissions.js";
import { missingCategories, resolveStatuses, type StatusDef } from "../src/modules/statuses.js";

// Pure-function tests: no database. They pin the algorithms the README documents.

const def = (ownerId: string, key: string, over: Partial<StatusDef> = {}): StatusDef => ({
  id: `${ownerId}_${key}`,
  ownerId,
  key,
  name: key.toUpperCase(),
  category: "active",
  color: "#000000",
  position: 1,
  hidden: false,
  ...over,
});
const ws = { id: "ws", type: "workspace" as const };
const space = { id: "sp", type: "space" as const };
const list = { id: "ls", type: "list" as const };

describe("resolveStatuses (merge by key)", () => {
  const base = [
    def("ws", "todo", { category: "not_started", position: 1 }),
    def("ws", "doing", { position: 2 }),
    def("ws", "done", { category: "done", position: 3 }),
  ];

  it("inherits the parent set unchanged when a level defines nothing", () => {
    const r = resolveStatuses([{ node: ws, defs: base }, { node: space, defs: [] }, { node: list, defs: [] }]);
    expect(r.map((s) => s.key)).toEqual(["todo", "doing", "done"]);
    expect(r.every((s) => s.inherited)).toBe(true);
    expect(r[0]!.ownerId).toBe("ws");
  });

  it("overrides label/colour/order by key without changing the key", () => {
    const r = resolveStatuses([
      { node: ws, defs: base },
      { node: list, defs: [def("ls", "done", { name: "Shipped", category: "done", position: 0 })] },
    ]);
    expect(r.map((s) => [s.key, s.name])).toEqual([["done", "Shipped"], ["todo", "TODO"], ["doing", "DOING"]]);
    const done = r.find((s) => s.key === "done")!;
    expect(done).toMatchObject({ ownerId: "ls", originOwnerId: "ws", inherited: false });
  });

  it("adds new keys and hides inherited ones", () => {
    const r = resolveStatuses([
      { node: ws, defs: base },
      { node: space, defs: [def("sp", "review", { position: 2.5 })] },
      { node: list, defs: [def("ls", "doing", { hidden: true, name: null, category: null, color: null, position: null })] },
    ]);
    expect(r.map((s) => s.key)).toEqual(["todo", "review", "done"]);
  });

  it("lets a lower level re-add a key hidden above it", () => {
    const r = resolveStatuses([
      { node: ws, defs: base },
      { node: space, defs: [def("sp", "doing", { hidden: true, name: null, category: null, color: null, position: null })] },
      { node: list, defs: [def("ls", "doing", { name: "Back again", position: 2 })] },
    ]);
    expect(r.find((s) => s.key === "doing")?.name).toBe("Back again");
  });

  it("hiding a key that is not inherited is a no-op", () => {
    const r = resolveStatuses([{ node: ws, defs: [...base, def("ws", "ghost", { hidden: true })] }]);
    expect(r).toHaveLength(3);
  });

  it("reports missing required categories", () => {
    expect(missingCategories([{ category: "not_started" }, { category: "closed" }])).toEqual(["active", "done"]);
    expect(missingCategories([{ category: "not_started" }, { category: "active" }, { category: "done" }])).toEqual([]);
  });
});

describe("validateCustomValues", () => {
  const field = (key: string, type: FieldDef["type"], extra: Partial<FieldDef> = {}): FieldDef => ({
    id: key, ownerId: "x", key, name: key, type, required: false, options: [], position: 0, ...extra,
  });
  const schema = [
    field("points", "number"),
    field("component", "single_select", { required: true, options: [{ id: "opt_api", label: "API" }] }),
    field("tags", "multi_select", { options: [{ id: "a", label: "A" }, { id: "b", label: "B" }] }),
    field("due", "date"),
    field("flag", "checkbox"),
    field("note", "text"),
  ];

  it("accepts a fully valid payload", () => {
    const r = validateCustomValues(schema, { points: 3, component: "opt_api", tags: ["a", "b"], due: "2026-11-30", flag: true, note: "hi" }, { requireAll: true });
    expect(r.errors).toEqual([]);
    expect(r.values.points).toBe(3);
  });

  it.each([
    ["points", "3", "expected a finite number"],
    ["points", Number.NaN, "expected a finite number"],
    ["component", "opt_nope", "is not an option"],
    ["tags", ["a", "zzz"], "not options of this field"],
    ["tags", ["a", "a"], "duplicate"],
    ["due", "30/11/2026", "ISO date"],
    ["due", "2026-02-30T00:00:00Z", "ISO date"],
    ["flag", "true", "true or false"],
    ["note", 42, "expected a string"],
  ])("rejects %s = %j with a path", (key, value, message) => {
    const r = validateCustomValues(schema, { component: "opt_api", [key]: value }, { requireAll: true });
    expect(r.errors).toEqual([expect.objectContaining({ path: `customFields.${key}`, message: expect.stringContaining(message) })]);
  });

  it("rejects unknown keys", () => {
    const r = validateCustomValues(schema, { component: "opt_api", nope: 1 }, { requireAll: true });
    expect(r.errors[0]).toMatchObject({ path: "customFields.nope" });
  });

  it("requires required fields on create but not on a partial update", () => {
    expect(validateCustomValues(schema, { points: 1 }, { requireAll: true }).errors).toEqual([
      expect.objectContaining({ path: "customFields.component", message: "is required" }),
    ]);
    expect(validateCustomValues(schema, { points: 1 }, { requireAll: false }).errors).toEqual([]);
  });

  it("refuses to clear a required field, allows clearing an optional one", () => {
    const existing = { component: "opt_api", points: 2 };
    expect(validateCustomValues(schema, { component: null }, { existing, requireAll: false }).errors[0]?.path).toBe("customFields.component");
    expect(validateCustomValues(schema, { points: null }, { existing, requireAll: false }).values).toEqual({ component: "opt_api" });
  });

  it("drops values whose field is not in the schema (cross-list move)", () => {
    const r = validateCustomValues(schema, {}, { existing: { component: "opt_api", budget: 100 }, requireAll: true });
    expect(r.values).toEqual({ component: "opt_api" });
    expect(r.dropped).toEqual(["budget"]);
  });
});

describe("canSee", () => {
  const member = { id: "usr_bob", name: "Bob", role: "member" as const };
  const admin = { id: "usr_alice", name: "Alice", role: "admin" as const };
  const n = (id: string, visibility: "public" | "private" = "public") => ({ id, type: "list" as const, visibility });

  it("public is visible, private needs allow, deny wins, admins bypass", () => {
    expect(canSee(member, [n("a")], new Map())).toBe(true);
    expect(canSee(member, [n("a", "private")], new Map())).toBe(false);
    expect(canSee(member, [n("a", "private")], new Map([["a", "allow"]]))).toBe(true);
    expect(canSee(member, [n("a")], new Map([["a", "deny"]]))).toBe(false);
    expect(canSee(admin, [n("a", "private")], new Map([["a", "deny"]]))).toBe(true);
  });

  it("a deny on an ancestor hides everything below it, even an explicit allow", () => {
    expect(canSee(member, [n("space"), n("list")], new Map([["space", "deny"], ["list", "allow"]]))).toBe(false);
  });
});
