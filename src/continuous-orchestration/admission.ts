// Continuous Orchestration — guardrailed admission.
//
// The safety core. Given ordered READY candidates and the current guardrail
// context, decide which items may be admitted (fired) THIS tick and why every
// other candidate was skipped. Pure + fully unit-tested — the daemon only wires
// I/O around it. NEVER admits outside the guardrails.

import type { ContinuousOrchestrationConfig } from "./config.js";
import { normalizeRuntime, resolveProviderFromRuntime } from "../dispatch-scheduler/types.js";
import type { BacklogItem, DecisionRecord, OrchestrationMode, UsageGateView } from "./types.js";

/** Risk classes safe to auto-run unattended. Everything else escalates. */
const AUTO_RUN_RISK = new Set(["routine", "build"]);

export interface AdmissionContext {
  mode: OrchestrationMode;
  /** Emergency kill-switch file present — wins over everything. */
  kill_switch_active: boolean;
  usage: UsageGateView;
  /** Current weighted tokens consumed today (from the usage report). */
  daily_tokens_used: number;
  /** Count of dispatches currently in flight. */
  in_flight: number;
  /** Write scopes already locked by in-flight/active dispatches. */
  active_write_scopes: Set<string>;
  /** item_ids known to be `done` (for dependency resolution). */
  done_item_ids: Set<string>;
  /** Max NEW dispatches this tick (from cadence). */
  admit_limit: number;
  /**
   * Build-pool gate (Stage C). When provided, an item that resolves to a pool
   * is admitted by POOL CAPACITY + a FREE BUILDER instead of the repo-scope
   * single-writer lock — this is what lets N builders build N worktrees of the
   * same repo concurrently. Items that resolve to no pool keep the scope lock.
   */
  pool_for?: (item: BacklogItem) => string | null;
  /** Free in-flight slots per pool this tick (max_parallel − current in-flight). */
  pool_free_slots?: Map<string, number>;
  /** Available builders per pool, in preference order (consumed as admitted). */
  pool_free_builders?: Map<string, string[]>;
  /** Pool members already bound to in-flight build work, for status/debug evidence. */
  pool_busy_builders?: Map<string, string[]>;
  /**
   * RD-014: agent names currently healthy/online. When provided, admission
   * rejects any candidate whose resolved target (the pool-assigned builder,
   * or `to_agent` for non-pool items) is NOT in this set — the admission
   * daemon previously fired dispatches to a lane with no live check that the
   * target runtime was actually up, which was the root cause of the
   * pending-lane cascade (+149 failed dispatches in one overnight wave).
   * `undefined`/`null` means health data was unavailable this tick (the
   * resolver is optional/best-effort) — admission then falls back to the
   * pre-RD-014 behavior (no health gate) rather than halting the whole
   * daemon on a health-check outage.
   */
  healthy_agents?: Set<string> | null;
  /** Registered runtime per target agent name. Used to flag provider/runtime rows that cannot land on that lane. */
  target_agent_runtimes?: Map<string, string> | null;
  /** Active clarification/promotion blockers keyed by ready backlog item_id. */
  ready_item_blockers?: Map<string, { code: "clarification_blocker" | "promotion_blocker"; reason: string; metadata?: Record<string, unknown> }> | null;
}

export interface AdmissionPlan {
  /** When set, the whole tick is halted before any admission. */
  halt: { halted: boolean; reason: string } | null;
  /** Items cleared to fire, in order. */
  admit: BacklogItem[];
  /** Late-bound builder assignment per admitted pool item (item_id → builder). */
  assignments: Record<string, string>;
  /** Per-candidate skip records (audit). */
  skipped: DecisionRecord[];
}

export type NonAdmissionCode =
  | "not_ready"
  | "no_in_flight_slots"
  | "tick_admission_cap"
  | "risk_requires_approval"
  | "blocked_dependency"
  | "pool_capacity_full"
  | "no_free_pool_builder"
  | "single_writer_lane_busy"
  | "daily_token_ceiling"
  | "missing_dispatch_target"
  | "target_unhealthy"
  | "provider_runtime_mismatch"
  | "clarification_blocker"
  | "promotion_blocker";

