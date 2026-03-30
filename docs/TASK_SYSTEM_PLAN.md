# Task System Plan

> Build one manager-owned task platform for `id-agents`.
> Keep task state durable in the database, keep checkout atomic, and make tasks the source of truth for multi-agent coordination while preserving the existing `talk`/`news` workflow.

---

## Goals

The task system should:
- support durable work items with a clear lifecycle: `todo -> in_progress -> done|blocked|cancelled`
- prevent double-claiming with atomic checkout and `409 Conflict` on contention
- support hierarchy: `epic -> story -> task -> subtask`
- support both single-owner and multi-agent assignment
- support comments, labels, priorities, and dependency tracking
- integrate with the existing manager-owned scheduler so tasks can trigger heartbeats
- work in both SQLite and PostgreSQL without forking the product model
- expose first-class manager APIs for humans, the interactive CLI, and autonomous agents
- coexist with current `talk`/`news` coordination during migration

The task system should not:
- replace `queries` or `news_items`; those remain the transport and conversational log
- allow two agents to actively own the same leaf task at the same time
- depend on database-specific enum types or JSON-only joins
- turn epics and stories into concurrently executable work units

---

## Design Principles

This design takes the strongest parts of modern issue systems and adapts them for agent teams:
- Jira-style hierarchy, workflow, and blockers
- Linear-style fast ownership, simple priorities, and narrow active work
- GitHub Issues-style comments, labels, and durable references
- Paperclip-style agent-first orchestration, manager-owned scheduling, and heartbeat-driven execution

For `id-agents`, the key extra rule is:
- assignment is advisory
- checkout is authoritative

Multiple agents can be assigned to a task, but only one agent can hold the active checkout lease for a leaf task.

---

## Product Model

### Task Kinds

- `epic`: large outcome bucket, usually parent of stories
- `story`: user-facing or milestone-sized slice, usually parent of tasks
- `task`: executable work item
- `subtask`: leaf-level work item under a task

### Statuses

- `todo`: ready or not yet started
- `in_progress`: actively claimed or manually started
- `blocked`: cannot progress because of an external blocker or dependency
- `done`: completed
- `cancelled`: intentionally dropped

### Priority Levels

Use a small numeric scale for stable sorting and easy CLI output:
- `0`: `urgent`
- `1`: `high`
- `2`: `medium` (default)
- `3`: `low`
- `4`: `backlog`

### Assignment Model

- one optional `owner`
- zero or more `collaborators`
- zero or more `reviewers`

This keeps accountability clear while still allowing multi-agent participation.

### Checkout Model

- only `task` and `subtask` items are claimable in v1
- `epic` and `story` items are planning containers, not executable leases
- checkout is exclusive and lease-based
- a task may be assigned to many agents, but only one agent may hold the live checkout
- checkout automatically transitions `todo -> in_progress`

---

## Database Design

## Portability Rules

To keep SQLite and PostgreSQL aligned:
- use `TEXT` ids generated in application code
- use integer unix-ms timestamps for task tables
- use `TEXT + CHECK` instead of DB-native enums
- normalize labels, assignees, dependencies, and comments into tables
- keep JSON optional and append-only, only where useful for events

SQL below is intentionally portable pseudocode.
- in PostgreSQL, `team_id` should use the existing `teams.id` type (`uuid`)
- in SQLite, `team_id` remains `TEXT`
- `task_events.id` should be `BIGSERIAL` in PostgreSQL and `INTEGER PRIMARY KEY AUTOINCREMENT` in SQLite

PostgreSQL may store `event_data` as `jsonb`; SQLite stores it as `TEXT` and repos parse/stringify it, matching the current DB abstraction style.

## New Tables

### `task_counters`

Per-team monotonic counter for human-friendly task numbers and keys.

```sql
CREATE TABLE task_counters (
  team_id TEXT PRIMARY KEY REFERENCES teams(id) ON DELETE CASCADE,
  next_number INTEGER NOT NULL
);
```

