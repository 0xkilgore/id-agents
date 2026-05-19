// Phase 3.3 TDD: exponential backoff with jitter.
//
// Backoff floor 30s, ceiling 5m. Each successive attempt doubles. Jitter
// is +/- jitter_pct%, deterministic when caller passes a seeded rng so
// tests can assert exact next_attempt_at values.

import { describe, it, expect } from "vitest";
import {
  computeBackoffMs,
  computeNextAttemptAt,
} from "../../src/dispatch-scheduler/backoff.js";

const policy = {
  rate_limit_backoff_initial_ms: 30_000,
  rate_limit_backoff_max_ms: 300_000,
  rate_limit_max_attempts: 5,
  jitter_pct: 0.2,
};

describe("computeBackoffMs (no jitter)", () => {
  it("attempt 1 = initial 30s", () => {
    expect(computeBackoffMs(1, policy, () => 0.5)).toBe(30_000);
  });
  it("attempt 2 = 60s", () => {
    expect(computeBackoffMs(2, policy, () => 0.5)).toBe(60_000);
  });
  it("attempt 3 = 120s", () => {
    expect(computeBackoffMs(3, policy, () => 0.5)).toBe(120_000);
  });
  it("attempt 4 = 240s", () => {
    expect(computeBackoffMs(4, policy, () => 0.5)).toBe(240_000);
  });
  it("attempt 5 = capped at 300s", () => {
    expect(computeBackoffMs(5, policy, () => 0.5)).toBe(300_000);
  });
  it("attempt 6+ stays capped at 300s", () => {
    expect(computeBackoffMs(20, policy, () => 0.5)).toBe(300_000);
  });
});

describe("computeBackoffMs (with jitter)", () => {
  it("jitter at rng=0 shifts down by jitter_pct", () => {
    // base 30000 ± 20% → 24000..36000; rng=0 → -20% → 24000
    expect(computeBackoffMs(1, policy, () => 0)).toBe(24_000);
  });
  it("jitter at rng=1 shifts up by jitter_pct", () => {
    // base 30000 ± 20% → 36000
    expect(computeBackoffMs(1, policy, () => 1)).toBe(36_000);
  });
  it("never goes below initial floor / 2", () => {
    // even with extreme jitter, we round to a sane integer floor
    const r = computeBackoffMs(1, policy, () => 0);
    expect(r).toBeGreaterThanOrEqual(15_000);
  });
});

describe("computeNextAttemptAt", () => {
  it("returns ISO timestamp = now + backoff(attempt)", () => {
    const now = "2026-05-19T20:00:00.000Z";
    const r = computeNextAttemptAt(now, 1, policy, () => 0.5);
    expect(r).toBe("2026-05-19T20:00:30.000Z");
  });
  it("attempt 3 = now + 120s", () => {
    const now = "2026-05-19T20:00:00.000Z";
    const r = computeNextAttemptAt(now, 3, policy, () => 0.5);
    expect(r).toBe("2026-05-19T20:02:00.000Z");
  });
});
