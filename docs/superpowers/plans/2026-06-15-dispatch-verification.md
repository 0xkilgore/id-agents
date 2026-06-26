# DispatchVerification Substrate Implementation Plan

> Refactor plan W2-1. This is the implementation-ready plan for the verified-landing-rate substrate that powers Kapelle's Agents tab.

**Date:** 2026-06-15  
**Project:** Kapelle  
**Owner lane:** Roger = `id-agents` core  
**Inputs read:** `agent-platform/output/2026-06-11-console-v2-structural-scope.md` §1.4, `cane/output/2026-06-12-kapelle-codebase-review.md` §2 #6, `cane/output/2026-06-12-kapelle-refactor-implementation-plan.md` §3 W2-1.

## Goal

Make `verified_landing_rate` a real manager-owned metric, not a dashboard guess.

A dispatch is a verified landing only when:

1. `/agent-done` completed the scheduler dispatch with `success: true`.
2. The dispatch has a first-class `artifact_path`.
3. The artifact exists on disk.
4. The artifact mtime is inside the delivery window: `started_at || not_before_at <= mtime <= completed_at`.
5. For build dispatches, the Spec 054 promotion block validates: `completed: true`, every repo has `pushed: true`, `verified: true`, and `remote_main_sha === promoted_sha`.

The manager writes this result into a typed `DispatchVerification` projection on a 5-minute job. Agents tab endpoints read the projection; they do not stat files on request.

## Scope

In scope:

- Add `artifact_path` to dispatch docs and persist it from `/agent-done.result.artifact_path`.
- Add a durable `dispatch_verifications` projection table.
- Add a pure verifier that classifies recent dispatches into verified/unverified rows.
- Add a scheduled verification job, default every 5 minutes, plus a manual test hook.
- Add `GET /agents/effectiveness?window=` and `GET /agents/:name/dispatches`.
- Keep numbers reconciled: fleet totals are derived from the same rows as per-agent totals.
- Add projection unit tests and an integration test against a fixture output directory.

Out of scope:

- Kapelle UI wiring.
- Cost-per-verified-landing.
- 30d/90d trend route from console-v2 §1.4. W2-1 only needs `trend_4w` in the effectiveness response.
- Migration registry work. Prefer it if W2-5 has landed; otherwise use the current idempotent migration pattern in `src/db/migrations/*`.

## Existing Surfaces

The current repo already has the right dispatch spine:

- `src/dispatch-scheduler/types.ts`
  - `DispatchDoc` has status, timestamps, `result_json`, promotion input/result, strict-mode failure kinds.
  - Missing: first-class `artifact_path`.
- `src/dispatch-scheduler/manager-integration.ts`
  - `SchedulerHandle.handleAgentDone()` marks rows done/failed and passes `result` into `markDoneWithResult`.
  - Strict-mode classifier already maps response bodies to `rate_limit_error`, `provider_server_error`, `provider_auth_error`, `dispatch_id_mismatch`, and `dispatch_not_found`.
- `src/dispatch-scheduler/sqlite-dispatch-reactor.ts`
  - Writes `result_json`, `promotion_result_json`, `promotion_input_json`.
  - Needs `artifact_path` in insert/update/select mapping.
- `src/dispatch-scheduler/read-model.ts`
  - Already extracts artifacts from `result_json`, but this is a request-time artifact list, not a verification projection.
- `src/db/migrations/sqlite.ts` and `src/db/migrations/postgres.ts`
  - Current migration style is idempotent TypeScript SQL.
- `src/agent-manager-db.ts`
  - Mounts `/agent-done`, `/dispatches`, `/artifacts`.
  - New Agents endpoints should be mounted near existing `/agents` and `/dispatches` management routes.

## Public Contract

### Failure Types

Use this exact v0 public enum:

```ts
export type DispatchVerificationFailureType =
  | "expired"
  | "artifact_missing"
  | "artifact_stale"
  | "dispatch_not_found"
  | "dispatch_id_mismatch"
  | "rate_limited"
  | "provider_error";
```