Notes:
- initialize `next_number = 1` when the first task is created for a team
- task creation must run in a DB transaction so `(team_id, number)` stays gap-safe enough for concurrent creates

### `tasks`

The main task record. Current checkout state lives on the row so claiming can be a single atomic update.

```sql
CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  number INTEGER NOT NULL,
  task_key TEXT NOT NULL,

  title TEXT NOT NULL,
  description TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('epic', 'story', 'task', 'subtask')),
  status TEXT NOT NULL CHECK (status IN ('todo', 'in_progress', 'done', 'blocked', 'cancelled')),
  priority INTEGER NOT NULL DEFAULT 2 CHECK (priority BETWEEN 0 AND 4),

  parent_task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  blocked_reason TEXT,
  due_at INTEGER,

  created_by_type TEXT NOT NULL CHECK (created_by_type IN ('manager', 'agent', 'human', 'system')),
  created_by_id TEXT,
  updated_by_type TEXT NOT NULL CHECK (updated_by_type IN ('manager', 'agent', 'human', 'system')),
  updated_by_id TEXT,

  checkout_agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
  checkout_token TEXT,
  checkout_claimed_at INTEGER,
  checkout_expires_at INTEGER,
  checkout_heartbeat_at INTEGER,

  started_at INTEGER,
  completed_at INTEGER,
  cancelled_at INTEGER,

  source_query_id TEXT,
  version INTEGER NOT NULL DEFAULT 1,

  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,

  CHECK (parent_task_id IS NULL OR parent_task_id <> id),
  CHECK (
    (status = 'done' AND completed_at IS NOT NULL)
    OR status <> 'done'
  ),
  CHECK (
    (status = 'cancelled' AND cancelled_at IS NOT NULL)
    OR status <> 'cancelled'
  )
);
```

Indexes and constraints:

```sql
CREATE UNIQUE INDEX tasks_team_number_uniq ON tasks(team_id, number);
CREATE UNIQUE INDEX tasks_team_key_uniq ON tasks(team_id, task_key);
CREATE INDEX tasks_team_status_priority_idx ON tasks(team_id, status, priority, updated_at);
CREATE INDEX tasks_team_parent_idx ON tasks(team_id, parent_task_id);
CREATE INDEX tasks_team_checkout_idx ON tasks(team_id, checkout_agent_id, checkout_expires_at);
CREATE INDEX tasks_team_kind_status_idx ON tasks(team_id, kind, status, updated_at);
CREATE INDEX tasks_due_idx ON tasks(team_id, due_at) WHERE due_at IS NOT NULL;
```

Application-level rules:
- parent/child kind compatibility is enforced in service code:
  - `epic` may parent `story`
  - `story` may parent `task`
  - `task` may parent `subtask`
  - `subtask` may not parent anything
- only leaf tasks may be claimed
- cycles in the hierarchy are rejected in service code

### `task_assignees`

Assignments are normalized so one task can have multiple agents with different roles.

```sql
CREATE TABLE task_assignees (
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('owner', 'collaborator', 'reviewer')),
  assigned_by_type TEXT NOT NULL CHECK (assigned_by_type IN ('manager', 'agent', 'human', 'system')),
  assigned_by_id TEXT,
  assigned_at INTEGER NOT NULL,
  PRIMARY KEY (task_id, agent_id)
);
```

Indexes:

```sql
CREATE INDEX task_assignees_agent_idx ON task_assignees(agent_id, role, assigned_at);
CREATE UNIQUE INDEX task_assignees_one_owner_idx
  ON task_assignees(task_id)
  WHERE role = 'owner';
```

### `task_comments`

Flat chronological discussion thread per task.

```sql
CREATE TABLE task_comments (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  author_type TEXT NOT NULL CHECK (author_type IN ('manager', 'agent', 'human', 'system')),
  author_id TEXT,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  edited_at INTEGER,
  deleted_at INTEGER
);
```