function reasonClass(code: NonAdmissionCode): string {
  switch (code) {
    case "risk_requires_approval":
      return "risk_class";
    case "provider_runtime_mismatch":
      return "provider_runtime";
    case "blocked_dependency":
      return "blocked_dependency";
    case "target_unhealthy":
    case "no_free_pool_builder":
      return "agent_availability";
    case "single_writer_lane_busy":
      return "write_scope_lock";
    case "clarification_blocker":
      return "clarification_blocker";
    case "promotion_blocker":
      return "promotion_blocker";
    case "tick_admission_cap":
    case "no_in_flight_slots":
    case "pool_capacity_full":
    case "daily_token_ceiling":
      return "config_cap";
    default:
      return "readiness";
  }
}

function nonAdmission(
  item_id: string,
  action: "skipped" | "held",
  code: NonAdmissionCode,
  reason: string,
  extra: Record<string, unknown> = {},
): DecisionRecord {
  return { item_id, action, reason, metadata: { code, class: reasonClass(code), ...extra } };
}

function providerRuntimeMismatch(
  item: BacklogItem,
  target: string | null,
  targetRuntime: string | undefined,
): { reason: string; metadata: Record<string, unknown> } | null {
  if (!item.provider && !item.runtime) return null;

  const requestedRuntime = item.runtime ? normalizeRuntime(item.runtime) : null;
  const requestedProvider = item.provider ?? (requestedRuntime ? resolveProviderFromRuntime(requestedRuntime) : null);
  const providerFromRequestedRuntime = requestedRuntime ? resolveProviderFromRuntime(requestedRuntime) : null;

  if (item.provider && requestedRuntime && item.provider !== providerFromRequestedRuntime) {
    return {
      reason: `provider/runtime mismatch: provider=${item.provider} does not match runtime=${requestedRuntime} (expected provider=${providerFromRequestedRuntime})`,
      metadata: {
        provider: item.provider,
        runtime: requestedRuntime,
        expected_provider: providerFromRequestedRuntime,
      },
    };
  }

  if (requestedRuntime && targetRuntime) {
    const normalizedTargetRuntime = normalizeRuntime(targetRuntime);
    if (requestedRuntime !== normalizedTargetRuntime) {
      return {
        reason:
          `provider/runtime mismatch: ready row requests ${requestedProvider}/${requestedRuntime} ` +
          `but target agent ${target ?? "(unknown)"} is registered for ${resolveProviderFromRuntime(normalizedTargetRuntime)}/${normalizedTargetRuntime}`,
        metadata: {
          provider: requestedProvider,
          runtime: requestedRuntime,
          target,
          target_runtime: normalizedTargetRuntime,
          target_provider: resolveProviderFromRuntime(normalizedTargetRuntime),
        },
      };
    }
  }

  return null;
}

/** Tick-level halt checks, in precedence order. Null = proceed. */
function tickHalt(ctx: AdmissionContext, config: ContinuousOrchestrationConfig): string | null {
  if (ctx.kill_switch_active) return "kill switch present";
  if (ctx.mode === "stopped") return "mode=stopped";
  if (ctx.mode === "paused") return "mode=paused";
  if (ctx.mode === "drain_only") return "mode=drain_only (no new admission)";
  if (ctx.mode === "approve_only") return "mode=approve_only (candidates batch for approval, not fired)";
  if (ctx.usage.hard_paused) return "usage gate hard-paused";
  if (ctx.daily_tokens_used >= config.daily_token_ceiling) {
    return `daily token ceiling reached (${ctx.daily_tokens_used} >= ${config.daily_token_ceiling})`;
  }
  return null;
}

/**
 * Build the admission plan. `candidates` MUST be pre-ordered (see
 * orderCandidates). Only items with readiness_state === "ready" are eligible —
 * the caller is expected to pass READY rows, but we re-check defensively.
 */
