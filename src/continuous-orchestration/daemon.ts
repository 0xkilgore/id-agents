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
import type { DbAdapter } from "../db/db-adapter.js";
import { effectiveAutoPromoteFloor, type ContinuousOrchestrationConfig } from "./config.js";
import type { BacklogItem, DecisionRecord, OrchestrationMode, ReadinessState, UsageGateView } from "./types.js";
import { fairInterleaveByLane, laneKeyOf, needsRefuel, orderCandidates } from "./selection.js";
import { tickAdmitLimit } from "./cadence.js";
import {
  planAdmission,
  evaluateStall,
  shouldRunZeroAdmitStallWatchdog,
  type AdmissionContext,
  type AdmissionPlan,
} from "./admission.js";
import { computeNextDelay, tickWriteCaps } from "./backpressure.js";
import {
  appendDecisions,
  bindItemForFire,
  getOrchestrationState,
  listBacklogByState,
  listDoneItemIds,
  listReadyItems,
  promoteToReady,
  recordTickOutcome,
  repairReadyCodexRuntimeMetadata,
  setItemState,
  setMode,
  type ReadyRuntimeRepair,
} from "./storage.js";
import { runFleshPass, type FleshRunSummary } from "./flesh-runner.js";
import { selectAutoPromotions } from "./auto-promote-policy.js";
import { sendTelegramAlert, type AlertSender } from "./telegram.js";
import { readOrchestrationHealthProjection } from "./health-projection.js";

/** Dispatch/effective statuses that mean the work is finished — its write-scope
 *  lock can be released. Mirrors dispatch terminal states plus recovery moot. */
const TERMINAL_DISPATCH_STATUSES = new Set(["done", "failed", "cancelled", "moot"]);

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
  /** Allocate a distinct worktree for one build off the pool repo. */
  allocateWorktree: (input: { agent: string; item: BacklogItem; pool: ResolvedPool }) => Promise<BuildWorktree>;
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
  decisions: DecisionRecord[];
}

export interface ReadyAdmissionExplanation {
  candidates: number;
  /** Raw READY rows before admission guardrails. */
  raw_ready: number;
  /** READY rows that are useful as immediate dispatch fuel after guardrails. */
  useful_ready: number;
  /** Post-guardrail READY rows that can be dispatched now. */
  admissible_now: number;
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
  }>;
  blocker_counts: Array<{
    code: string;
    category: ReadyAdmissionBlockerCategory;
    owner: string;
    reason_code: string;
    reason_text: string;
    next_action: string;
    count: number;
  }>;
  top_blocking_lanes: Array<{
    lane: string;
    code: string;
    count: number;
    item_ids: string[];
    next_action: string;
  }>;
  /** Same counts keyed by the exact non-admission code for compact UI/API consumers. */
  block_reason_counts: Record<string, number>;
  stale_ready_floor: {
    stale: boolean;
    status: "ok" | "low_ready_fuel" | "capacity_saturated" | "blocked_ready_fuel";
    ready: number;
    admissible: number;
    min_ready_fuel: number;
    reason: string | null;
    summary: string;
    next_action: string;
  };
  halted: string | null;
  ready_runtime_repairs: ReadyRuntimeRepair[];
}

export interface AdmissionBreakdownLane {
  lane: string;
  lane_kind: "pool" | "agent" | "write_scope";
  ready_count: number;
  admitting_count: number;
  stuck_reason: string | null;
  stuck_count: number;
  block_reason_counts: Record<string, number>;
  ready_item_ids: string[];
  admitting_item_ids: string[];
}

export interface AdmissionBreakdownExplanation {
  generated_at: string;
  ready_count: number;
  admitting_count: number;
  lanes: AdmissionBreakdownLane[];
}

export type ReadyAdmissionBlockerCategory =
  | "usage_gate"
  | "capacity_gate"
  | "lane_eligibility"
  | "runtime_unavailable"
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
    ready_lane_keys: string[];
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
  skipped_items: Array<{ item_id: string; reasons: string[] }>;
  top_skip_reasons: Array<{ reason: string; count: number }>;
  blocker_counts: Record<AutoPromoteBlockerClass, number>;
  blocker_classes: Array<{ blocker_class: AutoPromoteBlockerClass; count: number }>;
  next_action: string;
  ready_runtime_repairs: ReadyRuntimeRepair[];
  summary: string;
}

type AutoPromoteBlockerClass =
  | "already_dispatched"
  | "review_held_risk"
  | "blocked_dependencies"
  | "confidence_threshold"
  | "incomplete_flesh"
  | "other";

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
    case "no_in_flight_slots":
    case "tick_admission_cap":
    case "pool_capacity_full":
    case "no_free_pool_builder":
      return "capacity_gate";
    case "risk_requires_approval":
    case "blocked_dependency":
    case "single_writer_lane_busy":
      return "lane_eligibility";
    case "target_unhealthy":
    case "provider_runtime_mismatch":
      return "runtime_unavailable";
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
  const counts = new Map<string, ReadyAdmissionExplanation["blocker_counts"][number]>();
  for (const decision of plan.skipped) {
    const code = typeof decision.metadata?.code === "string" ? decision.metadata.code : "unknown";
    const category = readyAdmissionBlockerCategory(code);
    const key = `${category}:${code}`;
    const existing = counts.get(key);
    if (existing) existing.count += 1;
    else counts.set(key, { code, category, ...readyAdmissionBlockerDetails(code), reason_code: code, count: 1 });
  }
  return [...counts.values()].sort((a, b) => b.count - a.count || a.category.localeCompare(b.category) || a.code.localeCompare(b.code));
}

