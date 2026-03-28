# Scheduling System Implementation Plan

> Build one scheduling platform for `id-agents`, not two separate features glued together.
> Support both interval work (current heartbeat behavior) and wall-clock calendar events.
> Make it restart-safe, timezone-correct, agent-centric, observable, and consistent across SQLite and PostgreSQL.

---

## Goals

The scheduling system should:
- replace timer-per-agent heartbeat scheduling in `agent-manager-db.ts`
- preserve current heartbeat product behavior where it still matters (`interval`, `message`, optional `maxBeats`, optional `expiresAfter`)
- add first-class calendar scheduling for one-off and recurring local-time events
- use the existing repository-based database architecture in `src/db/`
- target agents directly by global `agent.id` (team is only metadata)
- behave correctly across manager restarts, timer drift, and normal downtime
- work the same on SQLite and PostgreSQL

The scheduling system should not:
- rely on broad SQL translation tricks
- depend on in-memory timer maps as the source of truth
- mix local wall time with UTC date logic
- store scheduling state in agent working-directory files unless that is an explicit compatibility shim

---

## Current Codebase Reality

The project already has important pieces in place:

- `src/db/` now uses repository interfaces with PostgreSQL and SQLite implementations
- `agents.id` is globally unique and is the correct scheduling target key
- heartbeat logic still lives in `src/agent-manager-db.ts` as in-memory timer maps plus `HEARTBEAT.yaml` reads
- `config-parser.ts` already has a `HeartbeatConfig` type with `interval`, `message`, `maxBeats`, `expiresAfter`
- SQLite and PostgreSQL migrations are already split cleanly

This means the best implementation path is:
- add scheduling tables and repositories under `src/db/`
- move heartbeat state and calendar state into the database
- keep one manager scheduler loop
- phase out timer-per-agent scheduling and file-based runtime heartbeat config

---

## Recommended Architecture

Use one unified scheduling system with two schedule kinds:

1. `interval`
- for sub-hourly and recurring background work
- replaces current heartbeat timers

2. `calendar`
- for local-time schedules such as daily/weekly or one-off dated events

Both kinds share the same:
- schedule definition storage
- target association
- due-run evaluation pipeline
- execution log and dedupe model
- delivery path into agents

### Core Principle

The source of truth is:
- `schedule_definitions`: what should happen
- `schedule_targets`: which agents should receive it
- `schedule_runs`: what actually happened

Do not use `last_fired_at` on the schedule row as the primary dedupe mechanism.
Use an append-only run log with a uniqueness constraint.

---

## Data Model

### 1. `schedule_definitions`

One row per schedule.

```sql
CREATE TABLE schedule_definitions (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,                    -- 'interval' | 'calendar'
  title TEXT NOT NULL,
  description TEXT,
  active INTEGER NOT NULL DEFAULT 1,

  -- common payload
  message TEXT NOT NULL,
  timezone TEXT,                        -- used by calendar schedules
  catch_up_policy TEXT NOT NULL DEFAULT 'skip',   -- 'skip' | 'fire_once'
  dedupe_window_seconds INTEGER NOT NULL DEFAULT 90,

  -- interval schedules
  interval_seconds INTEGER,
  anchor_at INTEGER,                    -- unix seconds; aligns recurring cadence
  max_runs INTEGER,
  expires_at INTEGER,                   -- unix seconds absolute expiry

  -- calendar schedules
  local_time_seconds INTEGER,           -- 0..86399
  local_date TEXT,                      -- YYYY-MM-DD for one-off schedules
  days_of_week TEXT,                    -- normalized csv: 'mon,tue,wed'

  -- lifecycle
  source_type TEXT NOT NULL DEFAULT 'yaml',       -- 'yaml' | 'cli' | 'api'
  source_key TEXT,                      -- stable key for idempotent reseeding
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
```

### 2. `schedule_targets`

Many-to-many mapping from schedules to agents.

```sql
CREATE TABLE schedule_targets (
  schedule_id TEXT NOT NULL REFERENCES schedule_definitions(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  PRIMARY KEY (schedule_id, agent_id)
);
```

