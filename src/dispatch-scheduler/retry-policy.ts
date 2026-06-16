// D1 / BUG-003 (rate-limit cascade): reason-aware retry policy.
//
// Before this, the scheduler bounced every retryable start-error with one
// jittered backoff (`backoff.ts::computeNextAttemptAt`) whose floor was
// initial/2 = 15s — so a `provider_rate_limit_exhausted` failure could retry
// in under 30s against the SAME already-throttled provider and cascade. And the
// backoff was blind to WHY the dispatch failed: an auth error retried as if it
// were transient.
//
// This module is the pure decision core (post-mortem
// `2026-06-15-rate-limit-cascade-post-mortem.md` §3.2/§3.3): a deterministic
// exponential ladder (30/60/120/240, cap 600s — NO sub-30s jitter) plus a
// reason-aware action table. The scheduler consults `computeRetryDecision`
// before firing a follow-up.
//
// Explicitly out of this slice (per the dispatch brief): cross-provider
// fallback routing (§3.4), Retry-After header parsing (§3.1), Sentinel/UI.

import type { FailureKind } from "./types.js";
import type { ThrottleKind } from "./throttle-classifier.js";

/** The typed failure reasons the retry table acts on. A normalized superset of
 *  the strict-mode classifier reasons + the FailureKind values that reach the
 *  scheduler's start-error path. */
export type RetryReason =
  | "provider_rate_limit_exhausted"
  | "provider_server_error"
  | "provider_auth_error"
  | "dispatch_id_mismatch"
  | "agent_error"
  | "expired";

/** §3.2 backoff ladder: attempt 1 = 30s, then double, capping at 600s. The cap
 *  binds from attempt 5 onward (matching the post-mortem's table, which lists
 *  attempt 5+ at the 600s cap rather than the bare geometric 480s). */
export const RETRY_BACKOFF_LADDER_MS: readonly number[] = [
  30_000, 60_000, 120_000, 240_000,
];
export const RETRY_BACKOFF_CAP_MS = 600_000;

/** Deterministic backoff for a 1-indexed attempt (1 = first retry). Never
 *  returns below the first rung (30s) — the BUG-003 floor invariant. */
export function backoffMsForAttempt(attempt: number): number {
  if (attempt <= 1) return RETRY_BACKOFF_LADDER_MS[0];
  if (attempt <= RETRY_BACKOFF_LADDER_MS.length) return RETRY_BACKOFF_LADDER_MS[attempt - 1];
  return RETRY_BACKOFF_CAP_MS;
}

export type RetryAction = "backoff" | "terminal" | "recover";

export interface RetryDecision {
  action: RetryAction;
  reason: RetryReason;
  /** The just-failed attempt count (1-indexed). */
  attempt: number;
  /** Backoff delay in ms (0 for terminal/recover). */
  delay_ms: number;
  /** When to fire the retry (ISO-UTC). null for terminal/recover. */
  next_attempt_at: string | null;
  /** Terminal because the retry budget for this reason is spent. */
  exhausted: boolean;
  /** FailureKind to stamp for a non-retryable terminal (auth/contract). null
   *  when backoff/recover, or when exhausted (the caller marks retries-exhausted). */
  terminal_kind: FailureKind | null;
  /** The retry budget for this reason. */
  max_attempts: number;
  /** Retries left after this attempt. */
  attempts_remaining: number;
}

type ReasonRule =
  | { policy: "backoff"; max_attempts: number }
  | { policy: "terminal"; terminal_kind: FailureKind }
  | { policy: "recover" };

// §3.3 reason-aware action table.
const REASON_RULES: Record<RetryReason, ReasonRule> = {
  // Same-provider backoff. After 5 failed retries → retries exhausted.
  provider_rate_limit_exhausted: { policy: "backoff", max_attempts: 5 },
  // Transient 5xx — same backoff, no fallback (recovers when the provider does).
  provider_server_error: { policy: "backoff", max_attempts: 5 },
  // 401/403 — retrying without re-auth is pointless. Terminal, surface to operator.
  provider_auth_error: { policy: "terminal", terminal_kind: "failed_auth_required" },
  // 409 — a hard dispatcher-contract error, not transient. Terminal, surface now.
  dispatch_id_mismatch: { policy: "terminal", terminal_kind: "failed_contract_error" },
  // Catch-all semantic failure. Capped lower than rate-limit (3) — semantic
  // causes are less likely to self-heal.
  agent_error: { policy: "backoff", max_attempts: 3 },
  // Handled by the auto-recovery path, not retried inline here.
  expired: { policy: "recover" },
};

/**
 * Decide what to do with a failed dispatch given its typed reason and the
 * just-failed attempt count (1-indexed; 1 = first failure). Pure.
 */
export function computeRetryDecision(
  reason: RetryReason,
  attempt: number,
  nowIso: string,
): RetryDecision {
  const rule = REASON_RULES[reason];
  const a = Math.max(1, Math.floor(attempt));

  if (rule.policy === "recover") {
    return terminalShape("recover", reason, a, null, false, 0);
  }
  if (rule.policy === "terminal") {
    return terminalShape("terminal", reason, a, rule.terminal_kind, false, 0);
  }

  // backoff policy
  if (a >= rule.max_attempts) {
    // Retry budget spent → terminal (caller marks retries-exhausted).
    return {
      action: "terminal",
      reason,
      attempt: a,
      delay_ms: 0,
      next_attempt_at: null,
      exhausted: true,
      terminal_kind: null,
      max_attempts: rule.max_attempts,
      attempts_remaining: 0,
    };
  }
  const delay_ms = backoffMsForAttempt(a);
  return {
    action: "backoff",
    reason,
    attempt: a,
    delay_ms,
    next_attempt_at: new Date(Date.parse(nowIso) + delay_ms).toISOString(),
    exhausted: false,
    terminal_kind: null,
    max_attempts: rule.max_attempts,
    attempts_remaining: rule.max_attempts - a,
  };
}

function terminalShape(
  action: RetryAction,
  reason: RetryReason,
  attempt: number,
  terminal_kind: FailureKind | null,
  exhausted: boolean,
  max_attempts: number,
): RetryDecision {
  return {
    action,
    reason,
    attempt,
    delay_ms: 0,
    next_attempt_at: null,
    exhausted,
    terminal_kind,
    max_attempts,
    attempts_remaining: 0,
  };
}

/**
 * Map the transport-time throttle classifier kind to a retry reason. Used to
 * wire the scheduler's start-error path through the reason-aware table.
 * `local_pause` is a usage-gate pause (not a failure) and is handled before
 * this path; it maps to agent_error only defensively.
 */
export function retryReasonFromThrottleKind(kind: ThrottleKind): RetryReason {
  switch (kind) {
    case "provider_throttle":
      return "provider_rate_limit_exhausted";
    case "transport":
      return "provider_server_error";
    case "auth_or_plan":
      return "provider_auth_error";
    case "agent_error":
    case "local_pause":
    default:
      return "agent_error";
  }
}
