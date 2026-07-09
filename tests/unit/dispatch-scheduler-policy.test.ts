// Phase 2.1 + 2.2 + 2.3 TDD for the scheduler's usage-meter v2
// concurrency contract: config loading, getSafeConcurrency decisioning,
// and the tuning report that recommends raising/lowering N from
// observed bounce/clean-start counts.

import { describe, it, expect } from "vitest";
import {
  loadSchedulerPolicy,
  getSafeConcurrency,
  buildTuningReport,
  parseDispatchCanonicalMode,
  staleTtlForRuntime,
  POLICY_DEFAULTS,
  type PolicyOverrides,
  type UsageObservation,
} from "../../src/dispatch-scheduler/policy.js";

describe("loadSchedulerPolicy (Phase 2.1)", () => {
  it("defaults max_in_flight_anthropic to 3", () => {
    const p = loadSchedulerPolicy({}, {});
    expect(p.max_in_flight_anthropic).toBe(3);
    expect(p.rate_limit_backoff_initial_ms).toBe(30_000);
    expect(p.rate_limit_backoff_max_ms).toBe(300_000);
    expect(p.rate_limit_max_attempts).toBe(5);
    expect(p.jitter_pct).toBeCloseTo(0.2);
    expect(p.claim_batch_limit).toBe(10);
    expect(p.starting_timeout_ms).toBe(60_000);
    // fix/dispatch-expiry-too-aggressive: build-appropriate inactivity backstop.
    expect(p.stale_in_flight_ttl_ms).toBe(45 * 60_000);
  });

  it("env override raises the cap without code changes", () => {
    const p = loadSchedulerPolicy({}, { DISPATCH_MAX_IN_FLIGHT_ANTHROPIC: "5" });
    expect(p.max_in_flight_anthropic).toBe(5);
  });

  it("env override lowers the cap", () => {
    const p = loadSchedulerPolicy({}, { DISPATCH_MAX_IN_FLIGHT_ANTHROPIC: "1" });
    expect(p.max_in_flight_anthropic).toBe(1);
  });

  it("env override configures stale in-flight TTL", () => {
    const p = loadSchedulerPolicy({}, { DISPATCH_STALE_IN_FLIGHT_TTL_MS: "120000" });
    expect(p.stale_in_flight_ttl_ms).toBe(120_000);
  });

  it("config object override beats defaults but loses to env", () => {
    const cfg: PolicyOverrides = { dispatch: { max_in_flight_anthropic: 4 } };
    const p1 = loadSchedulerPolicy(cfg, {});
    expect(p1.max_in_flight_anthropic).toBe(4);
    const p2 = loadSchedulerPolicy(cfg, { DISPATCH_MAX_IN_FLIGHT_ANTHROPIC: "2" });
    expect(p2.max_in_flight_anthropic).toBe(2);
  });

  it("invalid env values fall back to defaults", () => {
    const p = loadSchedulerPolicy({}, { DISPATCH_MAX_IN_FLIGHT_ANTHROPIC: "not-a-number" });
    expect(p.max_in_flight_anthropic).toBe(POLICY_DEFAULTS.max_in_flight_anthropic);
  });

  it("non-positive cap fails closed (clamps to 1)", () => {
    const p = loadSchedulerPolicy(
      { dispatch: { max_in_flight_anthropic: -1 } },
      {},
    );
    expect(p.max_in_flight_anthropic).toBe(1);
  });

  it("absurdly large cap clamps to a safety ceiling", () => {
    const p = loadSchedulerPolicy(
      { dispatch: { max_in_flight_anthropic: 9999 } },
      {},
    );
    expect(p.max_in_flight_anthropic).toBeLessThanOrEqual(20);
  });

  it("exposes policy_version for snapshotting onto Dispatch docs", () => {
    const p = loadSchedulerPolicy({}, {});
    expect(p.policy_version).toMatch(/^v\d+(\.\d+)*$/);
  });
});

