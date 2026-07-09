// Usage Meter Service — orchestrates config + storage + gate.
//
// SAFETY: defaults to WARN-ONLY mode. Hard-gating is opt-in via
// USAGE_GATE_ENFORCEMENT=enforce. Telemetry/storage failures degrade
// to "ok with stale data" rather than wedging the fleet.

import type { DbAdapter } from "../db/db-adapter.js";
import { evaluateGate, parseEnforcement, resolveExcludedAgents, shouldPauseAgent } from "./gate.js";
import { DEFAULT_USAGE_BUDGET_POLICY, loadUsageBudgetPolicy, type LoadPolicyResult } from "./config.js";
import {
  listRecentAgentUsageEvents,
  listAgentUsageRollupsForWindow,
  upsertAgentUsageRollup,
  listActiveProviderLimitSignals,
} from "./storage.js";
import { computeDayWindow, computeWeekWindow, rollupEvents } from "./rollup.js";
import { loadDispatchSpendScopes } from "./dispatch-spend-attribution.js";
import type {
  AgentUsageEvent,
  AgentUsageRollup,
  DaemonUsageReport,
  Provider,
  SpendScope,
  UsageBudgetPolicy,
  UsageGateDecision,
  UsageGateEnforcement,
  UsageGateSnapshot,
  UsageReportV2,
  UsageReportProviderWindow,
} from "./types.js";

/** Default daemon-attributed ceilings (the CONTINUOUS_ORCHESTRATION_* caps). */
export const DEFAULT_DAEMON_DAILY_BUDGET = 5_000_000;
export const DEFAULT_DAEMON_WEEKLY_BUDGET = 25_000_000;

export interface UsageMeterServiceOptions {
  adapter: DbAdapter;
  now: () => number;
  policy: UsageBudgetPolicy;
  policyDegraded?: boolean;
  policyDegradedReason?: string;
  enforcement: UsageGateEnforcement;
  /** Optional concurrency-snapshot provider for the v2 report. */
  concurrencyProvider?: () => Promise<UsageReportV2["concurrency"]> | UsageReportV2["concurrency"];
  /** How fresh the rollups need to be (ms) before we re-roll. Default 30s. */
  refreshIntervalMs?: number;
  /** Daemon-attributed daily ceiling (the CONTINUOUS_ORCHESTRATION_DAILY_CEILING). */
  daemonDailyBudget?: number;
  /** Daemon-attributed weekly ceiling. */
  daemonWeeklyBudget?: number;
  /** Pause the daemon when attribution is degraded (live enforce only). */
  daemonFailClosedOnAttribution?: boolean;
}

const DEFAULT_REFRESH_MS = 30_000;

export class UsageMeterService {
  private adapter: DbAdapter;
  private now: () => number;
  private policy: UsageBudgetPolicy;
  private policyDegraded: boolean;
  private policyDegradedReason?: string;
  private enforcement: UsageGateEnforcement;
  private concurrencyProvider?: UsageMeterServiceOptions["concurrencyProvider"];
  private refreshIntervalMs: number;
  private daemonDailyBudget: number;
  private daemonWeeklyBudget: number;
  private daemonFailClosedOnAttribution: boolean;

  // Cached snapshot for fast scheduler lookups.
  private cachedSnapshot: UsageGateSnapshot | null = null;
  private cachedSnapshotAtMs = 0;
  private cachedReport: UsageReportV2 | null = null;
  private cachedReportAtMs = 0;

  constructor(opts: UsageMeterServiceOptions) {
    this.adapter = opts.adapter;
    this.now = opts.now;
    this.policy = opts.policy;
    this.policyDegraded = !!opts.policyDegraded;
    this.policyDegradedReason = opts.policyDegradedReason;
    this.enforcement = opts.enforcement;
    this.concurrencyProvider = opts.concurrencyProvider;
    this.refreshIntervalMs = opts.refreshIntervalMs ?? DEFAULT_REFRESH_MS;
    this.daemonDailyBudget = opts.daemonDailyBudget ?? DEFAULT_DAEMON_DAILY_BUDGET;
    this.daemonWeeklyBudget = opts.daemonWeeklyBudget ?? DEFAULT_DAEMON_WEEKLY_BUDGET;
    this.daemonFailClosedOnAttribution = !!opts.daemonFailClosedOnAttribution;
  }