Indexes:

```sql
CREATE INDEX task_comments_task_time_idx ON task_comments(task_id, created_at);
CREATE INDEX task_comments_team_time_idx ON task_comments(team_id, created_at);
```

### `task_labels`

Team-scoped labels.

```sql
CREATE TABLE task_labels (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  normalized_name TEXT NOT NULL,
  color TEXT,
  description TEXT,
  created_at INTEGER NOT NULL,
  archived_at INTEGER
);
```

Indexes:

```sql
CREATE UNIQUE INDEX task_labels_team_name_uniq ON task_labels(team_id, normalized_name);
CREATE INDEX task_labels_team_active_idx ON task_labels(team_id, archived_at);
```

### `task_label_links`

Many-to-many join between tasks and labels.

```sql
CREATE TABLE task_label_links (
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  label_id TEXT NOT NULL REFERENCES task_labels(id) ON DELETE CASCADE,
  linked_at INTEGER NOT NULL,
  PRIMARY KEY (task_id, label_id)
);
```

Indexes:

```sql
CREATE INDEX task_label_links_label_idx ON task_label_links(label_id, task_id);
```

### `task_dependencies`

Explicit blockers between tasks.

```sql
CREATE TABLE task_dependencies (
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  blocked_by_task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  dependency_type TEXT NOT NULL DEFAULT 'blocked_by' CHECK (dependency_type = 'blocked_by'),
  created_by_type TEXT NOT NULL CHECK (created_by_type IN ('manager', 'agent', 'human', 'system')),
  created_by_id TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (task_id, blocked_by_task_id),
  CHECK (task_id <> blocked_by_task_id)
);
```

Indexes:

```sql
CREATE INDEX task_dependencies_blocker_idx ON task_dependencies(blocked_by_task_id, task_id);
```

Semantics:
- `task_id` is blocked by `blocked_by_task_id`
- unresolved blockers are blockers whose status is not in `('done', 'cancelled')`

### `task_heartbeat_configs`

V1 task-to-scheduler binding for recurring heartbeats while a task is active.

```sql
CREATE TABLE task_heartbeat_configs (
  task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
  enabled INTEGER NOT NULL DEFAULT 1,
  interval_seconds INTEGER NOT NULL,
  message TEXT NOT NULL,
  delivery_mode TEXT NOT NULL DEFAULT 'internal' CHECK (delivery_mode IN ('talk', 'internal')),
  target_mode TEXT NOT NULL DEFAULT 'claimant' CHECK (target_mode IN ('claimant', 'owner', 'assignees')),
  pause_when_blocked INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (interval_seconds >= 60)
);
```

Notes:
- one heartbeat config per task in v1
- future versions can generalize this to `task_automations`
- the actual schedule rows live in existing `schedule_definitions`, `schedule_targets`, and `schedule_runs`

### `task_events`

Append-only audit/event log for task mutations and compatibility fan-out into `news_items`.

```sql
CREATE TABLE task_events (
  id INTEGER PRIMARY KEY,
  team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('manager', 'agent', 'human', 'system')),
  actor_id TEXT,
  message TEXT,
  event_data TEXT,
  created_at INTEGER NOT NULL
);
```

PostgreSQL version:
- make `id BIGSERIAL PRIMARY KEY`
- make `event_data JSONB`

SQLite version:
- make `id INTEGER PRIMARY KEY AUTOINCREMENT`
- keep `event_data TEXT`

Indexes:

```sql
CREATE INDEX task_events_task_idx ON task_events(task_id, id);
CREATE INDEX task_events_team_idx ON task_events(team_id, id);
CREATE INDEX task_events_team_time_idx ON task_events(team_id, created_at);
```

