// Continuous Orchestration — the daemon runtime.
//
// Wires the pure guardrail core (selection + cadence + admission + stall) to the
// manager I/O: the usage gate, in-flight counts, the dispatch enqueue API, the
// backlog store, the decision log, and the Telegram alert channel.
//
// Safety posture (Chris's requirement): DISABLED by default + DRY-RUN-first. In
// dry-run the tick computes + logs exactly what it WOULD fire and fires nothing.
// Two loud Telegram alerts: daily-ceiling auto-pause, and the overnight-drain
// STALL alert. An emergency kill-switch file halts before any admission.

import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import type { DbAdapter } from "../db/db-adapter.js";
import type { ContinuousOrchestrationConfig } from "./config.js";
import type { BacklogItem, DecisionRecord, OrchestrationMode, ReadinessState, UsageGateView } from "./types.js";
import { fairInterleaveByLane, isUsefulReadyFuelItem, laneKeyOf, needsRefuel, orderCandidates } from "./selection.js";
import { tickAdmitLimit } from "./cadence.js";
import {
  planAdmission,
  evaluateStall,
  providerRuntimeMismatch,
  shouldRunZeroAdmitStallWatchdog,
  type AdmissionContext,
} from "./admission.js";
import { computeNextDelay, tickWriteCaps } from "./backpressure.js";
import {
  appendDecisions,
  bindItemForFire,
  getDispatchOutcomesByPhid,
  getDispatchStatusesByPhid,
  getOrchestrationState,
  listBacklogByState,
  listDependencyResolution,
  listReadyItems,
  promoteToReady,
  recordTickOutcome,
  repairReadyCodexRuntimeMetadata,
  reconcileStaleAlreadyDispatchedReadyRows,
  setItemState,
  setMode,
  updateBacklogFields,
  type ReadyRuntimeRepair,
  type StaleReadyReconcileResult,
  type DispatchOutcome,
} from "./storage.js";
import { deriveBacklogRetryReadiness } from "./backlog-retry-readiness.js";
import { duplicateDispatchRetryReceipt } from "./duplicate-dispatch-retry-receipt.js";
import { promotionCompletedAndVerified } from "../dispatch-scheduler/read-model.js";
import { runFleshPass, type FleshRunSummary } from "./flesh-runner.js";
import { AUTO_READY_CONFIDENCE_THRESHOLD } from "./flesh-policy.js";
import { autoPromoteRejections, selectAutoPromotions } from "./auto-promote-policy.js";
import { sendTelegramAlert, type AlertSender } from "./telegram.js";
import { readOrchestrationHealthProjection } from "./health-projection.js";
import {
  readWorkShareDirectiveDrift,
  type WorkShareDirectiveDrift,
} from "../model-policy/work-share-drift.js";
import { readRuntimeMixDrift, type RuntimeMixDrift } from "../model-policy/runtime-mix-drift.js";
import { readDiskHeadroom, type DiskHeadroom } from "../disk-health.js";

/** Dispatch/effective statuses that mean the work is finished — its write-scope
 *  lock can be released. Mirrors dispatch terminal states plus recovery moot. */
const TERMINAL_DISPATCH_STATUSES = new Set(["done", "failed", "failed_needs_operator", "cancelled", "moot"]);
const TERMINAL_DUPLICATE_READY_STATUSES = new Set(["done", "cancelled", "moot", "superseded"]);
export const AUTO_PROMOTE_HEALTH_STALE_ALREADY_DISPATCHED_STATUSES = new Set([
  "done",
  "cancelled",
  "moot",
  "failed_needs_operator",
]);
const INCIDENT_ALERT_COOLDOWN_MS = 60 * 60 * 1000;

type OrchestrationIncidentKind =
  | "stall"
  | "model_policy_drift"
  | "target_unhealthy_ready_blocked"
  | "zero_admit_ready_blocked";

interface AlertIncidentState {
  kind: OrchestrationIncidentKind;
  cause: string;
  recovery_message: string;
  opened_at_ms: number;
  last_alert_at_ms: number;
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => stableJson(v)).join(",")}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableJson(obj[k])}`)
    .join(",")}}`;
}

function incidentKey(kind: OrchestrationIncidentKind, cause: string): string {
  return `${kind}:${crypto.createHash("sha256").update(cause).digest("hex")}`;
}

function formatIncidentKind(kind: OrchestrationIncidentKind): string {
  switch (kind) {
    case "stall":
      return "STALL";
    case "model_policy_drift":
      return "model-policy drift";
    case "target_unhealthy_ready_blocked":
      return "target-unhealthy ready-blocked";
    case "zero_admit_ready_blocked":
      return "zero-admit ready-blocked";
  }
}

/** A pool an item routes to (resolved from its track). */
export interface ResolvedPool {
  pool_id: string;
  repo_root: string;
  max_parallel: number;
  members: string[];
}

/** A late-bound worktree lease for one build. */
export interface BuildWorktree {
  /** Distinct write_scope for the in-flight build (the worktree path). */
  path: string;
  /** Branch the builder pushes; the merge-queue serializes its merge. */
  branch: string;
  lease_id: string | null;
}

/** Stage-C routing seam. Factory wires it to BuildPoolRegistry + selectBuilder +
 *  allocateWorktree; tests inject a deterministic fake. */
export interface PoolRouting {
  /** Resolve the pool for an item (by track), or null for non-pool items. */
  poolForItem: (item: BacklogItem) => ResolvedPool | null;
  /** Pool members available to take work (members minus `building`, online/healthy), in preference order. */
  availableBuilders: (pool: ResolvedPool, building: Set<string>) => string[];
  /** Resolve a same-pool healthy target for an unhealthy explicitly targeted row. */
  healthyEquivalentTarget?: (input: {
    item: BacklogItem;
    unhealthyTarget: string;
    healthyAgents: Set<string>;
    busyAgents: Set<string>;
    targetAgentRuntimes?: Map<string, string>;
  }) => { pool: ResolvedPool; target: string; candidates: string[] } | null;
  /** Allocate a distinct worktree for one build off the pool repo. */
  allocateWorktree: (input: { agent: string; item: BacklogItem; pool: ResolvedPool }) => Promise<BuildWorktree>;
}

interface PoolLaneBlocker {
  agent: string;
  code: string;
  reason: string;
}

function isVirtualPoolTarget(agent: string): boolean {
  return agent.trim().toLowerCase().startsWith("pool:");
}

export interface DaemonDeps {
  adapter: DbAdapter;
  config: ContinuousOrchestrationConfig;
  /** Fire a dispatch through the manager API. */
  enqueue: (item: BacklogItem) => Promise<{ dispatch_phid: string; query_id: string }>;
  /** Read the live usage gate + today's weighted-token consumption. */
  readUsage: () => Promise<{ view: UsageGateView; daily_tokens_used: number }>;
  /** Read current in-flight count + the write scopes those dispatches hold. */
  readInFlight: () => Promise<{ count: number; active_write_scopes: Set<string> }>;
  /**
   * Resolve raw dispatch status by phid (NO team filter — phids are global).
   * Used by the in-flight reconciler to release the write-scope lock once a
   * fired dispatch reaches a terminal state. Optional so legacy boot/test paths
   * mount unchanged (reconciliation is then skipped, except the reaper's
   * unresolvable-stale net which needs no resolver).
   */
  resolveDispatchStates?: (phids: string[]) => Promise<Map<string, string>>;
  /**
   * RD-014: resolve which of the given agent names are currently
   * healthy/running. Optional so legacy boot/test paths mount unchanged
   * (health gating is then skipped, matching pre-RD-014 behavior) — a
   * missing resolver is a degraded-but-safe default, not a silent gap,
   * since the daemon still admits (it just can't tell healthy from not).
   */
  resolveAgentHealth?: (names: string[]) => Promise<Set<string>>;
  /** Resolve registered runtime by agent name so admission can diagnose provider/runtime lane mismatches. */
  resolveAgentRuntimes?: (names: string[]) => Promise<Map<string, string>>;
  /**
   * Build-pool routing (Stage C). When provided, an admitted item that resolves
   * to a pool late-binds its builder + worktree at FIRE time: the daemon spills
   * across pool members and each in-flight build gets a DISTINCT worktree
   * write_scope, so N builders build the same repo concurrently (admission gates
   * on pool capacity + a free member, not the repo-scope single-writer lock).
   * Omitted → legacy single-lane behavior (existing boot/tests unchanged).
   */
  pools?: PoolRouting;
  alert?: AlertSender;
  /** Emit a manager/news event so fleet-visible daemon blockages do not stay silent. */
  emitNews?: (event: { type: string; message: string; data?: Record<string, unknown> }) => Promise<void>;
  /** Absolute path to configs/model-policy.json for the directive drift guard. */
  modelPolicyPath?: string;
  /** Absolute path to generated runtime-mode config for desired-vs-actual mix drift. */
  runtimeModePath?: string | null;
  /** Tolerance for desired-vs-actual provider-share drift. */
  runtimeMixTolerance?: number;
  /** Test seam for the directive drift guard. */
  readModelPolicyDirectiveDrift?: () => WorkShareDirectiveDrift;
  /** Test seam for runtime/model mix drift. */
  readRuntimeMixDrift?: () => RuntimeMixDrift | Promise<RuntimeMixDrift>;
  /** Live agent runtime telemetry, usually sourced from the agents table. */
  resolveAllAgentRuntimes?: () => Promise<Map<string, string>>;
  /** Test seam for disk-pressure admission gating. */
  readDiskHeadroom?: () => DiskHeadroom | Promise<DiskHeadroom>;
  now?: () => number;
  /** Override the kill-switch check (defaults to fs existence of the file). */
  killSwitchActive?: () => boolean;
  teamId?: string;
  env?: NodeJS.ProcessEnv;
}

export interface TickResult {
  tick_id: string;
  now: string;
  mode: OrchestrationMode;
  dry_run: boolean;
  halted: string | null;
  candidates: number;
  admitted: Array<{ item_id: string; dispatch_phid: string | null }>;
  /** In-flight items whose lock was released this tick (completion + reaper). */
  reconciled: number;
  /** Ready rows closed/superseded because their prior dispatch already reached a safe terminal state. */
  stale_ready_reconciled: StaleReadyReconcileResult;
  skipped: number;
  zero_ticks: number;
  stall_alert: boolean;
  auto_paused: { reason: string } | null;
  /** Auto-flesh refuel summary, when a refuel pass ran this tick. */
  refuel: FleshRunSummary | null;
  /** Floor-triggered auto-promote summary, when an auto-promote pass ran. */
  auto_promote: AutoPromoteRunSummary | null;
  /** Ready rows whose stale provider/runtime metadata was corrected before admission. */
  ready_runtime_repairs: ReadyRuntimeRepair[];
  /** Per-tick model-policy directive drift guard outcome. */
  model_policy_drift: WorkShareDirectiveDrift;
  decisions: DecisionRecord[];
}

export interface ReadyAdmissionExplanation {
  candidates: number;
  useful_ready: number;
  admissible_now: number;
  lanes: {
    raw_ready: number;
    useful_ready: number;
    admissible_now: number;
    by_lane: Array<{ lane: string; raw_ready: number; useful_ready: number; admissible_now: number; blocked: number }>;
  };
  block_reason_counts: ReadyAdmissionBlockReasonCounts;
  top_block_reasons: Array<{ code: string; category: ReadyAdmissionBlockerCategory; count: number }>;
  blocked_lanes: ReadyAdmissionBlockedLane[];
  target_unhealthy_groups: ReadyAdmissionTargetUnhealthyGroup[];
  recommended_action: string;
  admissible: Array<{ item_id: string; title: string; to_agent: string | null; risk_class: string }>;
  non_admitted: Array<{
    item_id: string;
    title: string;
    to_agent: string | null;
    risk_class: string;
    action: "skipped" | "held";
    code: string;
    reason: string;
    metadata?: Record<string, unknown>;
    target_unhealthy_receipt?: ReadyAdmissionTargetUnhealthyReceipt;
  }>;
  blocker_counts: Array<{ code: string; category: ReadyAdmissionBlockerCategory; count: number }>;
  operator_blockers: Array<{
    code: string;
    category: ReadyAdmissionBlockerCategory;
    count: number;
    examples: string[];
    targets: string[];
    next_action: string;
  }>;
  stale_ready_floor: {
    stale: boolean;
    ready: number;
    admissible: number;
    min_ready_fuel: number;
    reason: string | null;
  };
  halted: string | null;
  ready_runtime_repairs: ReadyRuntimeRepair[];
  disk_headroom: DiskHeadroom | null;
}

export interface ReadyAdmissionTargetUnhealthyReceipt {
  code: "target_unhealthy";
  target: string;
  prior_owner: string | null;
  proposed_healthy_target: string | null;
  hold_reason: string | null;
  prior_dispatch_evidence: {
    last_dispatch_phid: string | null;
    status: string | null;
    recovery_status: string | null;
    retry_safe: boolean;
  };
  safe_action: "reroute_downclassify_or_owner_restart";
  safe_action_summary: string;
  counts_as_useful_build_fuel: false;
}

export interface ReadyAdmissionTargetUnhealthyGroup {
  target: string;
  lane: string;
  count: number;
  proposed_healthy_target: string | null;
  examples: Array<{
    item_id: string;
    title: string;
    prior_owner: string | null;
    risk_class: string;
  }>;
  recommended_action: string;
}

export interface ReadyAdmissionBlockedLane {
  lane: string;
  count: number;
  blocker_counts: Array<{ code: string; category: ReadyAdmissionBlockerCategory; count: number }>;
}

interface ZeroAdmitReadyBlockedIncident {
  cause: string;
  message: string;
  recommended_action: string;
  blocker_counts: ReadyAdmissionExplanation["blocker_counts"];
  no_in_flight_slots: number;
  duplicate_dispatch_retry_required: number;
}

export const READY_ADMISSION_BLOCK_REASONS = [
  "no_in_flight_slots",
  "tick_admission_cap",
  "blocked_dependency",
  "risk_requires_approval",
  "pool_capacity_full",
  "single_writer_lane_busy",
  "no_free_pool_builder",
  "target_unhealthy",
  "duplicate_dispatch_retry_required",
] as const;

export type ReadyAdmissionBlockReason = typeof READY_ADMISSION_BLOCK_REASONS[number];
export type ReadyAdmissionBlockReasonCounts = Record<ReadyAdmissionBlockReason, number>;

export type ReadyAdmissionBlockerCategory =
  | "usage_gate"
  | "capacity_gate"
  | "lane_eligibility"
  | "runtime_unavailable"
  | "infra_resource"
  | "retry_safety"
  | "dispatch_admission"
  | "route_sync"
  | "stale_ready_floor";

export interface AutoPromoteHealth {
  enabled: boolean;
  blocked_reason: string | null;
  min_ready_fuel: number;
  floor: number;
  min_ready_lanes: number;
  lanes: {
    build_ready: number;
    build_ready_lanes: number;
    build_in_flight: number;
    ready_plus_in_flight: number;
    capacity_occupied: boolean;
    ready_lane_keys: string[];
    in_flight_lane_keys: string[];
    candidate_lane_keys: string[];
  };
  below_floor: boolean;
  below_lanes: boolean;
  triggered: boolean;
  candidates_considered: number;
  candidates: Array<{
    item_id: string;
    title: string;
    lane: string;
    risk_class: string;
    to_agent: string | null;
    flesh_confidence: number | null;
  }>;
  promoted_count: number;
  promoted_items: Array<{ item_id: string; title: string; lane: string }>;
  skipped_count: number;
  skipped_items: AutoPromoteHealthSkippedItem[];
  top_skip_reasons: Array<{ reason: string; count: number }>;
  blocker_class_counts: AutoPromoteBlockerClassCount[];
  next_action: AutoPromoteNextAction;
  operator_summary: AutoPromoteOperatorSummary;
  empty_pipe_alert: AutoPromoteEmptyPipeAlert;
  ready_runtime_repairs: ReadyRuntimeRepair[];
  summary: string;
}

export interface AutoPromoteOperatorSummary {
  schema_version: "orchestration.auto_promote_operator_summary.v1";
  retryable_failed_rows: number;
  stale_duplicate_rows: number;
  waiting_on_live_dispatch_rows: number;
  non_retryable_failed_rows: number;
  confidence_held_rows: number;
  duplicate_dispatch_retry_required_examples: Array<{
    item_id: string;
    prior_dispatch_phid: string;
    retry_readiness_status: string;
  }>;
  capacity_gated: boolean;
  lane_diversity_topoff_needed: boolean;
  lane_diversity_deficit: number;
  safe_actions: string[];
  empty_fuel: boolean;
  summary: string;
}

