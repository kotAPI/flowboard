# AI usage log

## Tools

- **Claude Code (Anthropic, Claude Opus)** in the terminal as the main implementer. It wrote the schema, API modules, tests, React UI, Docker setup and docs from my direction, ran the test suites and the Docker stack, and drove a real Chrome window to check the UI.
- No other code generators were used.

## How I worked with it

1. **Model first.** Before any routes, I fixed the decisions the brief grades:
   - statuses merge by `key` (add / override / hide), and tasks store the stable key;
   - custom-field keys are unique along a path (no shadowing);
   - one config-safety wrapper that snapshots every affected list, applies the change, re-validates the categories and either rejects or remaps, all in one transaction;
   - a transactional outbox for the async path.
2. **Pure core, thin shell.** Resolution (`resolveStatuses`, `resolveFields`), value validation (`validateCustomValues`) and visibility (`canSee`) are pure functions with their own unit tests. The routes only parse input, call `authorize()` and call the modules.
3. **The brief's named scenarios became test names**, written alongside the code rather than afterwards. An `orphanTasks()` helper checks the "no orphan board state" invariant after every config-safety test.
4. **Ran the real thing.** Besides the tests, the stack was brought up with `docker compose up --build`, driven through the CLI, and clicked through in a browser: dragging cards, editing fields, the status remap prompt, and switching to Bob.

## Where it helped

- Volume: 72 routes, the board drag-and-drop with dnd-kit, the config UI, the Dockerfiles and the README tables were all much faster to produce.
- Thinking through edge cases: making the remap target valid in *every* affected list, keyset cursors that keep null due dates last in both directions, and rebalancing positions once fractional gaps get too small.
- Writing the docs-match-code test: the README's API table is checked against the router's registered routes.

## Where the output was wrong and had to be corrected

These all happened while building this repo:

| What was generated | Problem | Fix |
| --- | --- | --- |
| Test: "hiding Sprint 12's `todo` must fail with 422" | The test was wrong, not the code. Sprint 12 already overrides `todo` locally, so the API correctly answered `409 STATUS_KEY_EXISTS` ("update it instead"). | Pointed the test at Backlog, where `todo` is inherited. |
| Test: "poison outbox event is retried" | The "poison" payload wasn't actually invalid (Postgres happily coerced it), so the test proved nothing. | Injected a handler that throws for one event id. That exposed a **real bug in the worker's retry path**: an SQL parameter used both as int and in a comparison made Postgres fail with "inconsistent types deduced for parameter". Fixed with explicit casts. |
| Custom `date` validation | Relied on `Date.parse`, which rolls `2026-02-30` over to 2 March and accepts it. | Added an explicit calendar check, with a unit test for Feb 30. |
| Activity feed: "Alice updated title, description, statusKey, priority..." | The server reported every key in the request as changed, and the UI sends all built-in fields on save. Every channel would have got noisy activity and webhooks. | The server now diffs the task before and after the update and skips no-op saves. |
| Config UI remap flow | The "tasks still use this status" handler caught the error and returned normally, so the mutation's `onSuccess` ran and immediately cleared the remap prompt it had just opened. | Moved the handling into `onError` and carried the retry function through the mutation variables. |
| Docker healthcheck `wget http://localhost:3000/health` | `localhost` resolves to IPv6 in Alpine while the server listened on IPv4, so the API showed as unhealthy and the stack wouldn't start. | Used `127.0.0.1`. |
| `const id = z.string()` schema plus destructured `const { id }` in handlers | A TypeScript shadowing error ("used before its declaration"). | Renamed the schema to `idSchema`. |
| Frontend test: second test found two apps rendered | Testing Library's auto-cleanup needs Vitest globals, which this setup doesn't enable. | Called `cleanup()` explicitly in `afterEach`. |

## What I rejected or kept out

- **Storing a definition `statusId` on tasks** (the brief's default naming). That makes renaming or overriding a status a data migration. I kept the stable key and documented why.
- **Letting child levels override custom-field definitions.** It would make the same payload key mean different types in sibling lists. Rejected in favour of the no-shadowing rule.
- **Re-parenting containers**, without the remap flow that would make it safe. Left out and documented instead of shipping a half-safe version.
- **Generated OpenAPI with a half-correct schema.** I chose a smaller README table that a test proves complete.
