import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../App";
import type { Board, Task, TreeNode } from "../types";

// A small in-memory stand-in for the API, shaped exactly like the real responses.

const users = [
  { id: "usr_alice", name: "Alice", role: "admin" },
  { id: "usr_bob", name: "Bob", role: "member" },
];

const list = (id: string, name: string, visibility: "public" | "private" = "public"): TreeNode => ({ id, type: "list", name, visibility, parentId: "fld", children: [] });
const treeFor = (user: string): TreeNode => ({
  id: "wsp", type: "workspace", name: "Acme", visibility: "public", parentId: null,
  children: [{
    id: "spc", type: "space", name: "Engineering", visibility: "public", parentId: "wsp",
    children: [{
      id: "fld", type: "folder", name: "Q2 Launch", visibility: "public", parentId: "spc",
      children: [list("lst_backlog", "Backlog"), list("lst_sprint", "Sprint 12"), ...(user === "alice" ? [list("lst_incidents", "Incident Review", "private")] : [])],
    }],
  }],
});

const status = (key: string, name: string, category: string, inherited = true) => ({
  id: `sts_${key}`, key, name, category, color: "#888888", position: 0, ownerType: "workspace", ownerId: "wsp", originOwnerId: "wsp", inherited,
});

let task: Task;
const boardFor = (listId: string): Board => ({
  list: { id: listId, name: listId === "lst_sprint" ? "Sprint 12" : "Backlog" },
  statuses: (listId === "lst_sprint"
    ? [status("todo", "Ready", "not_started", false), status("in_progress", "In Progress", "active"), status("in_review", "In Review", "active", false), status("done", "Done", "done")]
    : [status("todo", "To Do", "not_started"), status("in_progress", "In Progress", "active"), status("done", "Done", "done")]) as Board["statuses"],
  fields: [
    { id: "cfd_component", ownerId: "spc", ownerType: "space", inherited: true, key: "component", name: "Component", type: "single_select", required: true, options: [{ id: "opt_api", label: "API" }, { id: "opt_web", label: "Web" }], position: 1 },
    { id: "cfd_points", ownerId: "spc", ownerType: "space", inherited: true, key: "story_points", name: "Story points", type: "number", required: false, options: [], position: 2 },
  ],
  columns: [{ statusKey: "in_review", taskIds: listId === "lst_sprint" ? [task.id] : [] }],
  tasks: listId === "lst_sprint" ? [task] : [],
  truncated: false,
});

const calls: { method: string; url: string; body?: any; user: string }[] = [];

function fakeFetch(input: RequestInfo | URL, init?: RequestInit) {
  const url = String(input);
  const method = init?.method ?? "GET";
  const user = (init?.headers as Record<string, string>)["x-user-id"]!;
  const body = init?.body ? JSON.parse(String(init.body)) : undefined;
  calls.push({ method, url, body, user });
  const ok = (data: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } }));
  if (url === "/v1/users") return ok({ data: users });
  if (url === "/v1/me") return ok({ data: users.find((u) => u.id === `usr_${user}`) });
  if (url === "/v1/tree") return ok({ data: treeFor(user) });
  const board = url.match(/^\/v1\/lists\/(\w+)\/board$/);
  if (board) return ok({ data: boardFor(board[1]!) });
  if (url === `/v1/tasks/${task.id}` && method === "GET") return ok({ data: task });
  if (url === `/v1/tasks/${task.id}` && method === "PATCH") {
    task = { ...task, customFields: { ...task.customFields, ...body.customFields }, version: task.version + 1 };
    return ok({ data: task });
  }
  if (url === `/v1/tasks/${task.id}/activity`) return ok({ data: [] });
  return ok({ error: { code: "NOT_MOCKED", message: url } }, 404);
}

function renderApp() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}><App /></QueryClientProvider>);
}

beforeEach(() => {
  task = {
    id: "tsk_1", listId: "lst_sprint", title: "Task detail drawer", description: null, statusKey: "in_review", priority: "normal",
    assigneeIds: ["usr_bob"], dueDate: null, customFields: { component: "opt_web", story_points: 3 }, position: 1024, version: 4,
    createdAt: "2026-11-01T00:00:00Z", updatedAt: "2026-11-01T00:00:00Z",
  };
  calls.length = 0;
  localStorage.setItem("flowboard.user", "alice");
  window.location.hash = "";
  vi.stubGlobal("fetch", vi.fn(fakeFetch));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Flowboard UI", () => {
  it("select list -> see its resolved kanban columns -> open task -> edit a custom field -> save", async () => {
    const user = userEvent.setup();
    renderApp();

    await user.click(await screen.findByRole("link", { name: "Sprint 12" }));

    // columns are the list's resolved statuses (Sprint 12 renames To Do -> Ready and adds In Review)
    const columns = await screen.findAllByRole("region");
    expect(columns.map((c) => c.getAttribute("aria-label"))).toEqual(["Ready", "In Progress", "In Review", "Done"]);

    await user.click(within(screen.getByRole("region", { name: "In Review" })).getByText("Task detail drawer"));
    const drawer = await screen.findByRole("dialog", { name: "Task details" });
    const points = await within(drawer).findByLabelText(/Story points/);
    expect(points).toHaveValue(3);

    await user.clear(points);
    await user.type(points, "8");
    await user.click(within(drawer).getByRole("button", { name: "Save" }));

    await within(drawer).findByRole("status"); // "Saved"
    const save = calls.find((c) => c.method === "PATCH");
    // only the changed custom field is sent, with the version for optimistic concurrency
    expect(save?.body).toMatchObject({ customFields: { story_points: 8 }, version: 4 });
    expect(save?.body.customFields).not.toHaveProperty("component");
    expect(save?.user).toBe("alice");
  });

  it("switching the acting user from Alice to Bob hides the private list", async () => {
    const user = userEvent.setup();
    renderApp();
    expect(await screen.findByRole("link", { name: "Incident Review" })).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText("Acting user"), "bob");
    await waitFor(() => expect(screen.queryByRole("link", { name: "Incident Review" })).not.toBeInTheDocument());
    expect(screen.getByRole("link", { name: "Backlog" })).toBeInTheDocument();
    expect(calls.filter((c) => c.url === "/v1/tree").map((c) => c.user)).toContain("bob");
  });
});
