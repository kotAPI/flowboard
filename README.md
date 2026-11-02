# Flowboard

A small project-management app (a mini ClickUp) for one workspace. It has a workspace → space → folder → list tree, tasks with typed custom fields, statuses that can differ per space, folder or list through inheritance, a kanban board and a list view, and allow/deny permissions.

**Stack:** Node 22 + TypeScript (Fastify, Zod, `pg`) · PostgreSQL 16 · React 19 + Vite (TanStack Query, dnd-kit) · an outbox worker · Docker Compose.

**Stretch goals attempted (two):** an activity feed fed asynchronously through the outbox worker, and filtering the list view by a custom-field value.

---

## 1. Run it

```bash
cp .env.example .env        # optional; every value has a default
docker compose up --build
```

| What | URL |
| --- | --- |
| Web UI | http://localhost:8080 |
| API (direct) | http://localhost:3000/v1 (also proxied at http://localhost:8080/v1) |
| Postgres | localhost:5433 (`flowboard` / `flowboard`) |

The first boot migrates the database and seeds the demo workspace. Later boots leave existing data alone. `make seed` wipes and reseeds; `make reset` deletes the volume.

**Users.** There's no login screen. Use the *Acting as* menu at the top right.

| User | Role | Sees |
| --- | --- | --- |
| Alice (`alice`) | admin | everything, and can change configuration |
| Bob (`bob`) | member | Engineering → Q2 Launch → Backlog and Sprint 12. Marketing is denied to him, and Incident Review is private. |
| Carol (`carol`) | member | Everything Bob sees, plus Incident Review (explicit allow) and Marketing |

**Demo path.**
1. Open Q2 Launch in the sidebar and compare **Backlog** with **Sprint 12**. Their columns differ: Sprint 12 renames *To Do* to *Ready*, adds *In Review* and hides *Cancelled*.
2. Open a card and edit *Story points*.
3. Switch to Bob. Marketing and Incident Review disappear, and opening `#/lists/lst_incident_review/board` directly shows *No access* (a 403 from the API).

**Tests**

```bash
make test        # = make test-api test-web, both run inside Docker
```

To run them locally instead: `cd api && npm i && TEST_DATABASE_URL=postgres://flowboard:flowboard@localhost:5433/flowboard_test npx vitest run`, and `cd web && npm i && npx vitest run`.

---

## 2. System design

```mermaid
flowchart LR
  subgraph Clients["Clients (untrusted)"]
    SPA["React SPA<br/>X-User-Id header"]
    CLI["CLI (cli/flowboard.mjs)<br/>Bearer JWT"]
    HOOK["Webhook consumers<br/>(receive task.* events)"]
  end

  subgraph Edge["Edge / BFF seam"]
    NGINX["nginx<br/>static SPA + /v1 proxy"]
  end

  subgraph API["API process (stateless, N replicas)"]
    AUTH["Auth boundary<br/>authenticate(): header/JWT → user row"]
    ROUTES["HTTP layer<br/>Zod validation · error shape · pagination"]
    PERM["permissions.authorize()<br/>single enforcement point"]
    subgraph Modules["Domain modules"]
      H["hierarchy"]
      ST["statuses<br/>resolveStatuses()"]
      F["fields<br/>resolveFields() · validateCustomValues()"]
      T["tasks"]
      ID["identity"]
    end
  end

  subgraph Data["PostgreSQL"]
    NODES[("nodes<br/>(workspace/space/folder/list)")]
    DEFS[("status_defs · field_defs<br/>owner_id → nodes")]
    TASKS[("tasks<br/>status_key · custom_fields jsonb")]
    GRANTS[("grants")]
    OUTBOX[("outbox")]
    ACT[("activity")]
  end

  WORKER["Worker process<br/>drains outbox (SKIP LOCKED)"]

  SPA --> NGINX --> AUTH
  CLI --> NGINX
  AUTH --> ROUTES --> PERM --> Modules
  Modules --> NODES & DEFS & TASKS & GRANTS
  T -- "same transaction" --> OUTBOX
  WORKER -- poll/claim --> OUTBOX
  WORKER --> ACT
  WORKER -. "POST (stubbed: logged)" .-> HOOK
```

