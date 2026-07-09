// Usage Meter Gate — pure decision functions.
//
// SAFETY-CRITICAL (Chris's overnight mandate, 2026-05-31): the gate
// ships in WARN-ONLY / OBSERVE mode by default. The internal `state`
// field still reports the underlying budget situation so the dashboard
// shows it accurately, but the `decision` field collapses to
// `warn_allow` unless `enforcement === "enforce"`. Operators set
// USAGE_GATE_ENFORCEMENT=enforce explicitly when ready to hard-block.

import type {
  AgentUsageRollup,
  UsageBudgetPolicy,
  UsageGateDecision,
  UsageGateDecisionLabel,
  UsageGateEnforcement,
  UsageGateSnapshot,
  UsageGateState,
  ProviderLimitSignal,
} from "./types.js";

// ─────────────────────────────────────────────────────────────────────
// Env parsing
// ─────────────────────────────────────────────────────────────────────

/**
 * Default is WARN — anything other than the explicit string "enforce"
 * (case-insensitive, whitespace-trimmed) falls back to warn-only mode.
 * "shadow" is accepted as an alias for warn for compatibility with the
 * spec's shadow|enforce language.
 */
export function parseEnforcement(raw: string | undefined): UsageGateEnforcement {
  if (!raw) return "warn";
  const v = raw.trim().toLowerCase();
  if (v === "enforce") return "enforce";
  return "warn";
}

// ─────────────────────────────────────────────────────────────────────
// Override expiry
// ─────────────────────────────────────────────────────────────────────

function overrideIsActive(
  policy: UsageBudgetPolicy,
  nowIso: string,
): boolean {
  const o = policy.emergency_override;
  if (!o.enabled) return false;
  if (!o.expires_at) return true;
  // Compare as strings is unreliable across TZs; parse both via Date.
  const now = Date.parse(nowIso);
  const exp = Date.parse(o.expires_at);
  if (!Number.isFinite(now) || !Number.isFinite(exp)) return false;
  return exp > now;
}

// ─────────────────────────────────────────────────────────────────────
// Percent helpers
// ─────────────────────────────────────────────────────────────────────

function pctOrNull(used: number, budget: number): number | null {
  if (!Number.isFinite(budget) || budget <= 0) return null;
  return used / budget;
}

/** Return state purely from the larger of daily / weekly percent vs thresholds. */
function classifyState(
  dailyPct: number | null,
  weeklyPct: number | null,
  policy: UsageBudgetPolicy,
): UsageGateState {
  const soft = policy.global.soft_threshold_pct ?? 0.8;
  const hard = policy.global.hard_threshold_pct ?? 1.0;
  const worst = Math.max(dailyPct ?? 0, weeklyPct ?? 0);
  if (worst >= hard) return "hard_paused";
  if (worst >= soft) return "soft_warning";
  return "normal";
}

// ─────────────────────────────────────────────────────────────────────
// evaluateGate (main entry)
// ─────────────────────────────────────────────────────────────────────

export interface GateRollups {
  /** Synthetic global rollup ("_global" agent_id). */
  globalRollup: { day: AgentUsageRollup; week: AgentUsageRollup };
  /** Per-agent rollups for any agent we have data on. */
  rollupsByAgent: Record<
    string,
    { day: AgentUsageRollup; week: AgentUsageRollup }
  >;
}

export interface EvaluateGateInput extends GateRollups {
  policy: UsageBudgetPolicy;
  enforcement: UsageGateEnforcement;
  now_iso: string;
  /** Age of the underlying usage data in milliseconds. */
  data_freshness_ms: number;
  /** Real provider limit observations. This is the only source of hard_paused. */
  provider_limits?: ProviderLimitSignal[];
}

const STALE_AFTER_MS = 5 * 60 * 1000;

