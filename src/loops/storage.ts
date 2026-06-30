// Loops runtime substrate storage (B1, 2026-06-22).
//
// Two idempotent tables — `loops` (durable definition + schedule binding) and
// `loop_runs` (execution envelope + evidence) — mirroring the recurrences
// storage pattern: positional `?` params, JSON columns for flexible shapes,
// and a UNIQUE(loop_phid, idempotency_key) constraint that makes run creation
// idempotent (the manual-trigger duplicate-returns-existing contract).

import type { DbAdapter } from "../db/db-adapter.js";
import { SEED_LOOPS, type LoopSummary } from "./registry.js";
import {
  ACTIVE_LOOP_RUN_STATUSES,
  type ActorRef,
  type LoopOutputRef,
  type LoopRecord,
  type LoopRunRecord,
  type LoopRunStatus,
  type LoopScheduleRef,
  type LoopStepLog,
  type LoopTrigger,
} from "./types.js";

const DEFAULT_TIMEZONE = "America/New_York";

// ---------------------------------------------------------------------------
// DDL (idempotent)
// ---------------------------------------------------------------------------

export async function migrateLoopsTables(adapter: DbAdapter): Promise<void> {
  await adapter.query(
    `
    CREATE TABLE IF NOT EXISTS loops (
      loop_phid           TEXT PRIMARY KEY,
      schema_version      INTEGER NOT NULL,
      slug                TEXT NOT NULL UNIQUE,
      name                TEXT NOT NULL,
      description         TEXT,
      kind                TEXT NOT NULL,
      owner_agent         TEXT NOT NULL,
      project_phid        TEXT,
      enabled             INTEGER NOT NULL,
      allow_scheduled_run INTEGER NOT NULL,
      allow_manual_run    INTEGER NOT NULL,
      schedule_json       TEXT NOT NULL,
      created_at          TEXT NOT NULL,
      updated_at          TEXT NOT NULL
    )
    `,
    [],
  );
  await adapter.query(
    `CREATE INDEX IF NOT EXISTS loops_owner_idx ON loops(owner_agent, enabled)`,
    [],
  );

  await adapter.query(
    `
    CREATE TABLE IF NOT EXISTS loop_runs (
      loop_run_phid               TEXT PRIMARY KEY,
      loop_phid                   TEXT NOT NULL,
      trigger_json                TEXT NOT NULL,
      status                      TEXT NOT NULL,
      failure_reason              TEXT,
      failure_detail              TEXT,
      step_log_json               TEXT NOT NULL,
      output_refs_json            TEXT NOT NULL,
      spawned_dispatch_phids_json TEXT NOT NULL,
      idempotency_key             TEXT NOT NULL,
      retry_of_phid               TEXT,
      fired_at                    TEXT NOT NULL,
      queued_at                   TEXT NOT NULL,
      admitted_at                 TEXT,
      started_at                  TEXT,
      finished_at                 TEXT,
      created_by_json             TEXT NOT NULL,
      updated_at                  TEXT NOT NULL,
      UNIQUE(loop_phid, idempotency_key)
    )
    `,
    [],
  );
  await adapter.query(
    `CREATE INDEX IF NOT EXISTS loop_runs_loop_status_idx ON loop_runs(loop_phid, status, fired_at)`,
    [],
  );
  await adapter.query(
    `CREATE INDEX IF NOT EXISTS loop_runs_status_updated_idx ON loop_runs(status, updated_at)`,
    [],
  );
}

// ---------------------------------------------------------------------------
// PHIDs
// ---------------------------------------------------------------------------

