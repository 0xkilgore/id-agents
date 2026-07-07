// Continuous Orchestration — blocker health projection.
//
// This is the operator-facing "why is the loop fake-green?" read-model. It
// ties dispatch blockers back to backlog dependencies so shipped-but-unlanded
// work and clarification waits are visible in the orchestration health surface.

import type { DbAdapter } from "../db/db-adapter.js";
import type { OrchestrationMode } from "./types.js";

export interface OrchestrationHealthBlocker {
  dispatch_phid: string;
  query_id: string | null;
  to_agent: string | null;
  updated_at: string | null;
  reason: string;
  blocks_backlog_dependency: boolean;
  blocked_dependency_item_ids: string[];
}

export interface OrchestrationHealthProjection {
  ok: boolean;
  generated_at: string;
  admission_status: OrchestrationAdmissionStatus | null;
  blockers: {
    blocked: boolean;
    needs_clarification: {
      count: number;
      recent_dispatch_ids: string[];
      blocks_backlog_dependency_count: number;
      items: OrchestrationHealthBlocker[];
    };
    promotion: {
      count: number;
      recent_dispatch_ids: string[];
      blocks_backlog_dependency_count: number;
      items: OrchestrationHealthBlocker[];
    };
  };
}

export type OrchestrationAdmissionStatusKind =
  | "healthy"
  | "paused"
  | "daemon_stuck"
  | "no_ready_fuel"
  | "blocked_by_clarification"
  | "admission_policy_held";

export interface OrchestrationAdmissionStatus {
  kind: OrchestrationAdmissionStatusKind;
  ok: boolean;
  page_operator: boolean;
  severity: "ok" | "watch" | "action_needed" | "incident";
  reason: string;
  ready: number;
  min_ready_fuel: number;
  consecutive_zero_ticks: number;
  last_tick_at: string | null;
  last_dispatch_at: string | null;
  seconds_since_tick: number | null;
  seconds_since_dispatch: number | null;
}

export interface OrchestrationAdmissionStatusInput {
  mode: OrchestrationMode;
  auto_paused?: boolean;
  last_tick_at: string | null;
  last_dispatch_at: string | null;
  consecutive_zero_ticks: number;
  ready: number;
  min_ready_fuel: number;
  stall_threshold_ticks: number;
  tick_interval_ms: number;
  active_clarification_count: number;
  now_ms?: number;
}

interface DispatchRow {
  dispatch_phid: string;
  query_id: string | null;
  to_agent: string | null;
  updated_at: string | null;
  completed_at?: string | null;
  active_clarification_json?: string | null;
  promotion_input_json?: string | null;
  promotion_result_json?: string | null;
}

interface BacklogDependencyRow {
  item_id: string;
  dependencies_json: string | null;
}

const RECOVERED_STATUSES = ["moot", "landed_reconciled", "verified_done", "retry_done"];

export async function readOrchestrationHealthProjection(
  adapter: DbAdapter,
  teamId = "default",
  opts: { recentLimit?: number; admissionStatus?: OrchestrationAdmissionStatus | null } = {},
): Promise<OrchestrationHealthProjection> {
  const recentLimit = Math.max(1, opts.recentLimit ?? 5);
  const dependencyImpact = await readDependencyImpact(adapter, teamId);

  const [clarifications, promotionRows] = await Promise.all([
    readActiveClarifications(adapter, teamId),
    readDoneBuildDispatches(adapter, teamId),
  ]);

  const needsClarification = clarifications
    .map((row) => blockerFromRow(row, dependencyImpact, clarificationReason(row)))
    .sort(compareBlockersRecent);

  const promotion = promotionRows
    .map((row) => ({ row, reason: promotionBlockerReason(row.promotion_result_json) }))
    .filter((x): x is { row: DispatchRow; reason: string } => x.reason != null)
    .map(({ row, reason }) => blockerFromRow(row, dependencyImpact, reason))
    .sort(compareBlockersRecent);

  return {
    ok: true,
    generated_at: new Date().toISOString(),
    admission_status: opts.admissionStatus ?? null,
    blockers: {
      blocked: needsClarification.length > 0 || promotion.length > 0,
      needs_clarification: summarize(needsClarification, recentLimit),
      promotion: summarize(promotion, recentLimit),
    },
  };
}