This is intentionally agent-centric. Team membership should not affect schedule identity.

### 3. `schedule_runs`

Append-only execution and dedupe log.

```sql
CREATE TABLE schedule_runs (
  schedule_id TEXT NOT NULL REFERENCES schedule_definitions(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  scheduled_key TEXT NOT NULL,          -- deterministic logical run key
  scheduled_at INTEGER NOT NULL,        -- logical scheduled instant (unix seconds)
  fired_at INTEGER NOT NULL,            -- actual execution instant
  status TEXT NOT NULL,                 -- 'sent' | 'failed' | 'skipped'
  error TEXT,
  PRIMARY KEY (schedule_id, agent_id, scheduled_key)
);

CREATE INDEX schedule_runs_schedule_idx ON schedule_runs(schedule_id, fired_at);
CREATE INDEX schedule_runs_agent_idx ON schedule_runs(agent_id, fired_at);
```

The unique key is what prevents double-delivery after overlap, retries, or restart.

---

## Schedule Semantics

## Interval Schedules

Use interval math, not a persisted slot wheel.

Each interval schedule has:
- `interval_seconds`
- `anchor_at`

A schedule is due when an interval boundary falls inside the elapsed window `(last_tick, now]`.

Logical run number:

```text
n = floor((t - anchor_at) / interval_seconds)
```

Logical scheduled instant:

```text
scheduled_at = anchor_at + n * interval_seconds
```

Logical run key:

```text
interval:<scheduled_at>
```

This is better than slot rows because it:
- avoids row explosion
- avoids divisibility restrictions like “must divide 3600”
- avoids startup alignment bugs
- supports arbitrary intervals cleanly
- makes catch-up handling explicit

### Interval Constraints

Recommended initial policy:
- minimum interval: 60 seconds
- maximum interval: 86400 seconds
- reject invalid config at parse/deploy time instead of rounding

For v1, `catch_up_policy` should support:
- `skip`
- `fire_once`

Recommended defaults:
- interval schedules: `fire_once`

Meaning:
- if the manager was down or delayed, send at most one missed interval run on recovery
- do not replay a backlog of 50 missed heartbeats

### Mapping Existing Heartbeat Behavior

Current `HeartbeatConfig` fields map directly:

| Current | New schedule field |
|---------|--------------------|
| `interval` | `interval_seconds` |
| `message` | `message` |
| `maxBeats` | `max_runs` |
| `expiresAfter` | `expires_at` computed from schedule activation time |

The current heartbeat feature becomes a specialized interval schedule, not a separate subsystem.

---

## Calendar Schedules

Calendar schedules are local wall-clock schedules.

Each calendar schedule has:
- `timezone`
- `local_time_seconds`
- either `local_date` for one-off schedules
- or `days_of_week` for recurring schedules

Examples:
- one-off launch event on `2026-04-01` at `08:00` America/New_York
- recurring Mon-Fri event at `09:00` America/New_York

Logical run key:

```text
calendar:<local-date>@<local_time_seconds>
```

Example:

```text
calendar:2026-04-01@32400
```

### Timezone Policy

All calendar matching must be done in the event timezone.
Never mix:
- local `Date.getHours()`
- UTC `toISOString()`

Use one explicit timezone pipeline end-to-end.

### DST Policy

Document and implement this explicitly:
- recurring schedules are local wall-clock schedules
- if a local time does not exist on spring-forward day, skip that occurrence
- if a local time occurs twice on fall-back day, fire once per logical local key

That policy is simple, predictable, and operationally safe.

### Calendar Catch-Up Policy

Recommended default:
- calendar schedules: `skip`

Meaning:
- if the manager was down at 09:00 and comes back at 09:43, do not fire the 09:00 calendar event late by default

This matches normal calendar expectations.

---

## Manager Runtime Design

Use one scheduler loop in the manager process.

```typescript
setInterval(() => this.schedulerTick(), 30_000);
```

A 30-second cadence is preferable to 60 seconds because:
- tighter delivery jitter
- easier window handling
- still operationally cheap

