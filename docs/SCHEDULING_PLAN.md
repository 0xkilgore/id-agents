# Scheduling System Implementation Plan

> Build one manager-owned scheduling platform for `id-agents`.
> Keep agent authoring simple with agent-level `heartbeat`, add first-class calendar events, and support multiple delivery modes including agent-internal scheduled dialogs.

---

## Goals

The scheduling system should:
- replace the old timer/file heartbeat runtime with one DB-backed scheduler
- keep agent config simple: an agent can declare its own `heartbeat`
- support top-level calendar events for one-off and recurring wall-clock schedules
- keep the manager as the only component that decides when a run is due
- support two delivery modes:
  - `talk`: manager posts the scheduled message to the agent's `/talk` endpoint
  - `internal`: manager posts the scheduled message to the agent's optional `/schedule` endpoint so the agent can enqueue it as an internal self-message
- remain restart-safe, timezone-correct, idempotent, and portable across SQLite and PostgreSQL

The scheduling system should not:
- run independent per-agent schedulers
- rely on in-memory timer maps as the source of truth
- mix UTC date strings with local-time calendar logic
- tie schedule identity to team membership

---

## Product Model

There is one scheduler with two schedule kinds:
- `interval`: recurring work every N seconds, including agent `heartbeat`
- `calendar`: one-off or recurring wall-clock events

There is one delivery contract with two delivery modes:
- `talk`: external scheduled message, delivered through `/talk`
- `internal`: internal scheduled dialog, delivered through `/schedule`

The manager owns time.
Agents own how scheduled work is consumed.

---

## Authoring Model

### Agent-level heartbeat

Keep this as the simplest authoring interface for single-agent recurring work.

```yaml
agents:
  - name: x
    heartbeat:
      interval: 300
      message: "Review timeline and draft replies"
      delivery: internal
      maxBeats: 20
      expiresAfter: 7200
```

This compiles into an `interval` schedule targeting that one agent.

### Top-level calendar events

Use top-level calendar events for wall-clock scheduling and fan-out to one or more agents.

```yaml
calendar:
  - title: "Morning X engagement"
    time: "09:00"
    timezone: "America/New_York"
    days: [mon, tue, wed, thu, fri]
    agents: [x]
    message: "Review timeline and draft replies"
    delivery: internal
```

---

## Core Architecture

The source of truth is:
- `schedule_definitions`: what should happen
- `schedule_targets`: which agents should receive it
- `schedule_runs`: what actually happened

The scheduler loop runs in the manager every 30 seconds:
1. load active schedule definitions
2. evaluate due logical runs inside `(last_tick, now]`
3. expand each run to target agents
4. insert a unique run log row for dedupe
5. dispatch only if the insert succeeds
6. mark the run as `sent`, `failed`, or `skipped`

This remains true for both `talk` and `internal` delivery. Only the final dispatch step changes.

---

## Data Model

### `schedule_definitions`

```sql
CREATE TABLE schedule_definitions (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,                    -- 'interval' | 'calendar'
  title TEXT NOT NULL,
  description TEXT,
  active INTEGER NOT NULL DEFAULT 1,

  message TEXT NOT NULL,
  delivery_mode TEXT NOT NULL DEFAULT 'talk',   -- 'talk' | 'internal'
  timezone TEXT,
  catch_up_policy TEXT NOT NULL DEFAULT 'skip',
  dedupe_window_seconds INTEGER NOT NULL DEFAULT 90,

  interval_seconds INTEGER,
  anchor_at INTEGER,
  max_runs INTEGER,
  expires_at INTEGER,

  local_time_seconds INTEGER,
  local_date TEXT,
  days_of_week TEXT,

  source_type TEXT NOT NULL DEFAULT 'yaml',
  source_key TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
```

### `schedule_targets`

```sql
CREATE TABLE schedule_targets (
  schedule_id TEXT NOT NULL REFERENCES schedule_definitions(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  PRIMARY KEY (schedule_id, agent_id)
);
```

### `schedule_runs`

```sql
CREATE TABLE schedule_runs (
  schedule_id TEXT NOT NULL REFERENCES schedule_definitions(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  scheduled_key TEXT NOT NULL,
  scheduled_at INTEGER NOT NULL,
  fired_at INTEGER NOT NULL,
  status TEXT NOT NULL,                 -- 'pending' | 'sent' | 'failed' | 'skipped'
  error TEXT,
  PRIMARY KEY (schedule_id, agent_id, scheduled_key)
);
```

`delivery_mode` lives on the schedule definition because delivery style is part of schedule behavior, not per-run state.

---

## Schedule Semantics

### Interval schedules

Store:
- `interval_seconds`
- `anchor_at`
- optional `max_runs`
- optional `expires_at`

Due-run math is elapsed-window based, not slot-wheel based.

Logical run key:
```text
interval:<scheduled_at>
```

Default policy:
- `catch_up_policy = fire_once`

### Calendar schedules

Store:
- `timezone`
- `local_time_seconds`
- either `local_date` or `days_of_week`

Evaluate every schedule in its own timezone.

Logical run key:
```text
calendar:<local-date>@<local_time_seconds>
```

Default policy:
- `catch_up_policy = skip`

### DST policy

Recurring calendar schedules are wall-clock schedules.
- if a local time does not exist during spring-forward, skip that occurrence
- if a local time occurs twice during fall-back, fire once for that logical local occurrence key

---

## Delivery Modes

### `talk`

Manager posts to the agent's `/talk` endpoint.
This is the default mode and the REST-AP-required baseline.

Payload:

```json
{
  "from": "schedule",
  "mode": "talk",
  "schedule": {
    "id": "sch_123",
    "kind": "calendar",
    "title": "Morning X engagement",
    "scheduledKey": "calendar:2026-03-28@32400"
  },
  "message": "Review timeline and draft replies"
}
```

