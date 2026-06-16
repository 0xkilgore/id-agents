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
import { normalizeRuntime } from "./types.js";

export interface SchedulerPolicy {
  max_in_flight_anthropic: number;
  max_in_flight_openai: number;
  // W1-1: Cursor CLI is its own provider lane with its own concurrency cap.
  max_in_flight_cursor: number;
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
  /**
   * B11 WIP: age-based TTL (time since claim) after which an in_flight
   * dispatch with an agent_query_id is marked failed via failStaleInFlight.
   * Complementary to silence_threshold_ms — this catches dispatches that
   * never produced a last_output_at stamp at all. Clamped >= starting_timeout_ms.
   */
  stale_in_flight_ttl_ms: number;
  /**
   * T1.6 / R.4: per-runtime override of `stale_in_flight_ttl_ms`. The expiry
   * backstop is an INACTIVITY window, and different harnesses go quiet for
   * legitimately different stretches: a claude-code-cli build can think for
   * over an hour between output flushes, while codex/cursor runs are shorter
   * and a long silence is a better wedge signal. Keyed by canonical Runtime;
   * a runtime absent from this map falls back to `stale_in_flight_ttl_ms`.
   * Resolve via `staleTtlForRuntime(policy, runtime)` (never read directly).
   */
  stale_in_flight_ttl_by_runtime: Partial<Record<Runtime, number>>;
  policy_version: string;
}

export interface PolicyOverrides {
  dispatch?: Partial<SchedulerPolicy>;
}

export const POLICY_DEFAULTS: SchedulerPolicy = {
  max_in_flight_anthropic: 3,
  max_in_flight_openai: 4,
  max_in_flight_cursor: 2,
  max_in_flight_other: 2,
  rate_limit_backoff_initial_ms: 30_000,
  rate_limit_backoff_max_ms: 300_000,
  rate_limit_max_attempts: 5,
  jitter_pct: 0.2,
  claim_batch_limit: 10,
  starting_timeout_ms: 60_000,
  silence_threshold_ms: 30 * 60_000,
  // fix/dispatch-expiry-too-aggressive: build-appropriate hard-fail window.
  // This is the activity-aware INACTIVITY backstop (no progress for this long)
  // — not a wall-clock cap on total runtime — so a long but active build is
  // safe regardless. 45 min gives a legitimately quiet stretch room to breathe.
  stale_in_flight_ttl_ms: 45 * 60_000,
  // T1.6 / R.4: per-runtime inactivity caps. claude-* harnesses get a build-
  // appropriate window > 60 min (long quiet "thinking" stretches are normal and
  // must not false-expire active work); codex/cursor get shorter windows where
  // a long silence more reliably means wedged. Runtimes not listed here (e.g.
  // public-agent-remote, other) fall back to stale_in_flight_ttl_ms (45 min).
  stale_in_flight_ttl_by_runtime: {
    "claude-code-cli": 90 * 60_000,
    "claude-agent-sdk": 90 * 60_000,
    "claude-code-local": 90 * 60_000,
    codex: 30 * 60_000,
    "cursor-cli": 25 * 60_000,
  },
  policy_version: "v1",
};

const SAFETY_CEILING = 20;
const MIN_CAP = 1;

const MAX_IN_FLIGHT_ENV_KEY = "DISPATCH_MAX_IN_FLIGHT_ANTHROPIC";
const MAX_IN_FLIGHT_OPENAI_ENV_KEY = "DISPATCH_MAX_IN_FLIGHT_OPENAI";
const MAX_IN_FLIGHT_CURSOR_ENV_KEY = "DISPATCH_MAX_IN_FLIGHT_CURSOR";
const SILENCE_ENV_KEY = "DISPATCH_SILENCE_THRESHOLD_MS";
const STALE_IN_FLIGHT_TTL_ENV_KEY = "DISPATCH_STALE_IN_FLIGHT_TTL_MS";

// T1.6 / R.4: the canonical runtimes that accept a per-runtime TTL override.
// The env key is the global key suffixed with the runtime, hyphens → "_" and
// uppercased — e.g. DISPATCH_STALE_IN_FLIGHT_TTL_MS_CLAUDE_CODE_CLI,
// DISPATCH_STALE_IN_FLIGHT_TTL_MS_CODEX, DISPATCH_STALE_IN_FLIGHT_TTL_MS_CURSOR_CLI.
const PER_RUNTIME_TTL_RUNTIMES: Runtime[] = [
  "claude-code-cli",
  "claude-agent-sdk",
  "claude-code-local",
  "codex",
  "cursor-cli",
  "public-agent-remote",
  "other",
];