Recommended event types:
- `task.created`
- `task.updated`
- `task.claimed`
- `task.claim_renewed`
- `task.released`
- `task.status_changed`
- `task.assignment_added`
- `task.assignment_removed`
- `task.comment_added`
- `task.label_added`
- `task.label_removed`
- `task.dependency_added`
- `task.dependency_removed`
- `task.heartbeat_seeded`
- `task.heartbeat_paused`

---

## Repository Additions

Add a new `tasks` repository surface under the existing DB abstraction:

```ts
db.tasks.create(...)
db.tasks.getByRef(teamId, ref)
db.tasks.list(teamId, filters)
db.tasks.update(...)
db.tasks.setStatus(...)
db.tasks.claim(...)
db.tasks.renewClaim(...)
db.tasks.releaseClaim(...)
db.tasks.replaceAssignees(...)
db.tasks.addComment(...)
db.tasks.addDependency(...)
db.tasks.removeDependency(...)
db.tasks.attachLabels(...)
db.tasks.detachLabel(...)
db.tasks.pollEvents(teamId, sinceId)
```

Also add transaction support to `DbAdapter`:

```ts
db.adapter.transaction(async (tx) => { ... })
```

This is required for:
- safe task number allocation via `task_counters`
- multi-step create flows
- status updates that also seed/pause schedules and write task events

SQLite implementation:
- use `better-sqlite3` transaction support
- keep WAL mode and current `busy_timeout`

PostgreSQL implementation:
- use a pooled client transaction with `BEGIN` / `COMMIT` / `ROLLBACK`

---

## Task Lifecycle Rules

Allowed primary transitions:

- `todo -> in_progress`
- `todo -> blocked`
- `todo -> cancelled`
- `in_progress -> blocked`
- `in_progress -> done`
- `in_progress -> cancelled`
- `in_progress -> todo`
- `blocked -> todo`
- `blocked -> in_progress`
- `blocked -> cancelled`

Optional reopen transitions:
- `done -> todo`
- `cancelled -> todo`

Rules:
- setting `done` clears checkout and sets `completed_at`
- setting `cancelled` clears checkout and sets `cancelled_at`
- setting `blocked` clears checkout unless `keepCheckout=true` is explicitly supported later
- a task with unresolved blockers cannot transition to `in_progress`
- a task with open children cannot transition to `done`
- claiming a `todo` task transitions it to `in_progress` in the same statement

---

## Atomic Checkout

## Why Checkout Is Separate From Assignment

Assignment answers "who should work on this?"

Checkout answers "who is working on this right now?"

That distinction matters for AI teams because:
- a manager may assign several agents to a story
- only one agent should actually edit the leaf task at a time
- leases let the system recover if an agent dies, stalls, or disappears

## Lease Fields

The current live lease is stored on `tasks`:
- `checkout_agent_id`
- `checkout_token`
- `checkout_claimed_at`
- `checkout_expires_at`
- `checkout_heartbeat_at`

Recommended defaults:
- default lease: `15 minutes`
- minimum lease: `60 seconds`
- recommended renew cadence: every `5 minutes`

## Claim Algorithm

`POST /tasks/:ref/claim` must be one atomic write.

Single-statement logic:
- resolve task by `id`, `task_key`, or team-local `number`
- verify the task is a claimable leaf task
- verify status is `todo` or `in_progress`
- verify there are no unresolved `blocked_by` dependencies
- verify no unexpired lease exists for another agent
- write lease fields
- if status is `todo`, set it to `in_progress`
- increment `version`
- emit `task.claimed` event

Portable SQL shape:

