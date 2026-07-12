// Continuous Orchestration — blocker health projection.
//
// This is the operator-facing "why is the loop fake-green?" read-model. It
// ties dispatch blockers back to backlog dependencies so shipped-but-unlanded
// work and clarification waits are visible in the orchestration health surface.

import type { DbAdapter } from "../db/db-adapter.js";
import { createHash } from "node:crypto";
import {
  classifyPromotionHygieneFailure,
  hygieneDedupeKey,
  hygieneOwnerLane,
} from "../loops/worktree-hygiene.js";
import {
  readManagerWorkTelemetryProjection,
  type ManagerWorkTelemetryProjection,
} from "./manager-work-telemetry.js";

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
  orchestration_loop: OrchestrationLoopHealthProjection;
  queue_quality: OrchestrationQueueQualityProjection;
  ready_item_blockers: OrchestrationReadyItemBlockerProjection;
  manager_work_telemetry: ManagerWorkTelemetryProjection;
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
    stale_hygiene: {
      count: number;
      recent_dispatch_ids: string[];
      owner_lanes: string[];
      items: OrchestrationHygieneRoute[];
    };
  };
}

export type OrchestrationLoopHealthState =
  | "running"
  | "idle_no_ready_work"
  | "blocked_backpressure"
  | "blocked_no_capacity"
  | "stalled_ready_not_launching"
  | "paused"
  | "misconfigured";

export interface OrchestrationLoopHealthProjection {
  state: OrchestrationLoopHealthState;
  raw_ready: number;
  useful_ready: number;
  admissible_now: number;
  ready_count: number;
  admissible_ready_count: number;
  actionable_ready_count: number;
  in_flight_count: number;
  noop_tick_count: number;
  last_tick_at: string | null;
  last_launch_at: string | null;
  last_noop_reason: string | null;
  first_stalled_at: string | null;
  scheduler_loop_id: string;
  reason: string;
}

export interface OrchestrationHygieneRoute {
  dispatch_phid: string;
  query_id: string | null;
  updated_at: string | null;
  repo: string;
  branch: string;
  class_code: string;
  dedupe_key: string;
  owner_lane: string;
  cleanup_item_id: string | null;
  cleanup_dispatch_id: string | null;
  reason: string;
}

export interface OrchestrationQueueNoisePattern {
  pattern: string;
  count: number;
  examples: string[];
}

export interface OrchestrationQueueQualityProjection {
  raw_queued: number;
  actionable_ready: number;
  needs_approval: number;
  duplicate_or_noop_backfill: number;
  suppressed_by_dedupe: number;
  blocked_or_failed: number;
  top_noise_patterns: OrchestrationQueueNoisePattern[];
  explanation: string;
}

export interface OrchestrationReadyItemBlockerCategory {
  code: string;
  category: string;
  owner: string;
  reason_code: string;
  reason_text: string;
  next_action: string;
  count: number;
  examples: string[];
}

export interface OrchestrationReadyItemBlockerProjection {
  raw_ready: number;
  useful_ready: number;
  admissible_now: number;
  ready: number;
  admissible: number;
  actionable: number;
  in_flight: number;
  stale_ready_floor: boolean;
  next_action: string;
  categories: OrchestrationReadyItemBlockerCategory[];
  top_blocking_lanes: OrchestrationReadyBlockingLane[];
}

