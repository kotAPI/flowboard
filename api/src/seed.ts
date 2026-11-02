import type pg from "pg";
import { createPool, tx } from "./lib/db.js";
import { migrate } from "./lib/migrate.js";

/**
 * Deterministic demo data with readable ids, used by the stack on first boot, by tests and by the
 * CLI cookbook.
 *
 * Acme (workspace)                     statuses: To Do, In Progress, Done, Cancelled
 * ├── Engineering (space, public)      + Blocked              fields: component* (single_select), story_points
 * │   └── Q2 Launch (folder)                                  fields: target_release (date)
 * │       ├── Backlog (list)
 * │       ├── Sprint 12 (list)         To Do -> "Ready", + In Review, - Cancelled   fields: needs_qa (checkbox)
 * │       └── Incident Review (list, private; Carol allowed)
 * └── Marketing (space, public; Bob denied)   To Do -> "Idea", In Progress -> "Drafting"   fields: channel (multi_select)
 *     └── Campaigns (folder)
 *         └── Launch Plan (list)       + Scheduled            fields: budget (number), brief (text)
 */
export const SEED = {
  users: { alice: "usr_alice", bob: "usr_bob", carol: "usr_carol" },
  workspace: "wsp_acme",
  spaces: { eng: "spc_engineering", mkt: "spc_marketing" },
  folders: { q2: "fld_q2_launch", campaigns: "fld_campaigns" },
  lists: { backlog: "lst_backlog", sprint: "lst_sprint_12", incidents: "lst_incident_review", launch: "lst_launch_plan" },
} as const;

const S = SEED;