The only in-memory state needed is tick bookkeeping:
- `lastSchedulerTickAtSec`

That state is only for evaluating the current elapsed window.
It is not the source of truth for schedule progress.

### Scheduler Tick Pipeline

Each tick should:

1. capture `nowSec`
2. compute window `(lastSchedulerTickAtSec, nowSec]`
3. evaluate due interval schedule runs
4. evaluate due calendar schedule runs
5. expand each due logical run to target agents
6. try to insert a `schedule_runs` row for each target
7. only dispatch if insert succeeds
8. update success/failure status in `schedule_runs`
9. update `lastSchedulerTickAtSec`

### Why This Is Restart-Safe

Because dedupe is enforced by `schedule_runs` uniqueness:
- restarting the manager does not re-send already logged runs
- a long tick window still produces deterministic logical run keys
- overlapping windows do not double-fire

---

## Repository Layer Plan

This project already has repository interfaces and per-dialect implementations.
Scheduling should follow the same pattern.

### Add New Repository Interfaces

In `src/db/db-service.ts`, add:

```typescript
export interface ScheduleDefinitionRow {
  id: string;
  kind: 'interval' | 'calendar';
  title: string;
  description: string | null;
  active: boolean;
  message: string;
  timezone: string | null;
  catch_up_policy: 'skip' | 'fire_once';
  dedupe_window_seconds: number;
  interval_seconds: number | null;
  anchor_at: number | null;
  max_runs: number | null;
  expires_at: number | null;
  local_time_seconds: number | null;
  local_date: string | null;
  days_of_week: string | null;
  source_type: string;
  source_key: string | null;
  created_at: number;
  updated_at: number;
}

export interface ScheduleRunRow {
  schedule_id: string;
  agent_id: string;
  scheduled_key: string;
  scheduled_at: number;
  fired_at: number;
  status: 'sent' | 'failed' | 'skipped';
  error: string | null;
}

export interface SchedulesRepository {
  upsertDefinition(def: ScheduleDefinitionRow): Promise<void>;
  replaceTargets(scheduleId: string, agentIds: string[]): Promise<void>;
  listActiveDefinitions(): Promise<ScheduleDefinitionRow[]>;
  listTargets(scheduleId: string): Promise<string[]>;
  insertRun(run: ScheduleRunRow): Promise<boolean>;   // true if inserted, false if duplicate
  updateRunStatus(scheduleId: string, agentId: string, scheduledKey: string, status: 'sent' | 'failed' | 'skipped', error?: string | null): Promise<void>;
  listSchedulesForAgent(agentId: string): Promise<ScheduleDefinitionRow[]>;
  deleteBySource(sourceType: string, sourceKeyPrefix?: string): Promise<void>;
}
```

### Add Repository Implementations

Create:
- `src/db/repos/postgres/schedules-repo.ts`
- `src/db/repos/sqlite/schedules-repo.ts`

Use explicit SQL per dialect.
No SQL translation layer.

### Compose into `Db`

Extend the DB factory in `src/db/index.ts` to include:
- `schedules: new PgSchedulesRepo(adapter)`
- `schedules: new SqliteSchedulesRepo(adapter)`

---

## Service Layer Plan

Create a scheduler service rather than putting all logic directly into `agent-manager-db.ts`.

Recommended new files:

```text
src/scheduling/
  schedule-types.ts
  schedule-config.ts
  schedule-evaluator.ts
  schedule-dispatcher.ts
  scheduler-service.ts
```

### `schedule-evaluator.ts`

Responsible for:
- computing due logical interval runs in a window
- computing due logical calendar runs in a window
- generating deterministic `scheduled_key`

It should be pure or mostly pure logic so it is easy to unit test.

### `schedule-dispatcher.ts`

Responsible for:
- loading target agent details
- delivering the schedule payload to the agent endpoint
- returning structured success/failure results

### `scheduler-service.ts`

Responsible for:
- orchestration of the tick
- repository calls
- run insertion and dedupe
- updating run status
- exposing helper methods for startup, reseed, and listing schedules

This separation is important. It keeps the manager code from becoming another giant mixed-responsibility file.