**Trust boundaries.**
- Everything left of the auth boundary is untrusted.
- `authenticate()` turns the `X-User-Id` header or a Bearer JWT into a user loaded from the `users` table. The role always comes from that row; any role in a JWT claim or the request body is ignored.
- Every route then calls `authorize(user, containerId, action)`. It returns **404** if the container doesn't exist (or is archived) and **403** if the caller can't see it or act on it. For a task, the check runs on the task's list. A move checks both the source and the destination list.
- The tree endpoint uses the same `canSee()` rule to prune hidden subtrees.
- The worker is internal and trusted. It only ever reads rows the API has already committed.

**Where statuses and field schemas live.**
- `status_defs` and `field_defs` rows are *owned by* a container (`owner_id` → `nodes`). Statuses can be owned at any level, including the workspace; custom fields at a space, folder or list.
- The resolved set for a list is computed on read by walking the list's ancestor chain (one recursive CTE plus one query for the definitions). It is never stored, so a change at a higher level appears below it immediately.

### Request flow: "load board + drag card"

```mermaid
sequenceDiagram
  participant UI as SPA
  participant N as nginx
  participant A as API
  participant DB as Postgres
  participant W as Worker

  UI->>N: GET /v1/lists/lst_sprint_12/board (X-User-Id: bob)
  N->>A: proxy
  A->>DB: users row (authenticate)
  A->>DB: ancestor chain + bob's grants → canSee? (else 403)
  A->>DB: status_defs + field_defs for chain
  A->>A: resolveStatuses / resolveFields (pure)
  A->>DB: tasks WHERE list_id ORDER BY position (tasks_board_idx)
  A-->>UI: { list, statuses (columns), fields, columns[{statusKey, taskIds}], tasks }

  Note over UI: drag card to "In Review", between two cards (optimistic)
  UI->>A: POST /v1/tasks/tsk_009/move { statusKey, afterId, beforeId, version }
  A->>DB: BEGIN; task FOR UPDATE; authorize write on list
  A->>A: statusKey ∈ resolved set? (else 400) · version matches? (else 409)
  A->>DB: lock column, position = midpoint(after, before) (rebalance if gap < 1e-6)
  A->>DB: UPDATE tasks ...; INSERT outbox(task.status_changed); COMMIT
  A-->>UI: { task, statusMapped, droppedFields }
  Note over UI: on error: roll back local columns, refetch board
  W->>DB: claim outbox rows (FOR UPDATE SKIP LOCKED)
  W->>DB: INSERT activity ... ON CONFLICT (event_id) DO NOTHING; mark processed
```

### Modules

| Module | Owns | Code |
| --- | --- | --- |
| identity | users, auth boundary, JWT issuing | `api/src/modules/identity.ts` |
| hierarchy | the container tree, ordering, archiving | `api/src/modules/hierarchy.ts` |
| permissions | grants, visibility rule, `authorize()` | `api/src/modules/permissions.ts` |
| statuses | status definitions, resolution, config-safety | `api/src/modules/statuses.ts` |
| fields | field definitions, resolution, value validation | `api/src/modules/fields.ts` |
| tasks | task CRUD, move/reorder, list/board reads | `api/src/modules/tasks.ts` |
| events / activity | outbox producer, activity projection | `api/src/modules/events.ts`, `activity.ts`, `api/src/worker.ts` |

Modules call each other only through exported functions, never through each other's tables. That boundary is where a module would be split out into its own service later.

---

## 3. Data model

```
users(id, name, role)
nodes(id, type, parent_id, name, position, visibility, archived_at)    -- the whole tree, one table
grants(node_id, user_id, mode allow|deny)
status_defs(owner_id → nodes, key, name, category, color, position, hidden, archived_at)
field_defs(owner_id → nodes, key, name, type, required, options jsonb, position, archived_at)
tasks(list_id → nodes, title, description, status_key, priority, priority_rank, assignee_ids[],
      due_date, custom_fields jsonb, position, version, archived_at, ...)
outbox(event_id, type, payload, attempts, available_at, processed_at, dead_at)
activity(event_id UNIQUE, task_id, list_id, actor_id, summary)
```