export async function seed(pool: pg.Pool, opts: { onlyIfEmpty?: boolean; log?: (m: string) => void } = {}): Promise<void> {
  const log = opts.log ?? console.log;
  await tx(pool, async (c) => {
    if (opts.onlyIfEmpty) {
      const { rows } = await c.query("SELECT count(*)::int AS n FROM users");
      if (rows[0].n > 0) return log("seed: data present, skipping");
    }
    await c.query(`INSERT INTO users (id, name, role) VALUES
      ('${S.users.alice}', 'Alice', 'admin'), ('${S.users.bob}', 'Bob', 'member'), ('${S.users.carol}', 'Carol', 'member')`);

    const nodes: [string, string, string | null, string, number, string][] = [
      [S.workspace, "workspace", null, "Acme", 0, "public"],
      [S.spaces.eng, "space", S.workspace, "Engineering", 1024, "public"],
      [S.spaces.mkt, "space", S.workspace, "Marketing", 2048, "public"],
      [S.folders.q2, "folder", S.spaces.eng, "Q2 Launch", 1024, "public"],
      [S.folders.campaigns, "folder", S.spaces.mkt, "Campaigns", 1024, "public"],
      [S.lists.backlog, "list", S.folders.q2, "Backlog", 1024, "public"],
      [S.lists.sprint, "list", S.folders.q2, "Sprint 12", 2048, "public"],
      [S.lists.incidents, "list", S.folders.q2, "Incident Review", 3072, "private"],
      [S.lists.launch, "list", S.folders.campaigns, "Launch Plan", 1024, "public"],
    ];
    for (const n of nodes) {
      await c.query("INSERT INTO nodes (id, type, parent_id, name, position, visibility) VALUES ($1, $2, $3, $4, $5, $6)", n);
    }

    await c.query(`INSERT INTO grants (id, node_id, user_id, mode) VALUES
      ('grt_bob_mkt', '${S.spaces.mkt}', '${S.users.bob}', 'deny'),
      ('grt_carol_incidents', '${S.lists.incidents}', '${S.users.carol}', 'allow')`);

    // [id, owner, key, name, category, color, position, hidden]
    const statuses: [string, string, string, string | null, string | null, string | null, number | null, boolean][] = [
      ["sts_ws_todo", S.workspace, "todo", "To Do", "not_started", "#94a3b8", 1024, false],
      ["sts_ws_in_progress", S.workspace, "in_progress", "In Progress", "active", "#3b82f6", 2048, false],
      ["sts_ws_done", S.workspace, "done", "Done", "done", "#22c55e", 4096, false],
      ["sts_ws_cancelled", S.workspace, "cancelled", "Cancelled", "closed", "#64748b", 5120, false],
      ["sts_eng_blocked", S.spaces.eng, "blocked", "Blocked", "active", "#ef4444", 2560, false],
      ["sts_sprint_todo", S.lists.sprint, "todo", "Ready", "not_started", "#0ea5e9", 1024, false],
      ["sts_sprint_review", S.lists.sprint, "in_review", "In Review", "active", "#a855f7", 3072, false],
      ["sts_sprint_hide_cancelled", S.lists.sprint, "cancelled", null, null, null, null, true],
      ["sts_mkt_todo", S.spaces.mkt, "todo", "Idea", "not_started", "#f59e0b", 1024, false],
      ["sts_mkt_in_progress", S.spaces.mkt, "in_progress", "Drafting", "active", "#3b82f6", 2048, false],
      ["sts_launch_scheduled", S.lists.launch, "scheduled", "Scheduled", "active", "#14b8a6", 3072, false],
    ];
    for (const s of statuses) {
      await c.query(
        "INSERT INTO status_defs (id, owner_id, key, name, category, color, position, hidden) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
        s,
      );
    }

    const opt = (id: string, label: string, color: string) => ({ id, label, color });
    // [id, owner, key, name, type, required, options, position]
    const fields: [string, string, string, string, string, boolean, object[], number][] = [
      ["cfd_component", S.spaces.eng, "component", "Component", "single_select", true,
        [opt("opt_api", "API", "#6366f1"), opt("opt_web", "Web", "#0ea5e9"), opt("opt_mobile", "Mobile", "#f97316"), opt("opt_infra", "Infra", "#64748b")], 1024],
      ["cfd_story_points", S.spaces.eng, "story_points", "Story points", "number", false, [], 2048],
      ["cfd_target_release", S.folders.q2, "target_release", "Target release", "date", false, [], 1024],
      ["cfd_needs_qa", S.lists.sprint, "needs_qa", "Needs QA", "checkbox", false, [], 1024],
      ["cfd_channel", S.spaces.mkt, "channel", "Channel", "multi_select", false,
        [opt("opt_email", "Email", "#22c55e"), opt("opt_social", "Social", "#ec4899"), opt("opt_blog", "Blog", "#8b5cf6"), opt("opt_ads", "Ads", "#f59e0b")], 1024],
      ["cfd_budget", S.lists.launch, "budget", "Budget (USD)", "number", false, [], 1024],
      ["cfd_brief", S.lists.launch, "brief", "Brief", "text", false, [], 2048],
    ];
    for (const f of fields) {
      await c.query(
        "INSERT INTO field_defs (id, owner_id, key, name, type, required, options, position) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
        [...f.slice(0, 6), JSON.stringify(f[6]), f[7]],
      );
    }

    const rank = { urgent: 0, high: 1, normal: 2, low: 3, none: 4 } as const;
    const day = (d: number) => new Date(Date.UTC(2026, 10, 2 + d, 12)).toISOString();
    const { alice, bob, carol } = S.users;
    // [list, title, status, priority, assignees, due (days from Nov 2), custom fields]
    const tasks: [string, string, string, keyof typeof rank, string[], number | null, Record<string, unknown>][] = [
      [S.lists.backlog, "Rate-limit the public API", "todo", "high", [bob], 10, { component: "opt_api", story_points: 5 }],
      [S.lists.backlog, "Dark mode for settings", "todo", "low", [], null, { component: "opt_web", story_points: 3 }],
      [S.lists.backlog, "Offline drafts on iOS", "todo", "normal", [carol], 21, { component: "opt_mobile", story_points: 8, target_release: "2026-12-15" }],
      [S.lists.backlog, "Migrate CI runners to ARM", "in_progress", "normal", [alice], 6, { component: "opt_infra", story_points: 5 }],
      [S.lists.backlog, "Audit log export", "blocked", "high", [bob], 4, { component: "opt_api", story_points: 3 }],
      [S.lists.backlog, "Retire v0 webhooks", "cancelled", "none", [], null, { component: "opt_api" }],
      [S.lists.backlog, "Upgrade Postgres to 16", "done", "urgent", [alice], -3, { component: "opt_infra", story_points: 2 }],
      [S.lists.sprint, "Kanban drag-and-drop polish", "in_progress", "high", [carol], 3, { component: "opt_web", story_points: 5, needs_qa: true }],
      [S.lists.sprint, "Task detail drawer", "in_review", "normal", [bob], 2, { component: "opt_web", story_points: 3, needs_qa: true }],
      [S.lists.sprint, "Scoped status resolver", "done", "urgent", [alice], -1, { component: "opt_api", story_points: 8 }],
      [S.lists.sprint, "Custom field validation", "in_review", "high", [alice, bob], 2, { component: "opt_api", story_points: 5, needs_qa: false }],
      [S.lists.sprint, "Push notification opt-in", "todo", "normal", [carol], 9, { component: "opt_mobile", story_points: 3 }],
      [S.lists.sprint, "Flaky e2e on Safari", "blocked", "urgent", [bob], 1, { component: "opt_web", story_points: 2, needs_qa: true }],
      [S.lists.sprint, "Sidebar keyboard navigation", "todo", "low", [], 12, { component: "opt_web", story_points: 2 }],
      [S.lists.incidents, "Postmortem: Oct 28 API outage", "in_progress", "urgent", [carol], 1, { component: "opt_api", story_points: 3 }],
      [S.lists.incidents, "Rotate leaked staging key", "done", "urgent", [alice], -5, { component: "opt_infra" }],
      [S.lists.incidents, "Add disk alerts to db hosts", "todo", "high", [carol], 5, { component: "opt_infra", story_points: 2 }],
      [S.lists.launch, "Launch announcement blog post", "in_progress", "high", [carol], 8, { channel: ["opt_blog"], brief: "Lead with scoped statuses." }],
      [S.lists.launch, "Email to beta users", "todo", "normal", [alice], 9, { channel: ["opt_email"], budget: 0 }],
      [S.lists.launch, "Paid social campaign", "scheduled", "normal", [carol], 14, { channel: ["opt_social", "opt_ads"], budget: 2500 }],
      [S.lists.launch, "Product Hunt listing", "todo", "high", [], 15, { channel: ["opt_social"] }],
      [S.lists.launch, "Customer case study", "done", "low", [carol], -7, { channel: ["opt_blog", "opt_email"], budget: 400 }],
      [S.lists.launch, "Webinar with design partners", "cancelled", "none", [], null, { channel: ["opt_email"] }],
      [S.lists.launch, "Press kit refresh", "scheduled", "low", [alice], 11, { budget: 150 }],
    ];
    const positions = new Map<string, number>();
    for (const [i, [list, title, status, priority, assignees, due, cf]] of tasks.entries()) {
      const col = `${list}:${status}`;
      const position = (positions.get(col) ?? 0) + 1024;
      positions.set(col, position);
      await c.query(
        `INSERT INTO tasks (id, list_id, title, status_key, priority, priority_rank, assignee_ids, due_date, custom_fields, position, created_by, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, now() - make_interval(hours => $12))`,
        [`tsk_${String(i + 1).padStart(3, "0")}`, list, title, status, priority, rank[priority], assignees,
          due === null ? null : day(due), JSON.stringify(cf), position, alice, tasks.length - i],
      );
    }
    log(`seed: ${tasks.length} tasks, ${statuses.length} status defs, ${fields.length} fields, 3 users`);
  });
}

/** Test helper: wipe everything and re-seed. */
export async function resetDatabase(pool: pg.Pool): Promise<void> {
  await pool.query("TRUNCATE activity, outbox, tasks, field_defs, status_defs, grants, nodes, users RESTART IDENTITY CASCADE");
  await seed(pool, { log: () => {} });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const pool = createPool();
  await migrate(pool);
  if (process.argv.includes("--reset")) await resetDatabase(pool);
  else await seed(pool, { onlyIfEmpty: true });
  await pool.end();
}