export function classifyOrchestrationAdmissionStatus(
  input: OrchestrationAdmissionStatusInput,
): OrchestrationAdmissionStatus {
  const nowMs = input.now_ms ?? Date.now();
  const tickAge = ageSeconds(input.last_tick_at, nowMs);
  const dispatchAge = ageSeconds(input.last_dispatch_at, nowMs);
  const daemonStuckAfterSeconds = Math.max(120, Math.ceil((input.tick_interval_ms * 3) / 1000));

  const base = {
    ready: input.ready,
    min_ready_fuel: input.min_ready_fuel,
    consecutive_zero_ticks: input.consecutive_zero_ticks,
    last_tick_at: input.last_tick_at,
    last_dispatch_at: input.last_dispatch_at,
    seconds_since_tick: tickAge,
    seconds_since_dispatch: dispatchAge,
  };

  const notRunning = input.mode !== "running" || input.auto_paused === true;
  if (notRunning) {
    return {
      ...base,
      kind: "paused",
      ok: true,
      page_operator: false,
      severity: "watch",
      reason: input.auto_paused ? "orchestration is auto-paused" : `orchestration mode is ${input.mode}`,
    };
  }

  if (tickAge == null || tickAge > daemonStuckAfterSeconds) {
    return {
      ...base,
      kind: "daemon_stuck",
      ok: false,
      page_operator: true,
      severity: "incident",
      reason:
        tickAge == null
          ? "orchestration is running but has not recorded a tick"
          : `orchestration tick is stale (${tickAge}s since last tick; threshold ${daemonStuckAfterSeconds}s)`,
    };
  }

  if (input.active_clarification_count > 0) {
    return {
      ...base,
      kind: "blocked_by_clarification",
      ok: false,
      page_operator: false,
      severity: "action_needed",
      reason: `${input.active_clarification_count} dispatch clarification(s) need operator input`,
    };
  }

  if (input.ready < input.min_ready_fuel) {
    return {
      ...base,
      kind: "no_ready_fuel",
      ok: true,
      page_operator: false,
      severity: "watch",
      reason: `daemon is ticking, but ready fuel is low (${input.ready}/${input.min_ready_fuel}); refuel/flesh is the next lever`,
    };
  }

  if (input.consecutive_zero_ticks >= input.stall_threshold_ticks) {
    return {
      ...base,
      kind: "admission_policy_held",
      ok: false,
      page_operator: false,
      severity: "action_needed",
      reason:
        `${input.consecutive_zero_ticks} recent tick(s) admitted no dispatches while ready fuel exists; ` +
        "check admission policy, in-flight slots, health gates, and write-scope locks",
    };
  }

  return {
    ...base,
    kind: "healthy",
    ok: true,
    page_operator: false,
    severity: "ok",
    reason:
      input.consecutive_zero_ticks > 0
        ? "daemon is ticking; zero-admit count is below the stall threshold"
        : "daemon is ticking and admission is not stalled",
  };
}

async function readActiveClarifications(adapter: DbAdapter, teamId: string): Promise<DispatchRow[]> {
  const placeholders = RECOVERED_STATUSES.map(() => "?").join(", ");
  const { rows } = await adapter.query<DispatchRow>(
    `SELECT dispatch_phid, query_id, to_agent, updated_at, active_clarification_json
       FROM dispatch_scheduler_queue
      WHERE team_id = ?
        AND status = 'needs_clarification'
        AND COALESCE(recovery_status, 'none') NOT IN (${placeholders})
      ORDER BY updated_at DESC, dispatch_phid ASC`,
    [teamId, ...RECOVERED_STATUSES],
  );
  return rows;
}

async function readDoneBuildDispatches(adapter: DbAdapter, teamId: string): Promise<DispatchRow[]> {
  const { rows } = await adapter.query<DispatchRow>(
    `SELECT dispatch_phid, query_id, to_agent, updated_at, completed_at,
            promotion_input_json, promotion_result_json
       FROM dispatch_scheduler_queue
      WHERE team_id = ?
        AND status = 'done'
        AND promote = 1
        AND promotion_input_json IS NOT NULL
      ORDER BY COALESCE(completed_at, updated_at) DESC, dispatch_phid ASC`,
    [teamId],
  );
  return rows.filter((row) => !promotionWasExplicitlySkipped(row.promotion_input_json));
}