```sql
UPDATE tasks
SET
  checkout_agent_id = :agent_id,
  checkout_token = :checkout_token,
  checkout_claimed_at = :now_ms,
  checkout_expires_at = :expires_ms,
  checkout_heartbeat_at = :now_ms,
  status = CASE WHEN status = 'todo' THEN 'in_progress' ELSE status END,
  started_at = COALESCE(started_at, :now_ms),
  updated_at = :now_ms,
  updated_by_type = 'agent',
  updated_by_id = :agent_id,
  version = version + 1
WHERE
  id = :task_id
  AND kind IN ('task', 'subtask')
  AND status IN ('todo', 'in_progress')
  AND (
    checkout_agent_id IS NULL
    OR checkout_agent_id = :agent_id
    OR checkout_expires_at < :now_ms
  )
  AND NOT EXISTS (
    SELECT 1
    FROM task_dependencies d
    JOIN tasks b ON b.id = d.blocked_by_task_id
    WHERE d.task_id = tasks.id
      AND b.status NOT IN ('done', 'cancelled')
  );
```

Result handling:
- `rowCount = 1`: success
- `rowCount = 0`: fetch current state and return:
  - `409 Conflict` if leased by another agent or blocked by dependencies
  - `422 Unprocessable Entity` if non-leaf or invalid kind
  - `409 Conflict` if already `done` or `cancelled`

## Renew Algorithm

`POST /tasks/:ref/claim/renew`

Rules:
- must include `checkout_token`
- renew only if `checkout_agent_id` and token match the live lease
- if the lease already expired and was taken by another agent, return `409`

Update:

```sql
UPDATE tasks
SET
  checkout_expires_at = :new_expires_ms,
  checkout_heartbeat_at = :now_ms,
  updated_at = :now_ms,
  version = version + 1
WHERE
  id = :task_id
  AND checkout_agent_id = :agent_id
  AND checkout_token = :checkout_token
  AND checkout_expires_at >= :now_ms;
```

## Release Algorithm

`POST /tasks/:ref/release`

Rules:
- only the claimant or the manager may release a live checkout
- release clears lease fields
- release does not change status unless explicitly requested

## Conflict Contract

When claim fails because another agent owns the live lease, return:

```json
{
  "error": "task_already_claimed",
  "task": {
    "id": "tsk_...",
    "task_key": "CORE-42",
    "status": "in_progress"
  },
  "current_checkout": {
    "agent_id": "coder-1",
    "expires_at": 1774722500000
  }
}
```

HTTP status:
- `409 Conflict`

That exact contract is what downstream agents should branch on.

---

## API Design

All task APIs live on the manager because the manager is the source of truth.

Authentication:
- reuse current manager auth model
- agents call with existing API key plus team headers
- include actor identity via `X-Id-Agent` or an explicit body field when needed

Task ref resolution:
- `:ref` may be:
  - full `id`
  - `task_key`
  - team-local numeric `number`

## Endpoints

### Create and Read

`POST /tasks`

Create a task, story, or epic.

Request body:

```json
{
  "title": "Implement atomic task checkout",
  "description": "Manager-side claim API and DB enforcement.",
  "kind": "task",
  "priority": 1,
  "parent_ref": "CORE-10",
  "assignees": [
    { "agent_id": "coder-1", "role": "owner" },
    { "agent_id": "reviewer-1", "role": "reviewer" }
  ],
  "labels": ["backend", "coordination"],
  "depends_on": ["CORE-37"],
  "heartbeat": {
    "interval_seconds": 300,
    "message": "Post a progress comment and renew your claim",
    "delivery_mode": "internal",
    "target_mode": "claimant"
  },
  "source_query_id": "query_1774751945910_qp5iywj"
}
```

Response:
- `201 Created`

`GET /tasks`

List tasks with filters:
- `status`
- `kind`
- `priority`
- `assignee`
- `label`
- `parent_ref`
- `blocked=true|false`
- `claimed_by`
- `mine=true`
- `include_children=true|false`
- `limit`
- `cursor` or `offset`

Default sort:
- open statuses first
- priority ascending
- updated_at descending

`GET /tasks/:ref`

Return:
- task
- assignees
- labels
- blockers
- children summary
- live checkout
- heartbeat config

### Update

`PATCH /tasks/:ref`

Patch mutable fields:
- `title`
- `description`
- `priority`
- `parent_ref`
- `due_at`

