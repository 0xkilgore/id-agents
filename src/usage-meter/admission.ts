// OP-7 usage-gating — dispatch admission decision (pure).
//
// CTO-3 scope: cto/output/2026-06-10-op7-usage-gating-architecture-scope.md
//
// OP-7 owns PREVENTION: it decides whether a dispatch may START. This is
// distinct from Dispatch-canonical strict-mode, which classifies an
// agent's response AFTER it exists.
//
// admitDispatch() runs the admission flow (spec §"Dispatch Admission
// Flow") as a pure function:
//   - over-budget attempts → status "dispatch_blocked" + typed DispatchGate
//   - agent/provider concurrency or spacing limited → "queued_for_capacity"
//   - clean → "delivering"
//
// SAFETY (Chris's overnight mandate, carried from the usage-meter gate):
// gating ships WARN-ONLY by default. In "warn" mode admitDispatch NEVER
// flips admit to false — it records the would-be gate as a SHADOW gate
// (gate_metadata.shadow = true) so /ops still surfaces the situation, but
// the dispatch proceeds. Hard enforcement is opt-in via enforcement:
// "enforce" (USAGE_GATE_ENFORCEMENT=enforce upstream).

// ── Typed gate reasons (spec §DispatchGate) ──────────────────────────

export type DispatchGateReason =
  | "budget_exhausted"
  | "near_budget_requires_override"
  | "over_concurrency"
  | "provider_capacity_full"
  | "provider_paused"
  | "operator_paused"
  | "missing_budget_config";

export type GateState = "blocked" | "queued" | "overridden" | "released";

/** Canonical dispatch status emitted by admission. Mirrors the
 *  Dispatch-canonical lifecycle additions in CTO-3 (§Build Acceptance). */
export type AdmissionStatus = "delivering" | "dispatch_blocked" | "queued_for_capacity";

export type CostTier = "low" | "medium" | "high";

export interface OperatorOverride {
  force_dispatch: boolean;
  reason: string | null;
  actor: string | null;
}

export interface DispatchGate {
  dispatch_gate_phid: string;
  dispatch_phid: string;
  agent_id: string;
  provider: string | null;
  gate_state: GateState;
  gate_reason: DispatchGateReason | null;
  gate_metadata: Record<string, unknown>;
  operator_override: {
    forced: boolean;
    reason: string | null;
    actor: string | null;
    at: string | null;
  };
  created_at: string;
  released_at: string | null;
}

export interface AdmissionResult {
  admit: boolean;
  status: AdmissionStatus;
  gate: DispatchGate | null;
  warnings: string[];
}

// ── Seed defaults (spec §Data Artifacts) ─────────────────────────────

export interface CostTierBudget {
  daily_token_equivalent_limit: number;
  weekly_token_equivalent_limit: number;
}

export const DEFAULT_TIER_BUDGETS: Readonly<Record<CostTier, CostTierBudget>> =
  Object.freeze({
    low: { daily_token_equivalent_limit: 2_000_000, weekly_token_equivalent_limit: 10_000_000 },
    medium: { daily_token_equivalent_limit: 750_000, weekly_token_equivalent_limit: 3_500_000 },
    high: { daily_token_equivalent_limit: 250_000, weekly_token_equivalent_limit: 1_250_000 },
  });

export const DEFAULT_AGENT_MAX_CONCURRENT = 1;
export const DEFAULT_PROVIDER_MAX_CONCURRENT = 3;
export const DEFAULT_MIN_SPACING_SECONDS = 30;
export const DEFAULT_NEAR_BUDGET_PCT = 0.9;

// W1-1: per-provider admission concurrency defaults. Each provider lane has
// its own cap so an over-concurrency gate on one lane never reflects another
// lane's load. Cursor is intentionally lower (2) — it is a distinct,
// lower-throughput lane, not Anthropic.
export const DEFAULT_PROVIDER_MAX_CONCURRENT_BY_PROVIDER: Readonly<Record<string, number>> =
  Object.freeze({
    anthropic: 3,
    openai: 4,
    cursor: 2,
    other: 2,
  });

/** Per-provider concurrency cap (spec step 7). Falls back to the generic
 *  default for unknown providers. */
export function defaultProviderMaxConcurrent(provider: string | null): number {
  if (provider && provider in DEFAULT_PROVIDER_MAX_CONCURRENT_BY_PROVIDER) {
    return DEFAULT_PROVIDER_MAX_CONCURRENT_BY_PROVIDER[provider];
  }
  return DEFAULT_PROVIDER_MAX_CONCURRENT;
}

