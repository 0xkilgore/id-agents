// Scheduler usage-meter v2 concurrency contract.
//
// loadSchedulerPolicy() resolves config: env override > config object >
// hard-coded defaults. The defaults are conservative because Anthropic
// returns server-side throttles ("Server is temporarily limiting
// requests") at ~8 parallel; 3 keeps a flat pipeline.
//
// getSafeConcurrency() is the decision helper the scheduler calls
// before each claim cycle. It combines provider cap, budget gate, and
// per-agent exemption into a single { max_safe, reason, source }.
//
// buildTuningReport() is advisory — it recommends raising/holding/
// lowering N from observed bounce/clean-start counts. Raising the cap
// requires explicit operator approval.

import type { Provider, Runtime, UsagePolicySnapshot } from "./types.js";

export interface SchedulerPolicy {
  max_in_flight_anthropic: number;
  max_in_flight_openai: number;
  max_in_flight_other: number;
  rate_limit_backoff_initial_ms: number;
  rate_limit_backoff_max_ms: number;
  rate_limit_max_attempts: number;
  jitter_pct: number;
  claim_batch_limit: number;
  starting_timeout_ms: number;
  /**
   * B0 (2026-06-08): max time without a B1 `last_output_at` stamp before
   * an in_flight dispatch with an agent_query_id is treated as silently
   * wedged. Bounced + requeued. 0 disables silence-aware sweeping; the
   * tick step then runs only the cheap terminal-closeout path.
   */
  silence_threshold_ms: number;
  policy_version: string;
}

export interface PolicyOverrides {
  dispatch?: Partial<SchedulerPolicy>;
}

export const POLICY_DEFAULTS: SchedulerPolicy = {
  max_in_flight_anthropic: 3,
  max_in_flight_openai: 4,
  max_in_flight_other: 2,
  rate_limit_backoff_initial_ms: 30_000,
  rate_limit_backoff_max_ms: 300_000,
  rate_limit_max_attempts: 5,
  jitter_pct: 0.2,
  claim_batch_limit: 10,
  starting_timeout_ms: 60_000,
  silence_threshold_ms: 30 * 60_000,
  policy_version: "v1",
};

const SAFETY_CEILING = 20;
const MIN_CAP = 1;

const ENV_KEY = "DISPATCH_MAX_IN_FLIGHT_ANTHROPIC";
const SILENCE_ENV_KEY = "DISPATCH_SILENCE_THRESHOLD_MS";

function parsePositiveInt(raw: string | undefined): number | null {
  if (raw == null) return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) return null;
  return n;
}

function clampCap(raw: number): number {
  if (!Number.isFinite(raw)) return POLICY_DEFAULTS.max_in_flight_anthropic;
  return Math.min(SAFETY_CEILING, Math.max(MIN_CAP, Math.floor(raw)));
}

export function loadSchedulerPolicy(
  overrides: PolicyOverrides,
  env: Record<string, string | undefined>,
): SchedulerPolicy {
  const merged: SchedulerPolicy = { ...POLICY_DEFAULTS, ...(overrides.dispatch ?? {}) };
  const envAnth = parsePositiveInt(env[ENV_KEY]);
  if (envAnth != null) merged.max_in_flight_anthropic = envAnth;
  const envSilence = parsePositiveInt(env[SILENCE_ENV_KEY]);
  if (envSilence != null) merged.silence_threshold_ms = envSilence;
  merged.max_in_flight_anthropic = clampCap(merged.max_in_flight_anthropic);
  merged.max_in_flight_openai = clampCap(merged.max_in_flight_openai);
  merged.max_in_flight_other = clampCap(merged.max_in_flight_other);
  if (!Number.isFinite(merged.silence_threshold_ms) || merged.silence_threshold_ms < 0) {
    merged.silence_threshold_ms = POLICY_DEFAULTS.silence_threshold_ms;
  }
  return merged;
}

export type BudgetState = "ok" | "soft_pause" | "hard_pause";

export interface SafeConcurrencyInput {
  provider: Provider;
  runtime: Runtime;
  agent?: string;
  budget_state?: BudgetState;
  current_in_flight?: number;
  exempt_extra?: number;
}

export interface SafeConcurrencyResult {
  max_safe: number;
  reason: string;
  source: "config" | "default" | "budget" | "exemption";
  policy_version: string;
}