export function evaluateGate(input: EvaluateGateInput): UsageGateSnapshot {
  const { policy, enforcement, now_iso, data_freshness_ms } = input;
  const providerLimits = input.provider_limits ?? [];
  const override = overrideIsActive(policy, now_iso);
  const stale = data_freshness_ms > STALE_AFTER_MS;
  const failClosed = policy.fail_closed_on_unknown !== false;
  const providerLimited = providerLimits.length > 0;

  // ── Global decision ─────────────────────────────────────────────
  const gDay = pctOrNull(
    input.globalRollup.day.weighted_tokens,
    policy.global.daily_weighted_tokens,
  );
  const gWeek = pctOrNull(
    input.globalRollup.week.weighted_tokens,
    policy.global.weekly_weighted_tokens,
  );
  const gState = providerLimited ? "hard_paused" : classifyState(gDay, gWeek, policy);

  let global: UsageGateDecision;
  if (override) {
    global = {
      state: "normal",
      decision: applyEnforcement("allow", enforcement),
      reason: `emergency override active${policy.emergency_override.reason ? `: ${policy.emergency_override.reason}` : ""}`,
      daily_pct: gDay,
      weekly_pct: gWeek,
    };
  } else if (stale && failClosed) {
    global = {
      state: "degraded",
      decision: applyEnforcement("pause_unknown", enforcement),
      reason: `usage telemetry stale (${Math.round(data_freshness_ms / 1000)}s); fail-closed`,
      daily_pct: gDay,
      weekly_pct: gWeek,
    };
  } else if (stale) {
    global = {
      state: "degraded",
      decision: applyEnforcement("warn_allow", enforcement),
      reason: `usage telemetry stale (${Math.round(data_freshness_ms / 1000)}s); fail-open`,
      daily_pct: gDay,
      weekly_pct: gWeek,
    };
  } else if (providerLimited) {
    global = {
      state: "hard_paused",
      decision: applyEnforcement("pause_non_core", enforcement),
      reason: `provider limit observed: ${providerLimits.map(limitSummary).join("; ")}`,
      daily_pct: gDay,
      weekly_pct: gWeek,
    };
  } else if (gState === "hard_paused") {
    global = {
      state: "soft_warning",
      decision: applyEnforcement("warn_allow", enforcement),
      reason: `configured token reference exceeded, but no real provider limit observed (daily ${pctStr(gDay)}, weekly ${pctStr(gWeek)})`,
      daily_pct: gDay,
      weekly_pct: gWeek,
    };
  } else if (gState === "soft_warning") {
    global = {
      state: "soft_warning",
      decision: applyEnforcement("warn_allow", enforcement),
      reason: `global budget at soft threshold (daily ${pctStr(gDay)}, weekly ${pctStr(gWeek)})`,
      daily_pct: gDay,
      weekly_pct: gWeek,
    };
  } else {
    global = {
      state: "normal",
      decision: applyEnforcement("allow", enforcement),
      reason: "global budget under soft threshold",
      daily_pct: gDay,
      weekly_pct: gWeek,
    };
  }

  // ── Per-agent decisions ─────────────────────────────────────────
  // Include every agent that EITHER has a rollup OR is named in the
  // policy. This way a configured agent with zero usage today still
  // appears in the snapshot — and gets excluded when global is paused.
  const agents: Record<string, UsageGateDecision> = {};
  const isExempt = (a: string) => policy.exempt_agents.includes(a);
  const knownAgents = new Set<string>([
    ...Object.keys(input.rollupsByAgent),
    ...Object.keys(policy.agents),
    ...policy.exempt_agents,
  ]);
  const emptyRollup = (a: string) =>
    input.rollupsByAgent[a] ?? {
      day: { ...input.globalRollup.day, agent_id: a, weighted_tokens: 0, raw_tokens: 0, requests: 0 },
      week: { ...input.globalRollup.week, agent_id: a, weighted_tokens: 0, raw_tokens: 0, requests: 0 },
    };
  for (const agentId of knownAgents) {
    const r = emptyRollup(agentId);
    if (override) {
      agents[agentId] = {
        state: "normal",
        decision: applyEnforcement("allow", enforcement),
        reason: "emergency override active",
        daily_pct: null,
        weekly_pct: null,
      };
      continue;
    }
    if (isExempt(agentId)) {
      agents[agentId] = {
        state: "normal",
        decision: applyEnforcement("allow", enforcement),
        reason: `agent ${agentId} is exempt`,
        daily_pct: null,
        weekly_pct: null,
      };
      continue;
    }
    const agentBudget = policy.agents[agentId];
    const dailyPct = agentBudget
      ? pctOrNull(r.day.weighted_tokens, agentBudget.daily_weighted_tokens)
      : null;
    const weeklyPct = agentBudget
      ? pctOrNull(r.week.weighted_tokens, agentBudget.weekly_weighted_tokens)
      : null;
    const aState = providerLimited ? "hard_paused" : classifyAgentState(dailyPct, weeklyPct, policy);

    // Global hard pause overrides per-agent normal state for non-exempt.
    if (global.state === "hard_paused" || global.state === "degraded") {
      agents[agentId] = {
        state: global.state,
        decision: applyEnforcement(
          global.decision === "pause_unknown" ? "pause_unknown" : "pause_non_core",
          enforcement,
        ),
        reason: global.reason,
        daily_pct: dailyPct,
        weekly_pct: weeklyPct,
      };
      continue;
    }

    if (aState === "hard_paused" && providerLimited) {
      agents[agentId] = {
        state: "hard_paused",
        decision: applyEnforcement("pause_agent", enforcement),
        reason: `provider limit observed: ${providerLimits.map(limitSummary).join("; ")}`,
        daily_pct: dailyPct,
        weekly_pct: weeklyPct,
      };
    } else if (aState === "hard_paused") {
      agents[agentId] = {
        state: "soft_warning",
        decision: applyEnforcement("warn_allow", enforcement),
        reason: `agent ${agentId} configured token reference exceeded, but no real provider limit observed`,
        daily_pct: dailyPct,
        weekly_pct: weeklyPct,
      };
    } else if (aState === "soft_warning") {
      agents[agentId] = {
        state: "soft_warning",
        decision: applyEnforcement("warn_allow", enforcement),
        reason: `agent ${agentId} at soft threshold`,
        daily_pct: dailyPct,
        weekly_pct: weeklyPct,
      };
    } else {
      agents[agentId] = {
        state: "normal",
        decision: applyEnforcement("allow", enforcement),
        reason: `agent ${agentId} under soft threshold`,
        daily_pct: dailyPct,
        weekly_pct: weeklyPct,
      };
    }
  }

  return {
    status: stale ? "degraded" : "ok",
    policy_version: policy.schema_version,
    global,
    agents,
    exempt_agents: [...policy.exempt_agents],
    enforcement,
    override_active: override,
    override_reason: override ? policy.emergency_override.reason ?? undefined : undefined,
    override_expires_at: override ? policy.emergency_override.expires_at ?? undefined : undefined,
    degraded_reason: stale ? "usage telemetry stale" : undefined,
    provider_limits: providerLimits,
    generated_at: now_iso,
  };
}