export interface OrchestrationReadyBlockingLane {
  lane: string;
  code: string;
  count: number;
  item_ids: string[];
  next_action: string;
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

interface BacklogQueueRow {
  item_id: string;
  title: string | null;
  readiness_state: string;
  risk_class: string | null;
  to_agent: string | null;
  dispatch_body: string | null;
  write_scope_json: string | null;
  dependencies_json: string | null;
}

interface HygieneCleanupRow {
  item_id: string;
  logical_key: string | null;
  to_agent: string | null;
  last_dispatch_phid: string | null;
}

interface DispatchQueueCountRow {
  status: string | null;
  n: number;
}

interface ArtifactCommentNoiseRow {
  artifact_id: string;
  op_id: number;
  actor: string | null;
  payload_json: string | null;
  idempotency_key: string | null;
  artifact_agent: string | null;
}

interface OrchestrationStateRow {
  team_id: string;
  mode: string;
  consecutive_zero_ticks: number;
  last_tick_at: string | null;
  last_dispatch_at: string | null;
  auto_paused: number | null;
  auto_pause_reason: string | null;
}

interface LastNoopDecisionRow {
  tick_id: string;
  action: string;
  reason: string;
  ts: string;
}

const RECOVERED_STATUSES = ["moot", "landed_reconciled", "verified_done", "retry_done"];
const STALL_TICK_THRESHOLD = 3;

export async function readOrchestrationHealthProjection(
  adapter: DbAdapter,
  teamId = "default",
  opts: { recentLimit?: number } = {},
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
    .filter((row) => !promotionHygieneIncident(row))
    .map((row) => ({ row, reason: promotionBlockerReason(row.promotion_result_json) }))
    .filter((x): x is { row: DispatchRow; reason: string } => x.reason != null)
    .map(({ row, reason }) => blockerFromRow(row, dependencyImpact, reason))
    .sort(compareBlockersRecent);
  const staleHygiene = await readStaleHygieneRoutes(adapter, teamId, promotionRows);

  const queueQuality = await readQueueQualityProjection(adapter, teamId, dependencyImpact, {
    needsClarification: needsClarification.length,
    promotion: promotion.length,
  });
  const readyItemBlockers = await readReadyItemBlockerProjection(adapter, teamId, dependencyImpact);
  const [orchestrationLoop, managerWorkTelemetry] = await Promise.all([
    readOrchestrationLoopHealthProjection(adapter, teamId, readyItemBlockers),
    readManagerWorkTelemetryProjection(adapter, teamId),
  ]);

  return {
    ok: orchestrationLoop.state !== "stalled_ready_not_launching" &&
      orchestrationLoop.state !== "blocked_backpressure" &&
      orchestrationLoop.state !== "blocked_no_capacity" &&
      orchestrationLoop.state !== "misconfigured",
    generated_at: new Date().toISOString(),
    orchestration_loop: orchestrationLoop,
    queue_quality: queueQuality,
    ready_item_blockers: readyItemBlockers,
    manager_work_telemetry: managerWorkTelemetry,
    blockers: {
      blocked: needsClarification.length > 0 || promotion.length > 0,
      needs_clarification: summarize(needsClarification, recentLimit),
      promotion: summarize(promotion, recentLimit),
      stale_hygiene: summarizeHygieneRoutes(staleHygiene, recentLimit),
    },
  };
}

async function readOrchestrationLoopHealthProjection(
  adapter: DbAdapter,
  teamId: string,
  readyItemBlockers: OrchestrationReadyItemBlockerProjection,
): Promise<OrchestrationLoopHealthProjection> {
  const [state, lastNoop] = await Promise.all([
    readOrchestrationStateRow(adapter, teamId),
    readLastNoopDecision(adapter, teamId),
  ]);
  const schedulerLoopId = `continuous-orchestration:${teamId}`;
  if (!state) {
    return {
      state: "misconfigured",
      raw_ready: readyItemBlockers.raw_ready,
      useful_ready: readyItemBlockers.useful_ready,
      admissible_now: readyItemBlockers.admissible_now,
      ready_count: readyItemBlockers.ready,
      admissible_ready_count: readyItemBlockers.admissible,
      actionable_ready_count: readyItemBlockers.actionable,
      in_flight_count: readyItemBlockers.in_flight,
      noop_tick_count: 0,
      last_tick_at: null,
      last_launch_at: null,
      last_noop_reason: null,
      first_stalled_at: null,
      scheduler_loop_id: schedulerLoopId,
      reason: "orchestration_state row is missing",
    };
  }

  const noopTickCount = Number(state.consecutive_zero_ticks ?? 0);
  const lastNoopReason = state.auto_pause_reason ?? lastNoop?.reason ?? null;
  const base = {
    raw_ready: readyItemBlockers.raw_ready,
    useful_ready: readyItemBlockers.useful_ready,
    admissible_now: readyItemBlockers.admissible_now,
    ready_count: readyItemBlockers.ready,
    admissible_ready_count: readyItemBlockers.admissible,
    actionable_ready_count: readyItemBlockers.actionable,
    in_flight_count: readyItemBlockers.in_flight,
    noop_tick_count: noopTickCount,
    last_tick_at: state.last_tick_at ?? null,
    last_launch_at: state.last_dispatch_at ?? null,
    last_noop_reason: lastNoopReason,
    first_stalled_at: null as string | null,
    scheduler_loop_id: schedulerLoopId,
  };

  if (state.mode === "paused" || state.auto_paused === 1) {
    return { state: "paused", ...base, reason: lastNoopReason ?? "continuous orchestration is paused" };
  }
  if (state.mode === "stopped") {
    return { state: "paused", ...base, reason: "continuous orchestration is stopped" };
  }
  if (state.mode && !["running", "drain_only"].includes(state.mode)) {
    return { state: "misconfigured", ...base, reason: `unknown orchestration mode: ${state.mode}` };
  }
  if (readyItemBlockers.ready === 0) {
    return { state: "idle_no_ready_work", ...base, reason: "no ready backlog items are waiting" };
  }

  const explicitBlock = explicitBlockState(readyItemBlockers, lastNoopReason);
  if (explicitBlock) {
    return { state: explicitBlock, ...base, reason: lastNoopReason ?? readyBlockerSummary(readyItemBlockers) };
  }

  if (noopTickCount >= STALL_TICK_THRESHOLD) {
    return {
      state: "stalled_ready_not_launching",
      ...base,
      first_stalled_at: state.last_tick_at ?? null,
      reason: `${readyItemBlockers.ready} ready backlog item(s) and ${noopTickCount} consecutive no-op tick(s) without an explicit blocking reason`,
    };
  }

  return {
    state: "running",
    ...base,
    reason: readyItemBlockers.actionable > 0
      ? `${readyItemBlockers.actionable} ready backlog item(s) are admissible`
      : "continuous orchestration is running",
  };
}

async function readOrchestrationStateRow(adapter: DbAdapter, teamId: string): Promise<OrchestrationStateRow | null> {
  const { rows } = await adapter.query<OrchestrationStateRow>(
    `SELECT team_id, mode, consecutive_zero_ticks, last_tick_at, last_dispatch_at, auto_paused, auto_pause_reason
       FROM orchestration_state
      WHERE team_id = ?
      LIMIT 1`,
    [teamId],
  );
  return rows[0] ?? null;
}

async function readLastNoopDecision(adapter: DbAdapter, teamId: string): Promise<LastNoopDecisionRow | null> {
  const { rows } = await adapter.query<LastNoopDecisionRow>(
    `SELECT tick_id, action, reason, ts
       FROM orchestration_decision_log
      WHERE team_id = ?
        AND dispatch_phid IS NULL
      ORDER BY ts DESC
      LIMIT 1`,
    [teamId],
  );
  return rows[0] ?? null;
}

function explicitBlockState(
  readyItemBlockers: OrchestrationReadyItemBlockerProjection,
  lastNoopReason: string | null,
): "blocked_backpressure" | "blocked_no_capacity" | null {
  const reason = (lastNoopReason ?? "").toLowerCase();
  if (/\b(capacity|in[-_ ]?flight|max_new|max enqueues|pool|free slot|no free|builder|write cap)\b/.test(reason)) {
    return "blocked_no_capacity";
  }
  if (/\b(token|budget|usage|kill switch|paused|halt|approval|clarification|promotion|dependency|unhealthy|backpressure)\b/.test(reason)) {
    return "blocked_backpressure";
  }
  if (readyItemBlockers.ready > 0 && readyItemBlockers.actionable === 0 && readyItemBlockers.categories.length > 0) {
    return "blocked_backpressure";
  }
  return null;
}

function readyBlockerSummary(readyItemBlockers: OrchestrationReadyItemBlockerProjection): string {
  const categories = readyItemBlockers.categories.map((c) => `${c.code}=${c.count}`);
  return categories.length > 0
    ? `ready backlog is explicitly blocked: ${categories.join(", ")}`
    : "ready backlog is blocked";
}

async function readReadyItemBlockerProjection(
  adapter: DbAdapter,
  teamId: string,
  dependencyImpact: Map<string, string[]>,
): Promise<OrchestrationReadyItemBlockerProjection> {
  const allRows = await readBacklogQueueRows(adapter, teamId);
  const rows = allRows.filter((row) => row.readiness_state === "ready");
  const inFlightRows = allRows.filter((row) => row.readiness_state === "in_flight");
  const inFlight = inFlightRows.length;
  const activeWriteScopes = new Set<string>();
  for (const row of inFlightRows) for (const scope of parseStringArray(row.write_scope_json)) activeWriteScopes.add(scope);
  const blockedDependencyItemIds = new Set<string>();
  for (const ids of dependencyImpact.values()) for (const id of ids) blockedDependencyItemIds.add(id);

  const categories = new Map<string, OrchestrationReadyItemBlockerCategory>();
  const blockingLanes = new Map<string, OrchestrationReadyBlockingLane>();
  let actionable = 0;
  const add = (code: string, category: string, itemId: string, lane?: string | null) => {
    const key = `${category}:${code}`;
    const current = categories.get(key) ?? readyItemBlockerCategory(code, category);
    current.count += 1;
    if (current.examples.length < 5) current.examples.push(itemId);
    categories.set(key, current);
    if (lane) {
      const laneKey = `${code}:${lane}`;
      const currentLane = blockingLanes.get(laneKey) ?? {
        lane,
        code,
        count: 0,
        item_ids: [],
        next_action: readyItemBlockerDetails(code).next_action,
      };
      currentLane.count += 1;
      if (currentLane.item_ids.length < 5) currentLane.item_ids.push(itemId);
      blockingLanes.set(laneKey, currentLane);
    }
  };

  for (const row of rows) {
    if (!hasDispatchPayload(row)) {
      add("missing_dispatch_target", "dispatch_admission", row.item_id);
    } else if (!isAutoRunRisk(row.risk_class)) {
      add("risk_requires_approval", "lane_eligibility", row.item_id);
    } else if (parseStringArray(row.dependencies_json).length > 0 || blockedDependencyItemIds.has(row.item_id)) {
      add("blocked_dependency", "lane_eligibility", row.item_id);
    } else {
      const scopeClash = parseStringArray(row.write_scope_json).find((scope) => activeWriteScopes.has(scope));
      if (scopeClash) {
        add("single_writer_lane_busy", "lane_eligibility", row.item_id, scopeClash);
      } else {
        actionable += 1;
      }
    }
  }

  return {
    raw_ready: rows.length,
    useful_ready: actionable,
    admissible_now: actionable,
    ready: rows.length,
    admissible: actionable,
    actionable,
    in_flight: inFlight,
    stale_ready_floor: rows.length > 0 && actionable === 0,
    next_action: readyItemBlockerNextAction(rows.length, actionable, categories),
    categories: [...categories.values()].sort((a, b) => b.count - a.count || a.category.localeCompare(b.category) || a.code.localeCompare(b.code)),
    top_blocking_lanes: [...blockingLanes.values()]
      .sort((a, b) => b.count - a.count || a.code.localeCompare(b.code) || a.lane.localeCompare(b.lane))
      .slice(0, 5),
  };
}

function readyItemBlockerNextAction(
  ready: number,
  actionable: number,
  categories: Map<string, OrchestrationReadyItemBlockerCategory>,
): string {
  if (ready === 0) return "No ready-fuel action needed.";
  if (actionable > 0) return "Dispatch admissible ready work before adding fuel.";
  const sorted = [...categories.values()].sort((a, b) => b.count - a.count || a.category.localeCompare(b.category) || a.code.localeCompare(b.code));
  if (sorted.length === 1 && sorted[0]?.code === "single_writer_lane_busy") {
    return "Request new-lane build-ready fuel outside the occupied write scopes, or wait for active writer locks to clear.";
  }
  return sorted[0]?.next_action ?? "Clear the leading ready-admission blockers before adding more fuel.";
}

function readyItemBlockerCategory(code: string, category: string): OrchestrationReadyItemBlockerCategory {
  const details = readyItemBlockerDetails(code);
  return {
    code,
    category,
    owner: details.owner,
    reason_code: code,
    reason_text: details.reason_text,
    next_action: details.next_action,
    count: 0,
    examples: [],
  };
}

function readyItemBlockerDetails(code: string): { owner: string; reason_text: string; next_action: string } {
  switch (code) {
    case "missing_dispatch_target":
      return {
        owner: "orchestration_flesher",
        reason_text: "Ready item is missing a target agent or dispatch body.",
        next_action: "Fill to_agent and dispatch_body, then re-run admission.",
      };
    case "risk_requires_approval":
      return {
        owner: "operator",
        reason_text: "Ready item has a risk class that is not eligible for unattended admission.",
        next_action: "Approve, downgrade, or batch the item before dispatch.",
      };
    case "blocked_dependency":
      return {
        owner: "dependency_owner",
        reason_text: "Ready item depends on work that has not landed.",
        next_action: "Complete or clear the blocking dependency before admitting this item.",
      };
    case "clarification_blocker":
      return {
        owner: "operator",
        reason_text: "A dependency dispatch is waiting on clarification.",
        next_action: "Answer the clarification or mark the dispatch moot.",
      };
    case "promotion_blocker":
      return {
        owner: "build_owner",
        reason_text: "A dependency dispatch has not completed required promotion.",
        next_action: "Promote the dependency branch or record an explicit promotion skip.",
      };
    case "target_unhealthy":
      return {
        owner: "runtime_owner",
        reason_text: "Target agent is not currently healthy for admission.",
        next_action: "Recover the target agent or reroute the item to a healthy lane.",
      };
    case "provider_runtime_mismatch":
      return {
        owner: "route_owner",
        reason_text: "Requested provider/runtime does not match the target lane.",
        next_action: "Repair the ready row runtime metadata or choose a matching target agent.",
      };
    case "single_writer_lane_busy":
      return {
        owner: "scheduler",
        reason_text: "A write scope for this ready item is already locked.",
        next_action: "Wait for the active writer to finish or split the write scope.",
      };
    case "no_in_flight_slots":
    case "tick_admission_cap":
    case "pool_capacity_full":
    case "no_free_pool_builder":
      return {
        owner: "scheduler",
        reason_text: "Scheduler or build-pool capacity is saturated.",
        next_action: "Do not refuel; wait for in-flight work or builder capacity to free.",
      };
    case "daily_token_ceiling":
      return {
        owner: "operator",
        reason_text: "Usage gate is blocking new admission.",
        next_action: "Raise the budget, wait for reset, or switch the usage gate to warning mode.",
      };
    default:
      return {
        owner: "scheduler",
        reason_text: `Ready item is blocked by ${code}.`,
        next_action: "Inspect the matching non-admission records and clear the leading blocker.",
      };
  }
}

async function readQueueQualityProjection(
  adapter: DbAdapter,
  teamId: string,
  dependencyImpact: Map<string, string[]>,
  activeBlockerCounts: { needsClarification: number; promotion: number },
): Promise<OrchestrationQueueQualityProjection> {
  const [backlogRows, dispatchCounts, artifactNoise] = await Promise.all([
    readBacklogQueueRows(adapter, teamId),
    readDispatchQueueCounts(adapter, teamId),
    readArtifactCommentNoise(adapter),
  ]);

  const dispatchByStatus = new Map(dispatchCounts.map((r) => [r.status ?? "unknown", Number(r.n)]));
  const rawQueued = Number(dispatchByStatus.get("queued") ?? 0) + Number(dispatchByStatus.get("bounced") ?? 0);

  const readyRows = backlogRows.filter((row) => row.readiness_state === "ready");
  const blockedDependencyItemIds = new Set<string>();
  for (const ids of dependencyImpact.values()) for (const id of ids) blockedDependencyItemIds.add(id);

  const actionableReady = readyRows.filter((row) =>
    hasDispatchPayload(row) &&
    isAutoRunRisk(row.risk_class) &&
    parseStringArray(row.dependencies_json).length === 0 &&
    !blockedDependencyItemIds.has(row.item_id)
  ).length;

  const needsApproval = backlogRows.filter((row) =>
    row.readiness_state === "needs_review" ||
    row.readiness_state === "needs_chris_batch" ||
    (row.readiness_state === "ready" && !isAutoRunRisk(row.risk_class))
  ).length;

  const blockedBacklog = backlogRows.filter((row) =>
    row.readiness_state === "blocked_dependency" ||
    (row.readiness_state === "ready" && blockedDependencyItemIds.has(row.item_id))
  ).length;
  const failedDispatches =
    Number(dispatchByStatus.get("failed") ?? 0) +
    Number(dispatchByStatus.get("cancelled") ?? 0) +
    Number(dispatchByStatus.get("needs_clarification") ?? 0);

  const noise = classifyArtifactNoise(artifactNoise);
  const blockedOrFailed = blockedBacklog + failedDispatches + noise.retryableRouteFailures;
  const explanation = queueQualityExplanation({
    actionableReady,
    rawQueued,
    needsApproval,
    duplicateOrNoop: noise.duplicateOrNoop,
    suppressedByDedupe: noise.suppressedByDedupe,
    blockedOrFailed,
    activeBlockerCounts,
  });

  return {
    raw_queued: rawQueued,
    actionable_ready: actionableReady,
    needs_approval: needsApproval,
    duplicate_or_noop_backfill: noise.duplicateOrNoop,
    suppressed_by_dedupe: noise.suppressedByDedupe,
    blocked_or_failed: blockedOrFailed,
    top_noise_patterns: noise.topPatterns,
    explanation,
  };
}

async function readBacklogQueueRows(adapter: DbAdapter, teamId: string): Promise<BacklogQueueRow[]> {
  const { rows } = await adapter.query<BacklogQueueRow>(
    `SELECT item_id, title, readiness_state, risk_class, to_agent, dispatch_body, write_scope_json, dependencies_json
       FROM orchestration_backlog_item
      WHERE team_id = ?
        AND readiness_state NOT IN ('done', 'cancelled', 'superseded')`,
    [teamId],
  );
  return rows;
}

async function readDispatchQueueCounts(adapter: DbAdapter, teamId: string): Promise<DispatchQueueCountRow[]> {
  const { rows } = await adapter.query<DispatchQueueCountRow>(
    `SELECT status, COUNT(*) AS n
       FROM dispatch_scheduler_queue
      WHERE team_id = ?
        AND COALESCE(recovery_status, 'none') NOT IN ('moot', 'landed_reconciled', 'verified_done', 'retry_done')
      GROUP BY status`,
    [teamId],
  );
  return rows;
}

async function readArtifactCommentNoise(adapter: DbAdapter): Promise<ArtifactCommentNoiseRow[]> {
  try {
    const { rows } = await adapter.query<ArtifactCommentNoiseRow>(
      `SELECT o.artifact_id, o.op_id, o.actor, o.payload_json, o.idempotency_key,
              a.agent AS artifact_agent
         FROM artifact_operations o
         LEFT JOIN artifacts a ON a.artifact_id = o.artifact_id
        WHERE o.op_type = 'comment_recorded'
        ORDER BY o.artifact_id ASC, o.op_id ASC`,
      [],
    );
    return rows;
  } catch (err) {
    if (err instanceof Error && /no such table|does not exist/i.test(err.message)) return [];
    throw err;
  }
}

function classifyArtifactNoise(rows: ArtifactCommentNoiseRow[]): {
  duplicateOrNoop: number;
  suppressedByDedupe: number;
  retryableRouteFailures: number;
  topPatterns: OrchestrationQueueNoisePattern[];
} {
  const groups = new Map<string, { count: number; examples: string[]; pattern: string }>();
  let duplicateOrNoop = 0;
  let retryableRouteFailures = 0;

  for (const row of rows) {
    const payload = parseJson(row.payload_json);
    const routeStatus = parseRouteStatus(payload?.route_status);
    if (routeStatus?.retryable) retryableRouteFailures += 1;
    if (!isNoopAckRoute(routeStatus)) continue;

    duplicateOrNoop += 1;
    const routeReceipt = routeStatus.dispatch?.dispatch_phid ?? routeStatus.skipped ?? "no_receipt";
    const workItemId = workItemIdentity(row, payload, routeStatus);
    const targetAgent = routeStatus.target_agent ?? row.artifact_agent ?? "unknown_agent";
    const routeKind = routeStatus.route_kind;
    const fingerprint = payloadFingerprint(payload);
    const key = `${workItemId}|${targetAgent}|${fingerprint}|${routeReceipt}`;
    const pattern = `${routeKind}:${targetAgent}:${routeReceipt}`;
    const existing = groups.get(key) ?? { count: 0, examples: [], pattern };
    existing.count += 1;
    if (existing.examples.length < 3) existing.examples.push(`${row.artifact_id}#${row.op_id}`);
    groups.set(key, existing);
  }

  const suppressedByDedupe = [...groups.values()].reduce((sum, group) => sum + Math.max(0, group.count - 1), 0);
  const topPatterns = [...groups.values()]
    .sort((a, b) => b.count - a.count || a.pattern.localeCompare(b.pattern))
    .slice(0, 5)
    .map((group) => ({ pattern: group.pattern, count: group.count, examples: group.examples }));

  return { duplicateOrNoop, suppressedByDedupe, retryableRouteFailures, topPatterns };
}

function isNoopAckRoute(routeStatus: ParsedRouteStatus | null): routeStatus is ParsedRouteStatus {
  return !!routeStatus &&
    routeStatus.routed === false &&
    routeStatus.retryable === false &&
    (routeStatus.route_kind === "acknowledgement" ||
      routeStatus.route_kind === "approval_signal" ||
      routeStatus.skipped === "acknowledged" ||
      routeStatus.skipped === "approval_signal");
}

interface ParsedRouteStatus {
  route_kind: string | null;
  routed: boolean;
  retryable: boolean;
  target_agent: string | null;
  skipped: string | null;
  dispatch: { dispatch_phid?: string | null } | null;
  task_triage_id: string | null;
}

function parseRouteStatus(value: unknown): ParsedRouteStatus | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const dispatch = v.dispatch && typeof v.dispatch === "object" && !Array.isArray(v.dispatch)
    ? v.dispatch as { dispatch_phid?: string | null }
    : null;
  return {
    route_kind: typeof v.route_kind === "string" ? v.route_kind : null,
    routed: v.routed === true,
    retryable: v.retryable === true,
    target_agent: typeof v.target_agent === "string" ? v.target_agent : null,
    skipped: typeof v.skipped === "string" ? v.skipped : null,
    dispatch,
    task_triage_id: firstString(v.task_triage_id, v.taskTriageId, v.triage_id, v.triageId),
  };
}