Recommended request contract:

```json
{
  "patch": {
    "priority": 0,
    "due_at": 1774723000000
  },
  "if_version": 7
}
```

Use `if_version` for optimistic concurrency. If stale:
- return `409 Conflict`

### Status

`POST /tasks/:ref/status`

Request body:

```json
{
  "status": "blocked",
  "reason": "Waiting on scheduler repo abstraction changes"
}
```

Behavior:
- validates lifecycle transition
- updates timestamps
- clears or preserves lease per rule
- writes `task.status_changed`
- seeds/pauses task heartbeat if needed

### Claim

`POST /tasks/:ref/claim`

Request body:

```json
{
  "agent_id": "coder-1",
  "lease_seconds": 900
}
```

Response:

```json
{
  "task": {
    "id": "tsk_01...",
    "task_key": "CORE-42",
    "status": "in_progress"
  },
  "checkout": {
    "agent_id": "coder-1",
    "checkout_token": "chk_01...",
    "claimed_at": 1774721600000,
    "expires_at": 1774722500000
  }
}
```

`POST /tasks/:ref/claim/renew`

```json
{
  "agent_id": "coder-1",
  "checkout_token": "chk_01...",
  "lease_seconds": 900
}
```

`POST /tasks/:ref/release`

```json
{
  "agent_id": "coder-1",
  "checkout_token": "chk_01...",
  "reason": "Handing off to integration agent"
}
```

### Assignment

`PUT /tasks/:ref/assignees`

Replace the full assignment set:

```json
{
  "assignees": [
    { "agent_id": "coder-1", "role": "owner" },
    { "agent_id": "reviewer-1", "role": "reviewer" }
  ]
}
```

Alternative additive endpoint if desired:
- `POST /tasks/:ref/assignees`
- `DELETE /tasks/:ref/assignees/:agentId`

### Comments

`POST /tasks/:ref/comments`

```json
{
  "author_type": "agent",
  "author_id": "coder-1",
  "body": "Implemented the repo interface. Starting on manager routes next."
}
```

`GET /tasks/:ref/comments`

Return chronological thread.

### Labels

`POST /task-labels`

Create team label.

`POST /tasks/:ref/labels`

```json
{
  "labels": ["backend", "urgent"]
}
```

`DELETE /tasks/:ref/labels/:name`

### Dependencies

`POST /tasks/:ref/dependencies`

```json
{
  "blocked_by": ["CORE-37", "CORE-40"]
}
```

`DELETE /tasks/:ref/dependencies/:blockedByRef`

### Event Feed

`GET /tasks/events?since_id=1234`

Purpose:
- let agents or the CLI poll durable task changes
- allow migration without forcing everything through `news_items`

Return:
- append-only ordered task events

## Status Codes

- `200 OK`: read or update success
- `201 Created`: create/comment/label creation success
- `204 No Content`: delete success
- `400 Bad Request`: malformed payload
- `401/403`: auth failure
- `404 Not Found`: task or label missing
- `409 Conflict`: active checkout, stale version, unresolved blockers, invalid terminal transition
- `422 Unprocessable Entity`: bad hierarchy, invalid assignee role, non-claimable kind

---

## CLI Design

Required commands:
- `/task create`
- `/task list`
- `/task assign`
- `/task status`
- `/task comment`

Recommended v1 command set:

```text
/task create "<title>" [--kind epic|story|task|subtask] [--priority p0|p1|p2|p3|p4]
                      [--parent <task-ref>] [--assign <agent[:role]>,...]
                      [--label <name>,...] [--depends-on <task-ref>,...]
                      [--description "<markdown>"]
                      [--heartbeat <seconds>] [--heartbeat-message "<message>"]

/task list [--status <csv>] [--kind <csv>] [--priority <csv>] [--assignee <agent>]
           [--label <name>] [--mine] [--parent <task-ref>] [--blocked] [--tree]

/task show <task-ref>

/task assign <task-ref> <agent[:role]>,...

/task claim <task-ref> [--lease <seconds>]

/task release <task-ref> [--reason "<text>"]

/task status <task-ref> <todo|in_progress|done|blocked|cancelled> [--reason "<text>"]

/task comment <task-ref> "<message>"
```