describe("per-runtime stale-in-flight TTL (T1.6 / R.4)", () => {
  it("defaults: claude-code-cli inactivity cap is > 60 min", () => {
    const p = loadSchedulerPolicy({}, {});
    expect(staleTtlForRuntime(p, "claude-code-cli")).toBeGreaterThan(60 * 60_000);
    expect(staleTtlForRuntime(p, "claude-code-cli")).toBe(90 * 60_000);
  });

  it("defaults: codex and cursor caps are shorter than claude-code-cli", () => {
    const p = loadSchedulerPolicy({}, {});
    const claude = staleTtlForRuntime(p, "claude-code-cli");
    expect(staleTtlForRuntime(p, "codex")).toBe(30 * 60_000);
    expect(staleTtlForRuntime(p, "cursor-cli")).toBe(25 * 60_000);
    expect(staleTtlForRuntime(p, "codex")).toBeLessThan(claude);
    expect(staleTtlForRuntime(p, "cursor-cli")).toBeLessThan(claude);
  });

  it("falls back to the global TTL for a runtime with no override", () => {
    const p = loadSchedulerPolicy({}, {});
    expect(staleTtlForRuntime(p, "public-agent-remote")).toBe(p.stale_in_flight_ttl_ms);
    expect(staleTtlForRuntime(p, "other")).toBe(45 * 60_000);
  });

  it("normalizes the legacy `cursor` alias and blank/unknown runtimes", () => {
    const p = loadSchedulerPolicy({}, {});
    expect(staleTtlForRuntime(p, "cursor")).toBe(25 * 60_000); // legacy alias → cursor-cli
    expect(staleTtlForRuntime(p, "")).toBe(p.stale_in_flight_ttl_ms); // → other → global
    expect(staleTtlForRuntime(p, null)).toBe(p.stale_in_flight_ttl_ms);
  });

  it("per-runtime env override changes the cap for just that runtime", () => {
    const p = loadSchedulerPolicy(
      {},
      { DISPATCH_STALE_IN_FLIGHT_TTL_MS_CODEX: String(10 * 60_000) },
    );
    expect(staleTtlForRuntime(p, "codex")).toBe(10 * 60_000); // overridden
    expect(staleTtlForRuntime(p, "claude-code-cli")).toBe(90 * 60_000); // untouched
  });

  it("env override for claude-code-cli is honored (hyphens → underscores in key)", () => {
    const p = loadSchedulerPolicy(
      {},
      { DISPATCH_STALE_IN_FLIGHT_TTL_MS_CLAUDE_CODE_CLI: String(120 * 60_000) },
    );
    expect(staleTtlForRuntime(p, "claude-code-cli")).toBe(120 * 60_000);
  });

  it("clamps any resolved cap to at least starting_timeout_ms", () => {
    const p = loadSchedulerPolicy(
      {},
      { DISPATCH_STALE_IN_FLIGHT_TTL_MS_CODEX: "1000" }, // 1s < 60s starting_timeout
    );
    expect(staleTtlForRuntime(p, "codex")).toBe(p.starting_timeout_ms);
  });

  it("the default policy exposes the per-runtime map", () => {
    expect(POLICY_DEFAULTS.stale_in_flight_ttl_by_runtime["claude-code-cli"]).toBe(90 * 60_000);
  });

  it("an explicit GLOBAL env TTL supersedes the built-in per-runtime defaults", () => {
    // Operator intent: DISPATCH_STALE_IN_FLIGHT_TTL_MS=X means X for every
    // runtime. The built-in 90-min claude default must not mask it.
    const p = loadSchedulerPolicy({}, { DISPATCH_STALE_IN_FLIGHT_TTL_MS: String(5 * 60_000) });
    expect(staleTtlForRuntime(p, "claude-code-cli")).toBe(5 * 60_000);
    expect(staleTtlForRuntime(p, "codex")).toBe(5 * 60_000);
  });

  it("a per-runtime env still wins over a global env override", () => {
    const p = loadSchedulerPolicy(
      {},
      {
        DISPATCH_STALE_IN_FLIGHT_TTL_MS: String(5 * 60_000),
        DISPATCH_STALE_IN_FLIGHT_TTL_MS_CLAUDE_CODE_CLI: String(80 * 60_000),
      },
    );
    expect(staleTtlForRuntime(p, "claude-code-cli")).toBe(80 * 60_000); // per-runtime env wins
    expect(staleTtlForRuntime(p, "codex")).toBe(5 * 60_000); // global env applies
  });
});

describe("parseDispatchCanonicalMode (Task 10)", () => {
  it("defaults to shadow when env unset", () => {
    expect(parseDispatchCanonicalMode({})).toBe("shadow");
  });

  it("returns enforce when DISPATCH_CANONICAL_MODE=enforce", () => {
    expect(parseDispatchCanonicalMode({ DISPATCH_CANONICAL_MODE: "enforce" })).toBe("enforce");
  });

  it("normalizes case (ENFORCE, Enforce)", () => {
    expect(parseDispatchCanonicalMode({ DISPATCH_CANONICAL_MODE: "ENFORCE" })).toBe("enforce");
    expect(parseDispatchCanonicalMode({ DISPATCH_CANONICAL_MODE: "Enforce" })).toBe("enforce");
  });

  it("falls back to shadow on any other value (unknown, empty, whitespace)", () => {
    expect(parseDispatchCanonicalMode({ DISPATCH_CANONICAL_MODE: "" })).toBe("shadow");
    expect(parseDispatchCanonicalMode({ DISPATCH_CANONICAL_MODE: "   " })).toBe("shadow");
    expect(parseDispatchCanonicalMode({ DISPATCH_CANONICAL_MODE: "off" })).toBe("shadow");
    expect(parseDispatchCanonicalMode({ DISPATCH_CANONICAL_MODE: "strict" })).toBe("shadow");
  });
});

