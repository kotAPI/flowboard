-- Flowboard schema v1.
-- IDs are prefixed text (usr_, spc_, fld_, lst_, tsk_ ...) so they are readable in logs, URLs and the CLI.

CREATE TABLE users (
  id          text PRIMARY KEY,
  name        text NOT NULL,
  role        text NOT NULL CHECK (role IN ('admin', 'member')),
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- One table for every container in the hierarchy (workspace, space, folder, list).
-- Parent/type validity (workspace -> space -> folder -> list) is enforced in the hierarchy module;
-- the CHECK only guarantees that exactly the workspace is a root.
CREATE TABLE nodes (
  id           text PRIMARY KEY,
  type         text NOT NULL CHECK (type IN ('workspace', 'space', 'folder', 'list')),
  parent_id    text REFERENCES nodes(id),
  name         text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  position     double precision NOT NULL DEFAULT 0,
  visibility   text NOT NULL DEFAULT 'public' CHECK (visibility IN ('public', 'private')),
  archived_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CHECK ((type = 'workspace') = (parent_id IS NULL))
);
CREATE INDEX nodes_children_idx ON nodes (parent_id, position) WHERE archived_at IS NULL;

-- Access grants on a container. Absence of a row = default rule (public visible, private hidden).
CREATE TABLE grants (
  id          text PRIMARY KEY,
  node_id     text NOT NULL REFERENCES nodes(id),
  user_id     text NOT NULL REFERENCES users(id),
  mode        text NOT NULL CHECK (mode IN ('allow', 'deny')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (node_id, user_id)
);
CREATE INDEX grants_user_idx ON grants (user_id);

-- Status definitions owned by any container. Rows merge by `key` from the workspace down to the list:
--   a new key adds a status, an existing key overrides it, hidden = true removes it from the resolved set.
CREATE TABLE status_defs (
  id           text PRIMARY KEY,
  owner_id     text NOT NULL REFERENCES nodes(id),
  key          text NOT NULL CHECK (key ~ '^[a-z][a-z0-9_]{0,39}$'),
  name         text,
  category     text CHECK (category IN ('not_started', 'active', 'done', 'closed')),
  color        text,
  position     double precision,
  hidden       boolean NOT NULL DEFAULT false,
  archived_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  -- an "add" or "override" row must carry display data; a "hide" row carries none
  CHECK (hidden OR (name IS NOT NULL AND category IS NOT NULL AND color IS NOT NULL AND position IS NOT NULL))
);
CREATE UNIQUE INDEX status_defs_owner_key_uq ON status_defs (owner_id, key) WHERE archived_at IS NULL;

-- Custom field definitions owned by space/folder/list. Keys are unique along any root-to-leaf path
-- (no shadowing), so a task payload key always maps to exactly one definition.
CREATE TABLE field_defs (
  id           text PRIMARY KEY,
  owner_id     text NOT NULL REFERENCES nodes(id),
  key          text NOT NULL CHECK (key ~ '^[a-z][a-z0-9_]{0,39}$'),
  name         text NOT NULL,
  type         text NOT NULL CHECK (type IN ('text', 'number', 'single_select', 'multi_select', 'date', 'checkbox')),
  required     boolean NOT NULL DEFAULT false,
  options      jsonb NOT NULL DEFAULT '[]'::jsonb,
  position     double precision NOT NULL DEFAULT 0,
  archived_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX field_defs_owner_key_uq ON field_defs (owner_id, key) WHERE archived_at IS NULL;

CREATE TABLE tasks (
  id              text PRIMARY KEY,
  list_id         text NOT NULL REFERENCES nodes(id),
  parent_task_id  text REFERENCES tasks(id),
  title           text NOT NULL CHECK (length(title) BETWEEN 1 AND 500),
  description     text,
  status_key      text NOT NULL,
  priority        text NOT NULL DEFAULT 'none' CHECK (priority IN ('urgent', 'high', 'normal', 'low', 'none')),
  -- denormalised sort key so "sort by priority" is an index scan, not a CASE expression
  priority_rank   smallint NOT NULL DEFAULT 4,
  assignee_ids    text[] NOT NULL DEFAULT '{}',
  due_date        timestamptz,
  custom_fields   jsonb NOT NULL DEFAULT '{}'::jsonb,
  position        double precision NOT NULL,
  version         integer NOT NULL DEFAULT 1,
  created_by      text NOT NULL REFERENCES users(id),
  archived_at     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
-- board load: all live tasks of a list grouped by column, ordered
CREATE INDEX tasks_board_idx ON tasks (list_id, status_key, position) WHERE archived_at IS NULL;
-- list view sorts (keyset pagination on (sort value, id))
CREATE INDEX tasks_due_idx ON tasks (list_id, (COALESCE(due_date, 'infinity'::timestamptz)), id) WHERE archived_at IS NULL;
CREATE INDEX tasks_priority_idx ON tasks (list_id, priority_rank, id) WHERE archived_at IS NULL;
CREATE INDEX tasks_position_idx ON tasks (list_id, position, id) WHERE archived_at IS NULL;
-- custom-field equality filters: custom_fields @> '{"component": "opt_api"}'
CREATE INDEX tasks_custom_fields_idx ON tasks USING gin (custom_fields jsonb_path_ops);
CREATE INDEX tasks_parent_idx ON tasks (parent_task_id) WHERE parent_task_id IS NOT NULL;

-- Transactional outbox: written in the same transaction as the domain change, drained by the worker.
CREATE TABLE outbox (
  id            bigserial PRIMARY KEY,
  event_id      text NOT NULL UNIQUE,
  type          text NOT NULL,
  aggregate_id  text NOT NULL,
  payload       jsonb NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  available_at  timestamptz NOT NULL DEFAULT now(),
  attempts      integer NOT NULL DEFAULT 0,
  last_error    text,
  processed_at  timestamptz,
  dead_at       timestamptz
);
CREATE INDEX outbox_pending_idx ON outbox (available_at, id) WHERE processed_at IS NULL AND dead_at IS NULL;

-- Read model built by the worker. event_id UNIQUE makes the consumer idempotent under redelivery.
CREATE TABLE activity (
  id          bigserial PRIMARY KEY,
  event_id    text NOT NULL UNIQUE,
  task_id     text,
  list_id     text,
  actor_id    text,
  type        text NOT NULL,
  summary     text NOT NULL,
  created_at  timestamptz NOT NULL
);
CREATE INDEX activity_task_idx ON activity (task_id, id DESC);
CREATE INDEX activity_list_idx ON activity (list_id, id DESC);