function workItemIdentity(
  row: ArtifactCommentNoiseRow,
  payload: Record<string, unknown> | null,
  routeStatus: ParsedRouteStatus,
): string {
  const taskTriageId = firstString(
    routeStatus.task_triage_id,
    payload?.task_triage_id,
    payload?.taskTriageId,
    payload?.triage_id,
    payload?.triageId,
  );
  return taskTriageId ? `task-triage:${taskTriageId}` : `artifact:${row.artifact_id}`;
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim() !== "") return value.trim();
  }
  return null;
}

function payloadFingerprint(payload: Record<string, unknown> | null): string {
  const stable = {
    body: typeof payload?.body === "string" ? payload.body.trim().toLowerCase().replace(/\s+/g, " ") : "",
    reaction: typeof payload?.reaction === "string" ? payload.reaction : null,
    anchor: typeof payload?.anchor === "string" ? payload.anchor : null,
  };
  return createHash("sha256").update(JSON.stringify(stable)).digest("hex").slice(0, 12);
}

function hasDispatchPayload(row: BacklogQueueRow): boolean {
  return typeof row.to_agent === "string" && row.to_agent.trim() !== "" &&
    typeof row.dispatch_body === "string" && row.dispatch_body.trim() !== "";
}

function isAutoRunRisk(risk: string | null | undefined): boolean {
  return risk === "routine" || risk === "build";
}