  get currentEnforcement(): UsageGateEnforcement {
    return this.enforcement;
  }

  get currentPolicy(): UsageBudgetPolicy {
    return this.policy;
  }

  /**
   * Refresh rollups from raw events. Best-effort; never throws. Returns
   * the recomputed rollups for callers that want them.
   */
  async refreshRollups(): Promise<AgentUsageRollup[]> {
    try {
      const nowMs = this.now();
      // Pull events from at least the last 8 days so we have a full week.
      const since = nowMs - 8 * 86_400_000;
      const events = await listRecentAgentUsageEvents(this.adapter, {
        since_ms: since,
        limit: 100_000,
      });
      const rollups = rollupEvents(
        events
          .filter((e) => e.provider === this.policy.provider)
          .map((e: AgentUsageEvent) => ({
          agent_id: e.agent_id,
          ts: e.ts,
          raw_tokens: e.raw_tokens,
          weighted_tokens: e.weighted_tokens,
          model: e.model,
          source: e.source,
          confidence: e.confidence,
        })),
        {
          provider: this.policy.provider,
          timezone: this.policy.timezone,
          now_iso: new Date(nowMs).toISOString(),
          window_kinds: ["day", "week"],
        },
      );
      const extraProviders = uniqueProviders(events).filter((p) => p !== this.policy.provider);
      for (const provider of extraProviders) {
        rollups.push(...rollupEvents(
          events
            .filter((e) => e.provider === provider)
            .map((e) => ({
              agent_id: e.agent_id,
              ts: e.ts,
              raw_tokens: e.raw_tokens,
              weighted_tokens: e.weighted_tokens,
              model: e.model,
              source: e.source,
              confidence: e.confidence,
            })),
          {
            provider,
            timezone: this.policy.timezone,
            now_iso: new Date(nowMs).toISOString(),
            window_kinds: ["day", "week"],
          },
        ));
      }
      for (const r of rollups) {
        await upsertAgentUsageRollup(this.adapter, r);
      }
      this.cachedSnapshotAtMs = 0;
      this.cachedReportAtMs = 0;
      return rollups;
    } catch (err) {
      // Best-effort; degraded snapshot will absorb.
      console.warn(
        `[usage-meter] refreshRollups failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return [];
    }
  }

  /**
   * Return the cached UsageGateSnapshot, refreshing if stale. Catches
   * all errors and returns a degraded snapshot rather than throwing.
   */
  async snapshot(): Promise<UsageGateSnapshot> {
    const nowMs = this.now();
    if (
      this.cachedSnapshot &&
      nowMs - this.cachedSnapshotAtMs < this.refreshIntervalMs
    ) {
      return this.cachedSnapshot;
    }
    try {
      // Lazily refresh rollups in the background — don't block.
      void this.refreshRollups();

      const { rollupsByAgent, globalRollup } = await this.loadCurrentRollups();
      const providerLimits = await listActiveProviderLimitSignals(this.adapter, new Date(nowMs).toISOString());
      const snap = evaluateGate({
        policy: this.policy,
        rollupsByAgent,
        globalRollup,
        enforcement: this.enforcement,
        now_iso: new Date(nowMs).toISOString(),
        data_freshness_ms: this.computeDataFreshness(rollupsByAgent, globalRollup, nowMs),
        provider_limits: providerLimits,
      });
      // Patch in the policy-load degraded state if applicable.
      const final: UsageGateSnapshot =
        this.policyDegraded && snap.status === "ok"
          ? {
              ...snap,
              status: "degraded",
              degraded_reason: this.policyDegradedReason ?? "policy load failed",
            }
          : snap;
      this.cachedSnapshot = final;
      this.cachedSnapshotAtMs = nowMs;
      return final;
    } catch (err) {
      // Catastrophic — return a degraded warn_allow snapshot. The
      // scheduler's gate consumers never block in warn mode anyway.
      const fallback: UsageGateSnapshot = {
        status: "degraded",
        policy_version: this.policy.schema_version,
        global: {
          state: "degraded",
          decision: "warn_allow",
          reason: `usage-meter snapshot failed: ${err instanceof Error ? err.message : String(err)}`,
          daily_pct: null,
          weekly_pct: null,
        },
        agents: {},
        exempt_agents: [...this.policy.exempt_agents],
        enforcement: this.enforcement,
        override_active: false,
        degraded_reason: "usage-meter snapshot failed",
        provider_limits: [],
        generated_at: new Date(nowMs).toISOString(),
      };
      this.cachedSnapshot = fallback;
      this.cachedSnapshotAtMs = nowMs;
      return fallback;
    }
  }

  /**
   * UsageGateProvider interface for the scheduler. Synchronous-feeling
   * read of the cached snapshot, with self-refresh.
   */
  async getSnapshotForScheduler(): Promise<UsageGateSnapshot> {
    return this.snapshot();
  }

  /**
   * Build the public `usage-meter-v2` report. Falls back to defaults
   * + degraded markers on error rather than throwing.
   */
  async buildReport(): Promise<UsageReportV2> {
    const nowMs = this.now();
    const cacheAge = nowMs - this.cachedReportAtMs;
    if (this.cachedReport && cacheAge < this.refreshIntervalMs) {
      return this.cachedReport;
    }

    try {
      const snap = await this.snapshot();
      const { rollupsByAgent, globalRollup } = await this.loadCurrentRollups();
      const dayWin = computeDayWindow(nowMs, this.policy.timezone);
      const weekWin = computeWeekWindow(nowMs, this.policy.timezone);
      const concurrency = await this.resolveConcurrency();

      const gd = globalRollup.day;
      const gw = globalRollup.week;

      const by_agent = Object.entries(rollupsByAgent).map(([agent, rolls]) => {
        const agentBudget = this.policy.agents[agent];
        return {
          agent,
          daily: agentWindow(rolls.day, agentBudget?.daily_weighted_tokens ?? null),
          weekly: agentWindow(rolls.week, agentBudget?.weekly_weighted_tokens ?? null),
        };
      });

      const by_model = computeByModel(rollupsByAgent);
      const providerWindows = await this.computeProviderWindows(dayWin, weekWin, snap.provider_limits);

      const report: UsageReportV2 = {
        schema_version: "usage-meter-v2",
        generated_at: new Date(nowMs).toISOString(),
        windows: {
          daily: {
            start: dayWin.start,
            reset_at: dayWin.end,
            time_until_reset_seconds: Math.max(0, Math.floor((dayWin.end_ms - nowMs) / 1000)),
          },
          weekly: {
            start: weekWin.start,
            reset_at: weekWin.end,
            time_until_reset_seconds: Math.max(0, Math.floor((weekWin.end_ms - nowMs) / 1000)),
          },
        },
        usage: {
          daily: globalWindow(gd),
          weekly: globalWindow(gw),
        },
        by_provider: providerWindows,
        by_agent,
        by_model,
        concurrency,
        gate: {
          global_state: snap.global.state,
          should_pause_new_dispatches:
            snap.enforcement === "enforce" &&
            (snap.global.decision === "pause_non_core" ||
              snap.global.decision === "pause_unknown"),
          reason: snap.global.reason,
          daily_percent: null,
          weekly_percent: null,
          override_active: snap.override_active,
          enforcement: snap.enforcement,
          agent_overrides: Object.entries(snap.agents).map(([agent, d]) => ({
            agent,
            state: d.state,
            reason: d.reason,
          })),
          provider_limits: snap.provider_limits,
        },
        calibration: {
          denominator_kind: "usage_with_no_limit",
          calibrated_at: null,
          notes:
            this.policyDegraded
              ? `policy load degraded: ${this.policyDegradedReason ?? "?"}; using defaults`
              : "Provider plan limits are not token-metered API budgets. Percent consumed is intentionally omitted until a calibrated estimate is derived from observed limit-hit events.",
        },
        source: "manager-usage-meter",
      };
      this.cachedReport = report;
      this.cachedReportAtMs = nowMs;
      return report;
    } catch (err) {
      const fallback = degradedReport(this.policy, this.now(), err);
      this.cachedReport = fallback;
      this.cachedReportAtMs = nowMs;
      return fallback;
    }
  }

  /**
   * Build the daemon-attributed usage report (Gap 2). Sums ONLY weighted tokens
   * caused by continuous-orchestration dispatches (resolved usage event →
   * dispatch from_actor → spend scope), within the policy day/week. The global
   * report stays the fleet-wide emergency brake: the daemon hard-pauses if the
   * global gate is enforce-hard-paused OR daemon spend is over its own cap.
   */
  async buildDaemonReport(
    opts: { dailyBudget?: number; weeklyBudget?: number } = {},
  ): Promise<DaemonUsageReport> {
    const nowMs = this.now();
    const dailyBudget = opts.dailyBudget ?? this.daemonDailyBudget;
    const weeklyBudget = opts.weeklyBudget ?? this.daemonWeeklyBudget;
    try {
      const dayWin = computeDayWindow(nowMs, this.policy.timezone);
      const weekWin = computeWeekWindow(nowMs, this.policy.timezone);
      const events = await listRecentAgentUsageEvents(this.adapter, {
        since_ms: weekWin.start_ms,
        limit: 200_000,
      });
      const dispatchIds = events
        .map((e) => e.dispatch_id)
        .filter((d): d is string => typeof d === "string" && d.length > 0);
      const scopes = await loadDispatchSpendScopes(this.adapter, dispatchIds);

      let dAuto = 0;
      let dFlesh = 0;
      let wCombined = 0;
      let attributed = 0;
      let unknown = 0;
      for (const e of events) {
        if (e.ts < weekWin.start_ms || e.ts >= weekWin.end_ms) continue;
        let scope: SpendScope;
        if (!e.dispatch_id) {
          scope = "fleet";
        } else {
          const s = scopes.get(e.dispatch_id);
          if (s) {
            scope = s.spend_scope;
            attributed += 1;
          } else {
            scope = "unknown";
            unknown += 1;
          }
        }
        if (scope !== "daemon_autonomous" && scope !== "daemon_fleshing") continue;
        wCombined += e.weighted_tokens;
        if (e.ts >= dayWin.start_ms && e.ts < dayWin.end_ms) {
          if (scope === "daemon_autonomous") dAuto += e.weighted_tokens;
          else dFlesh += e.weighted_tokens;
        }
      }
      const dCombined = dAuto + dFlesh;

      // Global emergency brake — already enforce-gated inside buildReport().
      const global = await this.buildReport();
      const globalHardPause = global.gate.should_pause_new_dispatches;
      const overDaily = dailyBudget > 0 && dCombined >= dailyBudget;
      const overWeekly = weeklyBudget > 0 && wCombined >= weeklyBudget;

      const considered = attributed + unknown;
      const degraded = considered > 0 && unknown / considered > 0.5;
      // Fail-closed only under live enforcement when configured (else allow loudly).
      const attributionPause =
        degraded && this.daemonFailClosedOnAttribution && this.enforcement === "enforce";
      const hard_paused = globalHardPause || attributionPause;

      const reasonParts: string[] = [];
      if (globalHardPause) reasonParts.push("fleet global emergency brake hard-paused");
      if (overDaily) reasonParts.push(`daemon daily reference exceeded (${dCombined} >= ${dailyBudget}; warn-only)`);
      if (overWeekly) reasonParts.push(`daemon weekly reference exceeded (${wCombined} >= ${weeklyBudget}; warn-only)`);
      if (attributionPause) reasonParts.push("attribution degraded (fail-closed)");

      return {
        schema_version: "daemon-usage.v1",
        generated_at: new Date(nowMs).toISOString(),
        daily: {
          autonomous_weighted_tokens: dAuto,
          fleshing_weighted_tokens: dFlesh,
          combined_weighted_tokens: dCombined,
          budget: dailyBudget,
          percent_consumed: dailyBudget > 0 ? dCombined / dailyBudget : 0,
        },
        weekly: {
          combined_weighted_tokens: wCombined,
          budget: weeklyBudget,
          percent_consumed: weeklyBudget > 0 ? wCombined / weeklyBudget : 0,
        },
        coverage: {
          attributed_events: attributed,
          unknown_events: unknown,
          confidence: degraded ? "degraded" : "fresh",
        },
        gate: {
          hard_paused,
          enforcement: this.enforcement,
          reason: reasonParts.length ? reasonParts.join("; ") : "within daemon budget",
        },
      };
    } catch (err) {
      // Degraded: never silently charge the daemon. Default allow with loud
      // reason unless fail-closed under live enforcement.
      const failClosed = this.daemonFailClosedOnAttribution && this.enforcement === "enforce";
      return {
        schema_version: "daemon-usage.v1",
        generated_at: new Date(nowMs).toISOString(),
        daily: {
          autonomous_weighted_tokens: 0,
          fleshing_weighted_tokens: 0,
          combined_weighted_tokens: 0,
          budget: dailyBudget,
          percent_consumed: 0,
        },
        weekly: { combined_weighted_tokens: 0, budget: weeklyBudget, percent_consumed: 0 },
        coverage: { attributed_events: 0, unknown_events: 0, confidence: "degraded" },
        gate: {
          hard_paused: failClosed,
          enforcement: this.enforcement,
          reason: `daemon usage report failed: ${err instanceof Error ? err.message : String(err)}`,
        },
      };
    }
  }

  /**
   * Compute exclusion list for a scheduler claim cycle. Always empty in
   * WARN mode (Chris's overnight mandate).
   */
  async getExcludedAgentsForClaim(): Promise<string[]> {
    const snap = await this.snapshot();
    return resolveExcludedAgents(snap);
  }

  /**
   * Helper for enqueue gating. Returns true when the new dispatch must
   * be refused. Always false in WARN mode.
   */
  async isAgentPaused(agentId: string): Promise<boolean> {
    const snap = await this.snapshot();
    return shouldPauseAgent(snap, agentId);
  }

  // ── Internal helpers ───────────────────────────────────────────────

  private async loadCurrentRollups(): Promise<{
    rollupsByAgent: Record<string, { day: AgentUsageRollup; week: AgentUsageRollup }>;
    globalRollup: { day: AgentUsageRollup; week: AgentUsageRollup };
  }> {
    const nowMs = this.now();
    const dayWin = computeDayWindow(nowMs, this.policy.timezone);
    const weekWin = computeWeekWindow(nowMs, this.policy.timezone);
    const providers: Provider[] = ["anthropic", "openai", "cursor", "other"];
    const dayRollups = (
      await Promise.all(providers.map((provider) => listAgentUsageRollupsForWindow(this.adapter, {
        provider,
        window_kind: "day",
        window_start: dayWin.start,
      })))
    ).flat();
    const weekRollups = (
      await Promise.all(providers.map((provider) => listAgentUsageRollupsForWindow(this.adapter, {
        provider,
        window_kind: "week",
        window_start: weekWin.start,
      })))
    ).flat();

    const dayByAgent = new Map<string, AgentUsageRollup>();
    const weekByAgent = new Map<string, AgentUsageRollup>();
    for (const r of dayRollups) mergeRollup(dayByAgent, r);
    for (const r of weekRollups) mergeRollup(weekByAgent, r);

    const allAgents = new Set<string>([
      ...dayByAgent.keys(),
      ...weekByAgent.keys(),
    ]);
    allAgents.delete("_global");

    const rollupsByAgent: Record<string, { day: AgentUsageRollup; week: AgentUsageRollup }> = {};
    for (const a of allAgents) {
      rollupsByAgent[a] = {
        day: dayByAgent.get(a) ?? emptyRollup(a, "day", dayWin.start, dayWin.end, this.policy.provider, nowMs),
        week: weekByAgent.get(a) ?? emptyRollup(a, "week", weekWin.start, weekWin.end, this.policy.provider, nowMs),
      };
    }
    return {
      rollupsByAgent,
      globalRollup: {
        day: dayByAgent.get("_global") ?? emptyRollup("_global", "day", dayWin.start, dayWin.end, this.policy.provider, nowMs),
        week: weekByAgent.get("_global") ?? emptyRollup("_global", "week", weekWin.start, weekWin.end, this.policy.provider, nowMs),
      },
    };
  }

  private computeDataFreshness(
    rollupsByAgent: Record<string, { day: AgentUsageRollup; week: AgentUsageRollup }>,
    globalRollup: { day: AgentUsageRollup; week: AgentUsageRollup },
    nowMs: number,
  ): number {
    const all: AgentUsageRollup[] = [globalRollup.day, globalRollup.week];
    for (const r of Object.values(rollupsByAgent)) {
      all.push(r.day, r.week);
    }
    if (all.length === 0) return Number.POSITIVE_INFINITY;
    let mostRecent = 0;
    for (const r of all) {
      const t = Date.parse(r.computed_at);
      if (Number.isFinite(t) && t > mostRecent) mostRecent = t;
    }
    return mostRecent === 0 ? Number.POSITIVE_INFINITY : nowMs - mostRecent;
  }

  private async resolveConcurrency(): Promise<UsageReportV2["concurrency"]> {
    if (!this.concurrencyProvider) {
      return {
        in_flight_claude: 0,
        max_safe_concurrency: 0,
        slots_available: 0,
        queue_depth: 0,
        rate_limit_retry: 0,
        wedged_count: 0,
        oldest_in_flight_age_seconds: null,
        oldest_in_flight_agent: null,
        source_status: "degraded",
      };
    }
    try {
      const c = await this.concurrencyProvider();
      return c;
    } catch {
      return {
        in_flight_claude: 0,
        max_safe_concurrency: 0,
        slots_available: 0,
        queue_depth: 0,
        rate_limit_retry: 0,
        wedged_count: 0,
        oldest_in_flight_age_seconds: null,
        oldest_in_flight_agent: null,
        source_status: "degraded",
      };
    }
  }

  private async computeProviderWindows(
    dayWin: { start_ms: number; end_ms: number },
    weekWin: { start_ms: number; end_ms: number },
    providerLimits: UsageReportV2["gate"]["provider_limits"],
  ): Promise<UsageReportProviderWindow[]> {
    const events = await listRecentAgentUsageEvents(this.adapter, {
      since_ms: weekWin.start_ms,
      limit: 200_000,
    });
    const acc = new Map<string, {
      daily: { weighted_tokens: number; raw_tokens: number; requests: number };
      weekly: { weighted_tokens: number; raw_tokens: number; requests: number };
    }>();
    const ensure = (provider: string) => {
      const key = normalizeProvider(provider);
      let value = acc.get(key);
      if (!value) {
        value = {
          daily: { weighted_tokens: 0, raw_tokens: 0, requests: 0 },
          weekly: { weighted_tokens: 0, raw_tokens: 0, requests: 0 },
        };
        acc.set(key, value);
      }
      return value;
    };
    for (const event of events) {
      if (event.ts < weekWin.start_ms || event.ts >= weekWin.end_ms) continue;
      const bucket = ensure(event.provider);
      bucket.weekly.weighted_tokens += event.weighted_tokens;
      bucket.weekly.raw_tokens += event.raw_tokens;
      bucket.weekly.requests += 1;
      if (event.ts >= dayWin.start_ms && event.ts < dayWin.end_ms) {
        bucket.daily.weighted_tokens += event.weighted_tokens;
        bucket.daily.raw_tokens += event.raw_tokens;
        bucket.daily.requests += 1;
      }
    }
    for (const signal of providerLimits) ensure(signal.provider);
    return [...acc.entries()].sort((a, b) => b[1].daily.weighted_tokens - a[1].daily.weighted_tokens).map(([provider, value]) => {
      const activeLimit = providerLimits.find((s) => s.provider === provider);
      return {
        provider: normalizeProvider(provider),
        daily: { ...value.daily, limit: null, percent_of_limit: null },
        weekly: { ...value.weekly, limit: null, percent_of_limit: null },
        limit_state: activeLimit ? "limited" : "unknown",
        limit_source: activeLimit ? "observed_provider_signal" : "not_available",
        reset_at: activeLimit?.reset_at ?? null,
      };
    });
  }
}

// ─────────────────────────────────────────────────────────────────────
// Factory: load policy + env enforcement, build service.
// ─────────────────────────────────────────────────────────────────────

export interface CreateUsageMeterServiceOptions {
  adapter: DbAdapter;
  env: NodeJS.ProcessEnv;
  now?: () => number;
  configsPath?: string;
  concurrencyProvider?: UsageMeterServiceOptions["concurrencyProvider"];
}

export function createUsageMeterService(
  opts: CreateUsageMeterServiceOptions,
): { service: UsageMeterService; loaded: LoadPolicyResult; enforcement: UsageGateEnforcement } {
  const loaded = loadUsageBudgetPolicy({
    env: opts.env,
    configsPath: opts.configsPath,
  });
  const enforcement = parseEnforcement(opts.env.USAGE_GATE_ENFORCEMENT);
  // Optional override env vars at runtime.
  let policy = loaded.policy;
  const overrideUntil = opts.env.USAGE_GATE_OVERRIDE_UNTIL;
  const overrideReason = opts.env.USAGE_GATE_OVERRIDE_REASON;
  if (overrideUntil) {
    policy = {
      ...policy,
      emergency_override: {
        enabled: true,
        reason: overrideReason ?? null,
        expires_at: overrideUntil,
      },
    };
  }
  // Daemon-attributed ceilings — kept in lock-step with the continuous-
  // orchestration config so /usage/daemon and the daemon cap speak the same
  // numbers (Gap 2). Same env vars the CO config reads.
  const daemonDailyBudget = parseEnvInt(opts.env.CONTINUOUS_ORCHESTRATION_DAILY_CEILING, DEFAULT_DAEMON_DAILY_BUDGET);
  const daemonWeeklyBudget = parseEnvInt(opts.env.CONTINUOUS_ORCHESTRATION_WEEKLY_CEILING, DEFAULT_DAEMON_WEEKLY_BUDGET);
  const daemonFailClosed = /^(1|true|yes|on)$/i.test(
    (opts.env.CONTINUOUS_ORCHESTRATION_FAIL_CLOSED_ON_ATTRIBUTION ?? "").trim(),
  );
  const service = new UsageMeterService({
    adapter: opts.adapter,
    now: opts.now ?? (() => Date.now()),
    policy,
    policyDegraded: loaded.degraded,
    policyDegradedReason: loaded.degraded_reason,
    enforcement,
    concurrencyProvider: opts.concurrencyProvider,
    daemonDailyBudget,
    daemonWeeklyBudget,
    daemonFailClosedOnAttribution: daemonFailClosed,
  });
  return { service, loaded, enforcement };
}

// ─────────────────────────────────────────────────────────────────────
// helpers
// ─────────────────────────────────────────────────────────────────────

function parseEnvInt(raw: string | undefined, dflt: number): number {
  const n = raw === undefined ? NaN : parseInt(raw, 10);
  return Number.isFinite(n) ? n : dflt;
}

function emptyRollup(
  agent_id: string,
  window_kind: "day" | "week",
  start: string,
  end: string,
  provider: Provider,
  nowMs: number,
): AgentUsageRollup {
  return {
    provider,
    agent_id,
    window_kind,
    window_start: start,
    window_end: end,
    raw_tokens: 0,
    weighted_tokens: 0,
    requests: 0,
    models: [],
    source_coverage: {},
    computed_at: new Date(nowMs).toISOString(),
  };
}

function globalWindow(
  r: AgentUsageRollup,
): UsageReportV2["usage"]["daily"] {
  return {
    weighted_tokens: r.weighted_tokens,
    raw_tokens: r.raw_tokens,
    requests: r.requests,
    budget: null,
    percent_consumed: null,
    soft_threshold: null,
    hard_threshold: null,
  };
}

function agentWindow(
  r: AgentUsageRollup,
  budget: number | null,
): UsageReportV2["by_agent"][number]["daily"] {
  return {
    weighted_tokens: r.weighted_tokens,
    raw_tokens: r.raw_tokens,
    requests: r.requests,
    budget,
    percent_of_budget: budget && budget > 0 ? r.weighted_tokens / budget : null,
  };
}

function computeByModel(
  rollupsByAgent: Record<string, { day: AgentUsageRollup; week: AgentUsageRollup }>,
): UsageReportV2["by_model"] {
  // The rollup table doesn't store per-model breakdown, but each rollup
  // lists which models contributed. We approximate by counting models
  // and attributing the rollup's total to each listed model evenly.
  // For v0 this is enough to surface "which models are burning tokens".
  const acc = new Map<string, { weighted: number; raw: number; requests: number }>();
  for (const { day } of Object.values(rollupsByAgent)) {
    if (day.models.length === 0) continue;
    const share = 1 / day.models.length;
    for (const m of day.models) {
      const prev = acc.get(m) ?? { weighted: 0, raw: 0, requests: 0 };
      prev.weighted += Math.round(day.weighted_tokens * share);
      prev.raw += Math.round(day.raw_tokens * share);
      prev.requests += Math.round(day.requests * share);
      acc.set(m, prev);
    }
  }
  return [...acc.entries()]
    .map(([model, v]) => ({
      model,
      daily: { weighted_tokens: v.weighted, raw_tokens: v.raw, requests: v.requests },
    }))
    .sort((a, b) => b.daily.weighted_tokens - a.daily.weighted_tokens);
}

function uniqueProviders(events: AgentUsageEvent[]): Array<AgentUsageEvent["provider"]> {
  return [...new Set(events.map((e) => e.provider))];
}

function normalizeProvider(raw: string): UsageReportProviderWindow["provider"] {
  return raw === "anthropic" || raw === "openai" || raw === "cursor" || raw === "other"
    ? raw
    : "other";
}

function mergeRollup(map: Map<string, AgentUsageRollup>, rollup: AgentUsageRollup): void {
  const prev = map.get(rollup.agent_id);
  if (!prev) {
    map.set(rollup.agent_id, { ...rollup, models: [...rollup.models], source_coverage: { ...rollup.source_coverage } });
    return;
  }
  prev.raw_tokens += rollup.raw_tokens;
  prev.weighted_tokens += rollup.weighted_tokens;
  prev.requests += rollup.requests;
  prev.models = [...new Set([...prev.models, ...rollup.models])];
  for (const [source, count] of Object.entries(rollup.source_coverage)) {
    prev.source_coverage[source] = (prev.source_coverage[source] ?? 0) + count;
  }
  if (Date.parse(rollup.computed_at) > Date.parse(prev.computed_at)) {
    prev.computed_at = rollup.computed_at;
  }
}

function degradedReport(
  policy: UsageBudgetPolicy,
  nowMs: number,
  err: unknown,
): UsageReportV2 {
  const dayWin = computeDayWindow(nowMs, policy.timezone);
  const weekWin = computeWeekWindow(nowMs, policy.timezone);
  const emptyG = () => ({
    weighted_tokens: 0,
    raw_tokens: 0,
    requests: 0,
    budget: null,
    percent_consumed: null,
    soft_threshold: null,
    hard_threshold: null,
  });
  return {
    schema_version: "usage-meter-v2",
    generated_at: new Date(nowMs).toISOString(),
    windows: {
      daily: { start: dayWin.start, reset_at: dayWin.end, time_until_reset_seconds: Math.max(0, Math.floor((dayWin.end_ms - nowMs) / 1000)) },
      weekly: { start: weekWin.start, reset_at: weekWin.end, time_until_reset_seconds: Math.max(0, Math.floor((weekWin.end_ms - nowMs) / 1000)) },
    },
    usage: {
      daily: emptyG(),
      weekly: emptyG(),
    },
    by_provider: [],
    by_agent: [],
    by_model: [],
    concurrency: {
      in_flight_claude: 0,
      max_safe_concurrency: 0,
      slots_available: 0,
      queue_depth: 0,
      rate_limit_retry: 0,
      wedged_count: 0,
      oldest_in_flight_age_seconds: null,
      oldest_in_flight_agent: null,
      source_status: "degraded",
    },
    gate: {
      global_state: "degraded",
      should_pause_new_dispatches: false,
      reason: `usage report unavailable: ${err instanceof Error ? err.message : String(err)}`,
      daily_percent: null,
      weekly_percent: null,
      override_active: false,
      enforcement: "warn",
      agent_overrides: [],
      provider_limits: [],
    },
    calibration: {
      denominator_kind: "usage_with_no_limit",
      calibrated_at: null,
      notes: "report degraded",
    },
    source: "manager-usage-meter",
  };
}

// Re-export the gate provider interface for the scheduler.
export type UsageGateProvider = Pick<UsageMeterService, "getSnapshotForScheduler" | "getExcludedAgentsForClaim">;
