// Continuous Orchestration — guardrailed admission.
//
// The safety core. Given ordered READY candidates and the current guardrail
// context, decide which items may be admitted (fired) THIS tick and why every
// other candidate was skipped. Pure + fully unit-tested — the daemon only wires
// I/O around it. NEVER admits outside the guardrails.

import type { ContinuousOrchestrationConfig } from "./config.js";
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
      skipped.push({ item_id: item.item_id, action: "skipped", reason: `not ready (${item.readiness_state})` });
      continue;
    }
    if (admit.length >= limit) {
      const why = slotsFree === 0 ? "no in-flight slots free" : "tick admission cap reached";
      skipped.push({ item_id: item.item_id, action: "held", reason: why });
      continue;
    }
    if (!AUTO_RUN_RISK.has(item.risk_class)) {
      skipped.push({
        item_id: item.item_id,
        action: "held",
        reason: `risk_class=${item.risk_class} requires approval batch`,
      });
      continue;
    }
    const unresolved = item.dependencies.filter((d) => !ctx.done_item_ids.has(d));
    if (unresolved.length > 0) {
      skipped.push({
        item_id: item.item_id,
        action: "skipped",
        reason: `blocked: dependency not done (${unresolved.join(", ")})`,
      });
      continue;
    }
    // Build-pool gate (Stage C) OR legacy repo-scope single-writer lock.
    const poolId = ctx.pool_for?.(item) ?? null;
    let assignedBuilder: string | null = null;
    if (poolId) {
      const free = poolSlots.get(poolId) ?? 0;
      if (free <= 0) {
        skipped.push({
          item_id: item.item_id,
          action: "held",
          reason: `pool capacity full: ${poolId}`,
        });
        continue;
      }
      const builders = poolBuilders.get(poolId) ?? [];
      assignedBuilder = builders.shift() ?? null;
      if (!assignedBuilder) {
        skipped.push({
          item_id: item.item_id,
          action: "held",
          reason: `no free builder in pool: ${poolId}`,
        });
        continue;
      }
    } else {
      const scopeClash = item.write_scope.find((s) => lockedScopes.has(s));
      if (scopeClash) {
        skipped.push({
          item_id: item.item_id,
          action: "skipped",
          reason: `single-writer lane busy: ${scopeClash}`,
        });
        continue;
      }
    }
    const estimate = item.token_estimate ?? 0;
    if (tokensUsed + estimate > config.daily_token_ceiling) {
      skipped.push({
        item_id: item.item_id,
        action: "skipped",
        reason: `would exceed daily token ceiling (${tokensUsed} + ${estimate} > ${config.daily_token_ceiling})`,
      });
      continue;
    }
    // Pool items late-bind to_agent at fire (assignedBuilder); non-pool items
    // must already carry a to_agent. Both need a dispatch body.
    if (!item.dispatch_body || (!poolId && !item.to_agent)) {
      skipped.push({
        item_id: item.item_id,
        action: "skipped",
        reason: "ready item missing to_agent or dispatch_body",
      });
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