Do not add `promotion_failed` in W2-1. Promotion diagnostics are separate fields on the projection:

```ts
promotion_verified: boolean | null;
promotion_failure_detail: string | null;
```

Rows with invalid promotion are `verified=false`; use `failure_type="provider_error"` only when the closeout also has strict-mode/provider failure evidence. Otherwise leave `failure_type=null` and expose the promotion detail. This preserves the requested enum while still making build dispatches fail verification.

### Projection Row

Add `src/dispatch-verification/types.ts`:

```ts
export type DispatchVerificationStatus = "verified" | "unverified" | "pending";

export interface DispatchVerification {
  schema_version: "dispatch-verification.v1";
  team_id: string;
  dispatch_id: string;
  query_id: string | null;
  agent_name: string;
  status: DispatchVerificationStatus;
  verified: boolean;
  failure_type: DispatchVerificationFailureType | null;
  failure_detail: string | null;
  artifact_path: string | null;
  artifact_exists: boolean | null;
  artifact_mtime: string | null;
  delivery_window_start: string | null;
  delivery_window_end: string | null;
  promotion_required: boolean;
  promotion_verified: boolean | null;
  promotion_failure_detail: string | null;
  dispatch_status: string;
  dispatch_created_at: string;
  dispatch_started_at: string | null;
  dispatch_completed_at: string | null;
  result_success: boolean | null;
  tl_dr: string | null;
  kind: "report" | "code" | "data" | "other";
  checked_at: string;
  source_metadata: {
    source: "dispatch_scheduler_queue";
    result_source: "artifact_path" | "result_json" | "none";
  };
}
```

### Endpoint: `GET /agents/effectiveness?window=`

Accepted windows: `24h`, `7d`, `30d`. Default `7d`. Invalid windows return `400`.

Response:

```ts
interface AgentsEffectivenessResponse {
  schema_version: "agents.effectiveness.v1";
  generated_at: string;
  window: "24h" | "7d" | "30d";
  fleet: {
    dispatches_completed: number;
    verified_landings: number;
    verified_landing_rate: number;
    throughput_per_week: number;
    failure_breakdown: Record<DispatchVerificationFailureType, number>;
    trend_4w: number[];
  };
  agents: Array<{
    name: string;
    status: string;
    dispatches_completed: number;
    verified_landings: number;
    verified_landing_rate: number;
    throughput: number;
    top_failure_type: DispatchVerificationFailureType | null;
    in_flight_dispatch_id: string | null;
    last_verified_landing: {
      timestamp: string;
      artifact_path: string;
      tl_dr: string | null;
      kind: "report" | "code" | "data" | "other";
    } | null;
  }>;
}
```

Reconciliation rule:

- `fleet.dispatches_completed === sum(agents[].dispatches_completed)`
- `fleet.verified_landings === sum(agents[].verified_landings)`
- `fleet.failure_breakdown[x] === sum(per-agent x)`
- `throughput_per_week = verified_landings / window_days * 7`

### Endpoint: `GET /agents/:name/dispatches`

Accepted query:

- `window=24h|7d|30d`, default `7d`
- `limit=1..200`, default `50`

Response:

```ts
interface AgentDispatchesResponse {
  schema_version: "agents.dispatches.v1";
  generated_at: string;
  agent_name: string;
  window: "24h" | "7d" | "30d";
  items: Array<{
    dispatch_id: string;
    query_id: string | null;
    time: string;
    subject: string;
    dispatch_status: string;
    verification_status: DispatchVerificationStatus;
    verified: boolean;
    failure_type: DispatchVerificationFailureType | null;
    failure_detail: string | null;
    artifact_path: string | null;
    artifact_exists: boolean | null;
    artifact_mtime: string | null;
    promotion_required: boolean;
    promotion_verified: boolean | null;
    promotion_failure_detail: string | null;
    tl_dr: string | null;
    kind: "report" | "code" | "data" | "other";
  }>;
}
```