Behavior notes:
- `/task claim` is the normal agent entrypoint
- `/task status <ref> done` auto-releases checkout
- `/task list --mine` means:
  - owner or collaborator assignments for humans
  - current checkout holder for agents, depending on caller type
- `/tasks` may remain an alias for `/task list`

---

## Agent Interaction Protocol

The manager remains the only writer of task truth. Agents read and mutate tasks through manager APIs.

## Standard Agent Flow

1. Discover candidate work:
   - `GET /tasks?status=todo&kind=task&assignee=<me>`
   - or `GET /tasks?mine=true`

2. Claim atomically:
   - `POST /tasks/:ref/claim`

3. Work normally in the local code process.

4. Post progress:
   - `POST /tasks/:ref/comments`
   - optionally `POST /tasks/:ref/claim/renew`

5. Finish or block:
   - `POST /tasks/:ref/status`

6. If blocked because the work is too large:
   - create child tasks under the story/task
   - release the parent leaf task if needed

## Agent Rules

Agents should:
- claim before editing when the work item is a shared leaf task
- treat `409 Conflict` as authoritative and choose a different task
- write structured comments instead of only sending ad hoc chat
- create subtasks when work should split across multiple agents
- renew leases if work exceeds the lease window

Agents should not:
- assume assignment implies ownership
- keep working after losing checkout
- use comments as the only source of status

## Message Interop

The existing `talk/news` system remains useful:
- manager may still send `/ask agent "Take CORE-42"`
- agent should then claim `CORE-42` via the task API
- task events can be mirrored into `news_items` so the interactive CLI still sees updates

Recommended `news_items` mirrors:
- `task.created`
- `task.claimed`
- `task.status_changed`
- `task.commented`

This keeps the single-chat manager UX intact during migration.

---

## Scheduler Integration

The repo already has a manager-owned scheduler backed by:
- `schedule_definitions`
- `schedule_targets`
- `schedule_runs`

The task system should reuse that instead of adding another scheduler.

## Heartbeat Semantics

A task heartbeat means:
- while a task is in an active state, emit recurring scheduled work tied to that task
- the heartbeat targets the claimant, owner, or all assignees
- the heartbeat message reminds or instructs the agent to report progress, renew lease, or perform follow-up work

Default v1 behavior:
- seed heartbeat when task enters `in_progress`
- target the live claimant if `target_mode = claimant`
- pause heartbeat when task becomes `blocked`, `done`, or `cancelled`
- reseed targets when checkout changes

## Schedule Materialization

Every task heartbeat config compiles into one existing schedule definition:

- `schedule_definitions.id = taskhb_<task_id>`
- `kind = 'heartbeat'`
- `source_type = 'task'`
- `source_key = 'task:<task_id>:heartbeat'`
- `delivery_mode` from `task_heartbeat_configs`
- `interval_seconds` from `task_heartbeat_configs`
- `message` from `task_heartbeat_configs`
- `sender = 'task-heartbeat'`

Targets:
- `claimant`: current `checkout_agent_id`
- `owner`: assignee with `role='owner'`
- `assignees`: all active task assignees

## Payload Shape

Extend scheduler payloads for task-sourced schedules with optional task context:

```json
{
  "from": "task-heartbeat",
  "mode": "internal",
  "schedule": {
    "id": "taskhb_tsk_01...",
    "kind": "heartbeat",
    "title": "Task heartbeat: CORE-42",
    "scheduledKey": "heartbeat:1774722000"
  },
  "task": {
    "id": "tsk_01...",
    "task_key": "CORE-42",
    "title": "Implement atomic task checkout"
  },
  "message": "Post a progress comment and renew your claim"
}
```

