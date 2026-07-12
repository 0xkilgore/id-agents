// Continuous Orchestration — blocker health projection.
//
// This is the operator-facing "why is the loop fake-green?" read-model. It
// ties dispatch blockers back to backlog dependencies so shipped-but-unlanded
// work and clarification waits are visible in the orchestration health surface.

import type { DbAdapter } from "../db/db-adapter.js";
import { createHash } from "node:crypto";
import { classifyPromotionHygieneFailure } from "../loops/worktree-hygiene.js";
import { loadContinuousOrchestrationConfig } from "./config.js";

export type OrchestrationLoopState =
  | "paused"
  | "running"
  | "running_at_capacity"
  | "stalled_ready_not_launching";

export interface OrchestrationLoopHealthProjection {
  state: OrchestrationLoopState;
  severity: "ok" | "warn" | "critical";
  consecutive_zero_ticks: number;
  stall_threshold_ticks: number;
  in_flight: number;
  last_admission_block_reasons: Record<string, number>;
  explanation: string;
}

export interface OrchestrationHealthBlocker {
  dispatch_phid: string;
  query_id: string | null;
  to_agent: string | null;
  updated_at: string | null;
  reason: string;
  owner_lane: string;
  recommended_action: string;
  needs_chris: boolean;
  blocks_backlog_dependency: boolean;
  blocked_dependency_item_ids: string[];
}

export interface OrchestrationHealthProjection {
  ok: boolean;
  generated_at: string;
  orchestration_loop: OrchestrationLoopHealthProjection;
  queue_quality: OrchestrationQueueQualityProjection;
  ready_item_blockers: OrchestrationReadyItemBlockerProjection;
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
  task_action_receipts: TaskActionReceiptCounts;
  top_noise_patterns: OrchestrationQueueNoisePattern[];
  explanation: string;
}

export interface OrchestrationReadyItemBlockerProjection {
  ready: number;
  actionable: number;
  stale_ready_floor: boolean;
  categories: Array<{ code: string; category: string; count: number; examples: string[] }>;
}

export interface TaskActionReceiptCounts {
  routed: number;
  failed: number;
  needs_chris: number;
  consumed: number;
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
  dependencies_json: string | null;
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

const RECOVERED_STATUSES = ["moot", "landed_reconciled", "verified_done", "retry_done"];

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
    .map((row) => ({ row, reason: clarificationReason(row) }))
    .filter(({ row, reason }) => !isRetryableClarificationNoise(row, reason, dependencyImpact))
    .map(({ row, reason }) => blockerFromRow(row, dependencyImpact, reason))
    .sort(compareBlockersRecent);

  const promotion = promotionRows
    .filter((row) => !promotionHygieneIncident(row))
    .map((row) => ({ row, reason: promotionBlockerReason(row.promotion_result_json) }))
    .filter((x): x is { row: DispatchRow; reason: string } => x.reason != null)
    .map(({ row, reason }) => blockerFromRow(row, dependencyImpact, reason, {
      owner_lane: "release-engineering",
      recommended_action: "complete promotion, push the base branch, and verify the remote tip",
      needs_chris: false,
    }))
    .sort(compareBlockersRecent);

  const queueQuality = await readQueueQualityProjection(adapter, teamId, dependencyImpact, {
    needsClarification: needsClarification.length,
    promotion: promotion.length,
  });

  return {
    ok: true,
    generated_at: new Date().toISOString(),
    orchestration_loop: await readOrchestrationLoopHealthProjection(adapter, teamId),
    queue_quality: queueQuality,
    ready_item_blockers: await readReadyItemBlockerProjection(adapter, teamId, dependencyImpact),
    blockers: {
      blocked: needsClarification.length > 0 || promotion.length > 0,
      needs_clarification: summarize(needsClarification, recentLimit),
      promotion: summarize(promotion, recentLimit),
    },
  };
}

const CAPACITY_OR_LANE_REASONS = new Set([
  "single_writer_lane_busy",
  "pool_capacity_full",
  "no_free_pool_builder",
  "no_in_flight_slots",
  "tick_admission_cap",
]);

