// Exponential backoff with jitter for provider-throttle requeue.
// Pure function — pass a seeded rng for deterministic test assertions.

export interface BackoffPolicy {
  rate_limit_backoff_initial_ms: number;
  rate_limit_backoff_max_ms: number;
  rate_limit_max_attempts: number;
  jitter_pct: number;
}

/**
 * attempt is 1-indexed: attempt=1 yields initial backoff, attempt=2 doubles,
 * and so on, capped at rate_limit_backoff_max_ms.
 *
 * Jitter is symmetric: rng=0 → -jitter_pct; rng=0.5 → 0; rng=1 → +jitter_pct.
 */
export function computeBackoffMs(
  attempt: number,
  policy: BackoffPolicy,
  rng: () => number = Math.random,
): number {
  const exponent = Math.max(0, attempt - 1);
  const base = Math.min(
    policy.rate_limit_backoff_initial_ms * Math.pow(2, exponent),
    policy.rate_limit_backoff_max_ms,
  );
  const r = clamp01(rng());
  // Map [0, 1] → [-jitter_pct, +jitter_pct]
  const jitterFactor = 1 + (r * 2 - 1) * policy.jitter_pct;
  const withJitter = Math.round(base * jitterFactor);
  return Math.max(Math.floor(policy.rate_limit_backoff_initial_ms / 2), withJitter);
}

export function computeNextAttemptAt(
  nowIso: string,
  attempt: number,
  policy: BackoffPolicy,
  rng: () => number = Math.random,
): string {
  const ms = computeBackoffMs(attempt, policy, rng);
  const nowMs = Date.parse(nowIso);
  return new Date(nowMs + ms).toISOString();
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0.5;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}