export function planAdmission(
  candidates: BacklogItem[],
  ctx: AdmissionContext,
  config: ContinuousOrchestrationConfig,
): AdmissionPlan {
  const halt = tickHalt(ctx, config);
  if (halt) return { halt: { halted: true, reason: halt }, admit: [], assignments: {}, skipped: [] };

  const admit: BacklogItem[] = [];
  const assignments: Record<string, string> = {};
  const skipped: DecisionRecord[] = [];

  const slotsFree = Math.max(0, config.max_in_flight - ctx.in_flight);
  const limit = Math.max(0, Math.min(ctx.admit_limit, slotsFree));

  // Mutable running view so multiple admits in one tick don't collide.
  const lockedScopes = new Set(ctx.active_write_scopes);
  // Running pool capacity + free-builder view, consumed as we admit this tick.
  const poolSlots = new Map<string, number>(ctx.pool_free_slots ? [...ctx.pool_free_slots] : []);
  const poolBuilders = new Map<string, string[]>();
  if (ctx.pool_free_builders) {
    for (const [k, v] of ctx.pool_free_builders) poolBuilders.set(k, [...v]);
  }
  let tokensUsed = ctx.daily_tokens_used;

  for (const item of candidates) {
    if (item.readiness_state !== "ready") {
      skipped.push(nonAdmission(item.item_id, "skipped", "not_ready", `not ready (${item.readiness_state})`, {
        readiness_state: item.readiness_state,
      }));
      continue;
    }
    const activeBlocker = ctx.ready_item_blockers?.get(item.item_id);
    if (activeBlocker) {
      skipped.push(nonAdmission(
        item.item_id,
        "held",
        activeBlocker.code,
        activeBlocker.reason,
        activeBlocker.metadata ?? {},
      ));
      continue;
    }
    if (admit.length >= limit) {
      const why = slotsFree === 0 ? "no in-flight slots free" : "tick admission cap reached";
      skipped.push(nonAdmission(
        item.item_id,
        "held",
        slotsFree === 0 ? "no_in_flight_slots" : "tick_admission_cap",
        why,
      ));
      continue;
    }
    if (!AUTO_RUN_RISK.has(item.risk_class)) {
      skipped.push(nonAdmission(
        item.item_id,
        "held",
        "risk_requires_approval",
        `risk_class=${item.risk_class} requires approval batch`,
        { risk_class: item.risk_class },
      ));
      continue;
    }
    const unresolved = item.dependencies.filter((d) => !ctx.done_item_ids.has(d));
    if (unresolved.length > 0) {
      skipped.push(nonAdmission(
        item.item_id,
        "skipped",
        "blocked_dependency",
        `blocked: dependency not done (${unresolved.join(", ")})`,
        { dependencies: unresolved },
      ));
      continue;
    }
    // Build-pool gate (Stage C) OR legacy repo-scope single-writer lock.
    const poolId = ctx.pool_for?.(item) ?? null;
    let assignedBuilder: string | null = null;
    if (poolId) {
      const free = poolSlots.get(poolId) ?? 0;
      if (free <= 0) {
        skipped.push(nonAdmission(item.item_id, "held", "pool_capacity_full", `pool capacity full: ${poolId}`, {
          pool_id: poolId,
        }));
        continue;
      }
      const builders = poolBuilders.get(poolId) ?? [];
      const builderIndex = ctx.healthy_agents
        ? builders.findIndex((builder) => ctx.healthy_agents?.has(builder))
        : builders.length > 0
          ? 0
          : -1;
      assignedBuilder = builderIndex >= 0 ? builders.splice(builderIndex, 1)[0] : null;
      if (!assignedBuilder) {
        const reason = ctx.healthy_agents && builders.length > 0
          ? `no healthy free builder in pool: ${poolId}`
          : `no free builder in pool: ${poolId}`;
        skipped.push(nonAdmission(item.item_id, "held", "no_free_pool_builder", reason, {
          pool_id: poolId,
          ...(ctx.healthy_agents ? { candidate_builders: builders } : {}),
          ...(ctx.pool_busy_builders?.get(poolId)?.length ? { busy_builders: ctx.pool_busy_builders.get(poolId) } : {}),
        }));
        continue;
      }
    } else {
      const scopeClash = item.write_scope.find((s) => lockedScopes.has(s));
      if (scopeClash) {
        skipped.push(nonAdmission(
          item.item_id,
          "skipped",
          "single_writer_lane_busy",
          `single-writer lane busy: ${scopeClash}`,
          { write_scope: scopeClash },
        ));
        continue;
      }
    }
    const estimate = item.token_estimate ?? 0;
    if (tokensUsed + estimate > config.daily_token_ceiling) {
      skipped.push(nonAdmission(
        item.item_id,
        "skipped",
        "daily_token_ceiling",
        `would exceed daily token ceiling (${tokensUsed} + ${estimate} > ${config.daily_token_ceiling})`,
        { tokens_used: tokensUsed, token_estimate: estimate, daily_token_ceiling: config.daily_token_ceiling },
      ));
      continue;
    }
    // Pool items late-bind to_agent at fire (assignedBuilder); non-pool items
    // must already carry a to_agent. Both need a dispatch body.
    if (!item.dispatch_body || (!poolId && !item.to_agent)) {
      skipped.push(nonAdmission(
        item.item_id,
        "skipped",
        "missing_dispatch_target",
        "ready item missing to_agent or dispatch_body",
        { has_to_agent: !!item.to_agent, has_dispatch_body: !!item.dispatch_body },
      ));
      continue;
    }
    // RD-014: reject admission to a target whose runtime is not live. The
    // resolved target is the pool-assigned builder (if this is a pool item)
    // or item.to_agent otherwise — both are guaranteed non-null past the
    // check above. Skipping (not halting the tick) matches every other
    // per-candidate gate here; a later, healthier candidate in this same
    // tick still gets a chance.
    const target = poolId ? assignedBuilder : item.to_agent;
    const laneMismatch = providerRuntimeMismatch(item, target, target ? ctx.target_agent_runtimes?.get(target) : undefined);
    if (laneMismatch) {
      skipped.push(nonAdmission(
        item.item_id,
        "held",
        "provider_runtime_mismatch",
        laneMismatch.reason,
        laneMismatch.metadata,
      ));
      continue;
    }
    if (ctx.healthy_agents && target && !ctx.healthy_agents.has(target)) {
      skipped.push(nonAdmission(
        item.item_id,
        "skipped",
        "target_unhealthy",
        `target agent '${target}' is not healthy/online (RD-014 admission health gate)`,
        { target },
      ));
      continue;
    }

    admit.push(item);
    if (poolId && assignedBuilder) {
      assignments[item.item_id] = assignedBuilder;
      poolSlots.set(poolId, (poolSlots.get(poolId) ?? 0) - 1);
    } else {
      for (const s of item.write_scope) lockedScopes.add(s);
    }
    tokensUsed += estimate;
  }

  return { halt: null, admit, assignments, skipped };
}