---

## Config Model

Move toward one unified schedule config shape.

### Recommended Future Shape

```yaml
schedules:
  - title: "Contracts test loop"
    kind: interval
    every: 300
    agents: [contracts]
    message: "Run tests and report status"
    maxRuns: 20
    expiresAfter: 7200

  - title: "Morning X engagement"
    kind: calendar
    time: "09:00"
    timezone: "America/New_York"
    days: [mon, tue, wed, thu, fri]
    agents: [x]
    message: "Find tweets to engage with and suggest replies"

  - title: "Launch day"
    kind: calendar
    date: "2026-04-01"
    time: "08:00"
    timezone: "America/New_York"
    agents: [x, id-agents-app]
    message: "Launch day — post announcements and monitor response"
```

### Transitional Compatibility

For v1 implementation, continue supporting current heartbeat config input from `config-parser.ts`:
- per-agent `heartbeat:` blocks
- resolved `HeartbeatConfig`

During config normalization:
- convert each heartbeat block into an `interval` schedule definition
- support top-level `calendar:` as a temporary alias or convert directly to unified `schedules:`

This avoids a big config break while moving the internal model to something much cleaner.

---

## Delivery Contract to Agents

Stop treating heartbeat and calendar as unrelated message origins.

Use one structured schedule payload:

```json
{
  "from": "schedule",
  "schedule": {
    "id": "sch_123",
    "kind": "interval",
    "title": "Contracts test loop",
    "scheduledKey": "interval:1711737600"
  },
  "message": "Run tests and report status"
}
```

Advantages:
- agents can distinguish scheduled work from human messages
- future schedule types can reuse the same contract
- logs and telemetry become cleaner

If needed for compatibility, the manager can temporarily preserve `from: "heartbeat"` / `from: "calendar"` at the edges, but the internal system should unify them.

---

## CLI / UX Plan

Do not start with a large interactive scheduling editor.
Start with visibility and safe basic control.

### Recommended Commands

- `/schedules`
  - list active schedules, grouped by agent or kind
- `/schedule <id>`
  - show a single schedule definition and targets
- `/schedule runs <id>`
  - show recent run history
- `/schedule pause <id>`
- `/schedule resume <id>`
- `/schedule remove <id>`

Compatibility layer:
- keep `/heartbeat` and `/heartbeats` initially
- reimplement them on top of schedule data
- mark them as heartbeat-specific views over interval schedules

This keeps the user-facing workflow stable while the backend changes dramatically.

---

## Migration Strategy

### Database Migrations

Add the same new tables to both:
- `src/db/migrations/postgres.ts`
- `src/db/migrations/sqlite.ts`

Required objects:
- `schedule_definitions`
- `schedule_targets`
- `schedule_runs`
- supporting indexes

### Code Migration

#### Remove over time
From `src/agent-manager-db.ts`:
- `heartbeatTimers`
- `heartbeatLastSent`
- `heartbeatIntervals`
- `heartbeatCounts`
- `heartbeatStartTimes`
- timer-based `startHeartbeatForAgent()`
- timer-based `stopHeartbeatForAgent()`
- file-driven `sendHeartbeat()` orchestration
- `initAllHeartbeats()` / `startAgentHeartbeats()` as timer bootstrapping

#### Keep temporarily as compatibility behavior
- `/heartbeat` and `/heartbeats` commands
- `HeartbeatConfig` parsing from config
- deploy-time heartbeat config loading

#### Remove intentionally later
- `HEARTBEAT.yaml` runtime file reads
- working-directory heartbeat state as authoritative source

The DB should become authoritative for scheduling.

---

## Reseeding / Deploy Behavior

Schedule seeding must be idempotent.
Do not rely on deleting agents to clean up stale schedules.

### Recommended Source Identity

Use:
- `source_type = 'yaml'`
- `source_key = <stable config path + logical schedule name>`

Deploy flow:
1. parse config
2. normalize into schedule definitions
3. upsert definitions by `source_type + source_key`
4. replace target mappings for those definitions
5. deactivate or delete prior YAML-derived definitions that are no longer present in the current config scope