function limitSummary(signal: ProviderLimitSignal): string {
  const reset = signal.reset_at ? ` until ${signal.reset_at}` : "";
  return `${signal.provider}${reset}`;
}

function classifyAgentState(
  dailyPct: number | null,
  weeklyPct: number | null,
  policy: UsageBudgetPolicy,
): UsageGateState {
  if (dailyPct == null && weeklyPct == null) return "normal";
  return classifyState(dailyPct, weeklyPct, policy);
}

function pctStr(pct: number | null): string {
  return pct == null ? "n/a" : `${Math.round(pct * 100)}%`;
}

/**
 * Map an "intent" decision to an actual decision based on enforcement
 * mode. In WARN mode, ALL pause decisions collapse to warn_allow so
 * nothing is blocked. This is the safety-critical pivot.
 */
function applyEnforcement(
  intent: UsageGateDecisionLabel,
  enforcement: UsageGateEnforcement,
): UsageGateDecisionLabel {
  if (enforcement === "enforce") return intent;
  // warn mode: never block
  if (intent === "pause_agent" || intent === "pause_non_core" || intent === "pause_unknown") {
    return "warn_allow";
  }
  return intent;
}

// ─────────────────────────────────────────────────────────────────────
// Scheduler-claim consumer helpers
// ─────────────────────────────────────────────────────────────────────

/**
 * Is the given agent currently blocked from starting new dispatches?
 * Always FALSE in warn mode (Chris's overnight mandate). In enforce
 * mode, true when the agent's decision is one of the pause_* labels.
 */
export function shouldPauseAgent(
  snapshot: UsageGateSnapshot,
  agentId: string,
): boolean {
  if (snapshot.enforcement !== "enforce") return false;
  const decision = snapshot.agents[agentId]?.decision ?? snapshot.global.decision;
  return (
    decision === "pause_agent" ||
    decision === "pause_non_core" ||
    decision === "pause_unknown"
  );
}

/**
 * Compute the list of agent_ids that the scheduler should EXCLUDE from
 * claim this tick. Always empty in warn mode. In enforce mode:
 *  - global hard pause: every non-exempt agent we have data on
 *  - per-agent pause: just that agent
 */
export function resolveExcludedAgents(snapshot: UsageGateSnapshot): string[] {
  if (snapshot.enforcement !== "enforce") return [];
  const excluded = new Set<string>();
  for (const [agentId, decision] of Object.entries(snapshot.agents)) {
    if (
      decision.decision === "pause_agent" ||
      decision.decision === "pause_non_core" ||
      decision.decision === "pause_unknown"
    ) {
      if (!snapshot.exempt_agents.includes(agentId)) {
        excluded.add(agentId);
      }
    }
  }
  return [...excluded];
}