/**
 * Stall self-detection. The overnight-drain failure mode is "ticks fire 0
 * dispatches while admissible work waits." Returns the next consecutive-zero
 * counter and whether a loud alert should fire this tick.
 */
export function evaluateStall(
  prevZeroTicks: number,
  opts: { mode: OrchestrationMode; halted: boolean; candidates_available: number; admitted: number },
  config: ContinuousOrchestrationConfig,
): { zero_ticks: number; alert: boolean } {
  // Only "running + not halted + work was available + fired nothing" counts as a
  // stall. Legitimately idle (no candidates) or intentionally halted does not.
  const stalledTick =
    opts.mode === "running" && !opts.halted && opts.candidates_available > 0 && opts.admitted === 0;
  if (!stalledTick) return { zero_ticks: 0, alert: false };
  const zero = prevZeroTicks + 1;
  return { zero_ticks: zero, alert: zero >= config.stall_threshold_ticks };
}

/**
 * Zero-admit stall watchdog. This is narrower than the normal stall alert:
 * it only trips when zero-admit has reached the configured threshold AND the
 * READY queue is below the refuel floor, which means the daemon needs to make
 * the blockage visible and attempt a flesh refuel before a manual refill.
 */
export function shouldRunZeroAdmitStallWatchdog(
  zeroTicks: number,
  readyCount: number,
  config: ContinuousOrchestrationConfig,
): boolean {
  return zeroTicks >= config.stall_threshold_ticks && readyCount < config.min_ready_fuel;
}
