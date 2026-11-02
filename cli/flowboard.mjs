#!/usr/bin/env node
// Flowboard CLI: a second channel on the same /v1 API the web UI uses. Zero dependencies (Node 18+).
//
// Auth: uses a short-lived JWT (Bearer) rather than the X-User-Id header the SPA uses, to show the
// API accepts both. The token is fetched from /v1/auth/token for $FLOWBOARD_USER (default alice),
// or taken from $FLOWBOARD_TOKEN if set.
//
//   node cli/flowboard.mjs tree
//   node cli/flowboard.mjs board lst_sprint_12
//   node cli/flowboard.mjs tasks lst_backlog --sort dueDate --cf component=opt_api
//   node cli/flowboard.mjs create lst_backlog "Fix login" --cf component=opt_web --cf story_points=3
//   node cli/flowboard.mjs move tsk_001 --status in_progress [--list lst_sprint_12]
//   FLOWBOARD_USER=bob node cli/flowboard.mjs tree

const BASE = process.env.FLOWBOARD_URL ?? "http://localhost:8080";
const USER = process.env.FLOWBOARD_USER ?? "alice";

async function token() {
  if (process.env.FLOWBOARD_TOKEN) return process.env.FLOWBOARD_TOKEN;
  const res = await fetch(`${BASE}/v1/auth/token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ userId: USER }),
  });
  const body = await res.json();
  if (!res.ok) fail(body);
  return body.data.token;
}

let bearer;
async function call(method, path, body) {
  bearer ??= await token();
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { authorization: `Bearer ${bearer}`, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return null;
  const json = await res.json();
  if (!res.ok) fail(json, res.status);
  return json;
}

function fail(body, status) {
  const e = body?.error ?? { code: "ERROR", message: JSON.stringify(body) };
  console.error(`✗ ${status ?? ""} ${e.code}: ${e.message}`);
  for (const d of e.details ?? []) console.error(`  - ${d.path ?? ""} ${d.message}`);
  process.exit(1);
}

function flags(args) {
  const out = { _: [], cf: {} };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--cf") {
      const [k, ...v] = args[++i].split("=");
      out.cf[k] = parseValue(v.join("="));
    } else if (a.startsWith("--")) out[a.slice(2)] = args[++i];
    else out._.push(a);
  }
  return out;
}

/** "3" -> 3, "true" -> true, "a,b" -> ["a","b"], else string */
function parseValue(v) {
  if (v === "true" || v === "false") return v === "true";
  if (v !== "" && !Number.isNaN(Number(v))) return Number(v);
  if (v.includes(",")) return v.split(",");
  return v;
}

function printTree(node, depth = 0) {
  const icon = { workspace: "■", space: "◆", folder: "▸", list: "≡" }[node.type];
  console.log(`${"  ".repeat(depth)}${icon} ${node.name}  ${node.type === "list" ? node.id : ""}${node.visibility === "private" ? " (private)" : ""}`);
  for (const c of node.children) printTree(c, depth + 1);
}

const [cmd, ...rest] = process.argv.slice(2);
const f = flags(rest);

switch (cmd) {
  case "tree": {
    printTree((await call("GET", "/v1/tree")).data);
    break;
  }
  case "board": {
    const { data } = await call("GET", `/v1/lists/${f._[0]}/board`);
    const byId = new Map(data.tasks.map((t) => [t.id, t]));
    console.log(`${data.list.name}\n`);
    for (const s of data.statuses) {
      const col = data.columns.find((c) => c.statusKey === s.key);
      console.log(`[${s.name}] (${s.key}, ${s.category}${s.inherited ? `, from ${s.ownerType}` : ""})`);
      for (const id of col.taskIds) console.log(`   ${id}  ${byId.get(id).title}`);
    }
    break;
  }
  case "tasks": {
    const q = new URLSearchParams({ limit: f.limit ?? "50", sort: f.sort ?? "position", order: f.order ?? "asc" });
    for (const [k, v] of Object.entries(f.cf)) q.set(`cf.${k}`, String(v));
    let cursor = "";
    do {
      if (cursor) q.set("cursor", cursor);
      const res = await call("GET", `/v1/lists/${f._[0]}/tasks?${q}`);
      for (const t of res.data) console.log(`${t.id}  ${t.statusKey.padEnd(12)} ${t.priority.padEnd(7)} ${(t.dueDate ?? "").slice(0, 10).padEnd(10)}  ${t.title}`);
      cursor = res.page.nextCursor;
    } while (cursor);
    break;
  }
  case "create": {
    const [listId, title] = f._;
    const { data } = await call("POST", `/v1/lists/${listId}/tasks`, {
      title,
      ...(f.status ? { statusKey: f.status } : {}),
      ...(f.priority ? { priority: f.priority } : {}),
      customFields: f.cf,
    });
    console.log(`✓ created ${data.id} in ${data.statusKey}`);
    break;
  }
  case "move": {
    const { data } = await call("POST", `/v1/tasks/${f._[0]}/move`, {
      ...(f.list ? { listId: f.list } : {}),
      ...(f.status ? { statusKey: f.status } : {}),
      ...(Object.keys(f.cf).length ? { customFields: f.cf } : {}),
      ...(f["on-missing-status"] ? { onMissingStatus: f["on-missing-status"] } : {}),
    });
    console.log(`✓ ${data.task.id} -> ${data.task.listId} / ${data.task.statusKey}`);
    if (data.statusMapped) console.log(`  status mapped ${data.statusMapped.from} -> ${data.statusMapped.to}`);
    if (data.droppedFields.length) console.log(`  dropped fields: ${data.droppedFields.join(", ")}`);
    break;
  }
  case "statuses": {
    for (const s of (await call("GET", `/v1/lists/${f._[0]}/resolved-statuses`)).data) {
      console.log(`${s.key.padEnd(12)} ${s.name.padEnd(14)} ${s.category.padEnd(12)} ${s.inherited ? `inherited (${s.ownerType})` : "local"}`);
    }
    break;
  }
  default:
    console.log("usage: flowboard <tree | board <listId> | tasks <listId> | create <listId> <title> | move <taskId> | statuses <listId>> [--cf key=value] [--status key] [--list id] [--sort dueDate|priority|position]");
    process.exit(cmd ? 1 : 0);
}
