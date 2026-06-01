// Usage Meter — budget policy loader tests.
// Spec: cto/output/2026-05-31-usage-meter-controls-spec.md
//
// Resolution order:
//   1. USAGE_BUDGET_POLICY_PATH (env), if set
//   2. configs/usage-budget-policy.json
//   3. compiled defaults (conservative)
// Invalid config: NEVER crash; degrade to defaults + flag as degraded.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadUsageBudgetPolicy,
  DEFAULT_USAGE_BUDGET_POLICY,
} from "../../src/usage-meter/config.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "usage-policy-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("DEFAULT_USAGE_BUDGET_POLICY — conservative compiled defaults", () => {
  it("includes schema_version v1, anthropic provider, soft/hard thresholds", () => {
    expect(DEFAULT_USAGE_BUDGET_POLICY.schema_version).toBe("usage-budget-policy.v1");
    expect(DEFAULT_USAGE_BUDGET_POLICY.provider).toBe("anthropic");
    expect(DEFAULT_USAGE_BUDGET_POLICY.global.soft_threshold_pct).toBe(0.8);
    expect(DEFAULT_USAGE_BUDGET_POLICY.global.hard_threshold_pct).toBe(1.0);
  });

  it("includes manager + sentinel as exempt by default", () => {
    expect(DEFAULT_USAGE_BUDGET_POLICY.exempt_agents).toContain("manager");
    expect(DEFAULT_USAGE_BUDGET_POLICY.exempt_agents).toContain("sentinel");
  });
});

describe("loadUsageBudgetPolicy — happy path", () => {
  it("loads a valid JSON file from the explicit path", () => {
    const file = join(tmpDir, "policy.json");
    writeFileSync(file, JSON.stringify({
      schema_version: "usage-budget-policy.v1",
      timezone: "America/Chicago",
      provider: "anthropic",
      global: { daily_weighted_tokens: 100, weekly_weighted_tokens: 500, soft_threshold_pct: 0.7, hard_threshold_pct: 0.95 },
      agents: { roger: { daily_weighted_tokens: 50, weekly_weighted_tokens: 200, priority: "worker" } },
      exempt_agents: ["manager"],
      emergency_override: { enabled: false, reason: null, expires_at: null },
    }));
    const r = loadUsageBudgetPolicy({ env: { USAGE_BUDGET_POLICY_PATH: file } });
    expect(r.degraded).toBe(false);
    expect(r.source).toBe("env_path");
    expect(r.policy.global.daily_weighted_tokens).toBe(100);
    expect(r.policy.agents.roger?.priority).toBe("worker");
  });
});

describe("loadUsageBudgetPolicy — resolution order", () => {
  it("env path wins over configs/ path", () => {
    const envFile = join(tmpDir, "from-env.json");
    writeFileSync(envFile, JSON.stringify({
      schema_version: "usage-budget-policy.v1",
      timezone: "UTC",
      provider: "anthropic",
      global: { daily_weighted_tokens: 7, weekly_weighted_tokens: 70, soft_threshold_pct: 0.5, hard_threshold_pct: 0.9 },
      agents: {},
      exempt_agents: [],
      emergency_override: { enabled: false, reason: null, expires_at: null },
    }));
    const configsFile = join(tmpDir, "configs-fallback.json");
    writeFileSync(configsFile, JSON.stringify({
      schema_version: "usage-budget-policy.v1",
      timezone: "America/Chicago",
      provider: "anthropic",
      global: { daily_weighted_tokens: 999, weekly_weighted_tokens: 999, soft_threshold_pct: 0.8, hard_threshold_pct: 1.0 },
      agents: {},
      exempt_agents: [],
      emergency_override: { enabled: false, reason: null, expires_at: null },
    }));
    const r = loadUsageBudgetPolicy({
      env: { USAGE_BUDGET_POLICY_PATH: envFile },
      configsPath: configsFile,
    });
    expect(r.source).toBe("env_path");
    expect(r.policy.global.daily_weighted_tokens).toBe(7);
  });

  it("falls through to configsPath when env is unset", () => {
    const configsFile = join(tmpDir, "configs.json");
    writeFileSync(configsFile, JSON.stringify({
      schema_version: "usage-budget-policy.v1",
      timezone: "America/Chicago",
      provider: "anthropic",
      global: { daily_weighted_tokens: 1234, weekly_weighted_tokens: 0, soft_threshold_pct: 0.8, hard_threshold_pct: 1.0 },
      agents: {},
      exempt_agents: [],
      emergency_override: { enabled: false, reason: null, expires_at: null },
    }));
    const r = loadUsageBudgetPolicy({ env: {}, configsPath: configsFile });
    expect(r.source).toBe("configs_file");
    expect(r.policy.global.daily_weighted_tokens).toBe(1234);
  });

  it("falls through to compiled defaults when neither path exists", () => {
    const r = loadUsageBudgetPolicy({ env: {}, configsPath: join(tmpDir, "does-not-exist.json") });
    expect(r.source).toBe("defaults");
    expect(r.policy).toEqual(DEFAULT_USAGE_BUDGET_POLICY);
    expect(r.degraded).toBe(false);
  });
});

