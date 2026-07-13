// Continuous Orchestration — blocker health projection.
//
// This is the operator-facing "why is the loop fake-green?" read-model. It
// ties dispatch blockers back to backlog dependencies so shipped-but-unlanded
// work and clarification waits are visible in the orchestration health surface.

import type { DbAdapter } from "../db/db-adapter.js";
import { createHash } from "node:crypto";
import { classifyPromotionHygieneFailure } from "../loops/worktree-hygiene.js";
import { loadContinuousOrchestrationConfig } from "./config.js";
import { normalizeRuntime, resolveProviderFromRuntime } from "../dispatch-scheduler/types.js";
import { laneKeyOf } from "./selection.js";
import type { BacklogItem } from "./types.js";
import { getDispatchOutcomesByPhid } from "./storage.js";
import {
  classifyDuplicateDispatchRetryDisposition,
  type DuplicateDispatchRetryDisposition,
  type DuplicateDispatchRetryOperatorDisposition,
  type DuplicateDispatchRetrySafeRecommendation,
} from "./duplicate-dispatch-retry-classifier.js";

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
  build_ready_floor: OrchestrationBuildReadyFloorProjection;
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
  min_ready_fuel: number;
  admissible_now: number | null;
  stale_ready_floor: boolean;
  stale_ready_fuel: {
    active: boolean;
    owner_lane: string;
    recommended_action: string;
    reason: string | null;
    counts_by_blocker_class: Array<{
      code: string;
      category: string;
      count: number;
      examples: string[];
    }>;
    examples: string[];
  };
  categories: Array<{
    code: string;
    category: string;
    count: number;
    examples: string[];
    owner_lane: string;
    reason: string;
    recommended_action: string;
  }>;
  items: OrchestrationReadyItemBlockerDetail[];
}

export interface OrchestrationReadyItemBlockerDetail {
  item_id: string;
  title: string | null;
  code: string;
  category: string;
  owner_lane: string;
  reason: string;
  recommended_action: string;
  prior_dispatch_id: string | null;
  prior_dispatch_status: string | null;
  prior_recovery_status: string | null;
  retry_safe_required: boolean;
  retry_safe_recommendation: DuplicateDispatchRetrySafeRecommendation | null;
  operator_disposition: DuplicateDispatchRetryOperatorDisposition | null;
  recommended_disposition: DuplicateDispatchRetryDisposition | null;
  stale_duplicate_closeout_receipt_exists: boolean;
}