export function getSafeConcurrency(
  input: SafeConcurrencyInput,
  policy: SchedulerPolicy,
): SafeConcurrencyResult {
  if (input.budget_state === "hard_pause") {
    return {
      max_safe: 0,
      reason: "budget hard pause: no new dispatches",
      source: "budget",
      policy_version: policy.policy_version,
    };
  }
  if (input.budget_state === "soft_pause") {
    return {
      max_safe: Math.max(0, input.current_in_flight ?? 0),
      reason: "budget soft pause: hold at current in-flight, no new starts",
      source: "budget",
      policy_version: policy.policy_version,
    };
  }

  let base: number;
  let source: SafeConcurrencyResult["source"];
  let reason: string;
  switch (input.provider) {
    case "anthropic":
      base = policy.max_in_flight_anthropic;
      source = "config";
      reason = `anthropic cap = ${base}`;
      break;
    case "openai":
      base = policy.max_in_flight_openai;
      source = "default";
      reason = `openai cap = ${base}`;
      break;
    default:
      base = policy.max_in_flight_other;
      source = "default";
      reason = `${input.provider} cap = ${base}`;
      break;
  }

  const exempt = Math.max(0, Math.floor(input.exempt_extra ?? 0));
  if (exempt > 0) {
    return {
      max_safe: Math.min(SAFETY_CEILING, base + exempt),
      reason: `${reason} + ${exempt} exempt slots for ${input.agent ?? "agent"}`,
      source: "exemption",
      policy_version: policy.policy_version,
    };
  }
  return { max_safe: base, reason, source, policy_version: policy.policy_version };
}

export interface UsageObservation {
  window_attempts: number;
  clean_starts: number;
  provider_bounces: number;
  retry_successes: number;
  avg_queue_wait_ms: number;
  slot_utilisation_pct: number;
}

export interface TuningReport {
  recommendation: "raise" | "hold" | "lower";
  proposed_max_in_flight_anthropic: number;
  current_max_in_flight_anthropic: number;
  reasons: string[];
  requires_operator_approval: boolean;
  bounce_rate: number;
}

const MIN_WINDOW = 10;
const LOWER_BOUNCE_THRESHOLD = 0.1;
const RAISE_UTIL_FLOOR = 0.5;

export function buildTuningReport(
  obs: UsageObservation,
  policy: SchedulerPolicy,
): TuningReport {
  const current = policy.max_in_flight_anthropic;
  const reasons: string[] = [];
  const bounceRate =
    obs.window_attempts === 0
      ? 0
      : obs.provider_bounces / obs.window_attempts;

  if (obs.window_attempts < MIN_WINDOW) {
    reasons.push("insufficient_observations");
    return {
      recommendation: "hold",
      proposed_max_in_flight_anthropic: current,
      current_max_in_flight_anthropic: current,
      reasons,
      requires_operator_approval: false,
      bounce_rate: bounceRate,
    };
  }

  if (bounceRate > LOWER_BOUNCE_THRESHOLD) {
    reasons.push("bounce_rate_exceeds_threshold");
    return {
      recommendation: "lower",
      proposed_max_in_flight_anthropic: Math.max(MIN_CAP, current - 1),
      current_max_in_flight_anthropic: current,
      reasons,
      requires_operator_approval: false,
      bounce_rate: bounceRate,
    };
  }

  if (bounceRate > 0) {
    reasons.push("nonzero_bounce_rate_under_threshold");
    if (obs.slot_utilisation_pct >= RAISE_UTIL_FLOOR) {
      reasons.push("slot_utilisation_high");
      return {
        recommendation: "hold",
        proposed_max_in_flight_anthropic: current,
        current_max_in_flight_anthropic: current,
        reasons,
        requires_operator_approval: false,
        bounce_rate: bounceRate,
      };
    }
    return {
      recommendation: "hold",
      proposed_max_in_flight_anthropic: current,
      current_max_in_flight_anthropic: current,
      reasons,
      requires_operator_approval: false,
      bounce_rate: bounceRate,
    };
  }

  if (current >= SAFETY_CEILING) {
    reasons.push("at_safety_ceiling");
    return {
      recommendation: "hold",
      proposed_max_in_flight_anthropic: current,
      current_max_in_flight_anthropic: current,
      reasons,
      requires_operator_approval: false,
      bounce_rate: bounceRate,
    };
  }

  reasons.push("clean_window_zero_bounces");
  return {
    recommendation: "raise",
    proposed_max_in_flight_anthropic: Math.min(SAFETY_CEILING, current + 1),
    current_max_in_flight_anthropic: current,
    reasons,
    requires_operator_approval: true,
    bounce_rate: bounceRate,
  };
}

export function snapshotPolicy(
  policy: SchedulerPolicy,
  decision: SafeConcurrencyResult,
): UsagePolicySnapshot {
  return {
    max_safe: decision.max_safe,
    source: decision.source,
    policy_version: policy.policy_version,
  };
}