/** FNV-1a hex — same deterministic-phid pattern recurrences/materialization uses. */
function simpleHash(input: string): string {
  let h = 2166136261;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = (h * 16777619) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/** Deterministic run phid from (loop_phid, idempotency_key): the same trigger
 *  key always maps to the same run phid, reinforcing idempotency. */
export function loopRunPhid(loopPhid: string, idempotencyKey: string): string {
  return `phid:looprun-${simpleHash(`${loopPhid}|${idempotencyKey}`)}`;
}

// ---------------------------------------------------------------------------
// Seed
// ---------------------------------------------------------------------------

function seedScheduleFor(seed: LoopSummary): LoopScheduleRef {
  return {
    recurrence_phid: null, // unbound until an operator binds a recurrence
    timezone: DEFAULT_TIMEZONE,
    enabled: seed.allow_scheduled_run,
    dedup_policy: "manual_idempotency_key",
  };
}

/**
 * Upsert the registry seed loops into the substrate. Idempotent and
 * binding-preserving: re-seeding refreshes definition fields but NEVER
 * clobbers `schedule_json` (so an operator's recurrence binding survives a
 * restart/re-seed).
 */
export async function seedLoopsFromRegistry(
  adapter: DbAdapter,
  nowIso: string,
): Promise<{ seeded: number }> {
  let seeded = 0;
  for (const seed of SEED_LOOPS) {
    await adapter.query(
      `INSERT INTO loops (
         loop_phid, schema_version, slug, name, description, kind, owner_agent,
         project_phid, enabled, allow_scheduled_run, allow_manual_run,
         schedule_json, created_at, updated_at
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(loop_phid) DO UPDATE SET
         name                = excluded.name,
         description         = excluded.description,
         kind                = excluded.kind,
         owner_agent         = excluded.owner_agent,
         project_phid        = excluded.project_phid,
         enabled             = excluded.enabled,
         allow_scheduled_run = excluded.allow_scheduled_run,
         allow_manual_run    = excluded.allow_manual_run,
         updated_at          = excluded.updated_at`,
      [
        seed.loop_phid,
        1,
        seed.slug,
        seed.name,
        seed.description,
        seed.kind,
        seed.owner_agent,
        seed.project?.project_phid ?? null,
        seed.enabled ? 1 : 0,
        seed.allow_scheduled_run ? 1 : 0,
        seed.allow_manual_run ? 1 : 0,
        JSON.stringify(seedScheduleFor(seed)),
        nowIso,
        nowIso,
      ],
    );
    seeded += 1;
  }
  return { seeded };
}

// ---------------------------------------------------------------------------
// Loop CRUD
// ---------------------------------------------------------------------------

interface LoopRow {
  loop_phid: string;
  schema_version: number;
  slug: string;
  name: string;
  description: string | null;
  kind: string;
  owner_agent: string;
  project_phid: string | null;
  enabled: number;
  allow_scheduled_run: number;
  allow_manual_run: number;
  schedule_json: string;
  created_at: string;
  updated_at: string;
}

function rowToLoop(row: LoopRow): LoopRecord {
  return {
    loop_phid: row.loop_phid,
    schema_version: 1,
    slug: row.slug,
    name: row.name,
    description: row.description,
    kind: row.kind as LoopRecord["kind"],
    owner_agent: row.owner_agent,
    project_phid: row.project_phid,
    enabled: row.enabled === 1,
    allow_scheduled_run: row.allow_scheduled_run === 1,
    allow_manual_run: row.allow_manual_run === 1,
    schedule: JSON.parse(row.schedule_json) as LoopScheduleRef,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/** Resolve a loop by `loop_phid` or `slug` (RD-001: both are stable ids). */
export async function getLoop(adapter: DbAdapter, ref: string): Promise<LoopRecord | null> {
  const r = (ref ?? "").trim();
  if (!r) return null;
  const { rows } = await adapter.query<LoopRow>(
    `SELECT * FROM loops WHERE loop_phid = ? OR slug = ? LIMIT 1`,
    [r, r],
  );
  return rows[0] ? rowToLoop(rows[0]) : null;
}

/**
 * The recurrence link: bind (or unbind) a loop to a recurrence template.
 * Passing `recurrencePhid: null` unbinds. Returns the updated record, or null
 * if the loop does not exist.
 */
export async function bindLoopRecurrence(
  adapter: DbAdapter,
  loopPhid: string,
  recurrencePhid: string | null,
  nowIso: string,
  opts: { enabled?: boolean; timezone?: string } = {},
): Promise<LoopRecord | null> {
  const loop = await getLoop(adapter, loopPhid);
  if (!loop) return null;
  const schedule: LoopScheduleRef = {
    recurrence_phid: recurrencePhid,
    timezone: opts.timezone ?? loop.schedule.timezone,
    enabled: opts.enabled ?? (recurrencePhid != null),
    dedup_policy: loop.schedule.dedup_policy,
  };
  await adapter.query(
    `UPDATE loops SET schedule_json = ?, updated_at = ? WHERE loop_phid = ?`,
    [JSON.stringify(schedule), nowIso, loop.loop_phid],
  );
  return { ...loop, schedule, updated_at: nowIso };
}

// ---------------------------------------------------------------------------
// LoopRun CRUD + evidence
// ---------------------------------------------------------------------------

interface LoopRunRow {
  loop_run_phid: string;
  loop_phid: string;
  trigger_json: string;
  status: LoopRunStatus;
  failure_reason: string | null;
  failure_detail: string | null;
  step_log_json: string;
  output_refs_json: string;
  spawned_dispatch_phids_json: string;
  idempotency_key: string;
  retry_of_phid: string | null;
  fired_at: string;
  queued_at: string;
  admitted_at: string | null;
  started_at: string | null;
  finished_at: string | null;
  created_by_json: string;
  updated_at: string;
}

function rowToRun(row: LoopRunRow): LoopRunRecord {
  return {
    loop_run_phid: row.loop_run_phid,
    loop_phid: row.loop_phid,
    trigger: JSON.parse(row.trigger_json) as LoopTrigger,
    status: row.status,
    failure_reason: (row.failure_reason as LoopRunRecord["failure_reason"]) ?? null,
    failure_detail: row.failure_detail,
    step_log: JSON.parse(row.step_log_json) as LoopStepLog[],
    output_refs: JSON.parse(row.output_refs_json) as LoopOutputRef[],
    spawned_dispatch_phids: JSON.parse(row.spawned_dispatch_phids_json) as string[],
    idempotency_key: row.idempotency_key,
    retry_of_phid: row.retry_of_phid,
    fired_at: row.fired_at,
    queued_at: row.queued_at,
    admitted_at: row.admitted_at,
    started_at: row.started_at,
    finished_at: row.finished_at,
    created_by: JSON.parse(row.created_by_json) as ActorRef,
    updated_at: row.updated_at,
  };
}

export async function getLoopRun(
  adapter: DbAdapter,
  loopRunPhid: string,
): Promise<LoopRunRecord | null> {
  const { rows } = await adapter.query<LoopRunRow>(
    `SELECT * FROM loop_runs WHERE loop_run_phid = ?`,
    [loopRunPhid],
  );
  return rows[0] ? rowToRun(rows[0]) : null;
}

export async function getLoopRunByKey(
  adapter: DbAdapter,
  loopPhid: string,
  idempotencyKey: string,
): Promise<LoopRunRecord | null> {
  const { rows } = await adapter.query<LoopRunRow>(
    `SELECT * FROM loop_runs WHERE loop_phid = ? AND idempotency_key = ?`,
    [loopPhid, idempotencyKey],
  );
  return rows[0] ? rowToRun(rows[0]) : null;
}

export interface ListRunsFilter {
  status?: LoopRunStatus;
  limit?: number;
  /**
   * Team scope. Threaded end-to-end for parity with the other team-scoped
   * read-models. MISSING PIECE: `loop_runs` has no `team_id` column yet (loops
   * + loop_runs are global per cto/output/2026-06-16-loops-runtime-scope.md §3),
   * so this is currently a documented no-op — when the column lands, add the
   * `team_id = ?` clause below and the call sites already carry the value.
   */
  team_id?: string | null;
}

export async function listLoopRuns(
  adapter: DbAdapter,
  loopPhid: string,
  filter: ListRunsFilter = {},
): Promise<LoopRunRecord[]> {
  const limit = Math.min(Math.max(filter.limit ?? 50, 1), 200);
  const clauses = ["loop_phid = ?"];
  const params: unknown[] = [loopPhid];
  if (filter.status) {
    clauses.push("status = ?");
    params.push(filter.status);
  }
  // filter.team_id intentionally unused until loop_runs gains a team_id column.
  params.push(limit);
  const { rows } = await adapter.query<LoopRunRow>(
    `SELECT * FROM loop_runs WHERE ${clauses.join(" AND ")} ORDER BY fired_at DESC LIMIT ?`,
    params,
  );
  return rows.map(rowToRun);
}

/** Count runs currently occupying the per-loop active-run cap. */
export async function countActiveRuns(adapter: DbAdapter, loopPhid: string): Promise<number> {
  const placeholders = ACTIVE_LOOP_RUN_STATUSES.map(() => "?").join(",");
  const { rows } = await adapter.query<{ n: number }>(
    `SELECT COUNT(*) AS n FROM loop_runs WHERE loop_phid = ? AND status IN (${placeholders})`,
    [loopPhid, ...ACTIVE_LOOP_RUN_STATUSES],
  );
  return Number(rows[0]?.n ?? 0);
}

export type CreateRunResult =
  | { created: true; run: LoopRunRecord }
  | { created: false; duplicate: true; run: LoopRunRecord };

/**
 * Create a LoopRun. Idempotent on (loop_phid, idempotency_key): a second call
 * with the same key returns the existing run with `duplicate: true` rather than
 * minting a second envelope.
 */
export async function createLoopRun(
  adapter: DbAdapter,
  run: LoopRunRecord,
): Promise<CreateRunResult> {
  const existing = await getLoopRunByKey(adapter, run.loop_phid, run.idempotency_key);
  if (existing) return { created: false, duplicate: true, run: existing };
  await adapter.query(
    `INSERT INTO loop_runs (
       loop_run_phid, loop_phid, trigger_json, status, failure_reason, failure_detail,
       step_log_json, output_refs_json, spawned_dispatch_phids_json, idempotency_key,
       retry_of_phid, fired_at, queued_at, admitted_at, started_at, finished_at,
       created_by_json, updated_at
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(loop_phid, idempotency_key) DO NOTHING`,
    [
      run.loop_run_phid,
      run.loop_phid,
      JSON.stringify(run.trigger),
      run.status,
      run.failure_reason,
      run.failure_detail,
      JSON.stringify(run.step_log),
      JSON.stringify(run.output_refs),
      JSON.stringify(run.spawned_dispatch_phids),
      run.idempotency_key,
      run.retry_of_phid,
      run.fired_at,
      run.queued_at,
      run.admitted_at,
      run.started_at,
      run.finished_at,
      JSON.stringify(run.created_by),
      run.updated_at,
    ],
  );
  // Re-read to settle any race on the unique key (returns the winning row).
  const settled = await getLoopRunByKey(adapter, run.loop_phid, run.idempotency_key);
  if (settled && settled.loop_run_phid !== run.loop_run_phid) {
    return { created: false, duplicate: true, run: settled };
  }
  return { created: true, run: settled ?? run };
}

/**
 * Append an evidence step + advance run state. The evidence contract: callers
 * (manual trigger now; the daemon runtime later) record each phase here so the
 * run's step_log / output_refs are the durable audit trail. Patches are
 * shallow-merged; provided steps/outputs/dispatch-phids are appended.
 */
export interface TransitionPatch {
  status?: LoopRunStatus;
  failure_reason?: LoopRunRecord["failure_reason"];
  failure_detail?: string | null;
  append_steps?: LoopStepLog[];
  append_outputs?: LoopOutputRef[];
  append_dispatch_phids?: string[];
  admitted_at?: string;
  started_at?: string;
  finished_at?: string;
}

export async function transitionLoopRun(
  adapter: DbAdapter,
  loopRunPhid: string,
  patch: TransitionPatch,
  nowIso: string,
): Promise<LoopRunRecord | null> {
  const current = await getLoopRun(adapter, loopRunPhid);
  if (!current) return null;
  const next: LoopRunRecord = {
    ...current,
    status: patch.status ?? current.status,
    failure_reason: patch.failure_reason ?? current.failure_reason,
    failure_detail: patch.failure_detail ?? current.failure_detail,
    step_log: [...current.step_log, ...(patch.append_steps ?? [])],
    output_refs: [...current.output_refs, ...(patch.append_outputs ?? [])],
    spawned_dispatch_phids: [
      ...current.spawned_dispatch_phids,
      ...(patch.append_dispatch_phids ?? []),
    ],
    admitted_at: patch.admitted_at ?? current.admitted_at,
    started_at: patch.started_at ?? current.started_at,
    finished_at: patch.finished_at ?? current.finished_at,
    updated_at: nowIso,
  };
  await adapter.query(
    `UPDATE loop_runs SET
       status = ?, failure_reason = ?, failure_detail = ?,
       step_log_json = ?, output_refs_json = ?, spawned_dispatch_phids_json = ?,
       admitted_at = ?, started_at = ?, finished_at = ?, updated_at = ?
     WHERE loop_run_phid = ?`,
    [
      next.status,
      next.failure_reason,
      next.failure_detail,
      JSON.stringify(next.step_log),
      JSON.stringify(next.output_refs),
      JSON.stringify(next.spawned_dispatch_phids),
      next.admitted_at,
      next.started_at,
      next.finished_at,
      next.updated_at,
      loopRunPhid,
    ],
  );
  return next;
}