export type AutoPromoteBlockerClass =
  | "already_dispatched"
  | "review_held_risk"
  | "blocked_dependencies"
  | "confidence_threshold"
  | "not_fleshed"
  | "missing_lane"
  | "wrong_state"
  | "other";

export interface AutoPromoteBlockerClassCount {
  class: AutoPromoteBlockerClass;
  count: number;
  label: string;
}

export interface AutoPromoteNextAction {
  code:
    | "none"
    | "wait_for_capacity"
    | "close_stale_already_dispatched_rows"
    | "manual_promote_safe_retries"
    | "manual_promote_or_close_already_dispatched"
    | "approve_review_held_risk"
    | "resolve_blocked_dependencies"
    | "raise_candidate_confidence"
    | "flesh_or_refuel_candidates"
    | "author_lane_diverse_rows";
  summary: string;
}

export interface AutoPromoteHealthSkippedItem {
  item_id: string;
  reasons: string[];
  prior_dispatch_phid?: string;
  prior_dispatch_status?: string | null;
}

export interface AutoPromoteEmptyPipeAlertItem {
  item_id: string;
  blocker_classes: AutoPromoteBlockerClass[];
  next_actions: string[];
  reasons: string[];
}

export interface AutoPromoteEmptyPipeAlert {
  active: boolean;
  ready: number;
  admissible_now: number;
  reason: string | null;
  message: string | null;
  items: AutoPromoteEmptyPipeAlertItem[];
}

/** Outcome of one floor-triggered auto-promote pass. */
export interface AutoPromoteRunSummary {
  /** True when build-ready fuel/lanes were below floor and a top-up ran. */
  triggered: boolean;
  /** Items promoted needs_review -> ready this pass. */
  promoted: number;
  /** Safe-gate rejections among the needs_review candidates. */
  skipped: number;
  /** Needs-review candidates evaluated by the safety gate. */
  candidates_considered: number;
  /** Most frequent safety-gate skip reasons in this pass. */
  top_skip_reasons: Array<{ reason: string; count: number }>;
  /** Safety-gate rejections grouped into operator-actionable classes. */
  blocker_class_counts: AutoPromoteBlockerClassCount[];
  /** Highest-leverage next operator move for this pass. */
  next_action: AutoPromoteNextAction;
  /** Exact safety-gate reasons for every skipped candidate. */
  skipped_items: Array<{ item_id: string; reasons: string[] }>;
  /** Build-ready total/lanes before the pass. */
  before: { build_ready: number; build_lanes: number };
  dry_run: boolean;
}

function readyAdmissionBlockerCategory(code: string): ReadyAdmissionBlockerCategory {
  switch (code) {
    case "daily_token_ceiling":
      return "usage_gate";
    case "disk_warning_floor":
    case "disk_critical_floor":
      return "infra_resource";
    case "no_in_flight_slots":
    case "tick_admission_cap":
    case "pool_capacity_full":
    case "no_free_pool_builder":
      return "capacity_gate";
    case "risk_requires_approval":
    case "broken_dependency":
    case "blocked_dependency":
    case "single_writer_lane_busy":
      return "lane_eligibility";
    case "target_unhealthy":
    case "provider_runtime_mismatch":
      return "runtime_unavailable";
    case "duplicate_dispatch_guard":
    case "duplicate_dispatch_retry_required":
      return "retry_safety";
    case "missing_dispatch_target":
      return "dispatch_admission";
    case "clarification_blocker":
    case "promotion_blocker":
      return "route_sync";
    default:
      return "stale_ready_floor";
  }
}

function readyAdmissionBlockerCounts(plan: { skipped: DecisionRecord[] }): ReadyAdmissionExplanation["blocker_counts"] {
  const counts = new Map<string, { code: string; category: ReadyAdmissionBlockerCategory; count: number }>();
  for (const decision of plan.skipped) {
    const code = typeof decision.metadata?.code === "string" ? decision.metadata.code : "unknown";
    const category = readyAdmissionBlockerCategory(code);
    const key = `${category}:${code}`;
    const existing = counts.get(key);
    if (existing) existing.count += 1;
    else counts.set(key, { code, category, count: 1 });
  }
  return [...counts.values()].sort((a, b) => b.count - a.count || a.category.localeCompare(b.category) || a.code.localeCompare(b.code));
}

function targetUnhealthyReadyBlockedIncident(input: {
  ready: BacklogItem[];
  plan: { admit: BacklogItem[]; skipped: DecisionRecord[] };
  blockerCounts: ReadyAdmissionExplanation["blocker_counts"];
  zeroTicks: number;
  config: ContinuousOrchestrationConfig;
}): {
  cause: string;
  message: string;
  targets: string[];
  examples: string[];
  targetCount: number;
} | null {
  if (input.ready.length < input.config.min_ready_fuel) return null;
  if (input.plan.admit.length !== 0) return null;
  if (input.zeroTicks < input.config.stall_threshold_ticks) return null;
  const targetCount = input.blockerCounts.find((count) => count.code === "target_unhealthy")?.count ?? 0;
  if (targetCount <= 0) return null;
  const largestOtherBlocker = Math.max(
    0,
    ...input.blockerCounts
      .filter((count) => count.code !== "target_unhealthy")
      .map((count) => count.count),
  );
  if (targetCount < largestOtherBlocker) return null;

  const targetDecisions = input.plan.skipped.filter((decision) => decision.metadata?.code === "target_unhealthy");
  const targets = [...new Set(targetDecisions.flatMap(decisionTargets))].sort((a, b) => a.localeCompare(b));
  const examples = targetDecisions
    .map((decision) => decision.item_id)
    .filter((itemId): itemId is string => !!itemId)
    .slice(0, 5);
  const blockerText = input.blockerCounts
    .filter((count) => count.count > 0)
    .map((count) => `${count.code}=${count.count}`)
    .join(", ");
  const repairText = targets.length > 0
    ? `restore or reroute affected target(s): ${targets.join(", ")}`
    : "restore unhealthy targets or reroute to compatible healthy owners";
  return {
    cause: stableJson({
      code: "ready_fuel_blocked_by_target_unhealthy",
      floor: input.config.min_ready_fuel,
      targets,
      blockers: input.blockerCounts.filter((count) => count.count > 0),
    }),
    message:
      `Continuous orchestration target-unhealthy ready-blocked incident: ready=${input.ready.length} ` +
      `floor=${input.config.min_ready_fuel}, admissible_now=0 for ${input.zeroTicks} consecutive tick(s); ` +
      `${blockerText}. Affected targets: ${targets.join(", ") || "unknown"}. ` +
      `Examples: ${examples.join(", ") || "none"}. Recommended repair: ${repairText}.`,
    targets,
    examples,
    targetCount,
  };
}

function zeroAdmitReadyBlockedIncident(input: {
  ready: BacklogItem[];
  plan: { admit: BacklogItem[] };
  blockerCounts: ReadyAdmissionExplanation["blocker_counts"];
  zeroTicks: number;
  inFlight: number;
  config: ContinuousOrchestrationConfig;
}): ZeroAdmitReadyBlockedIncident | null {
  if (input.zeroTicks < input.config.stall_threshold_ticks) return null;
  if (input.ready.length === 0) return null;
  if (input.plan.admit.length > 0) return null;
  const noInFlightSlots = input.blockerCounts.find((count) => count.code === "no_in_flight_slots")?.count ?? 0;
  if (noInFlightSlots <= 0) return null;

  const duplicateRetryRequired =
    input.blockerCounts.find((count) => count.code === "duplicate_dispatch_retry_required")?.count ?? 0;
  const blockerCounts = input.blockerCounts
    .filter((count) => count.count > 0)
    .sort((a, b) => b.count - a.count || a.category.localeCompare(b.category) || a.code.localeCompare(b.code));
  const recommendedParts = [
    "capacity saturated: wait for in-flight slots to free or close active dispatches; do not add filler ready rows",
  ];
  if (duplicateRetryRequired > 0) {
    recommendedParts.push(
      `review duplicate_dispatch_retry_required=${duplicateRetryRequired} rows and mark retry_safe only for bounded refires or close stale duplicates`,
    );
  }
  const recommendedAction = recommendedParts.join("; ");
  const cause = stableJson({
    ready: input.ready.length,
    in_flight: input.inFlight,
    max_in_flight: input.config.max_in_flight,
    blocker_counts: blockerCounts,
  });

  return {
    cause,
    message:
      `Continuous orchestration zero-admit incident: ${input.zeroTicks} consecutive zero-admit ticks with ` +
      `${input.ready.length} ready item(s), runtime capacity full (${input.inFlight}/${input.config.max_in_flight}), ` +
      `no_in_flight_slots=${noInFlightSlots}. Recommended action: ${recommendedAction}.`,
    recommended_action: recommendedAction,
    blocker_counts: blockerCounts,
    no_in_flight_slots: noInFlightSlots,
    duplicate_dispatch_retry_required: duplicateRetryRequired,
  };
}

function readyAdmissionOperatorBlockers(plan: { skipped: DecisionRecord[] }): ReadyAdmissionExplanation["operator_blockers"] {
  const blockers = new Map<string, ReadyAdmissionExplanation["operator_blockers"][number]>();
  for (const decision of plan.skipped) {
    const code = typeof decision.metadata?.code === "string" ? decision.metadata.code : "unknown";
    const category = readyAdmissionBlockerCategory(code);
    const key = `${category}:${code}`;
    const current = blockers.get(key) ?? {
      code,
      category,
      count: 0,
      examples: [],
      targets: [],
      next_action: readyAdmissionNextAction(code),
    };
    current.count += 1;
    if (decision.item_id && current.examples.length < 5) current.examples.push(decision.item_id);
    for (const target of decisionTargets(decision)) {
      if (current.targets.length < 5 && !current.targets.includes(target)) current.targets.push(target);
    }
    blockers.set(key, current);
  }
  return [...blockers.values()].sort((a, b) => b.count - a.count || a.category.localeCompare(b.category) || a.code.localeCompare(b.code));
}

function decisionTargets(decision: DecisionRecord): string[] {
  const targets: string[] = [];
  if (typeof decision.metadata?.target === "string" && decision.metadata.target.trim()) {
    targets.push(decision.metadata.target.trim());
  }
  const laneBlockers = decision.metadata?.lane_blockers;
  if (Array.isArray(laneBlockers)) {
    for (const blocker of laneBlockers) {
      if (blocker && typeof blocker === "object" && typeof blocker.agent === "string" && blocker.agent.trim()) {
        targets.push(blocker.agent.trim());
      }
    }
  }
  return [...new Set(targets)];
}

function readyAdmissionNextAction(code: string): string {
  switch (code) {
    case "target_unhealthy":
      return "restore the target agent health/heartbeat or route the ready item to a healthy compatible builder";
    case "no_free_pool_builder":
      return "free a pool builder or increase maintained pool capacity before readmitting the item";
    case "pool_capacity_full":
      return "wait for an in-flight pool item to complete or raise pool capacity";
    case "single_writer_lane_busy":
      return "wait for the active writer on the same write scope to finish";
    case "provider_runtime_mismatch":
      return "route to a compatible agent or update the requested provider/runtime";
    case "disk_warning_floor":
      return "free disk headroom or admit only cleanup/deploy-safe work until the warning floor clears";
    case "disk_critical_floor":
      return "free disk headroom with cleanup work before admitting non-cleanup orchestration rows";
    case "duplicate_dispatch_retry_required":
      return "mark the item retry-safe only when the operator wants a bounded refire, otherwise close or supersede it";
    default:
      return "clear this ready-admission blocker before readmitting the item";
  }
}

function readyAdmissionBlockReasonCounts(plan: { skipped: DecisionRecord[] }): ReadyAdmissionBlockReasonCounts {
  const counts = Object.fromEntries(READY_ADMISSION_BLOCK_REASONS.map((code) => [code, 0])) as ReadyAdmissionBlockReasonCounts;
  for (const decision of plan.skipped) {
    const code = decision.metadata?.code;
    if (typeof code === "string" && code in counts) counts[code as ReadyAdmissionBlockReason] += 1;
  }
  return counts;
}

function isNonUsefulReadyBlockerCode(code: unknown): boolean {
  return (
    code === "blocked_dependency" ||
    code === "broken_dependency" ||
    code === "duplicate_dispatch_guard" ||
    code === "duplicate_dispatch_retry_required" ||
    code === "no_free_pool_builder" ||
    code === "provider_runtime_mismatch" ||
    code === "target_unhealthy"
  );
}

function isTerminalDuplicateReadyFuel(
  decision: DecisionRecord,
  duplicateRetryOutcomes: Map<string, DispatchOutcome>,
): boolean {
  if (decision.metadata?.code !== "duplicate_dispatch_retry_required") return false;
  const lastDispatchPhid = typeof decision.metadata.last_dispatch_phid === "string"
    ? decision.metadata.last_dispatch_phid
    : null;
  if (!lastDispatchPhid) return false;
  const outcome = duplicateRetryOutcomes.get(lastDispatchPhid);
  if (!outcome) return false;
  return TERMINAL_DUPLICATE_READY_STATUSES.has(outcome.status) ||
    promotionCompletedAndVerified(outcome.promotion_result_json);
}

function readyAdmissionBlockedLanes(
  plan: { skipped: DecisionRecord[] },
  byId: Map<string, BacklogItem>,
): ReadyAdmissionBlockedLane[] {
  const lanes = new Map<string, ReadyAdmissionBlockedLane>();
  for (const decision of plan.skipped) {
    if (!decision.item_id) continue;
    const item = byId.get(decision.item_id);
    if (!item) continue;
    const lane = laneKeyOf(item);
    const code = typeof decision.metadata?.code === "string" ? decision.metadata.code : "unknown";
    const category = readyAdmissionBlockerCategory(code);
    const current = lanes.get(lane) ?? { lane, count: 0, blocker_counts: [] };
    current.count += 1;
    const existing = current.blocker_counts.find((count) => count.code === code && count.category === category);
    if (existing) existing.count += 1;
    else current.blocker_counts.push({ code, category, count: 1 });
    lanes.set(lane, current);
  }
  return [...lanes.values()]
    .map((lane) => ({
      ...lane,
      blocker_counts: lane.blocker_counts.sort((a, b) =>
        b.count - a.count || a.category.localeCompare(b.category) || a.code.localeCompare(b.code),
      ),
    }))
    .sort((a, b) => b.count - a.count || a.lane.localeCompare(b.lane));
}