## Schema

### Dispatch Doc Migration

Add nullable `artifact_path` to `dispatch_scheduler_queue`.

SQLite:

```sql
ALTER TABLE dispatch_scheduler_queue ADD COLUMN artifact_path TEXT;
CREATE INDEX IF NOT EXISTS dispatch_scheduler_artifact_path_idx
  ON dispatch_scheduler_queue(team_id, artifact_path)
  WHERE artifact_path IS NOT NULL;
```

Postgres:

```sql
ALTER TABLE dispatch_scheduler_queue ADD COLUMN IF NOT EXISTS artifact_path text;
CREATE INDEX IF NOT EXISTS dispatch_scheduler_artifact_path_idx
  ON dispatch_scheduler_queue(team_id, artifact_path)
  WHERE artifact_path IS NOT NULL;
```

Backfill:

- Parse `result_json`.
- If `result_json.artifact_path` is a non-empty string, set `artifact_path`.
- Do not infer from `tl_dr`, markdown links, or delivery-log text in W2-1. The dispatch requested `artifact_path` on dispatch docs; inference would make the metric less defensible.

### Projection Table

SQLite:

```sql
CREATE TABLE IF NOT EXISTS dispatch_verifications (
  team_id                   TEXT NOT NULL,
  dispatch_id               TEXT NOT NULL,
  query_id                  TEXT,
  agent_name                TEXT NOT NULL,
  status                    TEXT NOT NULL,
  verified                  INTEGER NOT NULL DEFAULT 0,
  failure_type              TEXT,
  failure_detail            TEXT,
  artifact_path             TEXT,
  artifact_exists           INTEGER,
  artifact_mtime            TEXT,
  delivery_window_start     TEXT,
  delivery_window_end       TEXT,
  promotion_required        INTEGER NOT NULL DEFAULT 0,
  promotion_verified        INTEGER,
  promotion_failure_detail  TEXT,
  dispatch_status           TEXT NOT NULL,
  dispatch_created_at       TEXT NOT NULL,
  dispatch_started_at       TEXT,
  dispatch_completed_at     TEXT,
  result_success            INTEGER,
  tl_dr                     TEXT,
  kind                      TEXT NOT NULL DEFAULT 'other',
  checked_at                TEXT NOT NULL,
  source_metadata_json      TEXT NOT NULL DEFAULT '{}',
  PRIMARY KEY (team_id, dispatch_id)
);

CREATE INDEX IF NOT EXISTS dispatch_verifications_team_agent_time_idx
  ON dispatch_verifications(team_id, agent_name, dispatch_completed_at DESC, dispatch_id);

CREATE INDEX IF NOT EXISTS dispatch_verifications_team_time_idx
  ON dispatch_verifications(team_id, dispatch_completed_at DESC, dispatch_id);

CREATE INDEX IF NOT EXISTS dispatch_verifications_team_failure_idx
  ON dispatch_verifications(team_id, failure_type, dispatch_completed_at DESC)
  WHERE failure_type IS NOT NULL;
```

Postgres uses the same columns with `text`, `boolean`, and `jsonb`; primary key `(team_id, dispatch_id)`.

## Implementation Files

New:

- `src/dispatch-verification/types.ts`
- `src/dispatch-verification/verifier.ts`
- `src/dispatch-verification/storage.ts`
- `src/dispatch-verification/job.ts`
- `src/dispatch-verification/read-model.ts`
- `src/dispatch-verification/routes.ts`
- `tests/unit/dispatch-verification-verifier.test.ts`
- `tests/unit/dispatch-verification-read-model.test.ts`
- `tests/integration/dispatch-verification-routes.test.ts`
- `tests/fixtures/dispatch-verification/output/fresh-report.md`
- `tests/fixtures/dispatch-verification/output/stale-report.md`

Modify:

- `src/dispatch-scheduler/types.ts`
- `src/dispatch-scheduler/sqlite-dispatch-reactor.ts`
- `src/dispatch-scheduler/read-model.ts`
- `src/dispatch-scheduler/manager-integration.ts`
- `src/db/migrations/sqlite.ts`
- `src/db/migrations/postgres.ts`
- `src/agent-manager-db.ts`

## TDD Tasks

### Task 1: Pure Verifier

- [ ] Add failing unit tests for:
  - done + success + fresh artifact + no promotion required => verified
  - done + success + missing artifact => `artifact_missing`
  - done + success + mtime before window start => `artifact_stale`
  - active in-flight older than 5 minutes => `expired`
  - failed strict-mode `rate_limit_error` detail => `rate_limited`
  - failed strict-mode provider/auth/server detail => `provider_error`
  - failed strict-mode `dispatch_id_mismatch` detail => `dispatch_id_mismatch`
  - missing dispatch row requested by job => `dispatch_not_found`
  - build dispatch with valid promotion => verified when artifact is fresh
  - build dispatch with invalid promotion => unverified, `promotion_verified=false`, detail populated
- [ ] Implement `verifyDispatch(row, deps)` as a pure function in `src/dispatch-verification/verifier.ts`.
- [ ] Inject filesystem stat through `deps.statArtifact(path)` so unit tests do not touch disk.
- [ ] Inject `now` and `expiredAfterMs`, defaulting to 5 minutes.

Failure mapping rules:

- `status IN ('queued','in_flight','bounced','needs_clarification','resume_delivery_failed')` and active age > 5 minutes => `expired`.
- `status='failed'` and `failure_kind='strict_mode_classified'`:
  - detail contains `rate_limit_error` => `rate_limited`
  - detail contains `dispatch_id_mismatch` => `dispatch_id_mismatch`
  - detail contains `dispatch_not_found` => `dispatch_not_found`
  - detail contains `provider_server_error` or `provider_auth_error` => `provider_error`
- `status='failed'` and failure kind is model/harness/provider exhaustion => `provider_error`.
- `status='done'` with no `artifact_path` => `artifact_missing`.
- `artifact_path` stat returns not found or non-file => `artifact_missing`.
- mtime < window start or mtime > completed_at + 60 seconds clock-skew allowance => `artifact_stale`.
- Promotion invalid does not change `failure_type` unless strict/provider evidence already exists; it does set `verified=false`.

### Task 2: Persist `artifact_path`

- [ ] Add `artifact_path: string | null` to `DispatchDoc`.
- [ ] Add `artifact_path` to `SqliteDispatchReactor` row mapping, insert, update, and read paths.
- [ ] In `markDoneWithResult` and `markQueuedDoneWithResult`, parse `result.artifact_path` and store it separately.
- [ ] Add backfill in migrations from `result_json`.
- [ ] Add regression tests around `handleAgentDone()` proving `artifact_path` is persisted when present and remains null when absent.

### Task 3: Projection Storage

- [ ] Create `DispatchVerificationStorage` with:
  - `upsertMany(rows)`
  - `readWindow(teamId, fromIso, toIso)`
  - `readAgentWindow(teamId, agentName, fromIso, toIso, limit)`
  - `readLastVerifiedByAgent(teamId, agentName)`
- [ ] Keep writes idempotent by primary key `(team_id, dispatch_id)`.
- [ ] Store `source_metadata_json` as a typed object, not ad hoc strings.
- [ ] Unit-test sqlite storage with an in-memory database.

### Task 4: Verification Job

- [ ] Add `DispatchVerificationJob` in `src/dispatch-verification/job.ts`.
- [ ] Query dispatches updated/completed in the last 30 days, plus active rows older than 5 minutes.
- [ ] Run every 5 minutes by default. Env:
  - `DISPATCH_VERIFICATION_ENABLED=true|false`, default `true`
  - `DISPATCH_VERIFICATION_INTERVAL_MS`, default `300000`
  - `DISPATCH_VERIFICATION_LOOKBACK_DAYS`, default `30`
