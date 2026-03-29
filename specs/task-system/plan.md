# Task System Implementation Plan

## Summary

This plan follows a spec-kit approach: keep the first slice narrow, map each requirement to one concrete code path, and land the feature as a small vertical addition instead of a broad refactor.

The implementation should mirror the existing scheduling pattern:

- schema and row types in `src/db/migrations/*` and `src/db/types.ts`
- repository interface in `src/db/db-service.ts`
- dialect implementations in `src/db/repos/sqlite/` and `src/db/repos/postgres/`
- DB wiring in `src/db/index.ts`
- manager-owned command orchestration in `src/agent-manager-db.ts`
- CLI routing in `src/interactive-agent-cli.ts`

## Scope And Decisions

- Keep v1 manager-owned. Agents mutate task state only by sending `/remote` commands to the manager, matching the spec and the existing `/schedule` flow in `src/agent-manager-db.ts:2388-2403` and `src/interactive-agent-server.ts:174-230`.
- Reuse `schedule_definitions` as the canonical calendar-event store. `task_event_links` should link tasks to `schedule_definitions.id` where `kind='calendar'`, instead of introducing a second event table. This matches current calendar seeding in `src/scheduling/schedule-config.ts:109-149` and `src/agent-manager-db.ts:3504-3529`.
- Keep task IDs internal and task names user-facing. CLI and `/remote` target tasks by `name`, but the DB should still have a stable primary key for joins and deletes.
- Keep cross-dialect SQL simple: text primary keys, integer timestamps, no PostgreSQL-only enums, and no SQLite-only JSON tricks.
- Keep the first session to one repository (`TasksRepository`) even though it owns both `tasks` and `task_event_links`.

## Workstream 1: Database Schema

### Changes

- Add `TaskRow` and `TaskEventLinkRow` to `src/db/types.ts` beside the existing DB row types in `src/db/types.ts:12-104`.
- Extend the DB composite service with `tasks: TasksRepository` in `src/db/db-service.ts:344-364`.
- Wire the repo into `createPostgresDb()` and `createSqliteDb()` in `src/db/index.ts:30-62`.
- Add idempotent table creation to:
  - `src/db/migrations/sqlite.ts:5-126`
  - `src/db/migrations/postgres.ts` in the same section that creates other core tables and indexes.

### Schema

`tasks`

- `id TEXT PRIMARY KEY`
- `name TEXT NOT NULL UNIQUE`
- `team_id TEXT NULL REFERENCES teams(id) ON DELETE SET NULL`
- `title TEXT NOT NULL`
- `description TEXT NULL`
- `status TEXT NOT NULL` with application-level validation to `todo|doing|done`
- `created_by TEXT NULL REFERENCES agents(id) ON DELETE SET NULL`
- `owner TEXT NULL REFERENCES agents(id) ON DELETE SET NULL`
- `created_at INTEGER NOT NULL`
- `updated_at INTEGER NOT NULL`
- `completed_at INTEGER NULL`

`task_event_links`

- `task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE`
- `schedule_id TEXT NOT NULL REFERENCES schedule_definitions(id) ON DELETE CASCADE`
- `created_at INTEGER NOT NULL`
- `PRIMARY KEY (task_id, schedule_id)`

### Indexes

- `tasks_status_idx` on `(status, updated_at)`
- `tasks_owner_idx` on `(owner, status, updated_at)`
- `tasks_team_idx` on `(team_id, status, updated_at)`
- `task_event_links_schedule_idx` on `(schedule_id, task_id)`

### Notes

- `team_id` is the safest internal representation even though the spec says `team`; it preserves referential integrity and still allows filtering and moving tasks between teams.
- `created_by` and `owner` should store agent IDs, not names. The manager layer can resolve names for CLI output.
- `task_event_links` must only link to calendar schedules. Validation belongs in the manager/repository layer because SQL cannot express “FK only when `schedule_definitions.kind='calendar'`” portably.

## Workstream 2: Repository Layer

### Files

- Add `src/db/repos/sqlite/tasks-repo.ts`
- Add `src/db/repos/postgres/tasks-repo.ts`
- Update:
  - `src/db/db-service.ts:286-338` style section for a new `TasksRepository`
  - `src/db/index.ts:30-62`

### Repository Shape

Add `TasksRepository` after `SchedulesRepository` in `src/db/db-service.ts:283-338` with a deliberately small API:

- `create(task: TaskRow, eventScheduleIds?: string[]): Promise<void>`
- `getByName(name: string): Promise<TaskRow | null>`
- `list(filters?: { status?: 'todo' | 'doing' | 'done'; owner?: string; teamId?: string | null }): Promise<TaskRow[]>`
- `updateFields(taskId: string, fields: { team_id?: string | null; owner?: string | null; status?: 'todo' | 'doing' | 'done'; title?: string; description?: string | null; completed_at?: number | null; updated_at: number }): Promise<void>`
- `claim(taskId: string, ownerId: string, updatedAt: number): Promise<boolean>`
- `delete(taskId: string): Promise<void>`
- `replaceEventLinks(taskId: string, scheduleIds: string[]): Promise<void>`
- `listEventLinksForTask(taskId: string): Promise<Array<{ schedule_id: string }>>`
- `listTasksForSchedule(scheduleId: string): Promise<TaskRow[]>`

### Implementation Notes

- Follow the existing repo split used by `src/db/repos/sqlite/schedules-repo.ts:7-244` and `src/db/repos/postgres/schedules-repo.ts:7-235`.
- SQLite should keep parsing helpers at the top of the class if any type coercion is needed, similar to `src/db/repos/sqlite/schedules-repo.ts:10-24`.
- Keep SQL explicit and dialect-local rather than hiding placeholder differences behind helpers.
- `claim()` should be conditional:
  - only succeed when `owner IS NULL`
  - only succeed when `status = 'todo'`
  - atomically set `owner`, `status='doing'`, and `updated_at`
- `create()` should set `status='doing'` when `owner` is present, otherwise `todo`, matching the spec.
- `replaceEventLinks()` should be the only link mutator in v1; it keeps command logic simpler than incremental add/remove operations.

## Workstream 3: Manager Integration

### Files And Anchors

- Add task imports/types near `src/agent-manager-db.ts:26-35`
- Add task helper methods near the existing command helpers at `src/agent-manager-db.ts:2492-2535`
- Add `case 'task'` inside `executeRemoteCommand()` in `src/agent-manager-db.ts:2540-2835`

### Command Surface

Implement these manager commands:

- `/task create "<title>" [--name <slug>] [--description "..."] [--team <team>] [--owner <agent>] [--event <schedule-id>]...`
- `/task list [--status todo|doing|done] [--owner <agent>] [--team <team>]`
- `/task assign <task-name> <agent> [--team <team>]`
- `/task claim <task-name>`
- `/task done <task-name>`
- `/task remove <task-name>`

### Helper Methods

Add small manager-owned helpers, parallel to the schedule helpers:

- `resolveTaskByName(name)`
- `resolveOptionalTeamId(teamName)`
- `resolveOptionalOwnerId(teamId, agentRef)`
- `buildTaskResult(taskRow)` that expands owner/team names and linked calendar ids
- `generateUniqueTaskName(title)` using `normalizeAlias()` from `src/core/agent-identifier.ts:121-129` plus a numeric suffix on conflict

### Command Rules

- `create`
  - generates `name` from `title` when omitted
  - validates any `--event` target by checking `db.schedules.getDefinition(id)` and `kind === 'calendar'`
  - resolves `--owner` in the current team unless `--team` is also supplied
  - writes through `db.tasks.create(...)`
- `list`
  - defaults to all statuses
  - returns a compact JSON result for the CLI formatter, including `name`, `status`, `ownerName`, `teamName`, and `linkedEvents`
- `assign`
  - sets `owner`
  - sets `status='doing'`
  - optionally updates `team_id`
- `claim`
  - intended for agent use over `/remote`
  - resolves the caller from the existing `from` field once the `/remote` request body is plumbed through
  - rejects already-owned tasks
- `done`
  - manager can mark any task done
  - agent can only mark its own task done
  - sets `status='done'`, `completed_at`, and `updated_at`
- `remove`
  - deletes the task row; `task_event_links` cascades

### One-Session Constraint

Do not add a second service class for tasks. The manager already owns schedule orchestration in `executeRemoteCommand()`, and tasks can follow the same pattern without introducing new abstractions.

## Workstream 4: CLI Routing

### Files And Anchors

- Add help entries in `src/interactive-agent-cli.ts:55-82`
- Add a `/task` branch in the command handler beside the other manager-routed commands, close to:
  - `/update` forwarding in `src/interactive-agent-cli.ts:2442-2470`
  - `/calendar` forwarding/formatting in `src/interactive-agent-cli.ts:2925-3000`

### CLI Behavior

- Forward all `/task ...` commands to manager `/remote` with the same pattern used elsewhere:
  - `managerFetch('/remote', { method: 'POST', body: JSON.stringify({ command: input }) })`