export function resolveTierBudget(tier: CostTier): { daily_limit: number; weekly_limit: number } {
  const t = DEFAULT_TIER_BUDGETS[tier];
  return { daily_limit: t.daily_token_equivalent_limit, weekly_limit: t.weekly_token_equivalent_limit };
}

// ── Admission input ──────────────────────────────────────────────────

export interface AdmissionInput {
  dispatch_phid: string;
  agent_id: string;
  provider: string | null;
  enforcement: "warn" | "enforce";
  now_iso: string;
  /** Resolved budget for this agent. null = no config (use default + warn). */
  budget: { daily_limit: number; weekly_limit: number } | null;
  usage: { daily_used: number; weekly_used: number };
  /** Fraction of budget at which "near budget" begins. Default 0.9. */
  near_budget_pct?: number;
  /** When true, a near-budget attempt requires an operator override. */
  require_override_near_budget?: boolean;
  /** Current active dispatches for this agent (max defaults to 1). */
  agent_concurrency?: { current: number; max?: number };
  /** Current active dispatches for this provider (max defaults per provider). */
  provider_concurrency?: { current: number; max?: number };
  /** Minimum spacing to the same agent (min_seconds defaults to 30). */
  spacing?: { min_seconds?: number; last_dispatched_at: string | null };
  provider_paused?: boolean;
  operator_paused?: boolean;
  override?: OperatorOverride | null;
}

// ── Admission decision ───────────────────────────────────────────────

export function admitDispatch(input: AdmissionInput): AdmissionResult {
  const warnings: string[] = [];
  const enforce = input.enforcement === "enforce";

  // A valid operator override needs force_dispatch + a non-empty reason +
  // an actor identity (spec §Override Semantics). An incomplete override
  // is ignored (and warned) so callers can't bypass gating by accident.
  const override = input.override ?? null;
  const overrideValid =
    !!override &&
    override.force_dispatch === true &&
    typeof override.reason === "string" &&
    override.reason.trim().length > 0 &&
    typeof override.actor === "string" &&
    override.actor.trim().length > 0;
  if (override?.force_dispatch && !overrideValid) {
    warnings.push(
      "operator override ignored: force_dispatch requires a non-empty reason and actor",
    );
  }

  // (a) Provider hard pause — NOT bypassable by an ordinary force_dispatch
  // (spec §Override Semantics: forced dispatches still respect provider
  // hard pauses).
  if (input.provider_paused) {
    return decide(input, enforce, "blocked", "budget", "provider_paused", {}, warnings, false);
  }

  // (b) Operator pause — bypassable by a valid override.
  if (input.operator_paused && !overrideValid) {
    return decide(input, enforce, "blocked", "budget", "operator_paused", {}, warnings, false);
  }

  // (1-3) Resolve budget. Missing config is a warning, not a block
  // (spec step 2: use cost-tier default and emit a warning).
  if (input.budget === null) {
    warnings.push("missing_budget_config: no budget configured for agent; using cost-tier default and admitting");
  }

  // (4) Budget exhaustion.
  if (input.budget) {
    const { daily_limit, weekly_limit } = input.budget;
    const dailyExhausted = daily_limit > 0 && input.usage.daily_used >= daily_limit;
    const weeklyExhausted = weekly_limit > 0 && input.usage.weekly_used >= weekly_limit;
    if (dailyExhausted || weeklyExhausted) {
      const meta = {
        daily_used: input.usage.daily_used,
        daily_limit,
        weekly_used: input.usage.weekly_used,
        weekly_limit,
        window: dailyExhausted ? "daily" : "weekly",
      };
      if (overrideValid) {
        return decide(input, enforce, "overridden", "delivering", "budget_exhausted", meta, warnings, true);
      }
      return decide(input, enforce, "blocked", "budget", "budget_exhausted", meta, warnings, false);
    }

    // (5) Near budget requiring override.
    if (input.require_override_near_budget) {
      const nearPct = input.near_budget_pct ?? DEFAULT_NEAR_BUDGET_PCT;
      const dailyNear = daily_limit > 0 && input.usage.daily_used >= nearPct * daily_limit;
      const weeklyNear = weekly_limit > 0 && input.usage.weekly_used >= nearPct * weekly_limit;
      if (dailyNear || weeklyNear) {
        const meta = { near_budget_pct: nearPct, window: dailyNear ? "daily" : "weekly" };
        if (overrideValid) {
          return decide(input, enforce, "overridden", "delivering", "near_budget_requires_override", meta, warnings, true);
        }
        return decide(input, enforce, "blocked", "budget", "near_budget_requires_override", meta, warnings, false);
      }
    }
  }

  // A valid override past budget but with no over-budget condition still
  // delivers normally; it only matters for concurrency below if forced.
  // (6) Per-agent concurrency.
  const agentMax = input.agent_concurrency?.max ?? DEFAULT_AGENT_MAX_CONCURRENT;
  const agentCurrent = input.agent_concurrency?.current ?? 0;
  if (!overrideValid && agentCurrent >= agentMax) {
    const meta = { scope: "agent", concurrent_count: agentCurrent, max_concurrent: agentMax };
    return decide(input, enforce, "queued", "queued", "over_concurrency", meta, warnings, false);
  }

  // (7) Per-provider concurrency.
  const providerMax = input.provider_concurrency?.max ?? defaultProviderMaxConcurrent(input.provider);
  const providerCurrent = input.provider_concurrency?.current ?? 0;
  if (!overrideValid && providerCurrent >= providerMax) {
    const meta = { scope: "provider", concurrent_count: providerCurrent, max_concurrent: providerMax };
    return decide(input, enforce, "queued", "queued", "provider_capacity_full", meta, warnings, false);
  }

  // (8) Minimum spacing to the same agent.
  const lastAt = input.spacing?.last_dispatched_at ?? null;
  if (!overrideValid && lastAt) {
    const minSeconds = input.spacing?.min_seconds ?? DEFAULT_MIN_SPACING_SECONDS;
    const last = Date.parse(lastAt);
    const now = Date.parse(input.now_iso);
    if (Number.isFinite(last) && Number.isFinite(now)) {
      const earliest = last + minSeconds * 1000;
      if (now < earliest) {
        const meta = {
          kind: "spacing",
          min_seconds: minSeconds,
          next_dispatch_no_earlier_than: new Date(earliest).toISOString(),
        };
        return decide(input, enforce, "queued", "queued", "over_concurrency", meta, warnings, false);
      }
    }
  }

  // (10) Admitted.
  return { admit: true, status: "delivering", gate: null, warnings };
}

