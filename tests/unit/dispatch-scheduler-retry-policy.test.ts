// D1 / BUG-003: reason-aware retry policy. The scheduler used a single jittered
// backoff (which could dip BELOW 30s) regardless of WHY a dispatch failed, so a
// provider_rate_limit_exhausted failure could same-second-retry on the already
// throttled provider and cascade. This pins the deterministic backoff ladder
// (30/60/120/240, cap 600s) and the reason-aware action table.

import { describe, it, expect } from "vitest";
import {
  backoffMsForAttempt,
  computeRetryDecision,
  retryReasonFromThrottleKind,
  RETRY_BACKOFF_CAP_MS,
} from "../../src/dispatch-scheduler/retry-policy.js";

const NOW = "2026-06-16T20:00:00.000Z";

describe("backoffMsForAttempt — exponential ladder with cap", () => {
  it("follows 30s, 60s, 120s, 240s then caps at 600s", () => {
    expect(backoffMsForAttempt(1)).toBe(30_000);
    expect(backoffMsForAttempt(2)).toBe(60_000);
    expect(backoffMsForAttempt(3)).toBe(120_000);
    expect(backoffMsForAttempt(4)).toBe(240_000);
    expect(backoffMsForAttempt(5)).toBe(600_000);
    expect(backoffMsForAttempt(6)).toBe(RETRY_BACKOFF_CAP_MS);
    expect(backoffMsForAttempt(50)).toBe(600_000);
  });

  it("clamps attempt <= 0 to the first rung (never below 30s)", () => {
    expect(backoffMsForAttempt(0)).toBe(30_000);
    expect(backoffMsForAttempt(-3)).toBe(30_000);
  });
});

describe("computeRetryDecision — provider_rate_limit_exhausted (backs off, never < 30s)", () => {
  it("first failure backs off exactly 30s on the same provider", () => {
    const d = computeRetryDecision("provider_rate_limit_exhausted", 1, NOW);
    expect(d.action).toBe("backoff");
    expect(d.delay_ms).toBe(30_000);
    expect(d.delay_ms).toBeGreaterThanOrEqual(30_000); // BUG-003 invariant
    expect(d.next_attempt_at).toBe("2026-06-16T20:00:30.000Z");
    expect(d.exhausted).toBe(false);
  });

  it("second failure doubles to 60s", () => {
    const d = computeRetryDecision("provider_rate_limit_exhausted", 2, NOW);
    expect(d.delay_ms).toBe(60_000);
    expect(d.next_attempt_at).toBe("2026-06-16T20:01:00.000Z");
  });

  it("becomes terminal (retries exhausted) after the 5th failed attempt", () => {
    const d = computeRetryDecision("provider_rate_limit_exhausted", 5, NOW);
    expect(d.action).toBe("terminal");
    expect(d.exhausted).toBe(true);
    expect(d.next_attempt_at).toBeNull();
  });
});

describe("computeRetryDecision — provider_server_error (5xx, backs off, no fallback)", () => {
  it("backs off like rate-limit on the same provider", () => {
    const d = computeRetryDecision("provider_server_error", 1, NOW);
    expect(d.action).toBe("backoff");
    expect(d.delay_ms).toBe(30_000);
  });
});

describe("computeRetryDecision — terminal non-retryable reasons", () => {
  it("provider_auth_error gets ZERO retries (terminal auth-required)", () => {
    const d = computeRetryDecision("provider_auth_error", 1, NOW);
    expect(d.action).toBe("terminal");
    expect(d.exhausted).toBe(false); // not exhausted — never retryable
    expect(d.terminal_kind).toBe("failed_auth_required");
    expect(d.next_attempt_at).toBeNull();
    expect(d.delay_ms).toBe(0);
    expect(d.attempts_remaining).toBe(0);
  });

  it("dispatch_id_mismatch gets ZERO retries (terminal contract error)", () => {
    const d = computeRetryDecision("dispatch_id_mismatch", 1, NOW);
    expect(d.action).toBe("terminal");
    expect(d.exhausted).toBe(false);
    expect(d.terminal_kind).toBe("failed_contract_error");
    expect(d.next_attempt_at).toBeNull();
  });
});

describe("computeRetryDecision — agent_error (capped retries)", () => {
  it("backs off on the first failures", () => {
    expect(computeRetryDecision("agent_error", 1, NOW).action).toBe("backoff");
    expect(computeRetryDecision("agent_error", 2, NOW).action).toBe("backoff");
  });

  it("caps at 3 retries — fewer than the rate-limit cap", () => {
    const d = computeRetryDecision("agent_error", 3, NOW);
    expect(d.action).toBe("terminal");
    expect(d.exhausted).toBe(true);
    expect(d.max_attempts).toBe(3);
  });
});

describe("computeRetryDecision — expired (defers to auto-recovery, not retried here)", () => {
  it("returns a recover action with no backoff", () => {
    const d = computeRetryDecision("expired", 1, NOW);
    expect(d.action).toBe("recover");
    expect(d.next_attempt_at).toBeNull();
  });
});

describe("retryReasonFromThrottleKind — maps classifier kinds to retry reasons", () => {
  it("provider_throttle -> provider_rate_limit_exhausted", () => {
    expect(retryReasonFromThrottleKind("provider_throttle")).toBe("provider_rate_limit_exhausted");
  });
  it("transport -> provider_server_error", () => {
    expect(retryReasonFromThrottleKind("transport")).toBe("provider_server_error");
  });
  it("auth_or_plan -> provider_auth_error", () => {
    expect(retryReasonFromThrottleKind("auth_or_plan")).toBe("provider_auth_error");
  });
  it("agent_error -> agent_error", () => {
    expect(retryReasonFromThrottleKind("agent_error")).toBe("agent_error");
  });
});