- [ ] Mount lifecycle in `AgentManagerDb` startup/shutdown beside the scheduler handle.
- [ ] Add a manual admin/debug route only if existing manager patterns support it; otherwise tests should call the job class directly.
- [ ] The job must never throw out of interval. Log and keep the previous projection rows if one run fails.

### Task 5: Read Model

- [ ] Implement `buildAgentsEffectiveness(rows, agents, window)` from projection rows.
- [ ] Use one source array for fleet and agent rollups so arithmetic reconciles by construction.
- [ ] Calculate `trend_4w` from four 7-day buckets ending at `generated_at`.
- [ ] Include agents with zero dispatches if they appear in `/agents` roster.
- [ ] `top_failure_type` is the highest count, tie-broken by enum order.
- [ ] `last_verified_landing` is the latest verified row with a non-null artifact path.

### Task 6: Routes

- [ ] Mount `GET /agents/effectiveness` before dynamic `/agents/:id` routes.
- [ ] Mount `GET /agents/:name/dispatches` without breaking existing `/agents/by-name/:name`, `/agents/status`, and `/agents/resolve/:ref` routes. If route ordering is risky, use a less ambiguous internal handler but preserve the public path.
- [ ] Validate `window` and `limit`; return `400` with `{ error: "invalid_window" }` or `{ error: "invalid_limit" }`.
- [ ] Use the same auth/team resolution as existing manager management routes.
- [ ] Add route tests that seed real dispatch rows, real projection rows through the job, and assert JSON shape plus arithmetic reconciliation.

### Task 7: Integration Fixture

- [ ] Create a temp sqlite DB and fixture output directory.
- [ ] Seed:
  - Agent `roger`: one verified fresh report, one missing artifact.
  - Agent `regina`: one stale artifact.
  - Agent `cursor-coder-pilot`: one failed strict-mode rate limit.
  - Agent `rams`: one build dispatch with valid promotion.
- [ ] Use `fs.utimesSync` to set fresh/stale mtimes deterministically.
- [ ] Run the verification job once.
- [ ] Assert:
  - `GET /agents/effectiveness?window=7d` returns real data.
  - Fleet completed count equals sum of agent completed counts.
  - Fleet verified count equals sum of agent verified counts.
  - Failure breakdown includes `artifact_missing`, `artifact_stale`, and `rate_limited`.
  - `GET /agents/roger/dispatches?window=7d` returns the verified report with artifact path and the missing failure row.

## Acceptance Checklist

- [ ] `npm run build` passes.
- [ ] `npx vitest run tests/unit/dispatch-verification-verifier.test.ts` passes.
- [ ] `npx vitest run tests/unit/dispatch-verification-read-model.test.ts` passes.
- [ ] `npx vitest run tests/integration/dispatch-verification-routes.test.ts` passes.
- [ ] Existing dispatch scheduler tests still pass.
- [ ] Local manager against the real DB returns non-empty `GET /agents/effectiveness?window=7d` data after one verification job run.
- [ ] Fleet and per-agent numbers reconcile exactly in tests.
- [ ] No endpoint recomputes filesystem mtime checks on request.
- [ ] No placeholder rows or fixture fallbacks in production endpoints.

## Rollout

1. Ship schema and pure verifier behind `DISPATCH_VERIFICATION_ENABLED=false` in tests first.
2. Enable the job locally and run one manual verification pass against the current manager DB.
3. Verify `/agents/effectiveness?window=7d` returns real rows.
4. Enable the 5-minute interval in manager.
5. Regina can then wire Kapelle's Agents tab to the new endpoints.

Rollback is simple because all schema changes are additive:

- Set `DISPATCH_VERIFICATION_ENABLED=false`.
- Leave projection tables in place.
- Kapelle can keep using its previous adapter until W2-2 consumes the endpoints.