describe("loadUsageBudgetPolicy — fail-safe on invalid files", () => {
  it("malformed JSON → defaults + degraded=true", () => {
    const f = join(tmpDir, "bad.json");
    writeFileSync(f, "{ not valid json");
    const r = loadUsageBudgetPolicy({ env: { USAGE_BUDGET_POLICY_PATH: f } });
    expect(r.policy).toEqual(DEFAULT_USAGE_BUDGET_POLICY);
    expect(r.degraded).toBe(true);
    expect(r.degraded_reason).toMatch(/parse|json|invalid/i);
  });

  it("missing required field (schema_version) → defaults + degraded", () => {
    const f = join(tmpDir, "missing.json");
    writeFileSync(f, JSON.stringify({ timezone: "UTC", provider: "anthropic" }));
    const r = loadUsageBudgetPolicy({ env: { USAGE_BUDGET_POLICY_PATH: f } });
    expect(r.policy).toEqual(DEFAULT_USAGE_BUDGET_POLICY);
    expect(r.degraded).toBe(true);
  });

  it("wrong schema_version → defaults + degraded", () => {
    const f = join(tmpDir, "wrong.json");
    writeFileSync(f, JSON.stringify({
      schema_version: "usage-budget-policy.v99",
      timezone: "UTC",
      provider: "anthropic",
      global: { daily_weighted_tokens: 1, weekly_weighted_tokens: 1, soft_threshold_pct: 0.5, hard_threshold_pct: 1.0 },
      agents: {},
      exempt_agents: [],
      emergency_override: { enabled: false, reason: null, expires_at: null },
    }));
    const r = loadUsageBudgetPolicy({ env: { USAGE_BUDGET_POLICY_PATH: f } });
    expect(r.degraded).toBe(true);
    expect(r.policy).toEqual(DEFAULT_USAGE_BUDGET_POLICY);
  });

  it("invalid threshold values (out of [0,1]) → defaults + degraded", () => {
    const f = join(tmpDir, "thresh.json");
    writeFileSync(f, JSON.stringify({
      schema_version: "usage-budget-policy.v1",
      timezone: "UTC",
      provider: "anthropic",
      global: { daily_weighted_tokens: 1, weekly_weighted_tokens: 1, soft_threshold_pct: 5, hard_threshold_pct: 2 },
      agents: {},
      exempt_agents: [],
      emergency_override: { enabled: false, reason: null, expires_at: null },
    }));
    const r = loadUsageBudgetPolicy({ env: { USAGE_BUDGET_POLICY_PATH: f } });
    expect(r.degraded).toBe(true);
  });

  it("negative budget values → defaults + degraded", () => {
    const f = join(tmpDir, "neg.json");
    writeFileSync(f, JSON.stringify({
      schema_version: "usage-budget-policy.v1",
      timezone: "UTC",
      provider: "anthropic",
      global: { daily_weighted_tokens: -1, weekly_weighted_tokens: 100, soft_threshold_pct: 0.8, hard_threshold_pct: 1.0 },
      agents: {},
      exempt_agents: [],
      emergency_override: { enabled: false, reason: null, expires_at: null },
    }));
    const r = loadUsageBudgetPolicy({ env: { USAGE_BUDGET_POLICY_PATH: f } });
    expect(r.degraded).toBe(true);
  });
});