This is backward-compatible because current `/schedule` and `/talk` payload handling can ignore extra fields.

## Calendar Integration

V1 only needs task-triggered heartbeats, but the model should leave room for:
- due-date reminders
- SLA escalations
- scheduled follow-ups on blocked tasks

Those should also reuse `schedule_definitions` with `source_type = 'task'` and a different `source_key`.

---

## Query and News Interop

Current coordination is message-based:
- `queries` track async work requests
- `news_items` track replies, notifications, and status updates

The task system should not break that. Instead:

- `source_query_id` links a task to the originating conversational request
- major task events are mirrored into `news_items`
- manager chat can continue to drive work through `/remote`
- agents can still discuss details over `talk/news`, but durable execution state lives in `tasks`

Recommended mirror format in `news_items.data`:

```json
{
  "task_id": "tsk_01...",
  "task_key": "CORE-42",
  "event_type": "task.status_changed",
  "status": "blocked"
}
```

---

## Manager Behavior

The manager should become the planner and allocator of work:
- create epics, stories, and tasks from chat requests
- assign candidate agents
- allow agents to claim leaf work
- surface `409 Conflict` cleanly instead of silently duplicating effort
- use task comments and events as the operational log

Recommended manager rules:
- prefer creating a task before telling an agent to do non-trivial work
- prefer splitting broad asks into child tasks instead of multi-claiming one task
- when a task is blocked, require a comment or `blocked_reason`

---

## Migration Plan

## Phase 0: Introduce Tables and Repos

- add the new task tables and repositories
- no behavior changes to `/ask`, `/hey`, `/talk`, `/news`
- keep current scheduler untouched

## Phase 1: Read/Write API

- add `/tasks` manager endpoints
- add `/task ...` interactive CLI commands
- allow humans and agents to create and update tasks explicitly

## Phase 2: Event Mirroring

- write `task_events` for every task mutation
- mirror major events into `news_items`
- link tasks to `source_query_id` when created from chat workflows

This is the compatibility bridge that keeps the single-chat manager experience intact.

## Phase 3: Claim-First Agent Workflow

- update agent instructions and skills to prefer:
  - list tasks
  - claim task
  - comment progress
  - mark blocked/done
- treat direct manager messages as routing hints, not authoritative ownership

## Phase 4: Heartbeat Integration

- add `task_heartbeat_configs`
- seed task heartbeats into the existing scheduler
- use heartbeat prompts to force regular progress comments or lease renewal

## Phase 5: Manager Defaults

- manager chat should create tasks automatically for long-running work
- `/ask agent ...` can optionally attach a `task_ref`
- broad user requests should map to `epic/story/task` trees instead of free-text delegation

## Phase 6: Legacy Coordination Cleanup

After the task system is stable:
- keep `queries` for conversational transport only
- stop treating chat history as the primary project tracker
- make task views the canonical work queue

---

## Recommended Implementation Order

1. Add DB adapter transaction support.
2. Add migrations for the new task tables.
3. Add `db.tasks` repository interfaces and implementations for SQLite/PostgreSQL.
4. Add manager REST endpoints.
5. Add `/task` CLI commands.
6. Mirror task events into `news_items`.
7. Add task heartbeat seeding using the existing scheduler service.
8. Update agent prompts/skills to use claim-first coordination.

---

## Opinionated Defaults

These defaults are optimized for AI coding teams:
- only leaf tasks are claimable
- one live checkout per leaf task
- multiple assignees allowed, but one owner
- claim implies `in_progress`
- blocked tasks require a reason
- long-running active tasks should have a heartbeat
- if two agents need to work in parallel, split into child tasks instead of shared checkout

That keeps the system simple enough to implement now and strong enough to prevent duplicate work, which is the main failure mode in multi-agent coding teams.