function staleTtlEnvKey(runtime: Runtime): string {
  return `${STALE_IN_FLIGHT_TTL_ENV_KEY}_${runtime.replace(/-/g, "_").toUpperCase()}`;
}

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
  const envAnth = parsePositiveInt(env[MAX_IN_FLIGHT_ENV_KEY]);
  if (envAnth != null) merged.max_in_flight_anthropic = envAnth;
  const envOpenai = parsePositiveInt(env[MAX_IN_FLIGHT_OPENAI_ENV_KEY]);
  if (envOpenai != null) merged.max_in_flight_openai = envOpenai;
  const envCursor = parsePositiveInt(env[MAX_IN_FLIGHT_CURSOR_ENV_KEY]);
  if (envCursor != null) merged.max_in_flight_cursor = envCursor;
  const envSilence = parsePositiveInt(env[SILENCE_ENV_KEY]);
  if (envSilence != null) merged.silence_threshold_ms = envSilence;
  const staleTtl = parsePositiveInt(env[STALE_IN_FLIGHT_TTL_ENV_KEY]);
  if (staleTtl != null) merged.stale_in_flight_ttl_ms = staleTtl;
  // T1.6 / R.4: resolve the per-runtime TTL map with env > config > default
  // precedence (matching this module's contract). An explicit GLOBAL env TTL
  // means "use this for every runtime", so it supersedes the built-in per-runtime
  // DEFAULTS — otherwise a default would silently mask the operator's explicit
  // global override. A per-runtime env key is more specific still and wins.
  const perRuntime: Partial<Record<Runtime, number>> =
    staleTtl != null ? {} : { ...(merged.stale_in_flight_ttl_by_runtime ?? {}) };
  for (const runtime of PER_RUNTIME_TTL_RUNTIMES) {
    const v = parsePositiveInt(env[staleTtlEnvKey(runtime)]);
    if (v != null) perRuntime[runtime] = v;
  }
  merged.stale_in_flight_ttl_by_runtime = perRuntime;
  merged.max_in_flight_anthropic = clampCap(merged.max_in_flight_anthropic);
  merged.max_in_flight_openai = clampCap(merged.max_in_flight_openai);
  merged.max_in_flight_cursor = clampCap(merged.max_in_flight_cursor);
  merged.max_in_flight_other = clampCap(merged.max_in_flight_other);
  if (!Number.isFinite(merged.silence_threshold_ms) || merged.silence_threshold_ms < 0) {
    merged.silence_threshold_ms = POLICY_DEFAULTS.silence_threshold_ms;
  }
  merged.stale_in_flight_ttl_ms = Math.max(merged.starting_timeout_ms, merged.stale_in_flight_ttl_ms);
  return merged;
}

/**
 * T1.6 / R.4: resolve the in-flight inactivity TTL for a specific runtime.
 * Returns the per-runtime override when one is configured, otherwise the global
 * `stale_in_flight_ttl_ms`. Always clamped to >= `starting_timeout_ms` so a
 * mis-set override can never expire a dispatch before it has even started. Pure.
 * Unknown/blank runtimes normalize to "other" and so use the global fallback.
 */
export function staleTtlForRuntime(
  policy: SchedulerPolicy,
  runtime: string | Runtime | null | undefined,
): number {
  const override = policy.stale_in_flight_ttl_by_runtime?.[normalizeRuntime(runtime)];
  const ttl =
    override != null && Number.isFinite(override) && override > 0
      ? override
      : policy.stale_in_flight_ttl_ms;
  return Math.max(policy.starting_timeout_ms, ttl);
}

// Spec 2026-06-10 (dispatch-canonical, Task 10): mode flag controlling the
// strictness of the canonical-lifecycle invariant. `shadow` is the default
// during rollout — direct /talk flows that bypass acceptDispatchStart are
// silently tolerated. `enforce` (Phase C) emits structured warnings so
// operators can spot any remaining legacy callers without refusing the work.
// Both modes leave markQueuedDoneWithResult available as the documented
// repair path.
export type DispatchCanonicalMode = "shadow" | "enforce";

export function parseDispatchCanonicalMode(
  env: Record<string, string | undefined>,
): DispatchCanonicalMode {
  const raw = (env.DISPATCH_CANONICAL_MODE ?? "shadow").toLowerCase();
  return raw === "enforce" ? "enforce" : "shadow";
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

/**
 * W1-1: the configured concurrency cap for a provider lane, independent of
 * every other lane. Used by snapshot/claim so no lane defaults to the
 * Anthropic cap. Pure.
 */
export function maxInFlightForProvider(policy: SchedulerPolicy, provider: Provider): number {
  switch (provider) {
    case "anthropic":
      return policy.max_in_flight_anthropic;
    case "openai":
      return policy.max_in_flight_openai;
    case "cursor":
      return policy.max_in_flight_cursor;
    default:
      return policy.max_in_flight_other;
  }
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
    case "cursor":
      base = policy.max_in_flight_cursor;
      source = "default";
      reason = `cursor cap = ${base}`;
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
