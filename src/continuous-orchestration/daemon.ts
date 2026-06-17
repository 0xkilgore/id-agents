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
import type { BacklogItem, DecisionRecord, OrchestrationMode, UsageGateView } from "./types.js";
import { orderCandidates } from "./selection.js";
import { tickAdmitLimit } from "./cadence.js";
import { planAdmission, evaluateStall, type AdmissionContext } from "./admission.js";
import {
  appendDecisions,
  getOrchestrationState,
  listDoneItemIds,
  listReadyItems,
  recordTickOutcome,
  setItemState,
  setMode,
} from "./storage.js";
import { sendTelegramAlert, type AlertSender } from "./telegram.js";

export interface DaemonDeps {
  adapter: DbAdapter;
  config: ContinuousOrchestrationConfig;
  /** Fire a dispatch through the manager API. */
  enqueue: (item: BacklogItem) => Promise<{ dispatch_phid: string; query_id: string }>;
  /** Read the live usage gate + today's weighted-token consumption. */
  readUsage: () => Promise<{ view: UsageGateView; daily_tokens_used: number }>;
  /** Read current in-flight count + the write scopes those dispatches hold. */
  readInFlight: () => Promise<{ count: number; active_write_scopes: Set<string> }>;
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
  skipped: number;
  zero_ticks: number;
  stall_alert: boolean;
  auto_paused: { reason: string } | null;
  decisions: DecisionRecord[];
}

export class ContinuousOrchestrationDaemon {
  private readonly deps: DaemonDeps;
  private readonly teamId: string;
  private timer: NodeJS.Timeout | null = null;

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
    const { view: usage, daily_tokens_used } = await this.deps.readUsage();
    const { count: in_flight, active_write_scopes } = await this.deps.readInFlight();

    const ready = await listReadyItems(this.deps.adapter, this.teamId);
    const done_item_ids = await listDoneItemIds(this.deps.adapter, this.teamId);
    const ordered = orderCandidates(ready);

    const ctx: AdmissionContext = {
      mode: state.mode,
      kill_switch_active: killSwitch,
      usage,
      daily_tokens_used,
      in_flight,
      active_write_scopes,
      done_item_ids,
      admit_limit: tickAdmitLimit(nowMs, config),
    };

    const plan = planAdmission(ordered, ctx, config);
    const decisions: DecisionRecord[] = [];
    const admitted: Array<{ item_id: string; dispatch_phid: string | null }> = [];

    if (plan.halt) {
      decisions.push({ item_id: null, action: "guardrail_halt", reason: plan.halt.reason });
    } else {
      for (const item of plan.admit) {
        if (config.dry_run) {
          decisions.push({ item_id: item.item_id, action: "would_dispatch", reason: "dry-run: would fire" });
          admitted.push({ item_id: item.item_id, dispatch_phid: null });
        } else {
          try {
            const res = await this.deps.enqueue(item);
            await setItemState(this.deps.adapter, item.item_id, "in_flight", { dispatch_phid: res.dispatch_phid });
            decisions.push({
              item_id: item.item_id,
              action: "dispatched",
              reason: `fired to ${item.to_agent}`,
              dispatch_phid: res.dispatch_phid,
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
      skipped: plan.skipped.length,
      zero_ticks: stall.zero_ticks,
      stall_alert: stall.alert,
      auto_paused,
      decisions,
    };
  }

  /** Start the interval loop. No-op (with a log) when disabled. */
  start(): void {
    if (!this.deps.config.enabled) {
      console.log("[orchestration] daemon DISABLED (set CONTINUOUS_ORCHESTRATION_ENABLED=true to arm); not ticking.");
      return;
    }
    if (this.timer) return;
    const mode = this.deps.config.dry_run ? "DRY-RUN" : "LIVE";
    console.log(`[orchestration] daemon armed in ${mode}; tick every ${this.deps.config.tick_interval_ms}ms.`);
    this.timer = setInterval(() => {
      this.runTick().catch((err) => console.error("[orchestration] tick error:", err));
    }, this.deps.config.tick_interval_ms);
    if (typeof this.timer.unref === "function") this.timer.unref();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
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