export interface OrchestrationBuildReadyFloorProjection {
  blocked: boolean;
  blocker_code: "build_ready_lane_diversity_below_min_lanes" | "build_ready_below_floor" | null;
  useful_ready_count: number;
  floor: number;
  build_ready_lanes: number;
  min_lanes: number;
  candidate_lanes: string[];
  blocker_reasons: Record<string, number>;
  next_action: string;
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
  provider: string | null;
  runtime: string | null;
  dispatch_body: string | null;
  write_scope_json: string | null;
  dependencies_json: string | null;
  last_dispatch_phid: string | null;
  retry_safe: number | null;
  stale_duplicate_closeout_receipt_json: string | null;
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

interface ReadyAdmissionBlockerSummary {
  code: string;
  category: string;
  count: number;
}

interface ReadyAdmissionNonAdmittedSummary {
  item_id: string;
  code: string;
}

interface OrchestrationHealthProjectionOptions {
  recentLimit?: number;
  minReadyFuel?: number;
  readyAdmission?: {
    admissibleNow: number;
    blockerCounts: ReadyAdmissionBlockerSummary[];
    nonAdmitted: ReadyAdmissionNonAdmittedSummary[];
  };
}

const RECOVERED_STATUSES = ["moot", "landed_reconciled", "verified_done", "retry_done"];

export async function readOrchestrationHealthProjection(
  adapter: DbAdapter,
  teamId = "default",
  opts: OrchestrationHealthProjectionOptions = {},
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
  const readyItemBlockers = await readReadyItemBlockerProjection(adapter, teamId, dependencyImpact, opts);
  const buildReadyFloor = await readBuildReadyFloorProjection(adapter, teamId);
  const blocked =
    needsClarification.length > 0 ||
    promotion.length > 0 ||
    buildReadyFloor.blocked;

  return {
    ok: !blocked,
    generated_at: new Date().toISOString(),
    orchestration_loop: await readOrchestrationLoopHealthProjection(adapter, teamId),
    queue_quality: queueQuality,
    build_ready_floor: buildReadyFloor,
    ready_item_blockers: readyItemBlockers,
    blockers: {
      blocked,
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
  const [{ rows: stateRows }, { rows: inFlightRows }, readyBlockReasons] = await Promise.all([
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
    readReadyAdmissionBlockReasonCounts(adapter, teamId),
  ]);
  const state = stateRows[0];
  const mode = state?.mode ?? "paused";
  const consecutiveZeroTicks = Number(state?.consecutive_zero_ticks ?? 0);
  const inFlight = Number(inFlightRows[0]?.count ?? 0);
  const persistedAdmissionBlockReasons = parseCountMap(state?.last_admission_block_reasons_json ?? null);
  const persistedExplainedCount = Object.values(persistedAdmissionBlockReasons).reduce((sum, count) => sum + count, 0);
  const lastAdmissionBlockReasons = persistedExplainedCount > 0
    ? persistedAdmissionBlockReasons
    : readyBlockReasons;
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

  if (consecutiveZeroTicks >= stallThresholdTicks && explainedCount > 0) {
    return {
      state: "stalled_ready_not_launching",
      severity: "critical",
      consecutive_zero_ticks: consecutiveZeroTicks,
      stall_threshold_ticks: stallThresholdTicks,
      in_flight: inFlight,
      last_admission_block_reasons: lastAdmissionBlockReasons,
      explanation:
        `${consecutiveZeroTicks} consecutive zero-admit ticks blocked by ` +
        formatCountMap(lastAdmissionBlockReasons),
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

function formatCountMap(counts: Record<string, number>): string {
  return Object.entries(counts)
    .filter(([, count]) => count > 0)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([code, count]) => `${code}=${count}`)
    .join(", ");
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
  opts: OrchestrationHealthProjectionOptions,
): Promise<OrchestrationReadyItemBlockerProjection> {
  const rows = (await readBacklogQueueRows(adapter, teamId)).filter((row) => row.readiness_state === "ready");
  const blockedDependencyItemIds = new Set<string>();
  for (const ids of dependencyImpact.values()) for (const id of ids) blockedDependencyItemIds.add(id);
  const agentRuntimes = await readAgentRuntimeMap(adapter, rows.map((row) => row.to_agent).filter((name): name is string => !!name));
  const duplicateDispatchOutcomes = await getDispatchOutcomesByPhid(
    adapter,
    rows
      .filter((row) => row.last_dispatch_phid && row.retry_safe !== 1)
      .map((row) => row.last_dispatch_phid)
      .filter((phid): phid is string => !!phid),
  );
  const minReadyFuel = Math.max(0, Math.floor(opts.minReadyFuel ?? loadContinuousOrchestrationConfig().min_ready_fuel));
  const admissibleNow = opts.readyAdmission?.admissibleNow ?? null;

  const categories = new Map<string, {
    code: string;
    category: string;
    count: number;
    examples: string[];
    owner_lane: string;
    reason: string;
    recommended_action: string;
  }>();
  const details: OrchestrationReadyItemBlockerDetail[] = [];
  let actionable = 0;
  const add = (blocker: ReadyAdmissionBlocker, itemId: string) => {
    const key = `${blocker.category}:${blocker.code}`;
    const current = categories.get(key) ?? { ...blocker, count: 0, examples: [] };
    current.count += 1;
    if (current.examples.length < 5) current.examples.push(itemId);
    categories.set(key, current);
  };

  for (const row of rows) {
    const blocker = classifyReadyAdmissionBlocker(row, blockedDependencyItemIds, agentRuntimes);
    if (blocker) {
      add(blocker, row.item_id);
      details.push(readyItemBlockerDetail(row, blocker, duplicateDispatchOutcomes));
    } else {
      actionable += 1;
    }
  }

  const categoryValues = [...categories.values()].sort(sortBlockerCounts);
  const staleReadyFuel = staleReadyFuelProjection({
    ready: rows.length,
    actionable,
    minReadyFuel,
    admissibleNow,
    categories: categoryValues,
    readyAdmission: opts.readyAdmission,
  });

  return {
    ready: rows.length,
    actionable,
    min_ready_fuel: minReadyFuel,
    admissible_now: admissibleNow,
    stale_ready_floor: staleReadyFuel.active,
    stale_ready_fuel: staleReadyFuel,
    categories: categoryValues,
    items: details.sort((a, b) => a.item_id.localeCompare(b.item_id)),
  };
}

function readyItemBlockerDetail(
  row: BacklogQueueRow,
  blocker: ReadyAdmissionBlocker,
  duplicateDispatchOutcomes: Awaited<ReturnType<typeof getDispatchOutcomesByPhid>>,
): OrchestrationReadyItemBlockerDetail {
  const outcome = row.last_dispatch_phid ? duplicateDispatchOutcomes.get(row.last_dispatch_phid) : undefined;
  const duplicateDisposition = blocker.code === "duplicate_dispatch_retry_required"
    ? classifyDuplicateDispatchRetryDisposition(outcome)
    : null;
  return {
    item_id: row.item_id,
    title: row.title,
    code: blocker.code,
    category: blocker.category,
    owner_lane: blocker.owner_lane,
    reason: duplicateDisposition?.reason ?? blocker.reason,
    recommended_action: duplicateDisposition
      ? duplicateDispatchRecommendedAction(duplicateDisposition.operator_disposition)
      : blocker.recommended_action,
    prior_dispatch_id: row.last_dispatch_phid,
    prior_dispatch_status: outcome?.status ?? null,
    prior_recovery_status: outcome?.recovery_status ?? null,
    retry_safe_required: blocker.code === "duplicate_dispatch_retry_required",
    retry_safe_recommendation: duplicateDisposition?.retry_safe_recommendation ?? null,
    operator_disposition: duplicateDisposition?.operator_disposition ?? null,
    recommended_disposition: duplicateDisposition?.recommended_disposition ?? null,
    stale_duplicate_closeout_receipt_exists: !!row.stale_duplicate_closeout_receipt_json,
  };
}

function duplicateDispatchRecommendedAction(disposition: DuplicateDispatchRetryOperatorDisposition): string {
  if (disposition === "close") {
    return "close or supersede the stale duplicate row; do not mark it retry-safe";
  }
  if (disposition === "retry") {
    return "mark retry_safe only when the operator wants a bounded refire";
  }
  return "hold the row and wait for the prior dispatch, or supersede it after operator review";
}

function staleReadyFuelProjection(input: {
  ready: number;
  actionable: number;
  minReadyFuel: number;
  admissibleNow: number | null;
  categories: Array<{
    code: string;
    category: string;
    count: number;
    examples: string[];
  }>;
  readyAdmission?: OrchestrationHealthProjectionOptions["readyAdmission"];
}): OrchestrationReadyItemBlockerProjection["stale_ready_fuel"] {
  const belowActionableFloor = input.actionable < input.minReadyFuel;
  const zeroAdmissible = input.admissibleNow === 0 && input.ready > 0;
  const active = input.ready > 0 && (belowActionableFloor || zeroAdmissible);
  const counts = staleReadyFuelCounts(input);
  const examples = uniqueStrings(counts.flatMap((count) => count.examples)).slice(0, 5);
  const reasonParts: string[] = [];
  if (belowActionableFloor) {
    reasonParts.push(`actionable_ready=${input.actionable} is below min_ready_fuel=${input.minReadyFuel}`);
  }
  if (zeroAdmissible) {
    reasonParts.push("admissible_now=0");
  }

  return {
    active,
    owner_lane: "orchestration",
    recommended_action: active
      ? "clear the top ready-admission blockers or promote/refuel safe backlog candidates until ready fuel is admissible"
      : "none",
    reason: active ? reasonParts.join("; ") : null,
    counts_by_blocker_class: counts,
    examples,
  };
}

function staleReadyFuelCounts(input: {
  categories: Array<{
    code: string;
    category: string;
    count: number;
    examples: string[];
  }>;
  readyAdmission?: OrchestrationHealthProjectionOptions["readyAdmission"];
}): OrchestrationReadyItemBlockerProjection["stale_ready_fuel"]["counts_by_blocker_class"] {
  if (!input.readyAdmission) {
    return input.categories.map((category) => ({
      code: category.code,
      category: category.category,
      count: category.count,
      examples: category.examples,
    }));
  }

  const examplesByCode = new Map<string, string[]>();
  for (const row of input.readyAdmission.nonAdmitted) {
    if (!row.item_id || !row.code) continue;
    const examples = examplesByCode.get(row.code) ?? [];
    if (examples.length < 5) examples.push(row.item_id);
    examplesByCode.set(row.code, examples);
  }

  return input.readyAdmission.blockerCounts
    .filter((count) => count.count > 0)
    .map((count) => ({
      code: count.code,
      category: count.category,
      count: count.count,
      examples: examplesByCode.get(count.code) ?? [],
    }))
    .sort(sortBlockerCounts);
}

function sortBlockerCounts(
  a: { count: number; category: string; code: string },
  b: { count: number; category: string; code: string },
): number {
  return b.count - a.count || a.category.localeCompare(b.category) || a.code.localeCompare(b.code);
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.trim() !== ""))];
}

async function readBuildReadyFloorProjection(
  adapter: DbAdapter,
  teamId: string,
): Promise<OrchestrationBuildReadyFloorProjection> {
  const config = loadContinuousOrchestrationConfig();
  const [backlogRows, persistedAdmissionBlockReasons] = await Promise.all([
    readBacklogQueueRows(adapter, teamId),
    readPersistedAdmissionBlockReasonCounts(adapter, teamId),
  ]);
  const readyRows = backlogRows
    .filter((row) => row.readiness_state === "ready" && row.risk_class === "build");
  const laneCounts = new Map<string, number>();
  const blockerReasons: Record<string, number> = {};
  let usefulReadyCount = 0;

  for (const row of readyRows) {
    if (row.last_dispatch_phid && row.retry_safe !== 1) {
      blockerReasons.duplicate_dispatch_retry_required =
        (blockerReasons.duplicate_dispatch_retry_required ?? 0) + 1;
      continue;
    }
    usefulReadyCount += 1;
    const lane = laneKeyOf(backlogQueueRowToLaneItem(row));
    laneCounts.set(lane, (laneCounts.get(lane) ?? 0) + 1);
  }
  for (const [code, count] of Object.entries(persistedAdmissionBlockReasons)) {
    if (
      count > 0 &&
      (
        code === "duplicate_dispatch_retry_required" ||
        code === "single_writer_lane_busy" ||
        code === "pool_capacity_full" ||
        code === "no_free_pool_builder"
      )
    ) {
      blockerReasons[code] = (blockerReasons[code] ?? 0) + count;
    }
  }

  const candidateLanes = [...laneCounts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([lane]) => lane);
  const buildReadyLanes = candidateLanes.length;
  const belowFloor = usefulReadyCount < config.auto_promote_floor;
  const belowLanes = buildReadyLanes < config.auto_promote_min_lanes;
  const blockerCode = belowLanes
    ? "build_ready_lane_diversity_below_min_lanes"
    : belowFloor
      ? "build_ready_below_floor"
      : null;
  if (belowLanes) blockerReasons.build_ready_lane_diversity_below_min_lanes = 1;
  if (belowFloor) blockerReasons.build_ready_below_floor = 1;

  return {
    blocked: blockerCode !== null,
    blocker_code: blockerCode,
    useful_ready_count: usefulReadyCount,
    floor: config.auto_promote_floor,
    build_ready_lanes: buildReadyLanes,
    min_lanes: config.auto_promote_min_lanes,
    candidate_lanes: candidateLanes,
    blocker_reasons: blockerReasons,
    next_action: blockerCode
      ? `auto-promote or flesh build work in a new lane until build ready lanes reach ${buildReadyLanes}/${config.auto_promote_min_lanes} and ready fuel reaches ${usefulReadyCount}/${config.auto_promote_floor}`
      : "build-ready fuel satisfies floor and lane diversity",
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
  const agentRuntimes = await readAgentRuntimeMap(adapter, readyRows.map((row) => row.to_agent).filter((name): name is string => !!name));

  const actionableReady = readyRows.filter((row) =>
    classifyReadyAdmissionBlocker(row, blockedDependencyItemIds, agentRuntimes) == null
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
    `SELECT item_id, title, readiness_state, risk_class, to_agent, provider, runtime,
            dispatch_body, write_scope_json, dependencies_json, last_dispatch_phid, retry_safe,
            stale_duplicate_closeout_receipt_json
       FROM orchestration_backlog_item
      WHERE team_id = ?
        AND readiness_state NOT IN ('done', 'cancelled', 'superseded')`,
    [teamId],
  );
  return rows;
}

function backlogQueueRowToLaneItem(row: BacklogQueueRow): BacklogItem {
  return { write_scope: parseStringArray(row.write_scope_json) } as BacklogItem;
}

async function readReadyAdmissionBlockReasonCounts(adapter: DbAdapter, teamId: string): Promise<Record<string, number>> {
  const rows = (await readBacklogQueueRows(adapter, teamId)).filter((row) => row.readiness_state === "ready");
  const agentRuntimes = await readAgentRuntimeMap(adapter, rows.map((row) => row.to_agent).filter((name): name is string => !!name));
  const counts: Record<string, number> = {};
  for (const row of rows) {
    const blocker = classifyReadyAdmissionBlocker(row, new Set(), agentRuntimes);
    if (!blocker) continue;
    counts[blocker.code] = (counts[blocker.code] ?? 0) + 1;
  }
  return counts;
}

async function readPersistedAdmissionBlockReasonCounts(adapter: DbAdapter, teamId: string): Promise<Record<string, number>> {
  const { rows } = await adapter.query<{ last_admission_block_reasons_json: string | null }>(
    `SELECT last_admission_block_reasons_json
       FROM orchestration_state
      WHERE team_id = ?
      LIMIT 1`,
    [teamId],
  );
  return parseCountMap(rows[0]?.last_admission_block_reasons_json ?? null);
}

async function readAgentRuntimeMap(adapter: DbAdapter, names: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const unique = [...new Set(names.filter((name) => name.trim() !== ""))];
  if (unique.length === 0) return out;
  const placeholders = unique.map((_, i) => `$${i + 1}`).join(",");
  const { rows } = await adapter.query<{ name: string; runtime: string | null; running_rank: number }>(
    `SELECT name, runtime, CASE WHEN status = 'running' AND deleted_at IS NULL THEN 0 ELSE 1 END AS running_rank
       FROM agents
      WHERE name IN (${placeholders}) AND deleted_at IS NULL
      ORDER BY running_rank ASC, name ASC`,
    unique,
  );
  for (const row of rows) {
    if (row.runtime && !out.has(row.name)) out.set(row.name, row.runtime);
  }
  return out;
}

interface ReadyAdmissionBlocker {
  code: string;
  category: string;
  owner_lane: string;
  reason: string;
  recommended_action: string;
}

function classifyReadyAdmissionBlocker(
  row: BacklogQueueRow,
  blockedDependencyItemIds: Set<string>,
  agentRuntimes: Map<string, string>,
): ReadyAdmissionBlocker | null {
  if (!hasDispatchPayload(row)) {
    return {
      code: "missing_dispatch_target",
      category: "dispatch_admission",
      owner_lane: "orchestration",
      reason: "ready row is missing a target agent or dispatch body",
      recommended_action: "repair ready metadata before admission can launch the item",
    };
  }
  if (row.last_dispatch_phid && row.retry_safe !== 1) {
    return {
      code: "duplicate_dispatch_retry_required",
      category: "retry_safety",
      owner_lane: "orchestration",
      reason: "ready row is still linked to a prior dispatch and has not been marked retry-safe",
      recommended_action: "mark the item retry-safe or create an explicit retry before readmitting it",
    };
  }
  if (!isAutoRunRisk(row.risk_class)) {
    return {
      code: "risk_requires_approval",
      category: "lane_eligibility",
      owner_lane: "chris",
      reason: "ready row has a risk class that cannot auto-run",
      recommended_action: "review and approve the item or lower the risk class before admission",
    };
  }
  if (parseStringArray(row.dependencies_json).length > 0 || blockedDependencyItemIds.has(row.item_id)) {
    return {
      code: "blocked_dependency",
      category: "lane_eligibility",
      owner_lane: "orchestration",
      reason: "ready row still has unresolved backlog dependencies",
      recommended_action: "land, clear, or supersede the dependency before admission",
    };
  }
  if (hasProviderRuntimeMismatch(row, agentRuntimes.get(row.to_agent ?? ""))) {
    return {
      code: "provider_runtime_mismatch",
      category: "runtime_unavailable",
      owner_lane: "fleet-ops",
      reason: "ready row requests a provider/runtime the target agent is not running",
      recommended_action: "route to a compatible agent or update the requested provider/runtime",
    };
  }
  return null;
}

function hasProviderRuntimeMismatch(row: BacklogQueueRow, targetRuntime: string | undefined): boolean {
  if (!row.provider && !row.runtime) return false;
  const requestedRuntime = row.runtime ? normalizeRuntime(row.runtime) : null;
  const requestedProvider = row.provider ?? (requestedRuntime ? resolveProviderFromRuntime(requestedRuntime) : null);
  const providerFromRequestedRuntime = requestedRuntime ? resolveProviderFromRuntime(requestedRuntime) : null;
  if (row.provider && requestedRuntime && row.provider !== providerFromRequestedRuntime) return true;
  if (!requestedRuntime || !targetRuntime) return false;
  const normalizedTargetRuntime = normalizeRuntime(targetRuntime);
  return requestedRuntime !== normalizedTargetRuntime || requestedProvider !== resolveProviderFromRuntime(normalizedTargetRuntime);
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
  else if (isHistoricalLinkedQueryFailure(routeStatus)) counts.failed += 1;
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

function isHistoricalLinkedQueryFailure(routeStatus: ParsedRouteStatus): boolean {
  const text = [
    routeStatus.route_kind,
    routeStatus.visible_state,
    routeStatus.skipped,
    routeStatus.failure_detail,
  ]
    .filter((x): x is string => typeof x === "string" && x.trim() !== "")
    .join(" ")
    .toLowerCase();
  return text.includes("linked query terminated expired") ||
    (text.includes("linked") && text.includes("query") && text.includes("failed"));
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
  visible_state: string | null;
  routed: boolean;
  retryable: boolean;
  target_agent: string | null;
  skipped: string | null;
  error: string | null;
  failure_detail: string | null;
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
    visible_state: typeof v.visible_state === "string" ? v.visible_state : null,
    routed: v.routed === true,
    retryable: v.retryable === true,
    target_agent: typeof v.target_agent === "string" ? v.target_agent : null,
    skipped: typeof v.skipped === "string" ? v.skipped : null,
    error: typeof v.error === "string" && v.error.trim() !== "" ? v.error : null,
    failure_detail: typeof v.failure_detail === "string" && v.failure_detail.trim() !== "" ? v.failure_detail : null,
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