function readyAdmissionRecommendedAction(input: {
  candidates: number;
  usefulReady: number;
  admissibleNow: number;
  minReadyFuel: number;
  blockerCounts: ReadyAdmissionExplanation["blocker_counts"];
  blockedLanes: ReadyAdmissionBlockedLane[];
  targetUnhealthyGroups: ReadyAdmissionTargetUnhealthyGroup[];
}): string {
  if (input.candidates === 0) return "flesh or promote ready fuel";
  if (input.usefulReady < input.minReadyFuel) {
    const actions = input.blockerCounts.flatMap((count) => {
      if (count.code === "target_unhealthy") {
        const examples = input.targetUnhealthyGroups.slice(0, 3).map((group) =>
          `target=${group.target} lane=${group.lane} count=${group.count}`,
        );
        const suffix = examples.length > 0 ? ` (${examples.join("; ")})` : "";
        return [`runtime repair for target_unhealthy=${count.count} rows where safe${suffix}`];
      }
      if (count.code === "provider_runtime_mismatch") {
        return [`reroute or update provider_runtime_mismatch=${count.count} rows to match a live runtime`];
      }
      if (count.code === "no_free_pool_builder") {
        const examples = input.blockedLanes
          .filter((lane) => lane.blocker_counts.some((blocker) => blocker.code === "no_free_pool_builder"))
          .slice(0, 3)
          .map((lane) => `lane=${lane.lane} count=${lane.blocker_counts.find((blocker) => blocker.code === "no_free_pool_builder")?.count ?? lane.count}`);
        const suffix = examples.length > 0 ? ` (${examples.join("; ")})` : "";
        return [`top off or repair builder pool capacity for no_free_pool_builder=${count.count} row(s)${suffix}`];
      }
      if (count.code === "single_writer_lane_busy") {
        const examples = input.blockedLanes
          .filter((lane) => lane.blocker_counts.some((blocker) => blocker.code === "single_writer_lane_busy"))
          .slice(0, 3)
          .map((lane) => `lane=${lane.lane} count=${lane.blocker_counts.find((blocker) => blocker.code === "single_writer_lane_busy")?.count ?? lane.count}`);
        const suffix = examples.length > 0 ? ` (${examples.join("; ")})` : "";
        return [`wait for or clear single_writer_lane_busy=${count.count} lane lock(s)${suffix}`];
      }
      if (count.code === "disk_warning_floor") {
        return [`free disk or admit cleanup/deploy-safe rows before releasing disk_warning_floor=${count.count} held row(s)`];
      }
      if (count.code === "disk_critical_floor") {
        return [`run cleanup rows before releasing disk_critical_floor=${count.count} held non-cleanup row(s)`];
      }
      if (count.code === "duplicate_dispatch_retry_required") {
        return [`review duplicate_dispatch_retry_required=${count.count} rows and mark retry_safe only for bounded refires or close stale duplicates`];
      }
      return [];
    });
    const repairText = actions.length > 0 ? actions.join("; ") : "clear the top ready-admission blockers";
    if (input.candidates >= input.minReadyFuel) {
      return (
        `raw_ready_fuel=${input.candidates} meets min_ready_fuel=${input.minReadyFuel} but ` +
        `useful_ready_fuel=${input.usefulReady} is below floor; ${repairText}`
      );
    }
    return (
      `useful_ready_fuel=${input.usefulReady} is below min_ready_fuel=${input.minReadyFuel}; ` +
      `run auto-promote/flesh for safe backlog candidates or ${repairText}`
    );
  }
  if (input.admissibleNow > 0) return "admit available ready rows";
  const capacitySaturated =
    input.blockerCounts.some((count) => count.count > 0 && count.code === "no_in_flight_slots");
  if (capacitySaturated) {
    return "capacity saturated: wait for in-flight slots to free or close active dispatches; do not add filler ready rows";
  }
  const blocked = input.blockerCounts.reduce((sum, count) => sum + count.count, 0);
  const onlySingleWriterBusy =
    blocked === input.candidates &&
    input.blockerCounts.length === 1 &&
    input.blockerCounts[0]?.code === "single_writer_lane_busy";
  if (onlySingleWriterBusy) {
    const lanes = input.blockedLanes.map((lane) => lane.lane).join(", ");
    return `add cross-lane fuel outside blocked lane(s): ${lanes}`;
  }
  const top = input.blockerCounts[0];
  return top
    ? `clear top ready-admission blocker ${top.code}=${top.count}`
    : "inspect ready admission blockers before refueling";
}

function targetUnhealthyGroupRecommendedAction(
  target: string,
  lane: string,
  priorOwner: string | null,
  proposedHealthyTarget: string | null,
): string {
  const ownerText = priorOwner && priorOwner !== target ? `original owner ${priorOwner}` : `target owner ${target}`;
  if (proposedHealthyTarget) {
    return (
      `Reroute to healthy compatible target ${proposedHealthyTarget} for lane ${lane}; ` +
      `downclassify/supersede the row if the target pin is stale; or restart ${ownerText} only when that owner is expected to resume safely.`
    );
  }
  return (
    `Reroute to a compatible healthy agent for lane ${lane}; downclassify/supersede the row if the target pin is stale; ` +
    `or restart ${ownerText} only when that owner is expected to resume safely.`
  );
}

function readyAdmissionTargetUnhealthyGroups(
  plan: { skipped: DecisionRecord[] },
  byId: Map<string, BacklogItem>,
  proposedHealthyTargets: Map<string, string> = new Map(),
): ReadyAdmissionTargetUnhealthyGroup[] {
  const groups = new Map<string, ReadyAdmissionTargetUnhealthyGroup>();
  for (const decision of plan.skipped) {
    if (decision.metadata?.code !== "target_unhealthy" || !decision.item_id) continue;
    const item = byId.get(decision.item_id);
    const target = typeof decision.metadata.target === "string" && decision.metadata.target.trim() !== ""
      ? decision.metadata.target
      : item?.to_agent;
    if (!item || !target) continue;

    const lane = laneKeyOf(item);
    const key = `${target}\u0000${lane}`;
    const proposedHealthyTarget = proposedHealthyTargets.get(item.item_id) ?? null;
    const current = groups.get(key) ?? {
      target,
      lane,
      count: 0,
      proposed_healthy_target: proposedHealthyTarget,
      examples: [],
      recommended_action: targetUnhealthyGroupRecommendedAction(target, lane, item.to_agent ?? null, proposedHealthyTarget),
    };
    if (!current.proposed_healthy_target && proposedHealthyTarget) {
      current.proposed_healthy_target = proposedHealthyTarget;
      current.recommended_action = targetUnhealthyGroupRecommendedAction(target, lane, item.to_agent ?? null, proposedHealthyTarget);
    }
    current.count += 1;
    if (current.examples.length < 5) {
      current.examples.push({
        item_id: item.item_id,
        title: item.title,
        prior_owner: item.to_agent ?? null,
        risk_class: item.risk_class,
      });
    }
    groups.set(key, current);
  }

  return [...groups.values()].sort((a, b) =>
    b.count - a.count || a.target.localeCompare(b.target) || a.lane.localeCompare(b.lane),
  );
}

function priorDispatchEvidence(
  item: BacklogItem | undefined,
  outcomes: Map<string, DispatchOutcome> = new Map(),
): ReadyAdmissionTargetUnhealthyReceipt["prior_dispatch_evidence"] {
  const phid = item?.last_dispatch_phid ?? null;
  const outcome = phid ? outcomes.get(phid) : undefined;
  return {
    last_dispatch_phid: phid,
    status: outcome?.status ?? null,
    recovery_status: outcome?.recovery_status ?? null,
    retry_safe: item?.retry_safe === true,
  };
}

function targetUnhealthyReceipt(
  item: BacklogItem | undefined,
  metadata: Record<string, unknown> | undefined,
  proposedHealthyTarget: string | null = null,
  outcomes: Map<string, DispatchOutcome> = new Map(),
): ReadyAdmissionTargetUnhealthyReceipt | undefined {
  const target = typeof metadata?.target === "string" && metadata.target.trim() !== ""
    ? metadata.target
    : null;
  if (!target) return undefined;
  const priorOwner = item?.to_agent ?? null;
  const poolName = priorOwner?.startsWith("pool:") ? priorOwner.slice("pool:".length) : null;
  const repairScope = poolName ? `${poolName} pool` : "target lane";
  const holdReason = proposedHealthyTarget
    ? null
    : "no healthy compatible target is currently available; hold, downclassify/supersede, or restart the owner only when safe";
  return {
    code: "target_unhealthy",
    target,
    prior_owner: priorOwner,
    proposed_healthy_target: proposedHealthyTarget,
    hold_reason: holdReason,
    prior_dispatch_evidence: priorDispatchEvidence(item, outcomes),
    safe_action: "reroute_downclassify_or_owner_restart",
    safe_action_summary:
      `Do not refire silently. Reroute this ready row to ${proposedHealthyTarget ?? "a healthy compatible"} ${repairScope} agent, ` +
      "downclassify/supersede it if the target pin is stale, or restart the owner only when safe.",
    counts_as_useful_build_fuel: false,
  };
}

export class ContinuousOrchestrationDaemon {
  private readonly deps: DaemonDeps;
  private readonly teamId: string;
  private timer: NodeJS.Timeout | null = null;
  // Slice 4: adaptive-backoff carry + stop flag for the self-scheduling loop.
  private backoffMult = 1;
  private stopped = false;
  private readonly alertIncidents = new Map<string, AlertIncidentState>();

