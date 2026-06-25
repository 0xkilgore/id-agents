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
import type { ContinuousOrchestrationConfig } from "./config.js";
import type { BacklogItem, DecisionRecord, OrchestrationMode, ReadinessState, UsageGateView } from "./types.js";
import { fairInterleaveByLane, needsRefuel, orderCandidates } from "./selection.js";
import { tickAdmitLimit } from "./cadence.js";
import { planAdmission, evaluateStall, type AdmissionContext } from "./admission.js";
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
  setItemState,
  setMode,
} from "./storage.js";
import { runFleshPass, type FleshRunSummary } from "./flesh-runner.js";
import { selectAutoPromotions } from "./auto-promote-policy.js";
import { sendTelegramAlert, type AlertSender } from "./telegram.js";

/** Raw dispatch statuses that mean the work is finished — its write-scope lock
 *  can be released. Mirrors the dispatch read-model's TERMINAL_STATUSES. */
const TERMINAL_DISPATCH_STATUSES = new Set(["done", "failed", "cancelled"]);

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
   * Build-pool routing (Stage C). When provided, an admitted item that resolves
   * to a pool late-binds its builder + worktree at FIRE time: the daemon spills
   * across pool members and each in-flight build gets a DISTINCT worktree
   * write_scope, so N builders build the same repo concurrently (admission gates
   * on pool capacity + a free member, not the repo-scope single-writer lock).
   * Omitted → legacy single-lane behavior (existing boot/tests unchanged).
   */
  pools?: PoolRouting;
  alert?: AlertSender;
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
  decisions: DecisionRecord[];
}

/** Outcome of one floor-triggered auto-promote pass. */
export interface AutoPromoteRunSummary {
  /** True when build-ready fuel/lanes were below floor and a top-up ran. */
  triggered: boolean;
  /** Items promoted needs_review -> ready this pass. */
  promoted: number;
  /** Safe-gate rejections among the needs_review candidates. */
  skipped: number;
  /** Build-ready total/lanes before the pass. */
  before: { build_ready: number; build_lanes: number };
  dry_run: boolean;
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
    const refuel = await this.maybeRefuel({
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
    };

    const plan = planAdmission(ordered, ctx, config);
    const decisions: DecisionRecord[] = [...reconcileDecisions];
    const admitted: Array<{ item_id: string; dispatch_phid: string | null }> = [];

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
            if (assignedBuilder && pool && this.deps.pools) {
              const wt = await this.deps.pools.allocateWorktree({ agent: assignedBuilder, item, pool });
              await bindItemForFire(this.deps.adapter, item.item_id, {
                to_agent: assignedBuilder,
                write_scope: [wt.path],
              });
              fireItem = { ...item, to_agent: assignedBuilder, write_scope: [wt.path] };
              builderNote = ` [pool ${pool.pool_id} → ${assignedBuilder} @ ${wt.path}]`;
            }
            const res = await this.deps.enqueue(fireItem);
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
      decisions,
    };
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
      } else {
        // Non-terminal: either RESOLVABLE-but-stuck (the dispatch is still
        // in_flight/queued/needs_clarification because its worker died, was killed,
        // or is parked, and the scheduler isn't recovering it) OR UNRESOLVABLE
        // (pruned/missing row, null phid). Both are PHANTOM LOCKS once aged out.
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
      const plan = selectAutoPromotions(needsReview, ready, {
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
      return {
        triggered: true,
        promoted,
        skipped: plan.skipped.length,
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