describe("getSafeConcurrency (Phase 2.2)", () => {
  const policy = loadSchedulerPolicy({}, {});

  it("anthropic provider uses max_in_flight_anthropic", () => {
    const r = getSafeConcurrency({ provider: "anthropic", runtime: "claude-code-cli" }, policy);
    expect(r.max_safe).toBe(policy.max_in_flight_anthropic);
    expect(r.source).toBe("config");
    expect(r.reason).toMatch(/anthropic/i);
    expect(r.policy_version).toBe(policy.policy_version);
  });

  it("non-anthropic provider falls through to a per-provider default", () => {
    const r = getSafeConcurrency({ provider: "openai", runtime: "codex" }, policy);
    expect(r.max_safe).toBeGreaterThanOrEqual(1);
    expect(r.source).toBe("default");
  });

  it("budget hard pause metadata does not reduce concurrency without a provider-limit signal", () => {
    const r = getSafeConcurrency(
      { provider: "anthropic", runtime: "claude-code-cli", budget_state: "hard_pause" },
      policy,
    );
    expect(r.max_safe).toBe(policy.max_in_flight_anthropic);
    expect(r.reason).toMatch(/usage reference exceeded/i);
    expect(r.source).toBe("config");
  });

  it("budget soft pause metadata does not hold at current in-flight", () => {
    const r = getSafeConcurrency(
      {
        provider: "anthropic",
        runtime: "claude-code-cli",
        budget_state: "soft_pause",
        current_in_flight: 2,
      },
      policy,
    );
    expect(r.max_safe).toBe(policy.max_in_flight_anthropic);
    expect(r.source).toBe("config");
    expect(r.reason).toMatch(/near threshold/i);
  });

  it("agent exemption raises max_safe by exempt_extra slots", () => {
    const r = getSafeConcurrency(
      {
        provider: "anthropic",
        runtime: "claude-code-cli",
        agent: "critical-watcher",
        exempt_extra: 2,
      },
      policy,
    );
    expect(r.max_safe).toBe(policy.max_in_flight_anthropic + 2);
    expect(r.source).toBe("exemption");
  });

  it("agent exemption still applies when only budget metadata is hard-paused", () => {
    const r = getSafeConcurrency(
      {
        provider: "anthropic",
        runtime: "claude-code-cli",
        budget_state: "hard_pause",
        exempt_extra: 2,
      },
      policy,
    );
    expect(r.max_safe).toBe(policy.max_in_flight_anthropic + 2);
  });
});

describe("buildTuningReport (Phase 2.3)", () => {
  const policy = loadSchedulerPolicy({}, {});

  function obs(overrides: Partial<UsageObservation>): UsageObservation {
    return {
      window_attempts: 30,
      clean_starts: 30,
      provider_bounces: 0,
      retry_successes: 0,
      avg_queue_wait_ms: 0,
      slot_utilisation_pct: 0.3,
      ...overrides,
    };
  }

  it("recommends LOWER when bounce rate exceeds threshold", () => {
    const r = buildTuningReport(
      obs({ window_attempts: 30, clean_starts: 20, provider_bounces: 10 }),
      policy,
    );
    expect(r.recommendation).toBe("lower");
    expect(r.proposed_max_in_flight_anthropic).toBeLessThan(
      policy.max_in_flight_anthropic,
    );
    expect(r.reasons).toContain("bounce_rate_exceeds_threshold");
  });

  it("recommends HOLD when slot utilisation high and bounces nonzero", () => {
    const r = buildTuningReport(
      obs({
        window_attempts: 30,
        clean_starts: 29,
        provider_bounces: 1,
        slot_utilisation_pct: 0.95,
      }),
      policy,
    );
    expect(r.recommendation).toBe("hold");
    expect(r.proposed_max_in_flight_anthropic).toBe(
      policy.max_in_flight_anthropic,
    );
  });

  it("recommends RAISE at most by 1 after clean window with zero bounces", () => {
    const r = buildTuningReport(
      obs({
        window_attempts: 30,
        clean_starts: 30,
        provider_bounces: 0,
        avg_queue_wait_ms: 0,
        slot_utilisation_pct: 0.4,
      }),
      policy,
    );
    expect(r.recommendation).toBe("raise");
    expect(r.proposed_max_in_flight_anthropic).toBe(
      policy.max_in_flight_anthropic + 1,
    );
  });

  it("RAISE recommendation is advisory only — requires_operator_approval is true", () => {
    const r = buildTuningReport(
      obs({ window_attempts: 30, clean_starts: 30, provider_bounces: 0 }),
      policy,
    );
    expect(r.requires_operator_approval).toBe(true);
  });

  it("never recommends raising beyond the safety ceiling", () => {
    const ceiling = loadSchedulerPolicy(
      { dispatch: { max_in_flight_anthropic: 19 } },
      {},
    );
    const r = buildTuningReport(
      obs({ window_attempts: 30, clean_starts: 30, provider_bounces: 0 }),
      ceiling,
    );
    expect(r.proposed_max_in_flight_anthropic).toBeLessThanOrEqual(20);
  });

  it("insufficient window holds without recommending a change", () => {
    const r = buildTuningReport(
      obs({ window_attempts: 4, clean_starts: 4, provider_bounces: 0 }),
      policy,
    );
    expect(r.recommendation).toBe("hold");
    expect(r.reasons).toContain("insufficient_observations");
  });
});