This is still asynchronous job submission, not a synchronous reply flow.
Scheduled deliveries should not trigger auto-reply behavior.

### `internal`

Manager posts to the agent's optional `/schedule` endpoint.
The agent accepts the schedule event and enqueues it as internal scheduled work.

Payload:

```json
{
  "from": "schedule",
  "mode": "internal",
  "schedule": {
    "id": "sch_123",
    "kind": "calendar",
    "title": "Morning X engagement",
    "scheduledKey": "calendar:2026-03-28@32400"
  },
  "message": "Review timeline and draft replies"
}
```

The `/schedule` endpoint should:
- validate the payload
- enqueue work internally
- return `202 Accepted`
- never block on task completion
- never auto-reply to the manager as if it were a normal agent conversation

---

## REST-AP Contract

REST-AP still mandates `/talk`.
This feature adds one optional endpoint:
- `POST /schedule`

Agent discovery via `/.well-known/restap.json` should advertise:
- `endpoints.schedule` when supported
- a corresponding capability entry

Manager dispatch rules:
- if `delivery_mode = talk`, use `/talk`
- if `delivery_mode = internal`, require a discovered `/schedule` endpoint
- if `/schedule` is missing for an `internal` schedule, mark the run failed with a clear error

Do not silently fall back from `internal` to `talk`.
That would hide capability mismatches.

---

## Manager Responsibilities

The manager owns:
- schedule seeding from config
- active schedule loading
- due-run computation
- run-log insertion and dedupe
- capability discovery from agent REST-AP catalogs
- delivery selection by `delivery_mode`
- run status updates

The manager does not own:
- how the agent internally queues or prioritizes `/schedule` work
- agent-specific execution semantics after the schedule has been accepted

---

## Agent Responsibilities

Agents should implement:
- `POST /talk` for required REST-AP message delivery
- optional `POST /schedule` for internal scheduled work

For Claude-style agents:
- `/schedule` should enqueue a query with `noAutoReply: true`
- `/talk` should also suppress auto-reply when the payload is schedule-originated

For interactive agents:
- `/schedule` should enqueue a pending query just like `/talk`, but mark it as internal scheduled work in persisted metadata/news

---

## Config Mapping

### HeartbeatConfig

Add:
- `delivery?: 'talk' | 'internal'`

### CalendarSpec

Add:
- `delivery?: 'talk' | 'internal'`

Normalization rules:
- heartbeat defaults to `delivery = internal`
- calendar defaults to `delivery = talk`

Reasoning:
- heartbeat is usually autonomous recurring work
- calendar events are more often explicit manager-driven prompts

---

## Database / Repository Changes

Update:
- `ScheduleDefinitionRow` to include `delivery_mode`
- PostgreSQL and SQLite migrations to add `delivery_mode`
- repository upsert/select plumbing for that column
- schedule config normalization to fill `delivery_mode`

No schedule-run schema changes are needed beyond keeping `pending` as a valid status.

---

## Dispatcher Changes

`ScheduleDispatcher` should:
1. build the common scheduled payload
2. inspect `def.delivery_mode`
3. choose endpoint path:
   - `/talk` or discovered `endpoints.talk`
   - `/schedule` or discovered `endpoints.schedule`
4. POST the payload
5. return success/failure to the scheduler service

Dispatch targets should carry:
- agent id
- agent name
- base endpoint
- discovered talk path
- optional discovered schedule path
- status

---

## Failure Policy

If an agent is offline or missing the required endpoint:
- insert the run row
- mark the run `failed` or `skipped` with a concrete error
- do not retry immediately in the same tick

If an `internal` schedule targets an agent without `/schedule` support:
- fail the run with `Agent does not advertise /schedule`

---

## Implementation Phases

### Phase 1: Schema and Types
- add `delivery_mode` to schedule definition types
- add migration support in SQLite and PostgreSQL
- update schedule repositories

### Phase 2: Config and Normalization
- extend `HeartbeatConfig` and `CalendarSpec` with `delivery`
- map config delivery to `delivery_mode`
- keep agent-level `heartbeat` authoring intact

### Phase 3: Manager Dispatch
- extend REST-AP discovery to include optional `schedule`
- extend dispatcher to branch on `delivery_mode`
- keep run-log dedupe unchanged

### Phase 4: Agent Endpoints
- add `POST /schedule` to Claude agent server
- add `POST /schedule` to interactive agent server
- advertise the endpoint in REST-AP catalogs
- ensure scheduled deliveries do not trigger auto-reply logic

### Phase 5: Validation and Failure Paths
- fail clearly when `internal` is requested but unsupported
- verify `talk` mode remains backward-compatible
- confirm no startup reseeding or max-run regressions

### Phase 6: Tests
- schedule config parsing for `delivery`
- heartbeat normalization -> `delivery_mode`
- calendar normalization -> `delivery_mode`
- dispatcher routing to `/talk` vs `/schedule`
- failure when `/schedule` is not advertised
- no double-fire across restart or duplicate ticks
- timezone correctness for recurring calendar schedules

---

## Rollout Notes

This feature is additive at the API layer and should preserve existing scheduled behavior.
Existing schedules without `delivery_mode` should default to `talk` at the DB layer.
Newly seeded heartbeat schedules may choose `internal` by default once the endpoint support is in place.

---

## Bottom Line

The optimal design is:
- one manager-owned scheduler
- one shared schedule data model
- two schedule kinds: `interval`, `calendar`
- two delivery modes: `talk`, `internal`
- optional `/schedule` endpoint for self-directed agent work

That keeps the architecture strong while making scheduled agent behavior feel more autonomous.