// ── Decision assembly ────────────────────────────────────────────────

/**
 * Build an AdmissionResult + DispatchGate for a non-clean outcome.
 *
 * `intentStatus` is the status the ENFORCE path would emit
 * ("budget" → dispatch_blocked, "queued" → queued_for_capacity,
 * "delivering" → delivering for an override).
 *
 * In WARN mode a would-be block/queue is downgraded to delivering and the
 * gate is stamped shadow=true so it stays observable in /ops without
 * stopping the dispatch.
 */
function decide(
  input: AdmissionInput,
  enforce: boolean,
  gateState: GateState,
  intentStatus: "budget" | "queued" | "delivering",
  reason: DispatchGateReason,
  metadata: Record<string, unknown>,
  warnings: string[],
  forced: boolean,
): AdmissionResult {
  const overriddenOutcome = gateState === "overridden";

  // An override is a real admit even in warn mode.
  if (overriddenOutcome) {
    const gate = buildGate(input, "overridden", reason, metadata, forced);
    return { admit: true, status: "delivering", gate, warnings };
  }

  if (!enforce) {
    // Warn-only: record the would-be gate as a shadow, but admit.
    const gate = buildGate(input, gateState, reason, { ...metadata, shadow: true }, false);
    warnings.push(`warn-only: would ${gateState} (${reason}); admitting`);
    return { admit: true, status: "delivering", gate, warnings };
  }

  const status: AdmissionStatus =
    intentStatus === "queued" ? "queued_for_capacity" : "dispatch_blocked";
  const gate = buildGate(input, gateState, reason, metadata, false);
  return { admit: false, status, gate, warnings };
}

function buildGate(
  input: AdmissionInput,
  gateState: GateState,
  reason: DispatchGateReason,
  metadata: Record<string, unknown>,
  forced: boolean,
): DispatchGate {
  return {
    // Deterministic, stable PHID derived from the dispatch PHID so the
    // gate is reproducible (no clock/random in this pure function).
    dispatch_gate_phid: `phid:dgate-${input.dispatch_phid.replace(/^phid:/, "")}`,
    dispatch_phid: input.dispatch_phid,
    agent_id: input.agent_id,
    provider: input.provider,
    gate_state: gateState,
    gate_reason: reason,
    gate_metadata: metadata,
    operator_override: {
      forced,
      reason: forced ? input.override?.reason ?? null : null,
      actor: forced ? input.override?.actor ?? null : null,
      at: forced ? input.now_iso : null,
    },
    created_at: input.now_iso,
    released_at: null,
  };
}