interface OrchestrationLoopStateRow {
  mode: string;
  consecutive_zero_ticks: number | null;
  last_admission_block_reasons_json: string | null;
}

export async function readOrchestrationLoopHealthProjection(
  adapter: DbAdapter,
  teamId = "default",
  opts: { stallThresholdTicks?: number } = {},
): Promise<OrchestrationLoopHealthProjection> {
  const stallThresholdTicks = Math.max(
    1,
    Math.floor(opts.stallThresholdTicks ?? loadContinuousOrchestrationConfig().stall_threshold_ticks),
  );
  const [{ rows: stateRows }, { rows: inFlightRows }] = await Promise.all([
    adapter.query<OrchestrationLoopStateRow>(
      `SELECT mode, consecutive_zero_ticks, last_admission_block_reasons_json
         FROM orchestration_state
        WHERE team_id = ?
        LIMIT 1`,
      [teamId],
    ),
    adapter.query<{ count: number }>(
      `SELECT COUNT(*) AS count
         FROM orchestration_backlog_item
        WHERE team_id = ?
          AND readiness_state = 'in_flight'`,
      [teamId],
    ),
  ]);
  const state = stateRows[0];
  const mode = state?.mode ?? "paused";
  const consecutiveZeroTicks = Number(state?.consecutive_zero_ticks ?? 0);
  const inFlight = Number(inFlightRows[0]?.count ?? 0);
  const lastAdmissionBlockReasons = parseCountMap(state?.last_admission_block_reasons_json ?? null);
  const explainedCount = Object.values(lastAdmissionBlockReasons).reduce((sum, count) => sum + count, 0);
  const allCapacityOrLane =
    explainedCount > 0 &&
    Object.entries(lastAdmissionBlockReasons)
      .filter(([, count]) => count > 0)
      .every(([code]) => CAPACITY_OR_LANE_REASONS.has(code));

  if (mode === "paused" || mode === "stopped") {
    return {
      state: "paused",
      severity: "warn",
      consecutive_zero_ticks: consecutiveZeroTicks,
      stall_threshold_ticks: stallThresholdTicks,
      in_flight: inFlight,
      last_admission_block_reasons: lastAdmissionBlockReasons,
      explanation: `orchestration mode is ${mode}`,
    };
  }

  if (consecutiveZeroTicks >= stallThresholdTicks && explainedCount === 0) {
    return {
      state: "stalled_ready_not_launching",
      severity: "critical",
      consecutive_zero_ticks: consecutiveZeroTicks,
      stall_threshold_ticks: stallThresholdTicks,
      in_flight: inFlight,
      last_admission_block_reasons: lastAdmissionBlockReasons,
      explanation: `${consecutiveZeroTicks} consecutive zero-admit ticks with no structured admission explanation`,
    };
  }

  if (consecutiveZeroTicks >= stallThresholdTicks && inFlight > 0 && allCapacityOrLane) {
    return {
      state: "running_at_capacity",
      severity: "warn",
      consecutive_zero_ticks: consecutiveZeroTicks,
      stall_threshold_ticks: stallThresholdTicks,
      in_flight: inFlight,
      last_admission_block_reasons: lastAdmissionBlockReasons,
      explanation: `${consecutiveZeroTicks} consecutive zero-admit ticks explained by capacity or lane eligibility`,
    };
  }

  return {
    state: "running",
    severity: "ok",
    consecutive_zero_ticks: consecutiveZeroTicks,
    stall_threshold_ticks: stallThresholdTicks,
    in_flight: inFlight,
    last_admission_block_reasons: lastAdmissionBlockReasons,
    explanation: explainedCount > 0
      ? "zero-admit ticks have structured admission explanations"
      : "orchestration loop is below the zero-admit stall threshold",
  };
}

function parseCountMap(json: string | null): Record<string, number> {
  if (!json) return {};
  try {
    const parsed = JSON.parse(json);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, number> = {};
    for (const [key, value] of Object.entries(parsed)) {
      const n = Number(value);
      if (Number.isFinite(n) && n > 0) out[key] = n;
    }
    return out;
  } catch {
    return {};
  }
}