The schema is in [`api/migrations/001_init.sql`](api/migrations/001_init.sql) and applied by a small runner that holds an advisory lock while migrating.

**Hierarchy rules.**
- Valid parents are strictly workspace → space → folder → list. Lists hold tasks only.
- Siblings are ordered by a fractional `position`. Reorder with `POST .../reorder { beforeId | afterId }`.
- **Deleting is a soft delete (archive).** It sets `archived_at` on the container, everything below it and their tasks, in one transaction. Archived things return 404 and drop out of the tree. Nothing is physically removed, so a restore endpoint can be added later.

### Status inheritance: merge by key

Each container can hold status definitions. Resolving the set for a container walks from the root down:

```
resolved = {}
for level in [workspace, space, folder, list]:          # root → leaf
  for def in level.defs ordered by position:
    if def.hidden:              remove resolved[def.key]              # hide an inherited status
    elif def.key in resolved:   overwrite name/category/color/position # override
    else:                       resolved[def.key] = def                # add
sort by (position, depth where the key first appeared, key)
```

- **Tasks store the stable `status_key`, not a definition id.** Renaming, recolouring, reordering or recategorising a status at any level never touches a task row. The brief allows a "stable `statusKey`", and this is why the API field is `statusKey` rather than `statusId`.
- A definition can be one of three things: a new key (needs a name and category), an **override** of an inherited key (any attribute left out is copied from the parent), or a **hide** row (`hidden: true`, which only works on an inherited key). A key hidden at one level can be added back lower down.
- Every resolved set must contain at least one `not_started`, one `active` and one `done` status. **This is checked for the changed container and every container below it**, so a change at the workspace can't break a list three levels down. A violation returns `422 STATUS_SET_INVALID`, with the failing container and the missing categories in `details`.
- `GET /v1/lists/:id/resolved-statuses` (available on every container) shows each status with `ownerId` (the last level that shaped it), `originOwnerId` (where the key was first introduced) and `inherited`. The config UI uses these to label rows "inherited from Engineering", "overrides Acme" or "defined here".

### Custom-field resolution: union with no shadowing

- A list's schema is every field defined on its space, folder and itself, ordered by depth and then position.
- **A key must be unique along any root-to-leaf path.** Creating a field whose key already exists above *or* below the owner returns `409 FIELD_KEY_CONFLICT`. Overriding a field's type halfway down the tree would make the same payload key mean different things in sibling lists, so this ambiguity is ruled out. Sibling branches can reuse a key.
- Values live in `tasks.custom_fields` (jsonb, `key → value`). Select fields store **option ids**, so renaming or recolouring an option never touches tasks.

| Type | Accepted value |
| --- | --- |
| `text` | string up to 10k characters (non-empty if required) |
| `number` | finite JSON number |
| `checkbox` | `true` / `false` |
| `date` | `YYYY-MM-DD` or an ISO datetime with an offset. Impossible dates such as Feb 30 are rejected. |
| `single_select` | an option id |
| `multi_select` | array of unique option ids (non-empty if required) |

Errors come back as `400 VALIDATION_ERROR` with `details: [{ path: "customFields.<key>", message }]`. `null` clears a value.

### Edge-case policies (all tested)