This gives clean redeploy behavior without duplicate schedules.

---

## Observability

A world-class scheduler needs visibility.

### Metrics

Track:
- active schedule count
- due schedule count per tick
- successful sends
- failed sends
- skipped sends
- scheduler lag (`now - scheduled_at`)
- average dispatch latency

### Logs

Log at least:
- schedule evaluated due
- dedupe insert accepted/rejected
- dispatch success/failure
- schedule pause/resume/remove actions

### Run History

The `schedule_runs` table should power:
- `/schedule runs <id>`
- debugging restart behavior
- verifying missed-event handling
- answering “did this actually fire?”

---

## Testing Plan

### Unit Tests

Pure evaluator tests for:
- interval due-run calculation across normal windows
- interval due-run calculation across restart/downtime windows
- `fire_once` vs `skip`
- calendar due-run matching by timezone
- day-of-week evaluation
- one-off date evaluation
- DST spring-forward skip behavior
- DST fall-back single-fire behavior
- deterministic `scheduled_key` generation

### Repository Tests

For both PostgreSQL and SQLite:
- insert schedule definition
- replace targets
- dedupe insert into `schedule_runs`
- duplicate insert returns false / no-op
- delete agent cascades schedule target cleanup
- delete schedule cascades run cleanup

### Integration Tests

- manager startup initializes scheduler loop without per-agent timers
- heartbeat config seeds interval schedules
- calendar config seeds calendar schedules
- interval schedule fires once on cadence
- one-off calendar schedule fires once then stops
- recurring calendar schedule fires on the correct local day/time
- manager restart does not duplicate sends
- manager downtime obeys catch-up policy
- `/heartbeat` compatibility commands still return meaningful status

---

## Implementation Order

### Phase 1: Schema + DB layer

1. add schedule row types and repository interfaces
2. add PostgreSQL schedule repository
3. add SQLite schedule repository
4. wire `db.schedules` into `src/db/index.ts`
5. add migrations for scheduling tables

### Phase 2: Pure scheduling engine

6. implement `schedule-evaluator.ts`
7. implement config normalization from current heartbeat/calendar config shapes
8. implement `scheduler-service.ts`
9. implement `schedule-dispatcher.ts`

### Phase 3: Manager integration

10. add one scheduler loop to manager boot
11. seed schedules on deploy/startup
12. replace timer-based heartbeat startup logic
13. route schedule dispatches through existing agent delivery code

### Phase 4: CLI compatibility + visibility

14. reimplement `/heartbeat` and `/heartbeats` on top of schedule state
15. add `/schedules` and `/schedule runs <id>`
16. expose recent run status in manager responses where useful

### Phase 5: Cleanup

17. remove timer maps and old timer lifecycle code
18. remove `HEARTBEAT.yaml` as authoritative source
19. collapse config docs to unified `schedules:` model once compatibility is no longer needed

---

## Open Design Decisions

These should be decided explicitly before implementation finishes:

1. Tick cadence
- recommended: 30 seconds

2. Catch-up policy defaults
- interval: `fire_once`
- calendar: `skip`

3. Schedule payload compatibility
- whether to preserve `from: "heartbeat"` / `from: "calendar"` temporarily

4. Runtime config mutability
- whether file edits to `HEARTBEAT.yaml` should still affect behavior after deploy
- recommendation: no, move authority to DB/YAML config and explicit reseed

5. Calendar timezone scope
- per-schedule timezone from day one, or one global/team default initially
- recommendation: keep per-schedule column now, even if config uses one default most of the time

---

## Summary

The right system for this project is:
- unified
- agent-centric
- repository-backed
- timezone-correct
- run-log deduped
- restart-safe
- compatible with both SQLite and PostgreSQL

In concrete terms:
- current heartbeat becomes `interval` schedules
- new calendar support becomes `calendar` schedules
- one scheduler loop replaces many in-memory timers
- database state becomes authoritative
- `schedule_runs` becomes the backbone for correctness and observability

This is more work than adding a wheel table and an events table, but it is the correct long-term design for `id-agents`.