async function readReadyItemBlockerProjection(
  adapter: DbAdapter,
  teamId: string,
  dependencyImpact: Map<string, string[]>,
): Promise<OrchestrationReadyItemBlockerProjection> {
  const rows = (await readBacklogQueueRows(adapter, teamId)).filter((row) => row.readiness_state === "ready");
  const blockedDependencyItemIds = new Set<string>();
  for (const ids of dependencyImpact.values()) for (const id of ids) blockedDependencyItemIds.add(id);

  const categories = new Map<string, { code: string; category: string; count: number; examples: string[] }>();
  let actionable = 0;
  const add = (code: string, category: string, itemId: string) => {
    const key = `${category}:${code}`;
    const current = categories.get(key) ?? { code, category, count: 0, examples: [] };
    current.count += 1;
    if (current.examples.length < 5) current.examples.push(itemId);
    categories.set(key, current);
  };

  for (const row of rows) {
    if (!hasDispatchPayload(row)) {
      add("missing_dispatch_target", "dispatch_admission", row.item_id);
    } else if (!isAutoRunRisk(row.risk_class)) {
      add("risk_requires_approval", "lane_eligibility", row.item_id);
    } else if (parseStringArray(row.dependencies_json).length > 0 || blockedDependencyItemIds.has(row.item_id)) {
      add("blocked_dependency", "lane_eligibility", row.item_id);
    } else {
      actionable += 1;
    }
  }

  return {
    ready: rows.length,
    actionable,
    stale_ready_floor: rows.length > 0 && actionable === 0,
    categories: [...categories.values()].sort((a, b) => b.count - a.count || a.category.localeCompare(b.category) || a.code.localeCompare(b.code)),
  };
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
    task_action_receipts: noise.taskActionReceipts,
    top_noise_patterns: noise.topPatterns,
    explanation,
  };
}

