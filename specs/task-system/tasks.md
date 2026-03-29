# Task System Ordered Task Breakdown

This breakdown is ordered for execution and grouped by the implementation-plan workstreams. Each task is scoped so a sub-agent can complete it in one pass. `Parallelizable` means it can run alongside the named tasks after its dependencies are satisfied, without intentionally sharing file ownership.

## Workstream 1: Database Schema

### T1. Shared task DB contracts and wiring
- Short title: Add shared task DB types, repository contract, and DB wiring
- Files to create or modify:
  - `src/db/types.ts`
  - `src/db/db-service.ts`
  - `src/db/index.ts`
- Dependencies: None
- Parallelizable: No. This is the foundation for all DB and integration tasks.

### T2. SQLite task schema migration
- Short title: Add SQLite tables and indexes for tasks
- Files to create or modify:
  - `src/db/migrations/sqlite.ts`
- Dependencies:
  - `T1`
- Parallelizable: Yes, with `T3`

### T3. Postgres task schema migration
- Short title: Add Postgres tables and indexes for tasks
- Files to create or modify:
  - `src/db/migrations/postgres.ts`
- Dependencies:
  - `T1`
- Parallelizable: Yes, with `T2`

## Workstream 2: Repository Layer

### T4. SQLite tasks repository
- Short title: Implement SQLite `TasksRepository`
- Files to create or modify:
  - `src/db/repos/sqlite/tasks-repo.ts`
- Dependencies:
  - `T1`
  - `T2`
- Parallelizable: Yes, with `T5`

### T5. Postgres tasks repository
- Short title: Implement Postgres `TasksRepository`
- Files to create or modify:
  - `src/db/repos/postgres/tasks-repo.ts`
- Dependencies:
  - `T1`
  - `T3`
- Parallelizable: Yes, with `T4`

## Workstream 3: Manager Integration

### T6. Manager task helpers and `/task` command handling
- Short title: Add manager-owned task command execution
- Files to create or modify:
  - `src/agent-manager-db.ts`
- Dependencies:
  - `T4`
  - `T5`
- Parallelizable: No. This task owns the full `/task` command path in `src/agent-manager-db.ts`, including parsing, validation, task-name resolution, result shaping, and manager-side state transitions.

## Workstream 4: CLI Routing

### T7. CLI help, forwarding, and task list formatting
- Short title: Add `/task` CLI routing and output formatting
- Files to create or modify:
  - `src/interactive-agent-cli.ts`
- Dependencies:
  - `T6`
- Parallelizable: Yes, with `T8` and `T9`

## Workstream 5: Calendar Integration

### T8. Scheduler linked-task payload enrichment
- Short title: Load linked tasks into calendar dispatch payloads
- Files to create or modify:
  - `src/scheduling/schedule-types.ts`
  - `src/scheduling/schedule-dispatcher.ts`
  - `src/scheduling/scheduler-service.ts`
- Dependencies:
  - `T4`
  - `T5`
- Parallelizable: Yes, with `T7`

## Workstream 6: Agent API Via `/remote`

### T9. Remote caller plumbing and agent-side task permissions
- Short title: Enable agent `create`, `claim`, and `done` via manager `/remote`
- Files to create or modify:
  - `src/interactive-agent-server.ts`
  - `src/agent-manager-db.ts`
- Dependencies:
  - `T6`
- Parallelizable: Limited. It can run alongside `T7` and `T8`, but not alongside any other task editing `src/agent-manager-db.ts`.

### T10. Preserve linked task context in internal schedule flow
- Short title: Keep `linkedTasks` in queued internal schedule metadata
- Files to create or modify:
  - `src/interactive-agent-server.ts`
- Dependencies:
  - `T8`
- Parallelizable: Yes, with `T7`. Do not run in parallel with `T9` because both modify `src/interactive-agent-server.ts`.

## Verification

### T11. SQLite and Postgres smoke test pass
- Short title: Run end-to-end task-system smoke tests
- Files to create or modify:
  - No source changes required
  - Optional test-doc update if the repo keeps manual verification notes
- Dependencies:
  - `T2`
  - `T3`
  - `T4`
  - `T5`
  - `T6`
  - `T7`
  - `T8`
  - `T9`
  - `T10`
- Parallelizable: No. This is the final validation step.

## Suggested Execution Order

1. `T1`
2. `T2` and `T3` in parallel
3. `T4` and `T5` in parallel
4. `T6`
5. `T7`, `T8`, and `T9` in parallel where file ownership allows
6. `T10`
7. `T11`