| Case | Policy |
| --- | --- |
| Create or update with a status not in the list's resolved set | `400 INVALID_STATUS` (`details[0].path = "statusKey"`) |
| Move a task to a list that doesn't have its status | **Default:** keep the status if the key exists there, otherwise map to the destination's first `not_started` status. The response reports `statusMapped: {from, to}`. **Strict:** `onMissingStatus: "reject"` returns `409 STATUS_NOT_IN_LIST`. An explicit `statusKey` in the move payload always wins (and is validated). |
| Remove, hide or recategorise a status that tasks still use | `409 STATUS_IN_USE`, listing each affected list, status and task count. Retry with `?remapTo=<key>` to move those tasks in the same transaction; the key must exist in every affected list's new set (`422 INVALID_REMAP` otherwise). The whole change is one transaction with a row lock on the owner, so the board never contains a task whose status has no column. |
| Delete an override | The status reverts to the inherited version. No tasks are affected. |
| Move into a list with a required field the task lacks | `400` with `customFields.<key>: is required`, unless the move payload supplies the value (`customFields` on `/move`). Values for fields the destination doesn't have are **dropped** and reported in `droppedFields`. |
| Wrong type, unknown option or unknown key | `400` with the field path |
| Create without a required field | `400` |
| Clear a required field | `400` |
| Turn on `required` for an existing field | Applies to new tasks, moves into the list and any update that touches the field. Existing tasks aren't retroactively invalid, so their other fields stay editable. |
| Change a field's type | `400 FIELD_TYPE_IMMUTABLE` (create a new field and migrate the values) |
| Remove a select option that tasks use | `409 FIELD_OPTION_IN_USE` with the task count. Renaming an option is free. |
| Delete a field | The definition is archived and its values are **stripped** from every task under the owner in the same transaction. No orphan values are left, so the key can be reused later, even with a different type. |
| Concurrent edits | Every task has a `version`. Sending `version` on PATCH or `/move` returns `409 VERSION_CONFLICT` if the task has moved on. The UI uses this for drag-and-drop and the drawer. |

---

## 4. API