function queueQualityExplanation(input: {
  actionableReady: number;
  rawQueued: number;
  needsApproval: number;
  duplicateOrNoop: number;
  suppressedByDedupe: number;
  blockedOrFailed: number;
  activeBlockerCounts: { needsClarification: number; promotion: number };
}): string {
  if (input.actionableReady > 0) return `${input.actionableReady} ready row(s) are admissible now.`;
  const reasons: string[] = [];
  if (input.needsApproval > 0) reasons.push(`${input.needsApproval} need approval/review`);
  if (input.blockedOrFailed > 0) reasons.push(`${input.blockedOrFailed} blocked or failed`);
  if (input.duplicateOrNoop > 0) reasons.push(`${input.duplicateOrNoop} duplicate/no-op artifact acknowledgement(s)`);
  if (input.suppressedByDedupe > 0) reasons.push(`${input.suppressedByDedupe} suppressed by dedupe`);
  if (input.activeBlockerCounts.needsClarification > 0) reasons.push(`${input.activeBlockerCounts.needsClarification} clarification blocker(s)`);
  if (input.activeBlockerCounts.promotion > 0) reasons.push(`${input.activeBlockerCounts.promotion} promotion blocker(s)`);
  if (input.rawQueued > 0) reasons.push(`${input.rawQueued} raw queued dispatch(es) are not ready fuel`);
  return reasons.length > 0
    ? `No ready fuel is admissible: ${reasons.join("; ")}.`
    : "No ready fuel is admissible because no dispatchable ready rows are present.";
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

function promotionHygieneIncident(row: DispatchRow): boolean {
  return getPromotionHygieneIncident(row) != null;
}

function getPromotionHygieneIncident(row: DispatchRow) {
  const input = parseJson(row.promotion_input_json);
  const result = parseJson(row.promotion_result_json);
  return classifyPromotionHygieneFailure({
    repo: typeof input?.repo === "string" ? input.repo : null,
    branch: typeof input?.branch === "string" ? input.branch : null,
    dispatch_id: row.dispatch_phid,
    text: `${row.active_clarification_json ?? ""}\n${row.promotion_result_json ?? ""}`,
    payload: result ?? input,
  });
}

async function readStaleHygieneRoutes(
  adapter: DbAdapter,
  teamId: string,
  promotionRows: DispatchRow[],
): Promise<OrchestrationHygieneRoute[]> {
  const incidents = promotionRows
    .map((row) => ({ row, incident: getPromotionHygieneIncident(row) }))
    .filter((x): x is { row: DispatchRow; incident: NonNullable<ReturnType<typeof getPromotionHygieneIncident>> } => x.incident != null);
  if (incidents.length === 0) return [];

  const keys = [...new Set(incidents.map(({ incident }) => `worktree-hygiene:${hygieneDedupeKey(incident)}`))];
  const cleanupByLogicalKey = new Map<string, HygieneCleanupRow>();
  const placeholders = keys.map(() => "?").join(", ");
  const { rows } = await adapter.query<HygieneCleanupRow>(
    `SELECT item_id, logical_key, to_agent, last_dispatch_phid
       FROM orchestration_backlog_item
      WHERE team_id = ?
        AND logical_key IN (${placeholders})`,
    [teamId, ...keys],
  );
  for (const row of rows) {
    if (row.logical_key) cleanupByLogicalKey.set(row.logical_key, row);
  }

  return incidents
    .map(({ row, incident }) => {
      const dedupeKey = hygieneDedupeKey(incident);
      const cleanup = cleanupByLogicalKey.get(`worktree-hygiene:${dedupeKey}`);
      return {
        dispatch_phid: row.dispatch_phid,
        query_id: row.query_id ?? null,
        updated_at: row.completed_at ?? row.updated_at ?? null,
        repo: incident.repo,
        branch: incident.branch,
        class_code: incident.incident_code,
        dedupe_key: dedupeKey,
        owner_lane: cleanup?.to_agent ?? hygieneOwnerLane(incident.repo),
        cleanup_item_id: cleanup?.item_id ?? null,
        cleanup_dispatch_id: cleanup?.last_dispatch_phid ?? null,
        reason: `hygiene route: ${incident.incident_code}; action=${incident.action}`,
      };
    })
    .sort((a, b) => String(b.updated_at ?? "").localeCompare(String(a.updated_at ?? "")) ||
      a.dispatch_phid.localeCompare(b.dispatch_phid));
}

function summarizeHygieneRoutes(items: OrchestrationHygieneRoute[], recentLimit: number) {
  const recent = items.slice(0, recentLimit);
  return {
    count: items.length,
    recent_dispatch_ids: recent.map((item) => item.dispatch_phid),
    owner_lanes: [...new Set(items.map((item) => item.owner_lane))].sort(),
    items: recent,
  };
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