async function readDependencyImpact(adapter: DbAdapter, teamId: string): Promise<Map<string, string[]>> {
  const { rows } = await adapter.query<BacklogDependencyRow>(
    `SELECT item_id, dependencies_json
       FROM orchestration_backlog_item
      WHERE team_id = ?
        AND readiness_state NOT IN ('done', 'cancelled', 'superseded')`,
    [teamId],
  );

  const dependentsByDependency = new Map<string, string[]>();
  for (const row of rows) {
    for (const dep of parseStringArray(row.dependencies_json)) {
      const list = dependentsByDependency.get(dep) ?? [];
      list.push(row.item_id);
      dependentsByDependency.set(dep, list);
    }
  }

  const { rows: owners } = await adapter.query<{ item_id: string; last_dispatch_phid: string | null }>(
    `SELECT item_id, last_dispatch_phid
       FROM orchestration_backlog_item
      WHERE team_id = ?
        AND last_dispatch_phid IS NOT NULL`,
    [teamId],
  );

  const impact = new Map<string, string[]>();
  for (const owner of owners) {
    if (!owner.last_dispatch_phid) continue;
    const dependents = dependentsByDependency.get(owner.item_id) ?? [];
    if (dependents.length > 0) impact.set(owner.last_dispatch_phid, dependents);
  }
  return impact;
}

function blockerFromRow(
  row: DispatchRow,
  dependencyImpact: Map<string, string[]>,
  reason: string,
): OrchestrationHealthBlocker {
  const blocked = dependencyImpact.get(row.dispatch_phid) ?? [];
  return {
    dispatch_phid: row.dispatch_phid,
    query_id: row.query_id ?? null,
    to_agent: row.to_agent ?? null,
    updated_at: row.completed_at ?? row.updated_at ?? null,
    reason,
    blocks_backlog_dependency: blocked.length > 0,
    blocked_dependency_item_ids: blocked,
  };
}

function summarize(items: OrchestrationHealthBlocker[], recentLimit: number) {
  const recent = items.slice(0, recentLimit);
  return {
    count: items.length,
    recent_dispatch_ids: recent.map((item) => item.dispatch_phid),
    blocks_backlog_dependency_count: items.filter((item) => item.blocks_backlog_dependency).length,
    items: recent,
  };
}

function compareBlockersRecent(a: OrchestrationHealthBlocker, b: OrchestrationHealthBlocker): number {
  return String(b.updated_at ?? "").localeCompare(String(a.updated_at ?? "")) ||
    a.dispatch_phid.localeCompare(b.dispatch_phid);
}

function clarificationReason(row: DispatchRow): string {
  const active = parseJson(row.active_clarification_json);
  const question = active && typeof active.question === "string" ? active.question.trim() : "";
  return question ? `needs clarification: ${question}` : "needs clarification";
}

function promotionBlockerReason(raw: string | null | undefined): string | null {
  const promo = parseJson(raw);
  if (!promo) return "missing promotion result";
  if (promo.completed !== true) return `promotion incomplete: completed=${String(promo.completed)}`;
  if (!Array.isArray(promo.repos) || promo.repos.length === 0) return "promotion has no repo entries";
  for (const repo of promo.repos) {
    const issues: string[] = [];
    if (repo?.pushed !== true) issues.push("pushed=false");
    if (repo?.verified !== true) issues.push("verified=false");
    if (!repo?.promoted_sha) issues.push("missing promoted_sha");
    if (!repo?.remote_main_sha) issues.push("missing remote_main_sha");
    if (repo?.promoted_sha && repo?.remote_main_sha && repo.promoted_sha !== repo.remote_main_sha) {
      issues.push("sha mismatch");
    }
    if (issues.length > 0) return `promotion verification failed: ${issues.join(", ")}`;
  }
  return null;
}

function promotionWasExplicitlySkipped(raw: string | null | undefined): boolean {
  const input = parseJson(raw);
  return typeof input?.promotion_skip_reason === "string" && input.promotion_skip_reason.trim() !== "";
}

function parseStringArray(raw: string | null | undefined): string[] {
  const parsed = parseJson(raw);
  return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string" && x.length > 0) : [];
}

function parseJson(raw: string | null | undefined): any | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function ageSeconds(iso: string | null, nowMs: number): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.floor((nowMs - t) / 1000));
}