**Conventions**
- **REST under `/v1`.** Breaking changes would go to `/v2`, mounted alongside it, while `/v1` stays frozen; additive changes are made in place. Resource URLs: containers are `/v1/spaces|folders|lists/:id`, config hangs off a container (`.../statuses`, `.../fields`), and tasks are `/v1/tasks/:id`.
- **Envelope:** `{ "data": ... }`. Lists return `{ "data": [...], "page": { "nextCursor", "limit" } }`.
- **Errors**, always: `{ "error": { "code", "message", "details?": [{ "path", "message", ... }] } }`. Codes are stable strings (`VALIDATION_ERROR`, `INVALID_STATUS`, `STATUS_IN_USE`, `FORBIDDEN`, ...). 401 means no or invalid identity; 403 means authenticated but not allowed; 404 means it doesn't exist or is archived; 409 means a conflict with current state; 422 means the request is well-formed but would break an invariant.
- **Pagination** uses keyset cursors: `?limit=&cursor=`. The cursor is opaque (base64url of `[sortValue, id]`), so pages stay stable under inserts. `/tasks` supports `sort=position|dueDate|priority|createdAt` and `order=asc|desc`, with null due dates always last.
- **Filtering:** `?statusKey=`, `?assigneeId=`, and `?cf.<fieldKey>=<value>` for a custom-field match. The filter is a jsonb containment query served by a GIN index.
- **Request bodies are strict.** Unknown properties are a 400, so a typo can't be silently ignored.
- **The docs are tested against the code.** `api/test/api.test.ts` fails if any registered route is missing from the table below. `npm run routes` prints the table rows.

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/v1/auth/token` | Dev token issuer: `{ userId }` → short-lived JWT (stands in for OIDC) |
| `GET` | `/v1/me` | The resolved caller |
| `GET` | `/v1/users` | Workspace members |
| `GET` | `/v1/workspace` | The workspace node |
| `GET` | `/v1/tree` | Whole tree, pruned to what the caller can see |
| `GET` | `/v1/spaces` | Visible spaces (paginated) |
| `POST` | `/v1/spaces` | Create space (admin) |
| `GET` | `/v1/spaces/:id` | Read space |
| `PATCH` | `/v1/spaces/:id` | Rename / change visibility (admin) |
| `DELETE` | `/v1/spaces/:id` | Archive space and everything under it (admin) |
| `POST` | `/v1/spaces/:id/reorder` | Move among siblings `{ beforeId \| afterId }` |
| `GET` | `/v1/spaces/:id/folders` | Visible folders (paginated) |
| `POST` | `/v1/spaces/:id/folders` | Create folder |
| `GET` | `/v1/spaces/:id/grants` | List grants (admin) |
| `PUT` | `/v1/spaces/:id/grants/:userId` | Set `{ mode: allow \| deny }` |
| `DELETE` | `/v1/spaces/:id/grants/:userId` | Remove grant |
| `GET` | `/v1/folders/:id` | Read folder |
| `PATCH` | `/v1/folders/:id` | Update folder |
| `DELETE` | `/v1/folders/:id` | Archive folder |
| `POST` | `/v1/folders/:id/reorder` | Reorder folder |
| `GET` | `/v1/folders/:id/lists` | Visible lists (paginated) |
| `POST` | `/v1/folders/:id/lists` | Create list |
| `GET` | `/v1/folders/:id/grants` | List grants |
| `PUT` | `/v1/folders/:id/grants/:userId` | Set grant |
| `DELETE` | `/v1/folders/:id/grants/:userId` | Remove grant |
| `GET` | `/v1/lists/:id` | Read list |
| `PATCH` | `/v1/lists/:id` | Update list |
| `DELETE` | `/v1/lists/:id` | Archive list and its tasks |
| `POST` | `/v1/lists/:id/reorder` | Reorder list |
| `GET` | `/v1/lists/:id/grants` | List grants |
| `PUT` | `/v1/lists/:id/grants/:userId` | Set grant |
| `DELETE` | `/v1/lists/:id/grants/:userId` | Remove grant |
| `GET` | `/v1/workspace/statuses` | `{ local, resolved }` statuses of the workspace |
| `GET` | `/v1/workspace/resolved-statuses` | Resolved set |
| `POST` | `/v1/workspace/statuses` | Add / override / hide (`?remapTo=`) |
| `POST` | `/v1/workspace/statuses/reorder` | `{ keys: [...] }`, a permutation of the resolved keys |
| `GET` | `/v1/workspace/fields` | (fields can't be defined on the workspace; always empty) |
| `GET` | `/v1/workspace/resolved-fields` | (always empty) |
| `GET` | `/v1/spaces/:id/statuses` | Local definitions and resolved set |
| `GET` | `/v1/spaces/:id/resolved-statuses` | Resolved set |
| `POST` | `/v1/spaces/:id/statuses` | Add / override / hide |
| `POST` | `/v1/spaces/:id/statuses/reorder` | Reorder (creates local overrides as needed) |
| `GET` | `/v1/spaces/:id/fields` | Local definitions and resolved schema |
| `GET` | `/v1/spaces/:id/resolved-fields` | Resolved schema |
| `POST` | `/v1/spaces/:id/fields` | Define a field |
| `GET` | `/v1/folders/:id/statuses` | Same as for spaces |
| `GET` | `/v1/folders/:id/resolved-statuses` | |
| `POST` | `/v1/folders/:id/statuses` | |
| `POST` | `/v1/folders/:id/statuses/reorder` | |
| `GET` | `/v1/folders/:id/fields` | |
| `GET` | `/v1/folders/:id/resolved-fields` | |
| `POST` | `/v1/folders/:id/fields` | |
| `GET` | `/v1/lists/:id/statuses` | Same as for spaces |
| `GET` | `/v1/lists/:id/resolved-statuses` | Used by the board and every validator |
| `POST` | `/v1/lists/:id/statuses` | |
| `POST` | `/v1/lists/:id/statuses/reorder` | |
| `GET` | `/v1/lists/:id/fields` | |
| `GET` | `/v1/lists/:id/resolved-fields` | Used by the task form and every validator |
| `POST` | `/v1/lists/:id/fields` | |
| `PATCH` | `/v1/statuses/:id` | Edit a local definition's name/category/color/position |
| `DELETE` | `/v1/statuses/:id` | Remove a local definition (`?remapTo=` when tasks use it) |
| `PATCH` | `/v1/fields/:id` | Edit name/required/options/position (the type can't change) |
| `DELETE` | `/v1/fields/:id` | Archive the field and strip its values |
| `GET` | `/v1/lists/:id/board` | Board in one round trip: list, resolved columns, schema, tasks |
| `GET` | `/v1/lists/:id/tasks` | Paginated, sortable, filterable task list |
| `POST` | `/v1/lists/:id/tasks` | Create task |
| `GET` | `/v1/lists/:id/activity` | Activity feed for a list |
| `GET` | `/v1/tasks/:id` | Read task |
| `PATCH` | `/v1/tasks/:id` | Partial update (`customFields` merges, `null` clears, optional `version`) |
| `POST` | `/v1/tasks/:id/move` | Change list, column and/or position: `{ listId?, statusKey?, afterId?, beforeId?, customFields?, onMissingStatus?, version? }` |
| `DELETE` | `/v1/tasks/:id` | Archive task |
| `GET` | `/v1/tasks/:id/activity` | Activity feed for a task |

`GET /health` sits outside `/v1` and is unauthenticated, for load balancers.

---

## 5. Auth and channels

**Auth now.**
- The API accepts `Authorization: Bearer <JWT>` (HS256, 15-minute expiry, claims `{ sub, userId, role }`, issued by `POST /v1/auth/token`) or, while `ALLOW_DEV_HEADER_AUTH=true`, the mock `X-User-Id: alice|bob|carol` header.
- Either way the API loads the user row. **The role claim in the token is informational only; authorization reads the role from the database.**
- No identity, an unknown user, or a bad or expired token returns 401. Admins bypass visibility rules. Members can see and edit tasks in containers they can see. Containers, statuses, fields and grants can only be changed by admins (the brief lets me choose; admin-only keeps "who can break everyone's board" small).

**Swapping in real auth.** Only `identity.authenticate()` changes:
1. Replace `/v1/auth/token` with an OIDC provider (Auth0/Okta/Entra/Keycloak). Verify RS256 tokens against the provider's JWKS (`jose.createRemoteJWKSet`) and check `iss`/`aud`.
2. Map the `sub` claim to a `users.external_id` column, creating the user on first login if allowed.
3. Turn off `ALLOW_DEV_HEADER_AUTH`.
4. For the browser, prefer a BFF session: nginx (or a small BFF) runs the OIDC code flow and keeps an HttpOnly, SameSite cookie, and the API trusts the session it forwards. Machine clients keep Bearer tokens.
`authorize()`, the routes and the modules don't change.

**Permission model and how it would grow.** Grants are `{resourceId, userId, allow|deny}` on any container. A container is visible when every container on its path is visible: deny hides it, private needs an allow, public is visible (`permissions.canSee`). To extend it:
- add `group_id` grants (teams) evaluated the same way;
- add a `level` (view/comment/edit/admin) instead of a single allow;
- at scale, materialise each user's visible set (a closure table or a per-user ACL cache invalidated by grant events) instead of evaluating the chain per request.

**Channels**

| Channel | Status | Auth | Notes |
| --- | --- | --- | --- |
| Web SPA | built | `X-User-Id` (mock) | Same-origin through nginx |
| CLI (`cli/flowboard.mjs`) | built | Bearer JWT | `node cli/flowboard.mjs tree`, `board <listId>`, `tasks <listId> --sort dueDate --cf component=opt_api`, `create`, `move`, `statuses`. Set `FLOWBOARD_USER=bob` to act as Bob. |
| Webhooks | worker stub | HMAC signing (planned) | The worker logs the exact body it would POST (`docker compose logs worker`) |
| Mobile / third-party | designed | Bearer JWT | Same `/v1` contracts. `/board` already returns a screen's worth of data in one call; a mobile BFF would only trim payloads. |

**Shared contracts:** the resource shapes, error envelope, status/field resolution, validation and permissions all live in the API, so every channel gets the same behaviour. **UI-only:** drag state, optimistic updates, the acting-user switcher, and the "edit resolved vs local" presentation.

Example webhook payload (`task.status_changed`, the "task updated" event):

```json
{
  "eventId": "evt_2pcw23guisu3",
  "type": "task.status_changed",
  "aggregateId": "tsk_012",
  "occurredAt": "2026-11-02T06:13:22.207Z",
  "payload": {
    "actor": { "id": "usr_alice", "name": "Alice" },
    "task": { "id": "tsk_012", "title": "Push notification opt-in", "listId": "lst_sprint_12", "statusKey": "blocked", "statusName": "Blocked", "version": 2 },
    "from": { "listId": "lst_sprint_12", "statusKey": "todo" },
    "statusMapped": null,
    "droppedFields": []
  }
}
```

Receivers should de-duplicate on `eventId`, because delivery is at-least-once.

---

## 6. Scalability and IPC

**What's built.** A modular monolith API with a separate **worker process** connected by a **transactional outbox** in Postgres.
- Every task and config mutation inserts its event in the *same transaction* as the change, so an event exists exactly when the change committed. There are no dual writes.
- The worker claims batches with `FOR UPDATE SKIP LOCKED`, so any number of worker replicas can run.
- The activity feed it builds is **eventually consistent**. The task drawer polls it and says it can lag.

**Failure modes.**
- **Retries:** a failing event gets `attempts+1` and exponential backoff (2^n seconds, capped at 5 minutes). After 8 attempts it's parked (`dead_at`) and stops blocking the rest. Each event runs inside a savepoint, so one bad event doesn't roll back its batch.
- **Idempotency:** consumers de-duplicate on `event_id` (`activity.event_id UNIQUE ... ON CONFLICT DO NOTHING`). Redelivery after a crash between processing and acknowledgement is safe, and a test covers it.
- **Ordering:** events are processed in id order within a batch, which is enough for a feed. A consumer that needs strict ordering per task would partition by `aggregate_id`.

**Horizontal scale.**
- API processes keep no state; identity comes from the request and data from Postgres. `docker compose up --scale api=3` works behind any load balancer.
- Config changes take a row lock on the owning container (`SELECT ... FOR UPDATE`), so two admins can't race each other past the "no orphaned status" check.
- Board and column positions use fractional ordering with an occasional per-column rebalance, which avoids rewriting whole columns on every drag.

**Indexes and query notes.**
- **Tree:** `nodes (parent_id, position) WHERE archived_at IS NULL`. Ancestor walks use a recursive CTE, which is cheap at depth 4. With deep or wide trees I'd add a materialised `path` (ltree) or a closure table and cache resolved status/field sets per list, invalidated by `status_config.changed` / `field.*` events.
- **Board:** `tasks (list_id, status_key, position) WHERE archived_at IS NULL` serves "all cards of a list in column order". The board is capped at 2,000 cards (`truncated: true`), with the list view for paging.
- **List sorts:** expression indexes `(list_id, COALESCE(due_date,'infinity'), id)`, `(list_id, priority_rank, id)` and `(list_id, position, id)` match the keyset predicates exactly. `priority_rank` is denormalised so sorting doesn't need a CASE expression.
- **Custom-field filters:** a GIN `jsonb_path_ops` index on `custom_fields` serves `@>` containment (`cf.component=opt_api`). Range filters (number or date between) would need per-field expression indexes or an EAV side table. For heavy cross-field filtering I'd move to a search index (next point).

**What I'd split out in weeks 2–4, and why.**
1. **Search/indexer service.** Consume `task.*` events into OpenSearch/Meilisearch for full-text search and arbitrary custom-field filters. Different scaling profile, and it shouldn't load the primary database. Outbox to Kafka/SQS via a relay.
2. **Notifications/webhooks service.** Signed delivery, per-subscriber retries, a dead-letter queue and endpoint health. It's slow I/O that must never sit on the request path.
3. **Config/schema service** (statuses, fields, permissions), only if many products start sharing the hierarchy. It's read-heavy and very cacheable, so the first step is a cache of resolved sets, not a service.
Tasks, hierarchy and statuses stay together: moving a task has to validate against the resolved config transactionally, and splitting them would force sagas onto the hottest path.

**IPC plan.**
- Inside a database: the outbox.
- Between services: the outbox relays to a log or queue (Kafka or SQS/SNS) carrying versioned event schemas (`type` plus a `version` field).
- Synchronous reads between services (for example, the search service fetching the resolved schema): HTTP/JSON or gRPC with deadlines, retries on idempotent calls only, and circuit breakers.
- Read models downstream are eventually consistent; anything that must be strongly consistent reads from the owning service.

---

## 7. Trade-offs, and what I'd do next

**Cut or simplified on purpose**
- **Re-parenting** containers (moving a list to another folder). Only sibling reorder exists. Re-parenting changes the list's resolved statuses and schema, so it needs the same validate-and-remap flow as a status deletion. That's the first thing I'd add.
- **Subtasks** (stretch). Not built.
- **Custom-field level overrides** (for example, making a space field required only in one list). Ruled out by the no-shadowing rule to keep resolution unambiguous. It could come back as a per-list "requirement override" row rather than a redefinition.
- **No OpenAPI generation.** The README table is checked against the running routes by a test, and Zod schemas validate every request. Next step: generate OpenAPI from the Zod schemas (`zod-to-openapi`) and generate the web client's types from it, replacing the hand-written `web/src/types.ts`.
- **Production image.** The API image runs TypeScript through `tsx` and includes dev dependencies so one image can migrate, serve, run the worker and run tests. For production: `tsc` build, `npm ci --omit=dev`, distroless base, and migrations as a separate job.
- Membership is implicit (everyone in `users` is in the one workspace). There's no grants admin UI; the grants API exists.

**Day 5**
- Re-parenting with a dry-run endpoint ("this move will remap 4 tasks and drop 2 field values"). The same dry-run would also serve status deletion.
- Playwright E2E against the compose stack (the UI-flow and Alice-to-Bob scenarios currently run as component tests with a fake API).
- Live updates over SSE driven by the outbox, so other open boards update without a refetch.

**Week 2**
- Real OIDC plus a BFF session.
- Restore archived containers and tasks.
- Field-level filters with ranges.
- Bulk edit.
- A cached resolved-config read model.
- Rate limiting at the edge.
- Structured audit log from the same events.

---

## 8. AI usage

See [AI_USAGE.md](AI_USAGE.md) for the full log: which tools were used, where they helped, and what was corrected, including tests that were wrong at first.

## Tests: how the brief's named scenarios map to the suite

| Area | Where | What it asserts |
| --- | --- | --- |
| Permissions | `api/test/permissions.test.ts` | Bob's tree hides the private and denied nodes while Alice sees all; Bob and Carol differ; denied list returns 403 on task read (direct URL, board, list); members can't configure; 401 cases; JWT round trip |
| Status resolution | `api/test/statuses.test.ts` | Backlog and Sprint 12 (same folder) resolve different column sets; columns contain exactly their tasks; space-level change flows down; list reorder is local |
| Status validation | `api/test/tasks.test.ts` | Unknown `statusKey` on create/update returns 400 |
| Cross-list move | `api/test/tasks.test.ts` | Default policy maps to `todo`, `reject` policy returns 409, a kept status stays, explicit `statusKey` is validated |
| Custom fields | `api/test/tasks.test.ts`, `api/test/fields.test.ts`, `api/test/resolution.unit.test.ts` | Wrong type and bad option return 400 with path; valid multi-level payload accepted; key-collision rules; option-in-use; delete strips values |
| Required fields | `api/test/tasks.test.ts` | Create without a required field returns 400; move into a list with a required field fails unless supplied; not retroactive |
| Config safety | `api/test/statuses.test.ts` | Deleting or hiding an in-use status returns 409 with counts, `remapTo` moves tasks, invalid remap returns 422, and an `orphanTasks()` helper asserts no task ever lacks a column |
| Async path | `api/test/worker.test.ts` | Events committed with the change and not on rejection; idempotent redelivery; poison event backs off without blocking |
| Frontend | `web/src/test/flow.test.tsx` | Select list, check the expected kanban columns, open task, edit a custom field, save (asserts the PATCH body), and switching Alice to Bob removes the private list |