- Format `task list` for daily use:
  - one line per task
  - show `status`, `name`, `owner`, and `team`
  - append linked calendar ids or titles in a short suffix
- Format `create`, `assign`, `claim`, `done`, and `remove` as short success/error messages.

### Minimal Help Additions

- `/task create "<title>" [--owner <agent>] [--team <team>] [--event <schedule-id>]`
- `/task list [--status <status>] [--owner <agent>] [--team <team>]`
- `/task assign <task-name> <agent>`
- `/task done <task-name>`
- `/task remove <task-name>`

## Workstream 5: Calendar Integration

### Files And Anchors

- Extend the schedule payload type in `src/scheduling/schedule-types.ts:27-40`
- Enrich dispatch payload creation in `src/scheduling/schedule-dispatcher.ts:36-46`
- Fetch linked tasks during scheduler ticks in `src/scheduling/scheduler-service.ts:37-103`
- Preserve the payload in agent internal scheduling flow in `src/interactive-agent-server.ts:300-352`

### Plan

- Extend `SchedulePayload` with an optional `linkedTasks` array:
  - `{ name, title, status, owner, team }[]`
- During `SchedulerService.tick()`, when `def.kind === 'calendar'`, load linked tasks via `db.tasks.listTasksForSchedule(def.id)`.
- Pass the linked tasks into `ScheduleDispatcher.dispatch(...)` so the payload sent to `/talk` or `/schedule` contains both the calendar message and task context.
- Keep heartbeat schedules unchanged.
- For internal schedules, make sure `interactive-agent-server` persists `linkedTasks` inside the queued query metadata together with `schedule` and `message`, so the receiving agent can inspect them later.

### Reasoning

This is the narrowest place to inject task context because `SchedulerService` already has DB access and already decides which schedule run is being delivered. No new calendar service is needed.

## Workstream 6: Agent API Via `/remote`

### Current Anchor

- Manager remote entrypoint: `src/agent-manager-db.ts:2388-2403`
- Interactive agent remote entrypoint: `src/interactive-agent-server.ts:174-230`

### Plan

- Keep the wire protocol command-based in v1. Agents create, claim, and complete tasks by POSTing `/remote` to the manager with task commands:
  - `/task create "..."`
  - `/task claim <task-name>`
  - `/task done <task-name>`
- Plumb the request-body `from` value through the manager remote endpoint so `executeRemoteCommand()` can enforce agent-specific permissions for `claim` and `done`.
- Permission rules:
  - `create`: any authenticated agent or manager
  - `claim`: authenticated agent only for unowned tasks
  - `done`: manager for any task; agent only when `owner === callerAgentId`
- Response shape should stay consistent with existing `/remote` usage:
  - `{ ok: true, result: ... }`
  - `{ ok: false, error: ... }`

### Why Not A New REST Resource

The current codebase already standardizes on remote CLI execution for manager-owned mutations. A dedicated `/tasks` API would be more surface area than needed for the first slice.

## Delivery Order

1. Add row types, repository interface, DB wiring, and migrations.
2. Implement SQLite and PostgreSQL task repos.
3. Add manager task helpers and `/task` command handling.
4. Add CLI help, routing, and formatting.
5. Add calendar linked-task payload enrichment.
6. Run smoke tests against both SQLite and PostgreSQL paths.

## Smoke Tests

- Start in SQLite mode and confirm migrations create `tasks` and `task_event_links`.
- Repeat in PostgreSQL mode.
- Manager CLI:
  - `/task create "Fix overflow"`
  - `/task list`
  - `/task assign fix-overflow contracts`
  - `/task done fix-overflow`
  - `/task remove fix-overflow`
- Calendar linkage:
  - create a calendar event with `/calendar add ...`
  - create a task linked to that schedule id
  - verify the fired payload includes `linkedTasks`
- Agent API:
  - POST manager `/remote` with `{ command: "/task create \"Follow up\"", from: "<agent>" }`
  - POST `/task claim`
  - POST `/task done`

## Risks And Guardrails

- The spec says tasks are global, but current agent resolution is team-scoped. For v1, treat tasks as globally named but resolve owners within the acting team unless `--team` explicitly overrides.
- Calendar events currently live inside `schedule_definitions`, not a dedicated event table. The plan depends on that remaining true for v1.
- `claim` needs the caller identity from manager `/remote`; without that plumbing, the manager cannot enforce “agent can only complete its own task.”
- Keep filtering and rendering simple. Do not add priorities, labels, comments, or task history in this session.