  constructor(deps: DaemonDeps) {
    this.deps = deps;
    this.teamId = deps.teamId ?? "default";
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  private killSwitchActive(): boolean {
    if (this.deps.killSwitchActive) return this.deps.killSwitchActive();
    try {
      return fs.existsSync(this.deps.config.kill_switch_path);
    } catch {
      return false;
    }
  }

  private async diskHeadroom(): Promise<DiskHeadroom | null> {
    try {
      return await (this.deps.readDiskHeadroom ? this.deps.readDiskHeadroom() : readDiskHeadroom());
    } catch {
      return null;
    }
  }

  private async alert(message: string): Promise<void> {
    const send: AlertSender = this.deps.alert ?? ((m) => sendTelegramAlert(m, this.deps.env));
    await send(message);
  }

  private async alertIncident(input: {
    kind: OrchestrationIncidentKind;
    cause: string;
    message: string;
    recoveryMessage: string;
    nowMs: number;
    activeIncidentKeys: Set<string>;
  }): Promise<boolean> {
    const key = incidentKey(input.kind, input.cause);
    input.activeIncidentKeys.add(key);
    const existing = this.alertIncidents.get(key);
    if (!existing) {
      this.alertIncidents.set(key, {
        kind: input.kind,
        cause: input.cause,
        recovery_message: input.recoveryMessage,
        opened_at_ms: input.nowMs,
        last_alert_at_ms: input.nowMs,
      });
      await this.alert(input.message);
      return true;
    }

    if (input.nowMs - existing.last_alert_at_ms >= INCIDENT_ALERT_COOLDOWN_MS) {
      existing.last_alert_at_ms = input.nowMs;
      await this.alert(`${input.message} Still active for ${Math.floor((input.nowMs - existing.opened_at_ms) / 60_000)} minute(s).`);
      return true;
    }

    return false;
  }

  private async recoverInactiveIncidents(activeIncidentKeys: Set<string>): Promise<void> {
    for (const [key, incident] of [...this.alertIncidents.entries()]) {
      if (activeIncidentKeys.has(key)) continue;
      this.alertIncidents.delete(key);
      await this.alert(incident.recovery_message);
    }
  }

  private async readModelPolicyDirectiveDrift(): Promise<WorkShareDirectiveDrift> {
    if (this.deps.readModelPolicyDirectiveDrift) return this.deps.readModelPolicyDirectiveDrift();
    const policyPath = this.deps.modelPolicyPath ?? path.join(process.cwd(), "configs", "model-policy.json");
    const directive = readWorkShareDirectiveDrift({
      policyPath,
    });
    const defaultRuntimeModePath = path.join(process.cwd(), "configs", "runtime-mode.generated.yaml");
    const runtimeModePath =
      this.deps.runtimeModePath === undefined
        ? fs.existsSync(defaultRuntimeModePath)
          ? defaultRuntimeModePath
          : null
        : this.deps.runtimeModePath;
    const runtimeMix = this.deps.readRuntimeMixDrift
      ? await this.deps.readRuntimeMixDrift()
      : runtimeModePath || this.deps.resolveAllAgentRuntimes
        ? readRuntimeMixDrift({
            policyPath,
            runtimeModePath,
            actualAgentRuntimes: this.deps.resolveAllAgentRuntimes
              ? await this.deps.resolveAllAgentRuntimes()
              : null,
            tolerance: this.deps.runtimeMixTolerance,
          })
        : null;

    if (!runtimeMix || runtimeMix.status === "match") return runtimeMix ? { ...directive, runtime_mix: runtimeMix } : directive;
    return {
      ...directive,
      status: "drift",
      message: directive.status === "match" ? runtimeMix.message : `${directive.message}; ${runtimeMix.message}`,
      runtime_mix: runtimeMix,
    };
  }

  /** Run exactly one orchestration tick. Idempotent w.r.t. external state. */
  async runTick(): Promise<TickResult> {
    const config = this.deps.config;
    const nowMs = this.now();
    const nowIso = new Date(nowMs).toISOString();
    const tick_id = `tick_${crypto.randomUUID()}`;
    const activeIncidentKeys = new Set<string>();

    const state = await getOrchestrationState(this.deps.adapter, this.teamId);
    const killSwitch = this.killSwitchActive();

    // COMPLETION RECONCILIATION + REAPER — the missing half of the loop. Release
    // the write-scope lock of any already-dispatched item whose dispatch has
    // terminated. The stale reaper remains limited to in_flight rows. MUST run BEFORE
    // readInFlight so the freed lanes are admissible THIS tick — otherwise a
    // fired item holds its lock forever and the lanes strangle after
    // ~max_in_flight fires (the overnight self-strangle this fixes).
    const reconcileDecisions = await this.reconcileDispatchedItems(nowMs, config.dry_run);
    let staleReadyReconcile = await reconcileStaleAlreadyDispatchedReadyRows(this.deps.adapter, {
      team_id: this.teamId,
      dry_run: config.dry_run,
      actor: "continuous-orchestration",
    });

    const { view: usage, daily_tokens_used } = await this.deps.readUsage();
    const { count: in_flight, active_write_scopes } = await this.deps.readInFlight();
    const disk_headroom = await this.diskHeadroom();

    // ADMISSION-V2 follow-up: AUTO-PROMOTE first (free) — drain already-fleshed
    // `needs_review` build items into READY to meet the build-ready floor across
    // lanes, BEFORE the token-costly flesh refuel. Then refuel only fills any
    // remaining gap, so the parallel pool self-maintains without manual /promote.
    const autoPromote = await this.maybeAutoPromote({
      config,
      mode: state.mode,
      killSwitch,
      hardPaused: usage.hard_paused,
    });
    const postAutoPromoteStaleReadyReconcile = await reconcileStaleAlreadyDispatchedReadyRows(this.deps.adapter, {
      team_id: this.teamId,
      dry_run: config.dry_run,
      actor: "continuous-orchestration",
    });
    staleReadyReconcile = {
      scanned: staleReadyReconcile.scanned + postAutoPromoteStaleReadyReconcile.scanned,
      closed: staleReadyReconcile.closed + postAutoPromoteStaleReadyReconcile.closed,
      superseded: staleReadyReconcile.superseded + postAutoPromoteStaleReadyReconcile.superseded,
      preserved_retry_safe: staleReadyReconcile.preserved_retry_safe + postAutoPromoteStaleReadyReconcile.preserved_retry_safe,
      dry_run: config.dry_run,
      items: [...staleReadyReconcile.items, ...postAutoPromoteStaleReadyReconcile.items],
    };

    // Daemon SELF-REFUEL: when READY fuel runs low — at a batch load-point or
    // when fully dry — flesh skeletons into dispatchable READY items BEFORE
    // admission, so a near-empty backlog refuels itself without operator action.
    // Mutates the backlog only when the daemon is live (dry-run computes/logs).
    // Slice 4 mechanism 1: refuel + admission share ONE per-tick write budget.
    const writeCfg = {
      maxEnqueuesPerTick: config.max_enqueues_per_tick,
      maxFleshPerTick: config.max_flesh_per_tick,
      maxNewPerTick: config.max_new_per_tick,
    };
    const refuelCap = tickWriteCaps(writeCfg, 0).refuelCap;
    let refuel = await this.maybeRefuel({
      config,
      mode: state.mode,
      killSwitch,
      hardPaused: usage.hard_paused,
      nowMs,
      dailyTokensUsed: daily_tokens_used,
      fleshLimit: refuelCap,
    });
    const postRefuelStaleReadyReconcile = await reconcileStaleAlreadyDispatchedReadyRows(this.deps.adapter, {
      team_id: this.teamId,
      dry_run: config.dry_run,
      actor: "continuous-orchestration",
    });
    staleReadyReconcile = {
      scanned: staleReadyReconcile.scanned + postRefuelStaleReadyReconcile.scanned,
      closed: staleReadyReconcile.closed + postRefuelStaleReadyReconcile.closed,
      superseded: staleReadyReconcile.superseded + postRefuelStaleReadyReconcile.superseded,
      preserved_retry_safe: staleReadyReconcile.preserved_retry_safe + postRefuelStaleReadyReconcile.preserved_retry_safe,
      dry_run: config.dry_run,
      items: [...staleReadyReconcile.items, ...postRefuelStaleReadyReconcile.items],
    };
    // Slice 4 mechanism 2: if the refuel fleshed anything this tick, suppress
    // admission so the daemon never stacks two write bursts in one tick.
    const refuelFleshed = refuel?.auto_ready ?? 0;
    const admitCap = tickWriteCaps(writeCfg, refuelFleshed).admitCap;

    const readyRuntimeRepairs = await repairReadyCodexRuntimeMetadata(this.deps.adapter, this.teamId, { apply: true });
    let ready = await listReadyItems(this.deps.adapter, this.teamId);
    const dependency_index = await listDependencyResolution(this.deps.adapter, this.teamId);
    // Priority-rank, then FAIR-interleave across distinct write_scope lanes so a
    // single busy lane can't monopolize this tick's admission slots — admission
    // consumes this order greedily, so a lane-diverse order => lane-diverse fires.
    let ordered = fairInterleaveByLane(orderCandidates(ready));

    // Stage C: compute the per-pool capacity + free-builder gate from the
    // current in-flight builds, so the daemon spills across pool members instead
    // of serializing the whole backlog onto one lane.
    let poolGate = await this.buildPoolGate(ordered);

    // RD-014: resolve live health for every agent name admission might target
    // this tick — non-pool candidates' to_agent, plus every pool's builder
    // list (any of them could be late-bound). Root cause of the pending-lane
    // cascade (+149 failed dispatches in one overnight wave): admission fired
    // to a lane with no check the target runtime was actually up.
    let candidateAgentNames = new Set<string>();
    for (const item of ordered) if (item.to_agent) candidateAgentNames.add(item.to_agent);
    if (poolGate) for (const builders of poolGate.pool_free_builders.values()) for (const b of builders) candidateAgentNames.add(b);
    let healthy_agents = this.deps.resolveAgentHealth
      ? await this.deps.resolveAgentHealth([...candidateAgentNames])
      : undefined;
    let pool_lane_blockers = poolGate ? this.applyPoolHealthGate(poolGate, healthy_agents) : undefined;
    let target_agent_runtimes = this.deps.resolveAgentRuntimes
      ? await this.deps.resolveAgentRuntimes([...candidateAgentNames])
      : undefined;
    const ready_item_blockers = await this.readyItemBlockers();
    const targetUnhealthyReroutes = await this.rerouteTargetUnhealthyReadyRows({
      items: ordered,
      healthyAgents: healthy_agents,
      targetAgentRuntimes: target_agent_runtimes,
      dryRun: config.dry_run,
    });
    if (targetUnhealthyReroutes.changed && !config.dry_run) {
      ready = await listReadyItems(this.deps.adapter, this.teamId);
      ordered = fairInterleaveByLane(orderCandidates(ready));
      poolGate = await this.buildPoolGate(ordered);
      candidateAgentNames = new Set<string>();
      for (const item of ordered) if (item.to_agent) candidateAgentNames.add(item.to_agent);
      if (poolGate) for (const builders of poolGate.pool_free_builders.values()) for (const b of builders) candidateAgentNames.add(b);
      healthy_agents = this.deps.resolveAgentHealth
        ? await this.deps.resolveAgentHealth([...candidateAgentNames])
        : undefined;
      pool_lane_blockers = poolGate ? this.applyPoolHealthGate(poolGate, healthy_agents) : undefined;
      target_agent_runtimes = this.deps.resolveAgentRuntimes
        ? await this.deps.resolveAgentRuntimes([...candidateAgentNames])
        : undefined;
    }

    const ctx: AdmissionContext = {
      mode: state.mode,
      kill_switch_active: killSwitch,
      usage,
      daily_tokens_used,
      in_flight,
      active_write_scopes,
      dependency_index,
      admit_limit: Math.min(tickAdmitLimit(nowMs, config), admitCap),
      pool_for: poolGate?.pool_for,
      pool_free_slots: poolGate?.pool_free_slots,
      pool_free_builders: poolGate?.pool_free_builders,
      pool_lane_blockers,
      healthy_agents,
      target_agent_runtimes,
      ready_item_blockers,
      disk_headroom,
    };

    const plan = planAdmission(ordered, ctx, config);
    const decisions: DecisionRecord[] = [...reconcileDecisions, ...targetUnhealthyReroutes.decisions];
    for (const item of staleReadyReconcile.items) {
      decisions.push({
        item_id: item.item_id,
        action: "stale_ready_reconcile",
        reason: item.reason,
        dispatch_phid: item.dispatch_phid,
        metadata: {
          dry_run: staleReadyReconcile.dry_run,
          from_state: item.from_state,
          to_state: item.to_state,
          dispatch_status: item.dispatch_status,
          receipt: item.receipt,
        },
      });
    }
    const admitted: Array<{ item_id: string; dispatch_phid: string | null }> = [];
    const modelPolicyDrift = await this.readModelPolicyDirectiveDrift();

    for (const repair of readyRuntimeRepairs) {
      decisions.push({
        item_id: repair.item_id,
        action: "ready_metadata_repair",
        reason:
          `repaired ready provider/runtime metadata for ${repair.to_agent}: ` +
          `${repair.from_provider ?? "(null)"}/${repair.from_runtime ?? "(null)"} -> ${repair.to_provider}/${repair.to_runtime}`,
        metadata: { ...repair },
      });
    }

    if (autoPromote) {
      decisions.push({
        item_id: null,
        action: "auto_promote",
        reason:
          `auto-promote${autoPromote.dry_run ? " (dry-run)" : ""}: ` +
          `build-ready ${autoPromote.before.build_ready} (lanes ${autoPromote.before.build_lanes}) ` +
          `-> +${autoPromote.promoted} promoted, ${autoPromote.skipped} held by safety gate`,
        metadata: {
          dry_run: autoPromote.dry_run,
          promoted: autoPromote.promoted,
          skipped: autoPromote.skipped,
          skipped_items: autoPromote.skipped_items,
          build_ready_before: autoPromote.before.build_ready,
          build_lanes_before: autoPromote.before.build_lanes,
        },
      });
    }

    if (refuel) {
      decisions.push({
        item_id: null,
        action: "refuel",
        reason:
          `auto-flesh refuel${refuel.dry_run ? " (dry-run)" : ""}: ` +
          `considered ${refuel.considered}, +${refuel.auto_ready} ready, ` +
          `${refuel.needs_chris_batch} held for batch, ${refuel.failed} failed`,
        metadata: {
          dry_run: refuel.dry_run,
          considered: refuel.considered,
          auto_ready: refuel.auto_ready,
          needs_chris_batch: refuel.needs_chris_batch,
          failed: refuel.failed,
        },
      });
    }

    if (plan.halt) {
      decisions.push({ item_id: null, action: "guardrail_halt", reason: plan.halt.reason });
    } else {
      for (const item of plan.admit) {
        if (config.dry_run) {
          decisions.push({ item_id: item.item_id, action: "would_dispatch", reason: "dry-run: would fire" });
          admitted.push({ item_id: item.item_id, dispatch_phid: null });
        } else {
          try {
            // Stage C late-binding: a pool item picks its builder + a distinct
            // worktree at fire time, so N builds of the same repo run concurrently.
            let fireItem = item;
            let builderNote = "";
            const assignedBuilder = plan.assignments[item.item_id];
            const pool = this.deps.pools?.poolForItem(item) ?? null;
            // RD-003 mode (a): the pool bind is PERSISTED before enqueue, and enqueue
            // can throw. Capture the pre-fire bind so we can revert on failure and
            // never strand the item on a worktree it never dispatched to.
            let didBind = false;
            const priorBind = { to_agent: item.to_agent, write_scope: item.write_scope };
            if (assignedBuilder && pool && this.deps.pools) {
              const wt = await this.deps.pools.allocateWorktree({ agent: assignedBuilder, item, pool });
              await bindItemForFire(this.deps.adapter, item.item_id, {
                to_agent: assignedBuilder,
                write_scope: [wt.path],
              });
              didBind = true;
              fireItem = { ...item, to_agent: assignedBuilder, write_scope: [wt.path] };
              builderNote = ` [pool ${pool.pool_id} → ${assignedBuilder} @ ${wt.path}]`;
            }
            let res: { dispatch_phid: string; query_id: string };
            try {
              res = await this.deps.enqueue(fireItem);
            } catch (enqErr) {
              // Enqueue failed AFTER the bind persisted → revert to the pre-fire
              // bind so the item stays cleanly 'ready' (not bound to an unused
              // worktree / lane-blocking). Re-throw to the skipped-decision handler.
              if (didBind) await bindItemForFire(this.deps.adapter, item.item_id, priorBind);
              throw enqErr;
            }
            // Enqueue succeeded (dispatch exists). Transition ready→in_flight bound
            // to the dispatch in a single write. If THIS throws (mode b), the item
            // stays 'ready' with a live dispatch; the next tick re-fires with the
            // same stable dedup_key, so the idempotent scheduler returns the SAME
            // dispatch (no double-fire) and the transition retries.
            await setItemState(this.deps.adapter, item.item_id, "in_flight", { dispatch_phid: res.dispatch_phid });
            decisions.push({
              item_id: item.item_id,
              action: "dispatched",
              reason: `fired to ${fireItem.to_agent}${builderNote}`,
              dispatch_phid: res.dispatch_phid,
              metadata: assignedBuilder
                ? {
                    pool_id: pool?.pool_id,
                    builder: assignedBuilder,
                    write_scope: fireItem.write_scope,
                    lane_blockers: pool?.pool_id ? (pool_lane_blockers?.get(pool.pool_id) ?? []) : [],
                  }
                : undefined,
            });
            admitted.push({ item_id: item.item_id, dispatch_phid: res.dispatch_phid });
          } catch (err) {
            decisions.push({
              item_id: item.item_id,
              action: "skipped",
              reason: `enqueue failed: ${err instanceof Error ? err.message : String(err)}`,
            });
          }
        }
      }
    }
    decisions.push(...plan.skipped);

    // Guardrail: daily reference warning (loud). Plan-based provider accounts
    // are not token-metered, so this never auto-pauses by itself.
    let auto_paused: { reason: string } | null = null;
    if (
      state.mode === "running" &&
      daily_tokens_used >= config.daily_token_ceiling * config.warn_fraction
    ) {
      decisions.push({
        item_id: null,
        action: "held",
        reason: `token reference warn: ${daily_tokens_used} >= ${Math.round(config.daily_token_ceiling * config.warn_fraction)} (${Math.round(config.warn_fraction * 100)}% of configured reference)`,
      });
    }

    // Stall self-detection (loud) — the overnight-drain failure mode.
    const stall = evaluateStall(
      state.consecutive_zero_ticks,
      { mode: state.mode, halted: !!plan.halt, candidates_available: ordered.length, admitted: admitted.length },
      config,
    );
    const admissionBlockerCountsForTick = readyAdmissionBlockerCounts(plan);
    const targetUnhealthyIncident = targetUnhealthyReadyBlockedIncident({
      ready,
      plan,
      blockerCounts: admissionBlockerCountsForTick,
      zeroTicks: stall.zero_ticks,
      config,
    });
    const zeroAdmitIncident = zeroAdmitReadyBlockedIncident({
      ready,
      plan,
      blockerCounts: admissionBlockerCountsForTick,
      zeroTicks: stall.zero_ticks,
      inFlight: in_flight,
      config,
    });
    if (targetUnhealthyIncident) {
      decisions.push({
        item_id: null,
        action: "target_unhealthy_incident",
        reason:
          `ready fuel blocked by target_unhealthy: ready=${ready.length} floor=${config.min_ready_fuel}, ` +
          `admissible_now=0, target_unhealthy=${targetUnhealthyIncident.targetCount}`,
        metadata: {
          incident_code: "ready_fuel_blocked_by_target_unhealthy",
          affected_targets: targetUnhealthyIncident.targets,
          example_item_ids: targetUnhealthyIncident.examples,
          blocker_counts: admissionBlockerCountsForTick,
          recommended_action: "restore unhealthy targets or reroute to compatible healthy owners before treating raw ready as useful fuel",
        },
      });
      await this.alertIncident({
        kind: "target_unhealthy_ready_blocked",
        cause: targetUnhealthyIncident.cause,
        message: targetUnhealthyIncident.message,
        recoveryMessage: `Continuous orchestration ${formatIncidentKind("target_unhealthy_ready_blocked")} recovered.`,
        nowMs,
        activeIncidentKeys,
      });
    } else if (zeroAdmitIncident) {
      const opened = await this.alertIncident({
        kind: "zero_admit_ready_blocked",
        cause: zeroAdmitIncident.cause,
        message: zeroAdmitIncident.message,
        recoveryMessage: `✅ Continuous orchestration ${formatIncidentKind("zero_admit_ready_blocked")} recovered.`,
        nowMs,
        activeIncidentKeys,
      });
      if (opened) {
        decisions.push({
          item_id: null,
          action: "zero_admit_incident",
          reason:
            `zero-admit ready-blocked incident: ready=${ready.length}, in_flight=${in_flight}/${config.max_in_flight}, ` +
            `no_in_flight_slots=${zeroAdmitIncident.no_in_flight_slots}`,
          metadata: {
            incident_code: "zero_admit_ready_blocked",
            dedupe_key: incidentKey("zero_admit_ready_blocked", zeroAdmitIncident.cause),
            zero_ticks: stall.zero_ticks,
            ready: ready.length,
            in_flight,
            max_in_flight: config.max_in_flight,
            blocker_counts: zeroAdmitIncident.blocker_counts,
            no_in_flight_slots: zeroAdmitIncident.no_in_flight_slots,
            duplicate_dispatch_retry_required: zeroAdmitIncident.duplicate_dispatch_retry_required,
            recommended_action: zeroAdmitIncident.recommended_action,
          },
        });
      }
    } else if (stall.alert) {
      const cause = stableJson({
        ready_waiting: ordered.length,
        block_reasons: readyAdmissionBlockReasonCounts(plan),
      });
      decisions.push({
        item_id: null,
        action: "stall_alert",
        reason: `STALL: ${stall.zero_ticks} consecutive ticks fired 0 dispatches with ${ordered.length} ready item(s) waiting`,
      });
      await this.alertIncident({
        kind: "stall",
        cause,
        message:
          `⚠️ Continuous orchestration STALL — ${stall.zero_ticks} ticks in a row fired nothing while ` +
          `${ordered.length} ready item(s) wait. Check lanes/budget.`,
        recoveryMessage: `✅ Continuous orchestration ${formatIncidentKind("stall")} recovered.`,
        nowMs,
        activeIncidentKeys,
      });
    }

    const admissibleReady = plan.admit.length;
    const inFlightCapacityFull = config.max_in_flight > 0 && in_flight >= config.max_in_flight;
    const nonUsefulReadyCount = plan.skipped.filter((decision) =>
      isNonUsefulReadyBlockerCode(decision.metadata?.code)
    ).length;
    const usefulReadyCount = Math.max(0, ready.length - nonUsefulReadyCount);
    if (!inFlightCapacityFull && shouldRunZeroAdmitStallWatchdog(stall.zero_ticks, usefulReadyCount, config)) {
      const message =
        `Continuous orchestration zero-admit stall: ${stall.zero_ticks} consecutive zero-admit ticks, ` +
        `${usefulReadyCount} useful ready item(s), ${admissibleReady} admissible, min_ready_fuel=${config.min_ready_fuel}`;
      decisions.push({
        item_id: null,
        action: "fleet_blockage",
        reason: `${message}; emitting fleet.blockage and triggering flesh/run`,
        metadata: {
          event_type: "fleet.blockage",
          zero_ticks: stall.zero_ticks,
          ready: ready.length,
          useful_ready: usefulReadyCount,
          admissible_ready: admissibleReady,
          min_ready_fuel: config.min_ready_fuel,
        },
      });
      await this.emitFleetBlockage(message, {
        tick_id,
        zero_ticks: stall.zero_ticks,
        ready: ready.length,
        useful_ready: usefulReadyCount,
        admissible_ready: admissibleReady,
        min_ready_fuel: config.min_ready_fuel,
        candidates: ordered.length,
      });

      if (!refuel) {
        refuel = await this.runStallWatchdogRefuel({
          config,
          dailyTokensUsed: daily_tokens_used,
        });
        if (refuel) {
          decisions.push({
            item_id: null,
            action: "refuel",
            reason:
              `stall watchdog flesh/run${refuel.dry_run ? " (dry-run)" : ""}: ` +
              `considered ${refuel.considered}, +${refuel.auto_ready} ready, ` +
              `${refuel.needs_chris_batch} held for batch, ${refuel.failed} failed`,
            metadata: {
              trigger: "zero_admit_stall_watchdog",
              dry_run: refuel.dry_run,
              considered: refuel.considered,
              auto_ready: refuel.auto_ready,
              needs_chris_batch: refuel.needs_chris_batch,
              failed: refuel.failed,
            },
          });
        }
      }
    }

    const emptyPipeAlert = autoPromoteEmptyPipeAlertFrom({
      ready: ready.length,
      admissibleReady,
      autoPromote,
    });
    if (emptyPipeAlert.active) {
      const message = emptyPipeAlert.message ?? "Continuous orchestration empty auto-promote pipe";
      decisions.push({
        item_id: null,
        action: "fleet_blockage",
        reason: message,
        metadata: {
          event_type: "fleet.blockage",
          kind: "empty_auto_promote_pipe",
          ready: emptyPipeAlert.ready,
          admissible_now: emptyPipeAlert.admissible_now,
          items: emptyPipeAlert.items,
        },
      });
      await this.emitFleetBlockage(message, {
        tick_id,
        kind: "empty_auto_promote_pipe",
        ready: emptyPipeAlert.ready,
        admissible_now: emptyPipeAlert.admissible_now,
        items: emptyPipeAlert.items,
      });
    }

    if (modelPolicyDrift.status !== "match") {
      const message = modelPolicyDrift.message ?? `model-policy directive guard failed with status ${modelPolicyDrift.status}`;
      const cause = stableJson({
        status: modelPolicyDrift.status,
        policy_path: modelPolicyDrift.policy_path,
        diffs: modelPolicyDrift.diffs,
        directive_targets: modelPolicyDrift.directive_targets,
        work_share_targets: modelPolicyDrift.work_share_targets,
        runtime_mix: modelPolicyDrift.runtime_mix
          ? {
              status: modelPolicyDrift.runtime_mix.status,
              runtime_mode_path: modelPolicyDrift.runtime_mix.runtime_mode_path,
              diffs: modelPolicyDrift.runtime_mix.diffs,
              desired_targets: modelPolicyDrift.runtime_mix.desired_targets,
              runtime_mode_actual: modelPolicyDrift.runtime_mix.runtime_mode_actual,
              agent_actual: modelPolicyDrift.runtime_mix.agent_actual,
            }
          : null,
      });
      decisions.push({
        item_id: null,
        action: "model_policy_drift_alert",
        reason: message,
        metadata: {
          event_type: "model_policy.drift",
          status: modelPolicyDrift.status,
          policy_path: modelPolicyDrift.policy_path,
          diffs: modelPolicyDrift.diffs,
          directive_targets: modelPolicyDrift.directive_targets,
          work_share_targets: modelPolicyDrift.work_share_targets,
          runtime_mix: modelPolicyDrift.runtime_mix,
        },
      });
      await this.alertIncident({
        kind: "model_policy_drift",
        cause,
        message: `Continuous orchestration model-policy drift: ${message}`,
        recoveryMessage: `✅ Continuous orchestration ${formatIncidentKind("model_policy_drift")} recovered.`,
        nowMs,
        activeIncidentKeys,
      });
      await this.emitModelPolicyDrift(message, {
        tick_id,
        status: modelPolicyDrift.status,
        policy_path: modelPolicyDrift.policy_path,
        diffs: modelPolicyDrift.diffs,
        directive_targets: modelPolicyDrift.directive_targets,
        work_share_targets: modelPolicyDrift.work_share_targets,
        runtime_mix: modelPolicyDrift.runtime_mix,
      });
    }

    await this.recoverInactiveIncidents(activeIncidentKeys);

    await appendDecisions(this.deps.adapter, { team_id: this.teamId, tick_id, dry_run: config.dry_run, records: decisions });
    await recordTickOutcome(this.deps.adapter, this.teamId, {
      zero_ticks: stall.zero_ticks,
      fired: admitted.length > 0 && !config.dry_run,
      admission_block_reasons: readyAdmissionBlockReasonCounts(plan),
      auto_pause: auto_paused,
    });

    return {
      tick_id,
      now: nowIso,
      mode: state.mode,
      dry_run: config.dry_run,
      halted: plan.halt?.reason ?? null,
      candidates: ordered.length,
      admitted,
      reconciled: reconcileDecisions.length,
      stale_ready_reconciled: staleReadyReconcile,
      skipped: plan.skipped.length,
      zero_ticks: stall.zero_ticks,
      stall_alert: stall.alert,
      auto_paused,
      refuel,
      auto_promote: autoPromote,
      ready_runtime_repairs: readyRuntimeRepairs,
      model_policy_drift: modelPolicyDrift,
      decisions,
    };
  }

  /**
   * Read-only status helper: explain why current READY rows would or would not
   * admit with the same guardrails as a tick. It intentionally does not
   * reconcile, auto-promote, refuel, enqueue, or mutate tick counters.
   */
  async explainReadyAdmission(): Promise<ReadyAdmissionExplanation> {
    const config = this.deps.config;
    const nowMs = this.now();
    const state = await getOrchestrationState(this.deps.adapter, this.teamId);
    const killSwitch = this.killSwitchActive();
    const { view: usage, daily_tokens_used } = await this.deps.readUsage();
    const { count: in_flight, active_write_scopes } = await this.deps.readInFlight();
    const disk_headroom = await this.diskHeadroom();
    const readyRuntimeRepairs = await repairReadyCodexRuntimeMetadata(this.deps.adapter, this.teamId, { apply: false });
    const ready = await listReadyItems(this.deps.adapter, this.teamId);
    const dependency_index = await listDependencyResolution(this.deps.adapter, this.teamId);
    const ordered = fairInterleaveByLane(orderCandidates(ready));
    const poolGate = await this.buildPoolGate(ordered);

    const candidateAgentNames = new Set<string>();
    for (const item of ordered) if (item.to_agent) candidateAgentNames.add(item.to_agent);
    if (poolGate) for (const builders of poolGate.pool_free_builders.values()) for (const b of builders) candidateAgentNames.add(b);
    const healthy_agents = this.deps.resolveAgentHealth
      ? await this.deps.resolveAgentHealth([...candidateAgentNames])
      : undefined;
    const pool_lane_blockers = poolGate ? this.applyPoolHealthGate(poolGate, healthy_agents) : undefined;
    const target_agent_runtimes = this.deps.resolveAgentRuntimes
      ? await this.deps.resolveAgentRuntimes([...candidateAgentNames])
      : undefined;
    const ready_item_blockers = await this.readyItemBlockers();

    const writeCfg = {
      maxEnqueuesPerTick: config.max_enqueues_per_tick,
      maxFleshPerTick: config.max_flesh_per_tick,
      maxNewPerTick: config.max_new_per_tick,
    };
    const ctx: AdmissionContext = {
      mode: state.mode,
      kill_switch_active: killSwitch,
      usage,
      daily_tokens_used,
      in_flight,
      active_write_scopes,
      dependency_index,
      admit_limit: Math.min(tickAdmitLimit(nowMs, config), tickWriteCaps(writeCfg, 0).admitCap),
      pool_for: poolGate?.pool_for,
      pool_free_slots: poolGate?.pool_free_slots,
      pool_free_builders: poolGate?.pool_free_builders,
      pool_lane_blockers,
      healthy_agents,
      target_agent_runtimes,
      ready_item_blockers,
      disk_headroom,
    };

    const plan = planAdmission(ordered, ctx, config);
    const byId = new Map(ordered.map((item) => [item.item_id, item]));
    const duplicateRetryOutcomes = await getDispatchOutcomesByPhid(
      this.deps.adapter,
      plan.skipped
        .filter((decision) => decision.metadata?.code === "duplicate_dispatch_retry_required")
        .map((decision) =>
          typeof decision.metadata?.last_dispatch_phid === "string" ? decision.metadata.last_dispatch_phid : null,
        )
        .filter((phid): phid is string => phid != null),
    );
    const targetUnhealthyOutcomes = await getDispatchOutcomesByPhid(
      this.deps.adapter,
      plan.skipped
        .filter((decision) => decision.metadata?.code === "target_unhealthy")
        .map((decision) => {
          const item = decision.item_id ? byId.get(decision.item_id) : undefined;
          return item?.last_dispatch_phid ?? null;
        })
        .filter((phid): phid is string => phid != null),
    );
    const busyAgents = await this.busyPoolAgents();
    const proposedHealthyTargets = new Map<string, string>();
    for (const decision of plan.skipped) {
      if (decision.metadata?.code !== "target_unhealthy" || !decision.item_id) continue;
      const item = byId.get(decision.item_id);
      const target = typeof decision.metadata.target === "string" ? decision.metadata.target : item?.to_agent;
      if (!item || !target) continue;
      const proposal = this.proposeHealthyEquivalentTarget({
        item,
        unhealthyTarget: target,
        healthyAgents: healthy_agents,
        busyAgents,
        targetAgentRuntimes: target_agent_runtimes,
      });
      if (proposal) proposedHealthyTargets.set(item.item_id, proposal.target);
    }
    const blockerCounts = readyAdmissionBlockerCounts(plan);
    const terminalDuplicateItemIds = new Set(
      plan.skipped
        .filter((decision) => isTerminalDuplicateReadyFuel(decision, duplicateRetryOutcomes))
        .map((decision) => decision.item_id)
        .filter((itemId): itemId is string => !!itemId),
    );
    const nonUsefulItemIds = new Set(
      plan.skipped
        .filter((decision) => isNonUsefulReadyBlockerCode(decision.metadata?.code))
        .map((decision) => decision.item_id)
        .filter((itemId): itemId is string => !!itemId),
    );
    const activeReady = ordered.filter((item) => !terminalDuplicateItemIds.has(item.item_id));
    const usefulReady = ordered.length - nonUsefulItemIds.size;
    const admittedItemIds = new Set(plan.admit.map((item) => item.item_id));
    const laneCounts = new Map<string, { lane: string; raw_ready: number; useful_ready: number; admissible_now: number; blocked: number }>();
    for (const item of activeReady) {
      const lane = laneKeyOf(item);
      const counts = laneCounts.get(lane) ?? { lane, raw_ready: 0, useful_ready: 0, admissible_now: 0, blocked: 0 };
      counts.raw_ready += 1;
      if (!nonUsefulItemIds.has(item.item_id)) counts.useful_ready += 1;
      if (admittedItemIds.has(item.item_id)) counts.admissible_now += 1;
      else counts.blocked += 1;
      laneCounts.set(lane, counts);
    }
    const staleReadyFloor =
      (usefulReady < config.min_ready_fuel && activeReady.length > 0) ||
      (usefulReady >= config.min_ready_fuel && plan.admit.length < config.min_ready_fuel && plan.skipped.length > 0);
    const blockedLanes = readyAdmissionBlockedLanes(plan, byId);
    const targetUnhealthyGroups = readyAdmissionTargetUnhealthyGroups(plan, byId, proposedHealthyTargets);
    const recommendedAction = readyAdmissionRecommendedAction({
      candidates: activeReady.length,
      usefulReady,
      admissibleNow: plan.admit.length,
      minReadyFuel: config.min_ready_fuel,
      blockerCounts,
      blockedLanes,
      targetUnhealthyGroups,
    });
    return {
      candidates: activeReady.length,
      useful_ready: usefulReady,
      admissible_now: plan.admit.length,
      lanes: {
        raw_ready: new Set(activeReady.map(laneKeyOf)).size,
        useful_ready: new Set(activeReady.filter((item) => !nonUsefulItemIds.has(item.item_id)).map(laneKeyOf)).size,
        admissible_now: new Set(plan.admit.map(laneKeyOf)).size,
        by_lane: [...laneCounts.values()].sort((a, b) => a.lane.localeCompare(b.lane)),
      },
      block_reason_counts: readyAdmissionBlockReasonCounts(plan),
      top_block_reasons: blockerCounts.slice(0, 5),
      blocked_lanes: blockedLanes,
      target_unhealthy_groups: targetUnhealthyGroups,
      recommended_action: recommendedAction,
      admissible: plan.admit.map((item) => ({
        item_id: item.item_id,
        title: item.title,
        to_agent: plan.assignments[item.item_id] ?? item.to_agent,
        risk_class: item.risk_class,
      })),
      non_admitted: plan.skipped.map((decision) => {
        const item = decision.item_id ? byId.get(decision.item_id) : undefined;
        const code = typeof decision.metadata?.code === "string" ? decision.metadata.code : "unknown";
        const unhealthyReceipt = code === "target_unhealthy"
          ? targetUnhealthyReceipt(
            item,
            decision.metadata,
            decision.item_id ? proposedHealthyTargets.get(decision.item_id) ?? null : null,
            targetUnhealthyOutcomes,
          )
          : undefined;
        const lastDispatchPhid =
          decision.metadata?.code === "duplicate_dispatch_retry_required" &&
          typeof decision.metadata.last_dispatch_phid === "string"
            ? decision.metadata.last_dispatch_phid
            : null;
        const duplicateRetry =
          lastDispatchPhid != null
            ? duplicateDispatchRetryReceipt(lastDispatchPhid, duplicateRetryOutcomes.get(lastDispatchPhid))
            : null;
        return {
          item_id: decision.item_id ?? "",
          title: item?.title ?? "",
          to_agent: item?.to_agent ?? null,
          risk_class: item?.risk_class ?? "",
          action: decision.action === "held" ? "held" : "skipped",
          code,
          reason: decision.reason,
          metadata: {
            ...decision.metadata,
            ...(duplicateRetry ? { duplicate_retry: duplicateRetry } : {}),
            ...(unhealthyReceipt ? { target_unhealthy_receipt: unhealthyReceipt } : {}),
          },
          ...(unhealthyReceipt ? { target_unhealthy_receipt: unhealthyReceipt } : {}),
        };
      }),
      blocker_counts: blockerCounts,
      operator_blockers: readyAdmissionOperatorBlockers(plan),
      stale_ready_floor: {
        stale: staleReadyFloor,
        ready: activeReady.length,
        admissible: plan.admit.length,
        min_ready_fuel: config.min_ready_fuel,
        reason: staleReadyFloor
          ? usefulReady < config.min_ready_fuel
            ? `useful_ready_fuel=${usefulReady} is below min_ready_fuel=${config.min_ready_fuel}; raw_ready_fuel=${activeReady.length}`
            : `useful READY floor is satisfied (${usefulReady}) but only ${plan.admit.length} item(s) are admissible`
          : null,
      },
      halted: plan.halt?.reason ?? null,
      ready_runtime_repairs: readyRuntimeRepairs,
      disk_headroom,
    };
  }

  async explainAutoPromoteHealth(): Promise<AutoPromoteHealth> {
    const config = this.deps.config;
    const state = await getOrchestrationState(this.deps.adapter, this.teamId);
    const killSwitch = this.killSwitchActive();
    const { view: usage } = await this.deps.readUsage();
    const readyRuntimeRepairs = await repairReadyCodexRuntimeMetadata(this.deps.adapter, this.teamId, { apply: false });

    const [ready, allNeedsReview, inFlight] = await Promise.all([
      listReadyItems(this.deps.adapter, this.teamId),
      listBacklogByState(this.deps.adapter, { team_id: this.teamId, state: "needs_review" }),
      listBacklogByState(this.deps.adapter, { team_id: this.teamId, state: "in_flight" }),
    ]);
    const dispatchStatuses = await getDispatchStatusesByPhid(
      this.deps.adapter,
      allNeedsReview.map((item) => item.last_dispatch_phid).filter((phid): phid is string => !!phid),
    );
    const needsReview = allNeedsReview.filter((item) => {
      if (!item.last_dispatch_phid) return true;
      const status = dispatchStatuses.get(item.last_dispatch_phid);
      return !status || !AUTO_PROMOTE_HEALTH_STALE_ALREADY_DISPATCHED_STATUSES.has(status);
    });
    const readyAdmission = await this.explainReadyAdmission();
    const nonUsefulReadyFuelIds = await this.nonUsefulProviderRuntimeReadyFuelIds(ready);
    for (const row of readyAdmission.non_admitted) {
      if (isNonUsefulReadyBlockerCode(row.code)) {
        nonUsefulReadyFuelIds.add(row.item_id);
      }
    }
    const capacityFuel = buildCapacityFuel(ready, inFlight, config.max_in_flight, nonUsefulReadyFuelIds);
    const plan = selectAutoPromotions(needsReview, capacityFuel.floorItems, {
      floor: config.auto_promote_floor,
      minLanes: config.auto_promote_min_lanes,
      maxPerPass: config.auto_promote_max_per_tick,
    });
    const readyLaneKeys = [...new Set(capacityFuel.readyBuild.map(laneKeyOf))].sort();
    const inFlightLaneKeys = [...new Set(capacityFuel.inFlightBuild.map(laneKeyOf))].sort();
    const safeAutoPromoteCandidates = needsReview.filter(
      (item) => autoPromoteRejections(item, AUTO_READY_CONFIDENCE_THRESHOLD).length === 0,
    );
    const candidateLaneKeys = [...new Set(safeAutoPromoteCandidates.map(laneKeyOf))].sort();
    const blockedReason =
      !config.auto_flesh_enabled ? "auto_flesh_disabled" :
      !config.auto_promote_enabled ? "auto_promote_disabled" :
      state.mode !== "running" ? `mode_${state.mode}` :
      killSwitch ? "kill_switch_active" :
      usage.hard_paused ? "usage_hard_paused" :
      null;
    const rawBelowFloor = plan.before.build_ready < config.auto_promote_floor;
    const belowFloor = !capacityFuel.capacityOccupied && rawBelowFloor;
    const belowLanes = plan.before.build_lanes < config.auto_promote_min_lanes;
    const skippedItems = plan.skipped;
    const itemById = new Map(needsReview.map((item) => [item.item_id, item]));
    const healthSkippedItems = skippedItems.map((item): AutoPromoteHealthSkippedItem => {
      const backlogItem = itemById.get(item.item_id);
      const priorDispatchPhid = backlogItem?.last_dispatch_phid ?? undefined;
      return {
        ...item,
        ...(priorDispatchPhid
          ? {
              prior_dispatch_phid: priorDispatchPhid,
              prior_dispatch_status: dispatchStatuses.get(priorDispatchPhid) ?? null,
            }
          : {}),
      };
    });
    const priorDispatchStatusCounts = alreadyDispatchedStatusCounts(healthSkippedItems);
    const promotedItems = plan.promote.map((item) => ({
      item_id: item.item_id,
      title: item.title,
      lane: laneKeyOf(item),
    }));
    const topSkipReasons = topSkipReasonsFrom(skippedItems);
    const promotedCount = blockedReason || capacityFuel.capacityOccupied ? 0 : plan.promote.length;
    const triggered = blockedReason || capacityFuel.capacityOccupied ? false : plan.triggered;
    const candidatesConsidered = triggered ? plan.candidates_considered : 0;
    const blockerClassCounts = triggered ? blockerClassCountsFrom(skippedItems) : [];
    const operatorSummary = await buildAutoPromoteOperatorSummary(this.deps.adapter, {
      triggered,
      ready: plan.before.build_ready,
      candidatesConsidered,
      needsReview,
      skippedItems,
      capacityOccupied: capacityFuel.capacityOccupied,
      readyRows: capacityFuel.readyBuild.length,
      readyPlusInFlight: plan.before.build_ready,
      buildReadyLanes: plan.before.build_lanes,
      minLanes: config.auto_promote_min_lanes,
    });
    const nextAction = nextAutoPromoteAction({
      blockedReason,
      belowFloor: rawBelowFloor,
      belowLanes,
      triggered,
      candidates: candidatesConsidered,
      promoted: promotedCount,
      blockerClassCounts,
      priorDispatchStatusCounts,
    });
    const emptyPipeAlert = autoPromoteEmptyPipeAlertFrom({
      ready: plan.before.build_ready,
      admissibleReady: plan.before.build_ready === 0 ? 0 : null,
      autoPromote: triggered
        ? {
          triggered,
          promoted: promotedCount,
          skipped: skippedItems.length,
          candidates_considered: candidatesConsidered,
          skipped_items: healthSkippedItems,
        }
        : null,
    });
    const summary = summarizeAutoPromoteHealth({
      blockedReason,
      belowFloor,
      belowLanes,
      triggered,
      ready: plan.before.build_ready,
      rawReady: capacityFuel.readyBuild.length,
      floor: config.auto_promote_floor,
      inFlight: capacityFuel.inFlightBuild.length,
      maxInFlight: config.max_in_flight,
      capacityOccupied: capacityFuel.capacityOccupied,
      lanes: plan.before.build_lanes,
      minLanes: config.auto_promote_min_lanes,
      candidates: candidatesConsidered,
      promoted: promotedCount,
      skipped: triggered ? skippedItems.length : 0,
      topReason: topSkipReasons[0]?.reason ?? null,
      blockerClassCounts,
      priorDispatchStatusCounts,
      nextAction,
    });

    return {
      enabled: config.auto_flesh_enabled && config.auto_promote_enabled,
      blocked_reason: blockedReason,
      min_ready_fuel: config.min_ready_fuel,
      floor: config.auto_promote_floor,
      min_ready_lanes: config.auto_promote_min_lanes,
      lanes: {
        build_ready: capacityFuel.readyBuild.length,
        build_in_flight: capacityFuel.inFlightBuild.length,
        ready_plus_in_flight: plan.before.build_ready,
        capacity_occupied: capacityFuel.capacityOccupied,
        build_ready_lanes: plan.before.build_lanes,
        ready_lane_keys: readyLaneKeys,
        in_flight_lane_keys: inFlightLaneKeys,
        candidate_lane_keys: candidateLaneKeys,
      },
      below_floor: belowFloor,
      below_lanes: belowLanes,
      triggered,
      candidates_considered: candidatesConsidered,
      candidates: triggered
        ? needsReview.map((item) => ({
          item_id: item.item_id,
          title: item.title,
          lane: laneKeyOf(item),
          risk_class: item.risk_class,
          to_agent: item.to_agent,
          flesh_confidence: item.flesh_confidence,
        }))
        : [],
      promoted_count: promotedCount,
      promoted_items: blockedReason ? [] : promotedItems,
      skipped_count: triggered ? skippedItems.length : 0,
      skipped_items: triggered ? healthSkippedItems : [],
      top_skip_reasons: triggered ? topSkipReasons : [],
      blocker_class_counts: blockerClassCounts,
      next_action: nextAction,
      operator_summary: operatorSummary,
      empty_pipe_alert: emptyPipeAlert,
      ready_runtime_repairs: readyRuntimeRepairs,
      summary,
    };
  }

  private async readyItemBlockers(): Promise<AdmissionContext["ready_item_blockers"]> {
    const health = await readOrchestrationHealthProjection(this.deps.adapter, this.teamId);
    const out: NonNullable<AdmissionContext["ready_item_blockers"]> = new Map();
    for (const item of health.blockers.needs_clarification.items) {
      for (const blockedId of item.blocked_dependency_item_ids) {
        if (!out.has(blockedId)) {
          out.set(blockedId, {
            code: "clarification_blocker",
            reason: item.reason,
            metadata: { dispatch_phid: item.dispatch_phid, query_id: item.query_id },
          });
        }
      }
    }
    for (const item of health.blockers.promotion.items) {
      for (const blockedId of item.blocked_dependency_item_ids) {
        if (!out.has(blockedId)) {
          out.set(blockedId, {
            code: "promotion_blocker",
            reason: item.reason,
            metadata: { dispatch_phid: item.dispatch_phid, query_id: item.query_id },
          });
        }
      }
    }
    return out;
  }

  private async busyPoolAgents(): Promise<Set<string>> {
    const inFlight = await listBacklogByState(this.deps.adapter, {
      team_id: this.teamId,
      state: "in_flight",
    });
    return new Set(inFlight.map((item) => item.to_agent).filter((agent): agent is string => !!agent));
  }

  private proposeHealthyEquivalentTarget(args: {
    item: BacklogItem;
    unhealthyTarget: string;
    healthyAgents: Set<string> | undefined;
    busyAgents: Set<string>;
    targetAgentRuntimes?: Map<string, string>;
  }): { pool: ResolvedPool; target: string; candidates: string[] } | null {
    if (!args.healthyAgents || !this.deps.pools?.healthyEquivalentTarget) return null;
    return this.deps.pools.healthyEquivalentTarget({
      item: args.item,
      unhealthyTarget: args.unhealthyTarget,
      healthyAgents: args.healthyAgents,
      busyAgents: args.busyAgents,
      targetAgentRuntimes: args.targetAgentRuntimes,
    });
  }

  private targetUnhealthyRerouteReceipt(args: {
    item: BacklogItem;
    unhealthyTarget: string;
    proposedHealthyTarget: string | null;
    action: "rerouted" | "held";
    reason: string;
    outcomes?: Map<string, DispatchOutcome>;
  }): Record<string, unknown> {
    return {
      schema_version: "orchestration.target_unhealthy_reroute_receipt.v1",
      code: "target_unhealthy",
      action: args.action,
      unhealthy_target: args.unhealthyTarget,
      proposed_healthy_target: args.proposedHealthyTarget,
      prior_owner: args.item.to_agent,
      item_id: args.item.item_id,
      title: args.item.title,
      prior_dispatch_evidence: priorDispatchEvidence(args.item, args.outcomes),
      duplicate_retry_refired: false,
      reason: args.reason,
    };
  }

  private async rerouteTargetUnhealthyReadyRows(args: {
    items: BacklogItem[];
    healthyAgents: Set<string> | undefined;
    targetAgentRuntimes?: Map<string, string>;
    dryRun: boolean;
  }): Promise<{ changed: boolean; decisions: DecisionRecord[] }> {
    if (!args.healthyAgents || !this.deps.pools?.healthyEquivalentTarget) return { changed: false, decisions: [] };
    const busyAgents = await this.busyPoolAgents();
    const priorOutcomes = await getDispatchOutcomesByPhid(
      this.deps.adapter,
      args.items.map((item) => item.last_dispatch_phid).filter((phid): phid is string => !!phid),
    );
    const decisions: DecisionRecord[] = [];
    let changed = false;

    for (const item of args.items) {
      const unhealthyTarget = item.to_agent?.trim();
      if (!unhealthyTarget || args.healthyAgents.has(unhealthyTarget)) continue;

      const proposal = this.proposeHealthyEquivalentTarget({
        item,
        unhealthyTarget,
        healthyAgents: args.healthyAgents,
        busyAgents,
        targetAgentRuntimes: args.targetAgentRuntimes,
      });

      if (item.last_dispatch_phid) {
        const reason = `held target_unhealthy row for ${unhealthyTarget}; prior dispatch ${item.last_dispatch_phid} requires duplicate-retry review before any reroute/refire`;
        decisions.push({
          item_id: item.item_id,
          action: "target_unhealthy_reroute",
          reason,
          dispatch_phid: item.last_dispatch_phid,
          metadata: {
            receipt: this.targetUnhealthyRerouteReceipt({
              item,
              unhealthyTarget,
              proposedHealthyTarget: proposal?.target ?? null,
              action: "held",
              reason,
              outcomes: priorOutcomes,
            }),
          },
        });
        continue;
      }

      if (!proposal) {
        const reason = `held target_unhealthy row for ${unhealthyTarget}; no healthy same-pool equivalent target is currently available`;
        decisions.push({
          item_id: item.item_id,
          action: "target_unhealthy_reroute",
          reason,
          metadata: {
            receipt: this.targetUnhealthyRerouteReceipt({
              item,
              unhealthyTarget,
              proposedHealthyTarget: null,
              action: "held",
              reason,
              outcomes: priorOutcomes,
            }),
          },
        });
        continue;
      }

      const reason = `${args.dryRun ? "would reroute" : "rerouted"} target_unhealthy ready row from ${unhealthyTarget} to healthy equivalent ${proposal.target} in pool ${proposal.pool.pool_id}`;
      if (!args.dryRun) {
        const updated = await updateBacklogFields(
          this.deps.adapter,
          item.item_id,
          { to_agent: proposal.target },
          { updated_by: "continuous-orchestration" },
        );
        if (updated) changed = true;
      }
      decisions.push({
        item_id: item.item_id,
        action: "target_unhealthy_reroute",
        reason,
        metadata: {
          pool_id: proposal.pool.pool_id,
          unhealthy_target: unhealthyTarget,
          proposed_healthy_target: proposal.target,
          candidate_targets: proposal.candidates,
          dry_run: args.dryRun,
          receipt: this.targetUnhealthyRerouteReceipt({
            item,
            unhealthyTarget,
            proposedHealthyTarget: proposal.target,
            action: args.dryRun ? "held" : "rerouted",
            reason,
            outcomes: priorOutcomes,
          }),
        },
      });
    }

    return { changed, decisions };
  }

  private async nonUsefulProviderRuntimeReadyFuelIds(ready: BacklogItem[]): Promise<Set<string>> {
    const readyBuild = ready.filter((item) => item.risk_class === "build");
    if (readyBuild.length === 0 || !this.deps.resolveAgentRuntimes) return new Set();
    const agentNames = readyBuild.map((item) => item.to_agent).filter((name): name is string => !!name);
    const runtimes = await this.deps.resolveAgentRuntimes([...new Set(agentNames)]);
    return new Set(
      readyBuild
        .filter((item) =>
          providerRuntimeMismatch(item, item.to_agent, item.to_agent ? runtimes.get(item.to_agent) : undefined),
        )
        .map((item) => item.item_id),
    );
  }

  /**
   * COMPLETION RECONCILIATION + STALE REAPER — the missing half of the loop.
   * Releases the write-scope lock of already-dispatched items whose dispatch has finished.
   *
   * Per queued/in_flight backlog item:
   *  - dispatch TERMINAL (done/failed/cancelled) → release immediately:
   *    done→done, cancelled→cancelled, failed→needs_review (a human/approval
   *    gate re-promotes rather than the loop auto-retrying a failure).
   *  - in_flight dispatch UNRESOLVABLE (missing row / null phid) AND stuck past
   *    stale_in_flight_ms → reaper releases it to needs_review (self-heals missed
   *    completions, pruned rows, daemon restarts).
   *  - queued dispatch UNRESOLVABLE → LEFT ALONE: without clear dispatch terminal
   *    evidence, preserving it avoids a duplicate re-fire.
   *  - dispatch resolvable but NON-terminal (active/queued/needs_clarification)
   *    and fresh → LEFT ALONE: the scheduler owns its recovery; reaping a live
   *    build would double-fire.
   *  - dispatch resolvable but NON-terminal and stale → release to needs_review
   *    so a parked clarification or zombie build cannot hold a write scope
   *    indefinitely.
   *
   * Runs every tick BEFORE readInFlight so freed lanes are admissible the same
   * tick. Dry-run mirrors the refuel posture: compute + log "would_reconcile",
   * mutate nothing.
   */
  private async reconcileDispatchedItems(nowMs: number, dryRun: boolean): Promise<DecisionRecord[]> {
    const [queuedItems, inFlightItems] = await Promise.all([
      listBacklogByState(this.deps.adapter, {
        team_id: this.teamId,
        state: "queued",
      }),
      listBacklogByState(this.deps.adapter, {
        team_id: this.teamId,
        state: "in_flight",
      }),
    ]);
    const items = [...queuedItems, ...inFlightItems];
    if (items.length === 0) return [];

    const phids = items.map((i) => i.last_dispatch_phid).filter((p): p is string => !!p);
    const states = this.deps.resolveDispatchStates
      ? await this.deps.resolveDispatchStates(phids)
      : new Map<string, string>();
    const staleMs = this.deps.config.stale_in_flight_ms;
    const poolStaleMs = this.deps.config.pool_stale_in_flight_ms;
    const out: DecisionRecord[] = [];

    for (const item of items) {
      const phid = item.last_dispatch_phid;
      const status = phid ? states.get(phid) : undefined;
      let toState: ReadinessState | null = null;
      let via = "";
      let reason = "";

      if (status && TERMINAL_DISPATCH_STATUSES.has(status)) {
        toState = status === "done" ? "done" : status === "cancelled" ? "cancelled" : "needs_review";
        via = "completion";
        reason = `dispatch ${status} → ${toState} (lock released)`;
      } else if (item.readiness_state === "in_flight") {
        // Non-terminal: either RESOLVABLE-but-stuck (the dispatch is still
        // in_flight/queued because its worker died, was killed, or is parked,
        // and the scheduler isn't recovering it) OR UNRESOLVABLE (pruned/
        // missing row, null phid). Both are PHANTOM LOCKS once aged out. A
        // needs_clarification dispatch is also a lock candidate once stale:
        // the dispatch may remain parked for operator input, but its backlog
        // row must not hold the write scope indefinitely.
        // This is the build-POOL strangle: Stage C routes each build to its own
        // worktree, and a dead pool worker's dispatch frequently never reaches a
        // terminal status — so without this it would hold its pool slot +
        // write-scope lock forever (the recurring "pool capacity full / single-
        // writer lane busy with nothing running" failure). Previously only the
        // UNRESOLVABLE branch reaped; resolvable-but-stuck zombies were left.
        //
        // The stale window is the safety: a genuinely-live build completes (or its
        // worker stays alive, refreshing progress) well within it, so only
        // phantoms are reaped. Release to needs_review — a human/approval gate,
        // NEVER an auto-refire, so a reaped-but-secretly-live build cannot
        // double-fire; and pool builds hold DISTINCT worktree write-scopes, so
        // freeing one lock can never collide with another build's scope.
        // A POOL build holds a DISTINCT worktree write_scope (Stage C late-binds
        // `write_scope: [wt.path]`), so reaping it can never collide with another
        // build — it's safe to reap fast. The shared-scope (single-writer) lane
        // keeps the long window so a live build is never reaped mid-run.
        const isPoolBuild = item.write_scope.some((s) => s.includes("/.worktrees/"));
        const window = isPoolBuild ? poolStaleMs : staleMs;
        const ageMs = nowMs - Date.parse(item.updated_at);
        if (Number.isFinite(ageMs) && ageMs > window) {
          toState = "needs_review";
          via = "reaper";
          reason = `stale ${isPoolBuild ? "pool " : ""}in_flight ${Math.round(ageMs / 60_000)}m, dispatch ${status ?? "unresolvable"} (non-terminal) → needs_review (phantom lock released)`;
        }
      }

      if (!toState) continue;
      if (!dryRun) {
        await setItemState(this.deps.adapter, item.item_id, toState);
      }
      out.push({
        item_id: item.item_id,
        action: dryRun ? "would_reconcile" : "reconciled",
        reason,
        dispatch_phid: phid,
        metadata: { via, dispatch_status: status ?? null, to_state: toState },
      });
    }
    return out;
  }

  /**
   * Stage C: build the per-pool admission gate from the current in-flight builds
   * and the ready candidates. For each pool that appears, free_slots =
   * max_parallel − current in-flight, and free_builders = members not currently
   * building (and online/healthy per the routing seam), in preference order.
   * Returns null when no pool routing is wired (legacy single-lane behavior).
   */
  private async buildPoolGate(candidates: BacklogItem[]): Promise<{
    pool_for: (item: BacklogItem) => string | null;
    pool_free_slots: Map<string, number>;
    pool_free_builders: Map<string, string[]>;
    pool_lane_blockers: Map<string, PoolLaneBlocker[]>;
  } | null> {
    const pools = this.deps.pools;
    if (!pools) return null;

    const inFlight = await listBacklogByState(this.deps.adapter, {
      team_id: this.teamId,
      state: "in_flight",
    });
    const resolved = new Map<string, ResolvedPool>();
    const building = new Map<string, Set<string>>();
    const inFlightCount = new Map<string, number>();

    for (const it of inFlight) {
      const p = pools.poolForItem(it);
      if (!p) continue;
      resolved.set(p.pool_id, p);
      inFlightCount.set(p.pool_id, (inFlightCount.get(p.pool_id) ?? 0) + 1);
      if (it.to_agent) {
        const set = building.get(p.pool_id) ?? new Set<string>();
        set.add(it.to_agent);
        building.set(p.pool_id, set);
      }
    }
    for (const it of candidates) {
      const p = pools.poolForItem(it);
      if (p) resolved.set(p.pool_id, p);
    }

    const pool_free_slots = new Map<string, number>();
    const pool_free_builders = new Map<string, string[]>();
    const pool_lane_blockers = new Map<string, PoolLaneBlocker[]>();
    for (const [pid, pool] of resolved) {
      const buildingSet = building.get(pid) ?? new Set<string>();
      const available = pools.availableBuilders(pool, buildingSet);
      const runnableBuilders = available.filter((agent) => !isVirtualPoolTarget(agent));
      const virtualBuilders = available.filter(isVirtualPoolTarget);
      pool_free_slots.set(pid, Math.max(0, pool.max_parallel - (inFlightCount.get(pid) ?? 0)));
      pool_free_builders.set(pid, runnableBuilders);
      pool_lane_blockers.set(
        pid,
        [
          ...pool.members
            .filter((agent) => buildingSet.has(agent))
            .map((agent) => ({
              agent,
              code: "lane_busy",
              reason: "builder already has an in-flight pool item",
            })),
          ...virtualBuilders.map((agent) => ({
            agent,
            code: "virtual_pool_alias",
            reason: "virtual pool aliases are dispatch targets, not runnable builder agents",
          })),
        ],
      );
    }

    return {
      pool_for: (item: BacklogItem) => pools.poolForItem(item)?.pool_id ?? null,
      pool_free_slots,
      pool_free_builders,
      pool_lane_blockers,
    };
  }

  private applyPoolHealthGate(
    poolGate: {
      pool_free_builders: Map<string, string[]>;
      pool_lane_blockers: Map<string, PoolLaneBlocker[]>;
    },
    healthyAgents: Set<string> | undefined,
  ): Map<string, PoolLaneBlocker[]> {
    const blockers = new Map<string, PoolLaneBlocker[]>();
    for (const [poolId, entries] of poolGate.pool_lane_blockers) blockers.set(poolId, [...entries]);
    if (!healthyAgents) return blockers;

    for (const [poolId, builders] of poolGate.pool_free_builders) {
      const healthyBuilders = builders.filter((agent) => healthyAgents.has(agent));
      const unhealthyBuilders = builders.filter((agent) => !healthyAgents.has(agent));
      poolGate.pool_free_builders.set(poolId, healthyBuilders);
      if (unhealthyBuilders.length > 0) {
        blockers.set(poolId, [
          ...(blockers.get(poolId) ?? []),
          ...unhealthyBuilders.map((agent) => ({
            agent,
            code: "target_unhealthy",
            reason: "agent is not healthy/online",
          })),
        ]);
      }
    }
    return blockers;
  }

  /**
   * Auto-flesh refuel gate. Runs a flesh pass when the feature is enabled, the
   * daemon is running/unblocked, and READY fuel is below the threshold at a
   * batch load-point (or fully dry). Returns the summary, or null when skipped.
   * Mirrors the daemon's dry-run posture: a dry-run daemon fleshes dry.
   */
  private async maybeRefuel(args: {
    config: DaemonDeps["config"];
    mode: OrchestrationMode;
    killSwitch: boolean;
    hardPaused: boolean;
    nowMs: number;
    dailyTokensUsed: number;
    /** Slice 4: per-tick flesh budget (defaults to config.max_flesh_per_tick). */
    fleshLimit?: number;
  }): Promise<FleshRunSummary | null> {
    const { config } = args;
    if (!config.auto_flesh_enabled) return null;
    if (args.mode !== "running" || args.killSwitch || args.hardPaused) return null;

    const [ready, inFlight] = await Promise.all([
      listReadyItems(this.deps.adapter, this.teamId),
      listBacklogByState(this.deps.adapter, { team_id: this.teamId, state: "in_flight" }),
    ]);
    if (inFlight.length >= config.max_in_flight) return null;
    const floorReady = [...ready, ...inFlight];
    // T-ORCH P0 (continuous self-refuel): refuel on ANY tick where READY fuel is
    // below threshold — not only at the 3 batch load-points. Low ready-fuel
    // auto-promotes+fleshes backlog items into READY as the daemon drains them,
    // so an unattended run never starves after the initial ready items.
    //
    // ADMISSION-V2 parallel-fuel floor: also refuel when READY spans too FEW
    // distinct lanes (even if the total is fine) so the parallel pool stays fed
    // across lanes, not just in aggregate.
    if (!needsRefuel(floorReady, { minReadyFuel: config.min_ready_fuel, minReadyLanes: config.min_ready_lanes })) {
      return null;
    }

    const remaining = Math.max(0, config.daily_token_ceiling - args.dailyTokensUsed);
    try {
      return await runFleshPass(this.deps.adapter, config, {
        teamId: this.teamId,
        dry_run: config.dry_run,
        limit: Math.min(config.max_flesh_per_tick, args.fleshLimit ?? config.max_flesh_per_tick),
        actor: "continuous-orchestration",
        remaining_daemon_budget: remaining,
      });
    } catch (err) {
      console.error("[orchestration] refuel error:", err);
      return null;
    }
  }

  private async runStallWatchdogRefuel(args: {
    config: DaemonDeps["config"];
    dailyTokensUsed: number;
  }): Promise<FleshRunSummary | null> {
    const remaining = Math.max(0, args.config.daily_token_ceiling - args.dailyTokensUsed);
    try {
      return await runFleshPass(this.deps.adapter, args.config, {
        teamId: this.teamId,
        dry_run: args.config.dry_run,
        limit: args.config.max_flesh_per_tick,
        actor: "continuous-orchestration-stall-watchdog",
        remaining_daemon_budget: remaining,
      });
    } catch (err) {
      console.error("[orchestration] stall watchdog refuel error:", err);
      return null;
    }
  }

  private async emitFleetBlockage(message: string, data: Record<string, unknown>): Promise<void> {
    if (!this.deps.emitNews) return;
    try {
      await this.deps.emitNews({ type: "fleet.blockage", message, data });
    } catch (err) {
      console.error("[orchestration] fleet blockage news emit failed:", err);
    }
  }

  private async emitModelPolicyDrift(message: string, data: Record<string, unknown>): Promise<void> {
    if (!this.deps.emitNews) return;
    try {
      await this.deps.emitNews({ type: "model_policy.drift", message, data });
    } catch (err) {
      console.error("[orchestration] model-policy drift news emit failed:", err);
    }
  }

  /**
   * Floor-triggered AUTO-PROMOTE (ADMISSION-V2 follow-up). Before fleshing new
   * skeletons (token-costly), drain the cheap backlog: when build-ready fuel is
   * below the floor, promote already-fleshed, safe `needs_review` build items to
   * READY per-lane. Subordinate to auto_flesh_enabled (the autonomous master
   * switch) + auto_promote_enabled. Reuses the flesh-policy safety gate — never
   * promotes approval-gated/destructive work. Mutates only when live (dry-run
   * computes + logs the would-promote set).
   */
  private async maybeAutoPromote(args: {
    config: DaemonDeps["config"];
    mode: OrchestrationMode;
    killSwitch: boolean;
    hardPaused: boolean;
  }): Promise<AutoPromoteRunSummary | null> {
    const { config } = args;
    if (!config.auto_flesh_enabled || !config.auto_promote_enabled) return null;
    if (args.mode !== "running" || args.killSwitch || args.hardPaused) return null;

    try {
      const [ready, needsReview, inFlight] = await Promise.all([
        listReadyItems(this.deps.adapter, this.teamId),
        listBacklogByState(this.deps.adapter, { team_id: this.teamId, state: "needs_review" }),
        listBacklogByState(this.deps.adapter, { team_id: this.teamId, state: "in_flight" }),
      ]);
      const nonUsefulReadyFuelIds = await this.nonUsefulProviderRuntimeReadyFuelIds(ready);
      const capacityFuel = buildCapacityFuel(ready, inFlight, config.max_in_flight, nonUsefulReadyFuelIds);
      if (capacityFuel.capacityOccupied) return null;
      const plan = selectAutoPromotions(needsReview, capacityFuel.floorItems, {
        floor: config.auto_promote_floor,
        minLanes: config.auto_promote_min_lanes,
        maxPerPass: config.auto_promote_max_per_tick,
      });
      if (!plan.triggered) return null;

      let promoted = 0;
      if (!config.dry_run) {
        for (const item of plan.promote) {
          const res = await promoteToReady(this.deps.adapter, item.item_id, "auto-promote-policy");
          if (res.ok) promoted += 1;
        }
      } else {
        promoted = plan.promote.length; // would-promote count
      }
      const blockerClassCounts = blockerClassCountsFrom(plan.skipped);
      return {
        triggered: true,
        promoted,
        skipped: plan.skipped.length,
        candidates_considered: plan.candidates_considered,
        top_skip_reasons: topSkipReasonsFrom(plan.skipped),
        blocker_class_counts: blockerClassCounts,
        next_action: nextAutoPromoteAction({
          blockedReason: null,
          belowFloor: plan.before.build_ready < config.auto_promote_floor,
          belowLanes: plan.before.build_lanes < config.auto_promote_min_lanes,
          triggered: plan.triggered,
          candidates: plan.candidates_considered,
          promoted,
          blockerClassCounts,
        }),
        skipped_items: plan.skipped,
        before: plan.before,
        dry_run: config.dry_run,
      };
    } catch (err) {
      console.error("[orchestration] auto-promote error:", err);
      return null;
    }
  }

  /** Start the loop. No-op (with a log) when disabled. Slice 4: a self-scheduling
   *  setTimeout loop (not a fixed setInterval) so the cadence can adaptively back
   *  off after slow ticks and recover after fast ones. */
  start(): void {
    if (!this.deps.config.enabled) {
      console.log("[orchestration] daemon DISABLED (set CONTINUOUS_ORCHESTRATION_ENABLED=true to arm); not ticking.");
      return;
    }
    if (this.timer) return;
    this.stopped = false;
    this.backoffMult = 1;
    const mode = this.deps.config.dry_run ? "DRY-RUN" : "LIVE";
    console.log(`[orchestration] daemon armed in ${mode}; base tick ${this.deps.config.tick_interval_ms}ms (adaptive backoff up to ×${this.deps.config.backoff_max}).`);
    this.scheduleNext(this.deps.config.tick_interval_ms);
  }

  /** Arm the next tick. Each fired tick measures its wall-time and uses
   *  computeNextDelay to pick the following delay (adaptive backoff). */
  private scheduleNext(delayMs: number): void {
    this.timer = setTimeout(() => {
      void this.tickAndReschedule();
    }, delayMs);
    if (typeof this.timer.unref === "function") this.timer.unref();
  }

  private async tickAndReschedule(): Promise<void> {
    const startedMs = Date.now();
    try {
      await this.runTick();
    } catch (err) {
      console.error("[orchestration] tick error:", err);
    }
    if (this.stopped) return; // stop() called during the tick — don't re-arm.
    const lastTickMs = Date.now() - startedMs;
    const { delayMs, mult } = computeNextDelay(
      this.deps.config.tick_interval_ms,
      lastTickMs,
      this.deps.config.slow_tick_ms,
      this.deps.config.backoff_max,
      this.backoffMult,
    );
    this.backoffMult = mult;
    this.scheduleNext(delayMs);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  setMode(mode: OrchestrationMode, opts: { clear_auto_pause?: boolean } = {}): Promise<void> {
    return setMode(this.deps.adapter, this.teamId, mode, opts);
  }

  getState() {
    return getOrchestrationState(this.deps.adapter, this.teamId);
  }
}

async function buildAutoPromoteOperatorSummary(
  adapter: DbAdapter,
  args: {
    triggered: boolean;
    ready: number;
    candidatesConsidered: number;
    needsReview: BacklogItem[];
    skippedItems: Array<{ item_id: string; reasons: string[] }>;
    capacityOccupied: boolean;
    readyRows: number;
    readyPlusInFlight: number;
    buildReadyLanes: number;
    minLanes: number;
  },
): Promise<AutoPromoteOperatorSummary> {
  const outcomes = await getDispatchOutcomesByPhid(
    adapter,
    args.needsReview.map((item) => item.last_dispatch_phid).filter((phid): phid is string => !!phid),
  );
  let retryableFailedRows = 0;
  let staleDuplicateRows = 0;
  let waitingOnLiveDispatchRows = 0;
  let nonRetryableFailedRows = 0;
  const duplicateDispatchRetryRequiredExamples: AutoPromoteOperatorSummary["duplicate_dispatch_retry_required_examples"] = [];
  for (const item of args.needsReview) {
    const readiness = deriveBacklogRetryReadiness(item, outcomes.get(item.last_dispatch_phid ?? ""));
    if (readiness.status === "retryable_failed_row") retryableFailedRows += 1;
    if (readiness.status === "stale_duplicate") staleDuplicateRows += 1;
    if (readiness.status === "waiting_on_live_dispatch") waitingOnLiveDispatchRows += 1;
    if (readiness.status === "non_retryable_failed_row" || readiness.status === "retry_cap_reached") {
      nonRetryableFailedRows += 1;
    }
    if (
      item.last_dispatch_phid &&
      readiness.status !== "not_retry_candidate" &&
      duplicateDispatchRetryRequiredExamples.length < 3
    ) {
      duplicateDispatchRetryRequiredExamples.push({
        item_id: item.item_id,
        prior_dispatch_phid: item.last_dispatch_phid,
        retry_readiness_status: readiness.status,
      });
    }
  }

  const confidenceHeldRows = args.skippedItems.filter((item) =>
    item.reasons.some((reason) => autoPromoteBlockerClass(reason) === "confidence_threshold"),
  ).length;
  const hasGatedFuel =
    args.ready > 0 ||
    args.readyRows > 0 ||
    args.readyPlusInFlight > 0 ||
    args.candidatesConsidered > 0 ||
    retryableFailedRows > 0 ||
    staleDuplicateRows > 0 ||
    waitingOnLiveDispatchRows > 0 ||
    nonRetryableFailedRows > 0 ||
    confidenceHeldRows > 0;
  const laneDiversityDeficit = Math.max(0, args.minLanes - args.buildReadyLanes);
  const laneDiversityTopoffNeeded = laneDiversityDeficit > 0;
  const safeActions: string[] = [];
  if (args.capacityOccupied) {
    safeActions.push(
      `Capacity is full with ready_plus_in_flight=${args.readyPlusInFlight}; wait for an in-flight build slot before dispatching additional ready rows.`,
    );
  }
  if (laneDiversityTopoffNeeded) {
    safeActions.push(
      `Top off lane diversity by adding or promoting build-ready work in ${laneDiversityDeficit} new lane(s).`,
    );
  }
  if (retryableFailedRows > 0) {
    safeActions.push(
      "For retryable failed duplicate rows, use the explicit retry_safe=true gate before a bounded refire; do not auto-refire.",
    );
  }
  if (staleDuplicateRows > 0) {
    safeActions.push(
      "For stale duplicate rows whose prior dispatch is done, moot, or superseded, close them with a stale_duplicate_closeout_receipt; do not refire.",
    );
  }
  if (waitingOnLiveDispatchRows > 0) {
    safeActions.push(
      "For waiting_on_live_dispatch rows, wait on the prior dispatch or supersede after operator review; do not refire while the prior dispatch is live or unreadable.",
    );
  }
  if (nonRetryableFailedRows > 0) {
    safeActions.push(
      "For non_retryable_failed_row rows, supersede or replace after operator review; do not mark retry_safe for an automatic refire.",
    );
  }
  if (confidenceHeldRows > 0) {
    safeActions.push("Re-flesh confidence-held rows or manually approve them after review.");
  }
  if (safeActions.length === 0) {
    safeActions.push("Inspect skipped_items before approving or refueling candidates.");
  }
  if (hasGatedFuel) {
    safeActions.push("Treat this as gated fuel; rows exist but require operator gates.");
  }

  const gates = [
    args.capacityOccupied ? "capacity full" : null,
    laneDiversityTopoffNeeded ? `lane diversity ${args.buildReadyLanes}/${args.minLanes}` : null,
  ].filter((part): part is string => part != null);
  const prefix = hasGatedFuel
    ? gates.length > 0
      ? `gated fuel (${gates.join(", ")}):`
      : "gated fuel:"
    : "no ready or needs_review build fuel is currently visible";
  const capacityDetail = args.capacityOccupied ? ` ready_plus_in_flight=${args.readyPlusInFlight};` : "";
  const summary = hasGatedFuel
    ? `${prefix}${capacityDetail} retryable_failed_rows=${retryableFailedRows}, stale_duplicate_rows=${staleDuplicateRows}, waiting_on_live_dispatch_rows=${waitingOnLiveDispatchRows}, non_retryable_failed_rows=${nonRetryableFailedRows}, confidence_held_rows=${confidenceHeldRows}; safe actions: ${safeActions.join(" ")}`
    : "no ready or needs_review build fuel is currently visible";
  return {
    schema_version: "orchestration.auto_promote_operator_summary.v1",
    retryable_failed_rows: retryableFailedRows,
    stale_duplicate_rows: staleDuplicateRows,
    waiting_on_live_dispatch_rows: waitingOnLiveDispatchRows,
    non_retryable_failed_rows: nonRetryableFailedRows,
    confidence_held_rows: confidenceHeldRows,
    duplicate_dispatch_retry_required_examples: duplicateDispatchRetryRequiredExamples,
    capacity_gated: args.capacityOccupied,
    lane_diversity_topoff_needed: laneDiversityTopoffNeeded,
    lane_diversity_deficit: laneDiversityDeficit,
    safe_actions: safeActions,
    empty_fuel: !hasGatedFuel,
    summary,
  };
}

function topSkipReasonsFrom(
  skipped: Array<{ reasons: string[] }>,
): Array<{ reason: string; count: number }> {
  const counts = new Map<string, number>();
  for (const item of skipped) {
    for (const reason of item.reasons) counts.set(reason, (counts.get(reason) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason))
    .slice(0, 5);
}

function buildCapacityFuel(
  ready: BacklogItem[],
  inFlight: BacklogItem[],
  maxInFlight: number,
  nonUsefulReadyItemIds: Set<string> = new Set(),
): {
  readyBuild: BacklogItem[];
  inFlightBuild: BacklogItem[];
  floorItems: BacklogItem[];
  capacityOccupied: boolean;
} {
  const readyBuild = ready.filter((item) => item.risk_class === "build");
  const usefulReadyBuild = readyBuild.filter(
    (item) => isUsefulReadyFuelItem(item) && !nonUsefulReadyItemIds.has(item.item_id),
  );
  const inFlightBuild = inFlight.filter((item) => item.risk_class === "build");
  return {
    readyBuild,
    inFlightBuild,
    floorItems: [...usefulReadyBuild, ...inFlightBuild],
    capacityOccupied: maxInFlight > 0 && inFlight.length >= maxInFlight,
  };
}

function autoPromoteBlockerClass(reason: string): AutoPromoteBlockerClass {
  if (reason.includes("already dispatched once")) return "already_dispatched";
  if (reason.includes("blocked dependencies") || reason.includes("dependency")) return "blocked_dependencies";
  if (reason.includes("risk_class") || reason.includes("high-risk denylist")) return "review_held_risk";
  if (reason.includes("confidence") || reason.includes("flesh_confidence")) return "confidence_threshold";
  if (reason.includes("missing to_agent") || reason.includes("not fleshed")) return "not_fleshed";
  if (reason.includes("empty write_scope")) return "missing_lane";
  if (reason.startsWith("state ")) return "wrong_state";
  return "other";
}

function autoPromoteBlockerLabel(cls: AutoPromoteBlockerClass): string {
  switch (cls) {
    case "already_dispatched": return "already-dispatched rows";
    case "review_held_risk": return "review-held risk classes";
    case "blocked_dependencies": return "blocked dependencies";
    case "confidence_threshold": return "confidence threshold";
    case "not_fleshed": return "not fleshed";
    case "missing_lane": return "missing lane";
    case "wrong_state": return "wrong state";
    case "other": return "other";
  }
}

function blockerClassCountsFrom(
  skipped: Array<{ reasons: string[] }>,
): AutoPromoteBlockerClassCount[] {
  const counts = new Map<AutoPromoteBlockerClass, number>();
  for (const item of skipped) {
    const classes = new Set(item.reasons.map(autoPromoteBlockerClass));
    for (const cls of classes) counts.set(cls, (counts.get(cls) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([cls, count]) => ({ class: cls, count, label: autoPromoteBlockerLabel(cls) }))
    .sort((a, b) => b.count - a.count || a.class.localeCompare(b.class));
}

function alreadyDispatchedStatusCounts(
  skipped: AutoPromoteHealthSkippedItem[],
): { done: number; retryable: number; unknown: number } {
  let done = 0;
  let retryable = 0;
  let unknown = 0;
  for (const item of skipped) {
    if (!item.reasons.some((reason) => autoPromoteBlockerClass(reason) === "already_dispatched")) continue;
    const status = item.prior_dispatch_status;
    if (status === "done" || status === "moot" || status === "cancelled" || status === "superseded") done += 1;
    else if (status === "failed") retryable += 1;
    else unknown += 1;
  }
  return { done, retryable, unknown };
}

function emptyPipeNextAction(cls: AutoPromoteBlockerClass): string | null {
  switch (cls) {
    case "confidence_threshold":
      return "needs a human /promote decision or Chris batch review";
    case "already_dispatched":
      return "needs reconciliation (verify done-vs-failed per output/2026-07-11-needs-review-promotion-reconciliation.md) or a fresh authored wave";
    default:
      return null;
  }
}

function autoPromoteEmptyPipeAlertFrom(args: {
  ready: number;
  admissibleReady: number | null;
  autoPromote: Pick<AutoPromoteRunSummary, "triggered" | "promoted" | "skipped" | "candidates_considered" | "skipped_items"> | null;
}): AutoPromoteEmptyPipeAlert {
  const inactive = (reason: string | null = null): AutoPromoteEmptyPipeAlert => ({
    active: false,
    ready: args.ready,
    admissible_now: args.admissibleReady ?? 0,
    reason,
    message: null,
    items: [],
  });
  if (args.ready !== 0 || args.admissibleReady !== 0) return inactive();
  const autoPromote = args.autoPromote;
  if (!autoPromote?.triggered) return inactive("auto_promote_not_triggered");
  if (autoPromote.promoted !== 0) return inactive("auto_promote_has_promotions");
  if (autoPromote.candidates_considered === 0) return inactive("no_needs_review_candidates");
  if (autoPromote.skipped !== autoPromote.candidates_considered) return inactive("not_every_candidate_skipped");

  const allowed = new Set<AutoPromoteBlockerClass>(["confidence_threshold", "already_dispatched"]);
  const items: AutoPromoteEmptyPipeAlertItem[] = [];
  for (const item of autoPromote.skipped_items) {
    const blockerClasses = [...new Set(item.reasons.map(autoPromoteBlockerClass))].sort();
    if (blockerClasses.length === 0 || blockerClasses.some((cls) => !allowed.has(cls))) {
      return inactive("skips_include_other_reasons");
    }
    const nextActions = [...new Set(blockerClasses.map(emptyPipeNextAction).filter((x): x is string => x != null))];
    items.push({
      item_id: item.item_id,
      blocker_classes: blockerClasses,
      next_actions: nextActions,
      reasons: item.reasons,
    });
  }

  const actionSummary = items
    .map((item) => `${item.item_id}: ${item.next_actions.join("; ")}`)
    .join(" | ");
  return {
    active: true,
    ready: args.ready,
    admissible_now: args.admissibleReady,
    reason: "ready_and_admissible_zero_all_needs_review_skipped_by_confidence_or_already_dispatched",
    message:
      `Continuous orchestration empty auto-promote pipe: ready=0, admissible_now=0, ` +
      `all ${items.length} needs_review candidate(s) were skipped by confidence/already-dispatched gates. ` +
      `Next actions: ${actionSummary}`,
    items,
  };
}

function nextAutoPromoteAction(args: {
  blockedReason: string | null;
  belowFloor: boolean;
  belowLanes: boolean;
  triggered: boolean;
  candidates: number;
  promoted: number;
  blockerClassCounts: AutoPromoteBlockerClassCount[];
  priorDispatchStatusCounts?: { done: number; retryable: number; unknown: number };
}): AutoPromoteNextAction {
  if (args.blockedReason) {
    return { code: "none", summary: `clear auto-promote block: ${args.blockedReason}` };
  }
  if (!args.belowFloor && !args.belowLanes) {
    return { code: "none", summary: "ready build fuel meets the configured floor" };
  }
  if (args.promoted > 0) {
    return { code: "none", summary: "auto-promote has safe candidates; let the daemon promote them on the next live tick" };
  }
  if (!args.triggered || args.candidates === 0) {
    return { code: "flesh_or_refuel_candidates", summary: "author new lane-diverse build rows or flesh more needs_review candidates" };
  }

  const top = args.blockerClassCounts[0]?.class;
  switch (top) {
    case "already_dispatched":
      if (args.priorDispatchStatusCounts) {
        const { done, retryable, unknown } = args.priorDispatchStatusCounts;
        if (done > 0 && retryable === 0 && unknown === 0) {
          return { code: "close_stale_already_dispatched_rows", summary: "close stale already-dispatched rows with stale_duplicate_closeout_receipt when prior dispatch is done, moot, or superseded" };
        }
        if (done === 0 && retryable > 0 && unknown === 0) {
          return { code: "manual_promote_safe_retries", summary: "mark retry_safe=true only for an intentional bounded refire of retryable failed rows" };
        }
      }
      return { code: "manual_promote_or_close_already_dispatched", summary: "close stale duplicates with stale_duplicate_closeout_receipt or mark retry_safe=true only for bounded retryable failed refires" };
    case "review_held_risk":
      return { code: "approve_review_held_risk", summary: "review and explicitly approve held risk classes; auto-promote only moves build risk" };
    case "blocked_dependencies":
      return { code: "resolve_blocked_dependencies", summary: "finish or unblock dependency items before refueling this lane" };
    case "confidence_threshold":
      return { code: "author_lane_diverse_rows", summary: "author new lane-diverse build rows; confidence-held candidates are not auto-promote fuel" };
    default:
      return { code: "flesh_or_refuel_candidates", summary: "author new lane-diverse safe build rows or inspect skipped_items for manual approval" };
  }
}

function summarizeAutoPromoteHealth(args: {
  blockedReason: string | null;
  belowFloor: boolean;
  belowLanes: boolean;
  triggered: boolean;
  ready: number;
  rawReady: number;
  floor: number;
  inFlight: number;
  maxInFlight: number;
  capacityOccupied: boolean;
  lanes: number;
  minLanes: number;
  candidates: number;
  promoted: number;
  skipped: number;
  topReason: string | null;
  blockerClassCounts: AutoPromoteBlockerClassCount[];
  priorDispatchStatusCounts: { done: number; retryable: number; unknown: number };
  nextAction: AutoPromoteNextAction;
}): string {
  if (args.blockedReason) return `auto-promote blocked: ${args.blockedReason}`;
  if (args.capacityOccupied) {
    const fuelState = args.rawReady < args.floor
      ? args.ready < args.floor
        ? "build-ready plus in-flight remains below floor"
        : "build-ready below floor but ready-plus-in-flight capacity covers floor"
      : "build-ready floor satisfied";
    const laneState = args.belowLanes
      ? `; lane diversity topoff needed: add/promote ${Math.max(0, args.minLanes - args.lanes)} new build lane(s)`
      : "; lane diversity satisfied";
    return (
      `${fuelState} but daemon capacity is occupied: ` +
      `build_ready=${args.rawReady}/${args.floor}, ready_plus_in_flight=${args.ready}/${args.floor}, ` +
      `in_flight=${args.inFlight}/${args.maxInFlight}, lanes=${args.lanes}/${args.minLanes}` +
      laneState
    );
  }
  if (!args.belowFloor && !args.belowLanes) {
    return `ready build fuel meets floor: ready=${args.ready} floor=${args.floor}, lanes=${args.lanes}/${args.minLanes}`;
  }
  const blockers = args.blockerClassCounts.length > 0
    ? `; blocker classes: ${args.blockerClassCounts.map((b) => `${b.class}=${b.count}`).join(", ")}`
    : "";
  const alreadyDispatchedStatus = args.priorDispatchStatusCounts.done || args.priorDispatchStatusCounts.retryable || args.priorDispatchStatusCounts.unknown
    ? `; already-dispatched statuses: done=${args.priorDispatchStatusCounts.done}, retryable=${args.priorDispatchStatusCounts.retryable}, unknown=${args.priorDispatchStatusCounts.unknown}`
    : "";
  const next = `; next: ${args.nextAction.summary}`;
  if (!args.triggered || args.candidates === 0) {
    return `ready build fuel below floor: ready=${args.ready} floor=${args.floor}, lanes=${args.lanes}/${args.minLanes}; no needs_review candidates considered${next}`;
  }
  if (args.promoted > 0) {
    return `ready build fuel below floor: ready=${args.ready} floor=${args.floor}, lanes=${args.lanes}/${args.minLanes}; would promote ${args.promoted}, skipped ${args.skipped}${blockers}${alreadyDispatchedStatus}${next}`;
  }
  return `ready build fuel below floor: ready=${args.ready} floor=${args.floor}, lanes=${args.lanes}/${args.minLanes}; promoted 0 of ${args.candidates}, top skip reason: ${args.topReason ?? "none"}${blockers}${alreadyDispatchedStatus}${next}`;
}