async function readBacklogQueueRows(adapter: DbAdapter, teamId: string): Promise<BacklogQueueRow[]> {
  const { rows } = await adapter.query<BacklogQueueRow>(
    `SELECT item_id, title, readiness_state, risk_class, to_agent, dispatch_body, dependencies_json
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
  taskActionReceipts: TaskActionReceiptCounts;
  topPatterns: OrchestrationQueueNoisePattern[];
} {
  const groups = new Map<string, { count: number; examples: string[]; pattern: string }>();
  let duplicateOrNoop = 0;
  let retryableRouteFailures = 0;
  const taskActionReceipts: TaskActionReceiptCounts = { routed: 0, failed: 0, needs_chris: 0, consumed: 0 };

  for (const row of rows) {
    const payload = parseJson(row.payload_json);
    const routeStatus = parseRouteStatus(payload?.route_status);
    countTaskActionReceipt(taskActionReceipts, routeStatus);
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

  return { duplicateOrNoop, suppressedByDedupe, retryableRouteFailures, taskActionReceipts, topPatterns };
}

function countTaskActionReceipt(counts: TaskActionReceiptCounts, routeStatus: ParsedRouteStatus | null): void {
  if (!routeStatus) return;
  if (routeStatus.routed) counts.routed += 1;
  else if (routeStatus.retryable || routeStatus.error) counts.failed += 1;
  else if (routeStatus.needs_chris) counts.needs_chris += 1;
  else if (
    routeStatus.skipped === "acknowledged" ||
    routeStatus.skipped === "approval_signal" ||
    routeStatus.skipped === "already_consumed" ||
    routeStatus.skipped === "consumed" ||
    routeStatus.route_kind === "acknowledgement" ||
    routeStatus.route_kind === "approval_signal"
  ) {
    counts.consumed += 1;
  }
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
  error: string | null;
  needs_chris: boolean;
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
    error: typeof v.error === "string" && v.error.trim() !== "" ? v.error : null,
    needs_chris: v.needs_chris === true || v.requires_chris === true || v.skipped === "needs_chris",
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
  routeOverride?: ClarificationRoute,
): OrchestrationHealthBlocker {
  const blocked = dependencyImpact.get(row.dispatch_phid) ?? [];
  const route = routeOverride ?? classifyClarificationBlocker(row, reason);
  return {
    dispatch_phid: row.dispatch_phid,
    query_id: row.query_id ?? null,
    to_agent: row.to_agent ?? null,
    updated_at: row.completed_at ?? row.updated_at ?? null,
    reason,
    owner_lane: route.owner_lane,
    recommended_action: route.recommended_action,
    needs_chris: route.needs_chris,
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

function isRetryableClarificationNoise(
  row: DispatchRow,
  reason: string,
  dependencyImpact: Map<string, string[]>,
): boolean {
  if ((dependencyImpact.get(row.dispatch_phid) ?? []).length > 0) return false;

  const text = [
    row.dispatch_phid,
    row.query_id,
    row.to_agent,
    reason,
    row.active_clarification_json,
  ]
    .filter((x): x is string => typeof x === "string" && x.length > 0)
    .join(" ")
    .toLowerCase();

  if (isOverloadedQaOrUiLinkedQueryExpiry(text)) return false;

  return matchesAny(text, [
    "linked query terminated expired",
    "expired as retryable",
    "retryable noise",
    "retryable closeout",
    "stale in_flight",
    "scheduler_wedged",
    "provider_timeout",
    "provider timeout",
    "provider_server_error",
    "rate_limit",
    "rate limit",
  ]);
}

interface ClarificationRoute {
  owner_lane: string;
  recommended_action: string;
  needs_chris: boolean;
}

function classifyClarificationBlocker(row: DispatchRow, reason: string): ClarificationRoute {
  const text = [
    row.dispatch_phid,
    row.query_id,
    row.to_agent,
    reason,
    row.active_clarification_json,
  ]
    .filter((x): x is string => typeof x === "string" && x.length > 0)
    .join(" ")
    .toLowerCase();

  if (isOverloadedQaOrUiLinkedQueryExpiry(text)) {
    return {
      owner_lane: "ui-builder",
      recommended_action: "treat as stale UI/QA lane capacity; retry when the lane has free capacity or reassign within the UI pool",
      needs_chris: false,
    };
  }

  if (matchesAny(text, ["dirty ui worktree", "ui worktree", "worktree dirty", "dirty worktree"])) {
    return {
      owner_lane: "ui-builder",
      recommended_action: "route to the UI worktree owner to preserve or commit local changes before resume",
      needs_chris: false,
    };
  }

  if (matchesAny(text, ["divergent task-cleanup promotion", "task-cleanup", "divergent promotion", "branch ahead and behind", "divergent ancestry"])) {
    return {
      owner_lane: "release-engineering",
      recommended_action: "run promotion preflight and resolve the task-cleanup branch divergence with the repo owner",
      needs_chris: false,
    };
  }

  if (matchesAny(text, ["unrelated dirty local-search", "local-search", "unrelated dirty local search", "unrelated dirty files"])) {
    return {
      owner_lane: "search-infra",
      recommended_action: "route to the local-search owner to stash, commit, or isolate unrelated dirty files",
      needs_chris: false,
    };
  }

  return {
    owner_lane: "chris",
    recommended_action: "ask Chris for the product or operator decision needed to resume",
    needs_chris: true,
  };
}

function isOverloadedQaOrUiLinkedQueryExpiry(text: string): boolean {
  if (!text.includes("linked query terminated expired")) return false;
  if (!matchesAny(text, ["overloaded", "all_members_busy_with_backlog", "single_writer_lane_busy", "pool_capacity_full", "no_free_pool_builder", "lane busy", "at capacity"])) {
    return false;
  }
  return matchesAny(text, ["qa", "ui", "frontend", "regina", "live-ui", "playwright", "browser"]);
}

function matchesAny(text: string, needles: string[]): boolean {
  return needles.some((needle) => text.includes(needle));
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
  const input = parseJson(row.promotion_input_json);
  const result = parseJson(row.promotion_result_json);
  const incident = classifyPromotionHygieneFailure({
    repo: typeof input?.repo === "string" ? input.repo : null,
    branch: typeof input?.branch === "string" ? input.branch : null,
    dispatch_id: row.dispatch_phid,
    text: `${row.active_clarification_json ?? ""}\n${row.promotion_result_json ?? ""}`,
    payload: result ?? input,
  });
  return incident != null;
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