function readyAdmissionBlockerDetails(code: string): {
  owner: string;
  reason_text: string;
  next_action: string;
} {
  switch (code) {
    case "daily_token_ceiling":
      return {
        owner: "operator",
        reason_text: "Usage gate is blocking new admission.",
        next_action: "Raise the budget, wait for reset, or switch the usage gate to warning mode.",
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
    case "single_writer_lane_busy":
      return {
        owner: "scheduler",
        reason_text: "A write scope for this ready item is already locked.",
        next_action: "Wait for the active writer to finish or split the write scope.",
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
    case "missing_dispatch_target":
      return {
        owner: "orchestration_flesher",
        reason_text: "Ready item is missing a target agent or dispatch body.",
        next_action: "Fill to_agent and dispatch_body, then re-run admission.",
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
    default:
      return {
        owner: "scheduler",
        reason_text: `Ready item is blocked by ${code}.`,
        next_action: "Inspect the matching non-admission records and clear the leading blocker.",
      };
  }
}

function readyAdmissionBlockReasonCounts(
  blockerCounts: ReadyAdmissionExplanation["blocker_counts"],
): ReadyAdmissionExplanation["block_reason_counts"] {
  return Object.fromEntries(blockerCounts.map((row) => [row.code, row.count]));
}

function readyAdmissionTopBlockingLanes(
  skipped: DecisionRecord[],
): ReadyAdmissionExplanation["top_blocking_lanes"] {
  const counts = new Map<string, { lane: string; code: string; count: number; item_ids: string[] }>();
  for (const decision of skipped) {
    const code = typeof decision.metadata?.code === "string" ? decision.metadata.code : "unknown";
    const lane =
      typeof decision.metadata?.write_scope === "string" ? decision.metadata.write_scope :
      typeof decision.metadata?.pool_id === "string" ? decision.metadata.pool_id :
      typeof decision.metadata?.target === "string" ? decision.metadata.target :
      "unknown";
    if (lane === "unknown" && code !== "single_writer_lane_busy" && code !== "pool_capacity_full" && code !== "no_free_pool_builder") {
      continue;
    }
    const key = `${code}:${lane}`;
    const current = counts.get(key) ?? { lane, code, count: 0, item_ids: [] };
    current.count += 1;
    if (decision.item_id && current.item_ids.length < 5) current.item_ids.push(decision.item_id);
    counts.set(key, current);
  }
  return [...counts.values()]
    .sort((a, b) => b.count - a.count || a.code.localeCompare(b.code) || a.lane.localeCompare(b.lane))
    .slice(0, 5)
    .map((row) => ({
      ...row,
      next_action: readyAdmissionBlockerDetails(row.code).next_action,
    }));
}

function summarizeReadyFloorStatus(args: {
  ready: number;
  admissible: number;
  minReadyFuel: number;
  blockerCounts: ReadyAdmissionExplanation["blocker_counts"];
}): ReadyAdmissionExplanation["stale_ready_floor"] {
  const stale = args.ready >= args.minReadyFuel && args.admissible < args.minReadyFuel && args.blockerCounts.length > 0;
  const capacityBlocked = args.blockerCounts
    .filter((row) => row.category === "capacity_gate")
    .reduce((sum, row) => sum + row.count, 0);
  const mostlyCapacity = stale && capacityBlocked > 0 && capacityBlocked >= args.ready - args.admissible;

  if (mostlyCapacity) {
    return {
      stale,
      status: "capacity_saturated",
      ready: args.ready,
      admissible: args.admissible,
      min_ready_fuel: args.minReadyFuel,
      reason:
        `raw READY floor is satisfied (${args.ready}) but only ${args.admissible} item(s) are admissible ` +
        "because scheduler capacity is saturated",
      summary: `capacity saturated: raw READY=${args.ready}, admissible=${args.admissible}, floor=${args.minReadyFuel}`,
      next_action: "Do not refuel. Wait for in-flight work or pool capacity to free, then re-check admission.",
    };
  }

  if (stale) {
    const topBlocker = args.blockerCounts[0];
    const lockOnly = args.blockerCounts.length === 1 && topBlocker?.code === "single_writer_lane_busy";
    return {
      stale,
      status: "blocked_ready_fuel",
      ready: args.ready,
      admissible: args.admissible,
      min_ready_fuel: args.minReadyFuel,
      reason: `raw READY floor is satisfied (${args.ready}) but only ${args.admissible} item(s) are admissible`,
      summary: `ready fuel blocked: raw READY=${args.ready}, admissible=${args.admissible}, floor=${args.minReadyFuel}`,
      next_action: lockOnly
        ? "Wait for the active writer locks to clear or widen/split the blocking write-scope lanes."
        : "Clear the leading ready-admission blockers before adding more fuel.",
    };
  }

  if (args.ready < args.minReadyFuel) {
    return {
      stale: false,
      status: "low_ready_fuel",
      ready: args.ready,
      admissible: args.admissible,
      min_ready_fuel: args.minReadyFuel,
      reason: null,
      summary: `low ready fuel: raw READY=${args.ready}, floor=${args.minReadyFuel}`,
      next_action: "Refuel or promote eligible review fuel if the daemon is not already doing so.",
    };
  }

  return {
    stale: false,
    status: "ok",
    ready: args.ready,
    admissible: args.admissible,
    min_ready_fuel: args.minReadyFuel,
    reason: null,
    summary: `ready fuel ok: raw READY=${args.ready}, admissible=${args.admissible}, floor=${args.minReadyFuel}`,
    next_action: "No ready-fuel action needed.",
  };
}

function laneForAdmissionBreakdown(
  item: BacklogItem,
  poolFor?: ((item: BacklogItem) => string | null) | undefined,
): Pick<AdmissionBreakdownLane, "lane" | "lane_kind"> {
  const pool = poolFor?.(item) ?? null;
  if (pool) return { lane: pool, lane_kind: "pool" };
  if (item.to_agent) return { lane: item.to_agent, lane_kind: "agent" };
  return { lane: laneKeyOf(item), lane_kind: "write_scope" };
}

function emptyAdmissionBreakdownLane(
  lane: string,
  lane_kind: AdmissionBreakdownLane["lane_kind"],
): AdmissionBreakdownLane {
  return {
    lane,
    lane_kind,
    ready_count: 0,
    admitting_count: 0,
    stuck_reason: null,
    stuck_count: 0,
    block_reason_counts: {},
    ready_item_ids: [],
    admitting_item_ids: [],
  };
}

export function buildAdmissionBreakdown(input: {
  ready: BacklogItem[];
  admitting: BacklogItem[];
  plan: AdmissionPlan;
  pool_for?: (item: BacklogItem) => string | null;
  generated_at?: string;
}): AdmissionBreakdownExplanation {
  const lanes = new Map<string, AdmissionBreakdownLane>();
  const laneFor = (item: BacklogItem): AdmissionBreakdownLane => {
    const key = laneForAdmissionBreakdown(item, input.pool_for);
    const existing = lanes.get(key.lane);
    if (existing) return existing;
    const created = emptyAdmissionBreakdownLane(key.lane, key.lane_kind);
    lanes.set(key.lane, created);
    return created;
  };

  for (const item of input.ready) {
    const lane = laneFor(item);
    lane.ready_count += 1;
    lane.ready_item_ids.push(item.item_id);
  }
  for (const item of input.admitting) {
    const lane = laneFor(item);
    lane.admitting_count += 1;
    lane.admitting_item_ids.push(item.item_id);
  }

  if (input.plan.halt) {
    for (const lane of lanes.values()) {
      if (lane.ready_count > 0) {
        lane.stuck_reason = input.plan.halt.reason;
        lane.stuck_count = lane.ready_count;
      }
    }
  }

  const readyById = new Map(input.ready.map((item) => [item.item_id, item]));
  for (const decision of input.plan.skipped) {
    if (!decision.item_id) continue;
    const item = readyById.get(decision.item_id);
    if (!item) continue;
    const lane = laneFor(item);
    const code = typeof decision.metadata?.code === "string" ? decision.metadata.code : "unknown";
    lane.block_reason_counts[code] = (lane.block_reason_counts[code] ?? 0) + 1;
    lane.stuck_count += 1;
  }

  for (const lane of lanes.values()) {
    if (!lane.stuck_reason) {
      const top = Object.entries(lane.block_reason_counts)
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
      lane.stuck_reason = top?.[0] ?? null;
    }
    lane.ready_item_ids.sort();
    lane.admitting_item_ids.sort();
  }

  return {
    generated_at: input.generated_at ?? new Date().toISOString(),
    ready_count: input.ready.length,
    admitting_count: input.admitting.length,
    lanes: [...lanes.values()].sort((a, b) => {
      const severity = Number(b.ready_count > 0 && b.stuck_count > 0) - Number(a.ready_count > 0 && a.stuck_count > 0);
      return severity || b.ready_count - a.ready_count || b.admitting_count - a.admitting_count || a.lane.localeCompare(b.lane);
    }),
  };
}

export class ContinuousOrchestrationDaemon {
  private readonly deps: DaemonDeps;
  private readonly teamId: string;
  private timer: NodeJS.Timeout | null = null;
  // Slice 4: adaptive-backoff carry + stop flag for the self-scheduling loop.
  private backoffMult = 1;
  private stopped = false;

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

  private async alert(message: string): Promise<void> {
    const send: AlertSender = this.deps.alert ?? ((m) => sendTelegramAlert(m, this.deps.env));
    await send(message);
  }

  /** Run exactly one orchestration tick. Idempotent w.r.t. external state. */
  async runTick(): Promise<TickResult> {
    const config = this.deps.config;
    const nowMs = this.now();
    const nowIso = new Date(nowMs).toISOString();
    const tick_id = `tick_${crypto.randomUUID()}`;

    const state = await getOrchestrationState(this.deps.adapter, this.teamId);
    const killSwitch = this.killSwitchActive();

    // COMPLETION RECONCILIATION + REAPER — the missing half of the loop. Release
    // the write-scope lock of any in_flight item whose dispatch has terminated
    // (or is stuck unresolvable past the stale window). MUST run BEFORE
    // readInFlight so the freed lanes are admissible THIS tick — otherwise a
    // fired item holds its lock forever and the lanes strangle after
    // ~max_in_flight fires (the overnight self-strangle this fixes).
    const reconcileDecisions = await this.reconcileInFlight(nowMs, config.dry_run);

    const { view: usage, daily_tokens_used } = await this.deps.readUsage();
    const { count: in_flight, active_write_scopes } = await this.deps.readInFlight();

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
    // Slice 4 mechanism 2: if the refuel fleshed anything this tick, suppress
    // admission so the daemon never stacks two write bursts in one tick.
    const refuelFleshed = refuel?.auto_ready ?? 0;
    const admitCap = tickWriteCaps(writeCfg, refuelFleshed).admitCap;

    const readyRuntimeRepairs = await repairReadyCodexRuntimeMetadata(this.deps.adapter, this.teamId);
    const ready = await listReadyItems(this.deps.adapter, this.teamId);
    const done_item_ids = await listDoneItemIds(this.deps.adapter, this.teamId);
    // Priority-rank, then FAIR-interleave across distinct write_scope lanes so a
    // single busy lane can't monopolize this tick's admission slots — admission
    // consumes this order greedily, so a lane-diverse order => lane-diverse fires.
    const ordered = fairInterleaveByLane(orderCandidates(ready));

    // Stage C: compute the per-pool capacity + free-builder gate from the
    // current in-flight builds, so the daemon spills across pool members instead
    // of serializing the whole backlog onto one lane.
    const poolGate = await this.buildPoolGate(ordered);

    // RD-014: resolve live health for every agent name admission might target
    // this tick — non-pool candidates' to_agent, plus every pool's builder
    // list (any of them could be late-bound). Root cause of the pending-lane
    // cascade (+149 failed dispatches in one overnight wave): admission fired
    // to a lane with no check the target runtime was actually up.
    const candidateAgentNames = new Set<string>();
    for (const item of ordered) if (item.to_agent) candidateAgentNames.add(item.to_agent);
    if (poolGate) for (const builders of poolGate.pool_free_builders.values()) for (const b of builders) candidateAgentNames.add(b);
    const healthy_agents = this.deps.resolveAgentHealth
      ? await this.deps.resolveAgentHealth([...candidateAgentNames])
      : undefined;
    const target_agent_runtimes = this.deps.resolveAgentRuntimes
      ? await this.deps.resolveAgentRuntimes([...candidateAgentNames])
      : undefined;
    const ready_item_blockers = await this.readyItemBlockers();

    const ctx: AdmissionContext = {
      mode: state.mode,
      kill_switch_active: killSwitch,
      usage,
      daily_tokens_used,
      in_flight,
      active_write_scopes,
      done_item_ids,
      admit_limit: Math.min(tickAdmitLimit(nowMs, config), admitCap),
      pool_for: poolGate?.pool_for,
      pool_free_slots: poolGate?.pool_free_slots,
      pool_free_builders: poolGate?.pool_free_builders,
      healthy_agents,
      target_agent_runtimes,
      ready_item_blockers,
    };

    const plan = planAdmission(ordered, ctx, config);
    const decisions: DecisionRecord[] = [...reconcileDecisions];
    const admitted: Array<{ item_id: string; dispatch_phid: string | null }> = [];

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
              metadata: assignedBuilder ? { pool_id: pool?.pool_id, builder: assignedBuilder, write_scope: fireItem.write_scope } : undefined,
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

    // Guardrail: daily-ceiling auto-pause (loud) — the named unattended trigger.
    let auto_paused: { reason: string } | null = null;
    if (state.mode === "running" && !killSwitch && daily_tokens_used >= config.daily_token_ceiling) {
      const reason = `daily token ceiling reached: ${daily_tokens_used} >= ${config.daily_token_ceiling}`;
      auto_paused = { reason };
      decisions.push({ item_id: null, action: "auto_pause", reason });
      await this.alert(`🛑 Continuous orchestration AUTO-PAUSED — ${reason}. New dispatches halted.`);
    } else if (
      state.mode === "running" &&
      daily_tokens_used >= config.daily_token_ceiling * config.warn_fraction
    ) {
      decisions.push({
        item_id: null,
        action: "held",
        reason: `token budget warn: ${daily_tokens_used} >= ${Math.round(config.daily_token_ceiling * config.warn_fraction)} (${Math.round(config.warn_fraction * 100)}% of ceiling)`,
      });
    }

    // Stall self-detection (loud) — the overnight-drain failure mode.
    const stall = evaluateStall(
      state.consecutive_zero_ticks,
      { mode: state.mode, halted: !!plan.halt, candidates_available: ordered.length, admitted: admitted.length },
      config,
    );
    if (stall.alert) {
      decisions.push({
        item_id: null,
        action: "stall_alert",
        reason: `STALL: ${stall.zero_ticks} consecutive ticks fired 0 dispatches with ${ordered.length} ready item(s) waiting`,
      });
      await this.alert(
        `⚠️ Continuous orchestration STALL — ${stall.zero_ticks} ticks in a row fired nothing while ${ordered.length} ready item(s) wait. Check lanes/budget.`,
      );
    }

    const admissibleReady = plan.admit.length;
    if (shouldRunZeroAdmitStallWatchdog(stall.zero_ticks, admissibleReady, config)) {
      const message =
        `Continuous orchestration zero-admit stall: ${stall.zero_ticks} consecutive zero-admit ticks, ` +
        `${ready.length} ready item(s), ${admissibleReady} admissible, min_ready_fuel=${config.min_ready_fuel}`;
      decisions.push({
        item_id: null,
        action: "fleet_blockage",
        reason: `${message}; emitting fleet.blockage and triggering flesh/run`,
        metadata: {
          event_type: "fleet.blockage",
          zero_ticks: stall.zero_ticks,
          ready: ready.length,
          admissible_ready: admissibleReady,
          min_ready_fuel: config.min_ready_fuel,
        },
      });
      await this.emitFleetBlockage(message, {
        tick_id,
        zero_ticks: stall.zero_ticks,
        ready: ready.length,
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

    await appendDecisions(this.deps.adapter, { team_id: this.teamId, tick_id, dry_run: config.dry_run, records: decisions });
    await recordTickOutcome(this.deps.adapter, this.teamId, {
      zero_ticks: stall.zero_ticks,
      fired: admitted.length > 0 && !config.dry_run,
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
      skipped: plan.skipped.length,
      zero_ticks: stall.zero_ticks,
      stall_alert: stall.alert,
      auto_paused,
      refuel,
      auto_promote: autoPromote,
      ready_runtime_repairs: readyRuntimeRepairs,
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
    const readyRuntimeRepairs = await repairReadyCodexRuntimeMetadata(this.deps.adapter, this.teamId);
    const ready = await listReadyItems(this.deps.adapter, this.teamId);
    const done_item_ids = await listDoneItemIds(this.deps.adapter, this.teamId);
    const ordered = fairInterleaveByLane(orderCandidates(ready));
    const poolGate = await this.buildPoolGate(ordered);

    const candidateAgentNames = new Set<string>();
    for (const item of ordered) if (item.to_agent) candidateAgentNames.add(item.to_agent);
    if (poolGate) for (const builders of poolGate.pool_free_builders.values()) for (const b of builders) candidateAgentNames.add(b);
    const healthy_agents = this.deps.resolveAgentHealth
      ? await this.deps.resolveAgentHealth([...candidateAgentNames])
      : undefined;
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
      done_item_ids,
      admit_limit: Math.min(tickAdmitLimit(nowMs, config), tickWriteCaps(writeCfg, 0).admitCap),
      pool_for: poolGate?.pool_for,
      pool_free_slots: poolGate?.pool_free_slots,
      pool_free_builders: poolGate?.pool_free_builders,
      healthy_agents,
      target_agent_runtimes,
      ready_item_blockers,
    };

    const plan = planAdmission(ordered, ctx, config);
    const byId = new Map(ordered.map((item) => [item.item_id, item]));
    const blockerCounts = readyAdmissionBlockerCounts(plan);
    return {
      candidates: ordered.length,
      raw_ready: ordered.length,
      useful_ready: plan.admit.length,
      admissible_now: plan.admit.length,
      admissible: plan.admit.map((item) => ({
        item_id: item.item_id,
        title: item.title,
        to_agent: plan.assignments[item.item_id] ?? item.to_agent,
        risk_class: item.risk_class,
      })),
      non_admitted: plan.skipped.map((decision) => {
        const item = decision.item_id ? byId.get(decision.item_id) : undefined;
        return {
          item_id: decision.item_id ?? "",
          title: item?.title ?? "",
          to_agent: item?.to_agent ?? null,
          risk_class: item?.risk_class ?? "",
          action: decision.action === "held" ? "held" : "skipped",
          code: typeof decision.metadata?.code === "string" ? decision.metadata.code : "unknown",
          reason: decision.reason,
          metadata: decision.metadata,
        };
      }),
      blocker_counts: blockerCounts,
      top_blocking_lanes: readyAdmissionTopBlockingLanes(plan.skipped),
      block_reason_counts: readyAdmissionBlockReasonCounts(blockerCounts),
      stale_ready_floor: summarizeReadyFloorStatus({
        ready: ordered.length,
        admissible: plan.admit.length,
        minReadyFuel: config.min_ready_fuel,
        blockerCounts,
      }),
      halted: plan.halt?.reason ?? null,
      ready_runtime_repairs: readyRuntimeRepairs,
    };
  }

  async explainAdmissionBreakdown(): Promise<AdmissionBreakdownExplanation> {
    const config = this.deps.config;
    const nowMs = this.now();
    const generatedAt = new Date(nowMs).toISOString();
    const state = await getOrchestrationState(this.deps.adapter, this.teamId);
    const killSwitch = this.killSwitchActive();
    const { view: usage, daily_tokens_used } = await this.deps.readUsage();
    const { count: in_flight, active_write_scopes } = await this.deps.readInFlight();
    await repairReadyCodexRuntimeMetadata(this.deps.adapter, this.teamId);
    const [ready, admitting, done_item_ids] = await Promise.all([
      listReadyItems(this.deps.adapter, this.teamId),
      listBacklogByState(this.deps.adapter, { team_id: this.teamId, state: "in_flight" }),
      listDoneItemIds(this.deps.adapter, this.teamId),
    ]);
    const ordered = fairInterleaveByLane(orderCandidates(ready));
    const poolGate = await this.buildPoolGate(ordered);

    const candidateAgentNames = new Set<string>();
    for (const item of ordered) if (item.to_agent) candidateAgentNames.add(item.to_agent);
    if (poolGate) for (const builders of poolGate.pool_free_builders.values()) for (const b of builders) candidateAgentNames.add(b);
    const healthy_agents = this.deps.resolveAgentHealth
      ? await this.deps.resolveAgentHealth([...candidateAgentNames])
      : undefined;
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
      done_item_ids,
      admit_limit: Math.min(tickAdmitLimit(nowMs, config), tickWriteCaps(writeCfg, 0).admitCap),
      pool_for: poolGate?.pool_for,
      pool_free_slots: poolGate?.pool_free_slots,
      pool_free_builders: poolGate?.pool_free_builders,
      healthy_agents,
      target_agent_runtimes,
      ready_item_blockers,
    };

    return buildAdmissionBreakdown({
      ready: ordered,
      admitting,
      plan: planAdmission(ordered, ctx, config),
      pool_for: poolGate?.pool_for,
      generated_at: generatedAt,
    });
  }

  async explainAutoPromoteHealth(): Promise<AutoPromoteHealth> {
    const config = this.deps.config;
    const state = await getOrchestrationState(this.deps.adapter, this.teamId);
    const killSwitch = this.killSwitchActive();
    const { view: usage } = await this.deps.readUsage();
    const readyRuntimeRepairs = await repairReadyCodexRuntimeMetadata(this.deps.adapter, this.teamId);

    const [ready, needsReview] = await Promise.all([
      listReadyItems(this.deps.adapter, this.teamId),
      listBacklogByState(this.deps.adapter, { team_id: this.teamId, state: "needs_review" }),
    ]);
    const floor = effectiveAutoPromoteFloor(config);
    const plan = selectAutoPromotions(needsReview, ready, {
      floor,
      minLanes: config.auto_promote_min_lanes,
      maxPerPass: config.auto_promote_max_per_tick,
      allowApprovedRetries: true,
    });
    const readyLaneKeys = [...new Set(ready.filter((item) => item.risk_class === "build").map(laneKeyOf))].sort();
    const candidateLaneKeys = [...new Set(needsReview.map(laneKeyOf))].sort();
    const blockedReason =
      !config.auto_flesh_enabled ? "auto_flesh_disabled" :
      !config.auto_promote_enabled ? "auto_promote_disabled" :
      state.mode !== "running" ? `mode_${state.mode}` :
      killSwitch ? "kill_switch_active" :
      usage.hard_paused ? "usage_hard_paused" :
      null;
    const belowFloor = plan.before.build_ready < floor;
    const belowLanes = plan.before.build_lanes < config.auto_promote_min_lanes;
    const skippedItems = plan.skipped;
    const promotedItems = plan.promote.map((item) => ({
      item_id: item.item_id,
      title: item.title,
      lane: laneKeyOf(item),
    }));
    const topSkipReasons = topSkipReasonsFrom(skippedItems);
    const blockerCounts = blockerCountsFrom(skippedItems);
    const blockerClasses = blockerClassesFrom(blockerCounts);
    const promotedCount = blockedReason ? 0 : plan.promote.length;
    const triggered = blockedReason ? false : plan.triggered;
    const candidatesConsidered = triggered ? plan.candidates_considered : 0;
    const nextAction = nextAutoPromoteAction({
      blockedReason,
      triggered,
      candidates: candidatesConsidered,
      promoted: promotedCount,
      blockerCounts,
    });
    const summary = summarizeAutoPromoteHealth({
      blockedReason,
      belowFloor,
      belowLanes,
      triggered,
      ready: plan.before.build_ready,
      floor,
      lanes: plan.before.build_lanes,
      minLanes: config.auto_promote_min_lanes,
      candidates: candidatesConsidered,
      promoted: promotedCount,
      skipped: triggered ? skippedItems.length : 0,
      topReason: topSkipReasons[0]?.reason ?? null,
      blockerCounts,
      nextAction,
    });

    return {
      enabled: config.auto_flesh_enabled && config.auto_promote_enabled,
      blocked_reason: blockedReason,
      min_ready_fuel: config.min_ready_fuel,
      floor,
      min_ready_lanes: config.auto_promote_min_lanes,
      lanes: {
        build_ready: plan.before.build_ready,
        build_ready_lanes: plan.before.build_lanes,
        ready_lane_keys: readyLaneKeys,
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
      skipped_items: triggered ? skippedItems : [],
      top_skip_reasons: triggered ? topSkipReasons : [],
      blocker_counts: triggered ? blockerCounts : emptyAutoPromoteBlockerCounts(),
      blocker_classes: triggered ? blockerClasses : [],
      next_action: nextAction,
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

  /**
   * COMPLETION RECONCILIATION + STALE REAPER — the missing half of the loop.
   * Releases the write-scope lock of in_flight items whose dispatch has finished.
   *
   * Per in_flight backlog item:
   *  - dispatch TERMINAL (done/failed/cancelled) → release immediately:
   *    done→done, cancelled→cancelled, failed→needs_review (a human/approval
   *    gate re-promotes rather than the loop auto-retrying a failure).
   *  - dispatch UNRESOLVABLE (missing row / null phid) AND stuck past
   *    stale_in_flight_ms → reaper releases it to needs_review (self-heals
   *    missed completions, pruned rows, daemon restarts).
   *  - dispatch resolvable but NON-terminal (active/queued) → LEFT ALONE: the
   *    scheduler owns its recovery; reaping a live build would double-fire.
   *
   * Runs every tick BEFORE readInFlight so freed lanes are admissible the same
   * tick. Dry-run mirrors the refuel posture: compute + log "would_reconcile",
   * mutate nothing.
   */
  private async reconcileInFlight(nowMs: number, dryRun: boolean): Promise<DecisionRecord[]> {
    const items = await listBacklogByState(this.deps.adapter, {
      team_id: this.teamId,
      state: "in_flight",
    });
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
      } else if (status === "needs_clarification") {
        // A pending clarification is waiting on an external human/manager
        // decision — its duration is unbounded and unrelated to whether the
        // worker is alive, so the stale-in_flight/pool windows (10-30 min)
        // are the wrong signal for it entirely. Root-caused 2026-07-04: a
        // dispatch parked in needs_clarification got phantom-lock-reaped to
        // needs_review every ~10 min for 3+ hours while genuinely awaiting a
        // reply, and (see auto-promote-policy.ts) each reap was immediately
        // auto-promoted back to ready and re-fired as a duplicate dispatch.
        // The ALREADY-CORRECT release path for an abandoned clarification is
        // recovery_status='moot' (resolved to the synthetic "moot" status
        // above, which IS terminal) — leave a live, non-moot clarification
        // in_flight indefinitely and let that signal (or the eventual
        // manager resume) be what moves it, never this staleness window.
      } else {
        // Non-terminal: either RESOLVABLE-but-stuck (the dispatch is still
        // in_flight/queued because its worker died, was killed, or is parked,
        // and the scheduler isn't recovering it) OR UNRESOLVABLE (pruned/
        // missing row, null phid). Both are PHANTOM LOCKS once aged out.
        // needs_clarification is handled separately above — it is never a
        // phantom-lock candidate on this timer.
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
    for (const [pid, pool] of resolved) {
      pool_free_slots.set(pid, Math.max(0, pool.max_parallel - (inFlightCount.get(pid) ?? 0)));
      pool_free_builders.set(pid, pools.availableBuilders(pool, building.get(pid) ?? new Set<string>()));
    }

    return {
      pool_for: (item: BacklogItem) => pools.poolForItem(item)?.pool_id ?? null,
      pool_free_slots,
      pool_free_builders,
    };
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

    const ready = await listReadyItems(this.deps.adapter, this.teamId);
    // T-ORCH P0 (continuous self-refuel): refuel on ANY tick where READY fuel is
    // below threshold — not only at the 3 batch load-points. Low ready-fuel
    // auto-promotes+fleshes backlog items into READY as the daemon drains them,
    // so an unattended run never starves after the initial ready items.
    //
    // ADMISSION-V2 parallel-fuel floor: also refuel when READY spans too FEW
    // distinct lanes (even if the total is fine) so the parallel pool stays fed
    // across lanes, not just in aggregate.
    if (!needsRefuel(ready, { minReadyFuel: config.min_ready_fuel, minReadyLanes: config.min_ready_lanes })) {
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
      const [ready, needsReview] = await Promise.all([
        listReadyItems(this.deps.adapter, this.teamId),
        listBacklogByState(this.deps.adapter, { team_id: this.teamId, state: "needs_review" }),
      ]);
      const floor = effectiveAutoPromoteFloor(config);
      const plan = selectAutoPromotions(needsReview, ready, {
        floor,
        minLanes: config.auto_promote_min_lanes,
        maxPerPass: config.auto_promote_max_per_tick,
        allowApprovedRetries: true,
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
      return {
        triggered: true,
        promoted,
        skipped: plan.skipped.length,
        candidates_considered: plan.candidates_considered,
        top_skip_reasons: topSkipReasonsFrom(plan.skipped),
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

function emptyAutoPromoteBlockerCounts(): Record<AutoPromoteBlockerClass, number> {
  return {
    already_dispatched: 0,
    review_held_risk: 0,
    blocked_dependencies: 0,
    confidence_threshold: 0,
    incomplete_flesh: 0,
    other: 0,
  };
}

function classifyAutoPromoteReason(reason: string): AutoPromoteBlockerClass {
  if (reason.startsWith("already dispatched once")) return "already_dispatched";
  if (reason.startsWith("risk_class ") || reason.startsWith("high-risk denylist match")) return "review_held_risk";
  if (reason.startsWith("blocked dependencies:")) return "blocked_dependencies";
  if (
    reason.startsWith("no flesh_confidence") ||
    reason.startsWith("confidence ")
  ) {
    return "confidence_threshold";
  }
  if (
    reason.startsWith("missing to_agent or dispatch_body") ||
    reason.startsWith("empty write_scope")
  ) {
    return "incomplete_flesh";
  }
  return "other";
}

function blockerCountsFrom(
  skipped: Array<{ reasons: string[] }>,
): Record<AutoPromoteBlockerClass, number> {
  const counts = emptyAutoPromoteBlockerCounts();
  for (const item of skipped) {
    const classes = new Set(item.reasons.map(classifyAutoPromoteReason));
    for (const cls of classes) counts[cls] += 1;
  }
  return counts;
}

function blockerClassesFrom(
  counts: Record<AutoPromoteBlockerClass, number>,
): Array<{ blocker_class: AutoPromoteBlockerClass; count: number }> {
  return (Object.entries(counts) as Array<[AutoPromoteBlockerClass, number]>)
    .filter(([, count]) => count > 0)
    .map(([blocker_class, count]) => ({ blocker_class, count }))
    .sort((a, b) => b.count - a.count || a.blocker_class.localeCompare(b.blocker_class));
}

function formatBlockerCounts(counts: Record<AutoPromoteBlockerClass, number>): string {
  const classes = blockerClassesFrom(counts);
  if (classes.length === 0) return "none";
  return classes.map((c) => `${c.blocker_class}=${c.count}`).join(", ");
}

function nextAutoPromoteAction(args: {
  blockedReason: string | null;
  triggered: boolean;
  candidates: number;
  promoted: number;
  blockerCounts: Record<AutoPromoteBlockerClass, number>;
}): string {
  if (args.blockedReason) return `Clear auto-promote blocker: ${args.blockedReason}.`;
  if (!args.triggered) return "No refuel action needed; ready build fuel already meets the configured floor and lane target.";
  if (args.promoted > 0) return "Let the daemon promote eligible review fuel, then re-check ready admission.";
  if (args.candidates === 0) return "Refuel by adding or fleshing needs_review build rows for the target lanes.";

  const ranked = blockerClassesFrom(args.blockerCounts);
  const top = ranked[0]?.blocker_class ?? "other";
  switch (top) {
    case "already_dispatched":
      return "Manually review already-dispatched needs_review rows and /promote only the ones safe to retry.";
    case "review_held_risk":
      return "Approve or reroute review-held risk rows manually; auto-promote only handles build-risk work.";
    case "blocked_dependencies":
      return "Complete or clear blocked dependency item_ids before expecting auto-promote to refill ready fuel.";
    case "confidence_threshold":
      return "Run another flesh pass, improve the dispatch patch confidence, or explicitly approve safe rows.";
    case "incomplete_flesh":
      return "Flesh incomplete rows so they have to_agent, dispatch_body, and write_scope before promotion.";
    case "other":
      return "Inspect skipped_items/top_skip_reasons, then manually approve or repair the leading blocker.";
  }
}

function summarizeAutoPromoteHealth(args: {
  blockedReason: string | null;
  belowFloor: boolean;
  belowLanes: boolean;
  triggered: boolean;
  ready: number;
  floor: number;
  lanes: number;
  minLanes: number;
  candidates: number;
  promoted: number;
  skipped: number;
  topReason: string | null;
  blockerCounts: Record<AutoPromoteBlockerClass, number>;
  nextAction: string;
}): string {
  if (args.blockedReason) return `auto-promote blocked: ${args.blockedReason}`;
  if (!args.belowFloor && !args.belowLanes) {
    return `ready build fuel meets floor: ready=${args.ready} floor=${args.floor}, lanes=${args.lanes}/${args.minLanes}`;
  }
  if (!args.triggered || args.candidates === 0) {
    return `ready build fuel below floor: ready=${args.ready} floor=${args.floor}, lanes=${args.lanes}/${args.minLanes}; no needs_review candidates considered`;
  }
  if (args.promoted > 0) {
    return `ready build fuel below floor: ready=${args.ready} floor=${args.floor}, lanes=${args.lanes}/${args.minLanes}; would promote ${args.promoted}, skipped ${args.skipped}`;
  }
  return (
    `ready build fuel below floor: ready=${args.ready} floor=${args.floor}, lanes=${args.lanes}/${args.minLanes}; ` +
    `promoted 0 of ${args.candidates}; blockers: ${formatBlockerCounts(args.blockerCounts)}; ` +
    `top skip reason: ${args.topReason ?? "none"}; next: ${args.nextAction}`
  );
}
