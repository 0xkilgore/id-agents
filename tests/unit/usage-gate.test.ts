// Usage Gate — pure decision math + WARN-ONLY enforcement gate.
//
// Safety-critical: tests pin the overnight default (WARN-ONLY) so that
// nothing is ever blocked unless USAGE_GATE_ENFORCEMENT=enforce is set.
// See spec: cto/output/2026-05-31-usage-meter-controls-spec.md
// and Chris's overnight mandate (2026-05-31).

import { describe, it, expect } from "vitest";
import {
  evaluateGate,
  shouldPauseAgent,
  parseEnforcement,
  resolveExcludedAgents,
} from "../../src/usage-meter/gate.js";
import type {
  UsageBudgetPolicy,
  AgentUsageRollup,
} from "../../src/usage-meter/types.js";

function policy(overrides: Partial<UsageBudgetPolicy> = {}): UsageBudgetPolicy {
  return {
    schema_version: "usage-budget-policy.v1",
    timezone: "America/Chicago",
    provider: "anthropic",
    global: {
      daily_weighted_tokens: 1_000_000,
      weekly_weighted_tokens: 5_000_000,
      soft_threshold_pct: 0.8,
      hard_threshold_pct: 1.0,
    },
    agents: {
      cto: { daily_weighted_tokens: 250_000, weekly_weighted_tokens: 1_000_000, priority: "core" },
      roger: { daily_weighted_tokens: 350_000, weekly_weighted_tokens: 1_500_000, priority: "worker" },
    },
    exempt_agents: ["manager", "sentinel"],
    emergency_override: { enabled: false, reason: null, expires_at: null },
    fail_closed_on_unknown: true,
    ...overrides,
  };
}

function rollup(
  agentId: string,
  windowKind: "day" | "week",
  weightedTokens: number,
): AgentUsageRollup {
  return {
    provider: "anthropic",
    agent_id: agentId,
    window_kind: windowKind,
    window_start: "2026-05-31T00:00:00.000-05:00",
    window_end: "2026-06-01T00:00:00.000-05:00",
    raw_tokens: weightedTokens,
    weighted_tokens: weightedTokens,
    requests: 1,
    models: ["claude-sonnet-4-6"],
    source_coverage: {},
    computed_at: "2026-05-31T18:00:00.000-05:00",
  };
}

const NOW_ISO = "2026-05-31T18:00:00.000-05:00";

// ─────────────────────────────────────────────────────────────────────
// parseEnforcement — env parsing with WARN default
// ─────────────────────────────────────────────────────────────────────

describe("parseEnforcement — WARN-ONLY default (Chris's overnight mandate)", () => {
  it("defaults to 'warn' when env var is unset", () => {
    expect(parseEnforcement(undefined)).toBe("warn");
  });

  it("defaults to 'warn' when env var is empty", () => {
    expect(parseEnforcement("")).toBe("warn");
  });

  it("defaults to 'warn' for any unrecognized value (fail-safe)", () => {
    expect(parseEnforcement("hard-pause-immediately-with-extreme-prejudice")).toBe("warn");
    expect(parseEnforcement("true")).toBe("warn");
  });

  it("accepts 'enforce' (case-insensitive) explicitly", () => {
    expect(parseEnforcement("enforce")).toBe("enforce");
    expect(parseEnforcement("ENFORCE")).toBe("enforce");
    expect(parseEnforcement("  Enforce  ")).toBe("enforce");
  });

  it("accepts 'warn' explicitly", () => {
    expect(parseEnforcement("warn")).toBe("warn");
    expect(parseEnforcement("shadow")).toBe("warn"); // shadow alias maps to warn
  });
});

// ─────────────────────────────────────────────────────────────────────
// evaluateGate — global + per-agent decisions
// ─────────────────────────────────────────────────────────────────────

describe("evaluateGate — below all thresholds: normal/allow everywhere", () => {
  it("returns global=normal/allow when daily and weekly usage are low", () => {
    const snap = evaluateGate({
      policy: policy(),
      rollupsByAgent: {
        roger: { day: rollup("roger", "day", 50_000), week: rollup("roger", "week", 200_000) },
      },
      globalRollup: { day: rollup("_global", "day", 100_000), week: rollup("_global", "week", 400_000) },
      enforcement: "warn",
      now_iso: NOW_ISO,
      data_freshness_ms: 1000,
    });
    expect(snap.global.state).toBe("normal");
    expect(snap.global.decision).toBe("allow");
    expect(snap.agents.roger?.state).toBe("normal");
    expect(snap.agents.roger?.decision).toBe("allow");
  });
});

describe("evaluateGate — soft threshold: warn_allow, never blocks", () => {
  it("90% of daily global → soft_warning + warn_allow (does not block)", () => {
    const snap = evaluateGate({
      policy: policy(),
      rollupsByAgent: {},
      globalRollup: { day: rollup("_global", "day", 900_000), week: rollup("_global", "week", 1_000_000) },
      enforcement: "enforce",
      now_iso: NOW_ISO,
      data_freshness_ms: 1000,
    });
    expect(snap.global.state).toBe("soft_warning");
    expect(snap.global.decision).toBe("warn_allow");
  });

  it("per-agent at soft threshold → soft_warning + warn_allow", () => {
    const snap = evaluateGate({
      policy: policy(),
      rollupsByAgent: {
        roger: { day: rollup("roger", "day", 300_000), week: rollup("roger", "week", 200_000) },
      },
      globalRollup: { day: rollup("_global", "day", 0), week: rollup("_global", "week", 0) },
      enforcement: "enforce",
      now_iso: NOW_ISO,
      data_freshness_ms: 1000,
    });
    // 300_000 / 350_000 = 0.857 → soft (>= 0.8)
    expect(snap.agents.roger?.state).toBe("soft_warning");
    expect(snap.agents.roger?.decision).toBe("warn_allow");
  });
});

describe("evaluateGate — hard threshold: pause decisions (in enforce mode)", () => {
  it("global at hard threshold → hard_paused + pause_non_core", () => {
    const snap = evaluateGate({
      policy: policy(),
      rollupsByAgent: {},
      globalRollup: { day: rollup("_global", "day", 1_000_000), week: rollup("_global", "week", 100_000) },
      enforcement: "enforce",
      now_iso: NOW_ISO,
      data_freshness_ms: 1000,
    });
    expect(snap.global.state).toBe("hard_paused");
    expect(snap.global.decision).toBe("pause_non_core");
  });

  it("per-agent above hard threshold → hard_paused + pause_agent", () => {
    const snap = evaluateGate({
      policy: policy(),
      rollupsByAgent: {
        roger: { day: rollup("roger", "day", 400_000), week: rollup("roger", "week", 0) },
      },
      globalRollup: { day: rollup("_global", "day", 0), week: rollup("_global", "week", 0) },
      enforcement: "enforce",
      now_iso: NOW_ISO,
      data_freshness_ms: 1000,
    });
    expect(snap.agents.roger?.state).toBe("hard_paused");
    expect(snap.agents.roger?.decision).toBe("pause_agent");
  });

  it("weekly above hard threshold ALSO triggers hard pause (not just daily)", () => {
    const snap = evaluateGate({
      policy: policy(),
      rollupsByAgent: {
        roger: { day: rollup("roger", "day", 0), week: rollup("roger", "week", 1_500_000) },
      },
      globalRollup: { day: rollup("_global", "day", 0), week: rollup("_global", "week", 0) },
      enforcement: "enforce",
      now_iso: NOW_ISO,
      data_freshness_ms: 1000,
    });
    expect(snap.agents.roger?.state).toBe("hard_paused");
  });
});

describe("evaluateGate — exempt agents bypass global hard pause", () => {
  it("manager (in exempt_agents) → allow even when global is hard_paused", () => {
    const snap = evaluateGate({
      policy: policy({ exempt_agents: ["manager", "sentinel"] }),
      rollupsByAgent: {
        manager: { day: rollup("manager", "day", 0), week: rollup("manager", "week", 0) },
        roger: { day: rollup("roger", "day", 0), week: rollup("roger", "week", 0) },
      },
      globalRollup: { day: rollup("_global", "day", 1_500_000), week: rollup("_global", "week", 0) },
      enforcement: "enforce",
      now_iso: NOW_ISO,
      data_freshness_ms: 1000,
    });
    expect(snap.global.state).toBe("hard_paused");
    expect(snap.agents.manager?.decision).toBe("allow");
    expect(snap.agents.manager?.reason).toMatch(/exempt/i);
    // Non-exempt roger inherits global pause:
    expect(snap.agents.roger?.decision).toBe("pause_non_core");
  });
});

// ─────────────────────────────────────────────────────────────────────
// WARN-ONLY enforcement gate (the overnight safety net)
// ─────────────────────────────────────────────────────────────────────

describe("evaluateGate — WARN-ONLY enforcement (Chris's overnight default)", () => {
  it("with enforcement='warn', NEVER returns a pause_* decision even when budget exhausted", () => {
    const snap = evaluateGate({
      policy: policy(),
      rollupsByAgent: {
        roger: { day: rollup("roger", "day", 1_000_000), week: rollup("roger", "week", 0) },
      },
      globalRollup: { day: rollup("_global", "day", 5_000_000), week: rollup("_global", "week", 0) },
      enforcement: "warn",
      now_iso: NOW_ISO,
      data_freshness_ms: 1000,
    });
    // State still surfaces hard_paused so the dashboard shows it,
    // but the decision is warn_allow so nothing is ever blocked.
    expect(snap.global.state).toBe("hard_paused");
    expect(snap.global.decision).toBe("warn_allow");
    expect(snap.agents.roger?.state).toBe("hard_paused");
    expect(snap.agents.roger?.decision).toBe("warn_allow");
    expect(snap.enforcement).toBe("warn");
  });

  it("with enforcement='warn', shouldPauseAgent returns FALSE for every agent (no blocks)", () => {
    const snap = evaluateGate({
      policy: policy(),
      rollupsByAgent: {
        roger: { day: rollup("roger", "day", 999_999_999), week: rollup("roger", "week", 0) },
      },
      globalRollup: { day: rollup("_global", "day", 999_999_999), week: rollup("_global", "week", 0) },
      enforcement: "warn",
      now_iso: NOW_ISO,
      data_freshness_ms: 1000,
    });
    expect(shouldPauseAgent(snap, "roger")).toBe(false);
    expect(shouldPauseAgent(snap, "cto")).toBe(false);
    expect(shouldPauseAgent(snap, "unknown-future-agent")).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Degraded fail-safe behavior
// ─────────────────────────────────────────────────────────────────────

describe("evaluateGate — telemetry stale / degraded", () => {
  it("data older than 5 minutes + fail_closed_on_unknown=true + enforce → pause_unknown for non-exempt", () => {
    const snap = evaluateGate({
      policy: policy({ fail_closed_on_unknown: true }),
      rollupsByAgent: {},
      globalRollup: { day: rollup("_global", "day", 0), week: rollup("_global", "week", 0) },
      enforcement: "enforce",
      now_iso: NOW_ISO,
      data_freshness_ms: 10 * 60 * 1000, // 10 minutes stale
    });
    expect(snap.status).toBe("degraded");
    expect(snap.global.decision).toBe("pause_unknown");
    expect(snap.degraded_reason).toMatch(/stale|fresh|coverage/i);
  });

  it("data stale + fail_closed_on_unknown=false → degraded but allow", () => {
    const snap = evaluateGate({
      policy: policy({ fail_closed_on_unknown: false }),
      rollupsByAgent: {},
      globalRollup: { day: rollup("_global", "day", 0), week: rollup("_global", "week", 0) },
      enforcement: "enforce",
      now_iso: NOW_ISO,
      data_freshness_ms: 10 * 60 * 1000,
    });
    expect(snap.status).toBe("degraded");
    expect(snap.global.decision).toBe("warn_allow");
  });

  it("data stale + enforcement='warn' → degraded but ALWAYS warn_allow (no blocks)", () => {
    const snap = evaluateGate({
      policy: policy({ fail_closed_on_unknown: true }),
      rollupsByAgent: {},
      globalRollup: { day: rollup("_global", "day", 0), week: rollup("_global", "week", 0) },
      enforcement: "warn",
      now_iso: NOW_ISO,
      data_freshness_ms: 10 * 60 * 1000,
    });
    expect(snap.status).toBe("degraded");
    expect(snap.global.decision).toBe("warn_allow");
  });
});

// ─────────────────────────────────────────────────────────────────────
// Emergency override
// ─────────────────────────────────────────────────────────────────────

describe("evaluateGate — emergency override", () => {
  it("active override → override_active=true and all agents allow", () => {
    const snap = evaluateGate({
      policy: policy({
        emergency_override: { enabled: true, reason: "incident-9192", expires_at: "2026-06-01T06:00:00.000-05:00" },
      }),
      rollupsByAgent: {},
      globalRollup: { day: rollup("_global", "day", 999_999_999), week: rollup("_global", "week", 0) },
      enforcement: "enforce",
      now_iso: NOW_ISO,
      data_freshness_ms: 1000,
    });
    expect(snap.override_active).toBe(true);
    expect(snap.global.decision).toBe("allow");
    expect(snap.global.reason).toMatch(/override/i);
  });

  it("expired override does NOT bypass hard pause", () => {
    const snap = evaluateGate({
      policy: policy({
        emergency_override: { enabled: true, reason: "incident-9192", expires_at: "2026-05-31T00:00:00.000-05:00" },
      }),
      rollupsByAgent: {},
      globalRollup: { day: rollup("_global", "day", 1_000_000), week: rollup("_global", "week", 0) },
      enforcement: "enforce",
      now_iso: NOW_ISO,
      data_freshness_ms: 1000,
    });
    expect(snap.override_active).toBe(false);
    expect(snap.global.decision).toBe("pause_non_core");
  });
});

// ─────────────────────────────────────────────────────────────────────
// resolveExcludedAgents — the scheduler-claim consumer
// ─────────────────────────────────────────────────────────────────────

describe("resolveExcludedAgents — agents to skip in claim (enforce mode only)", () => {
  it("warn mode: ALWAYS returns empty (no exclusions)", () => {
    const snap = evaluateGate({
      policy: policy(),
      rollupsByAgent: {
        roger: { day: rollup("roger", "day", 999_999_999), week: rollup("roger", "week", 0) },
      },
      globalRollup: { day: rollup("_global", "day", 999_999_999), week: rollup("_global", "week", 0) },
      enforcement: "warn",
      now_iso: NOW_ISO,
      data_freshness_ms: 1000,
    });
    expect(resolveExcludedAgents(snap)).toEqual([]);
  });

  it("enforce mode + global hard pause → returns ALL non-exempt agents seen in rollups + a sentinel marker", () => {
    const snap = evaluateGate({
      policy: policy({ exempt_agents: ["manager"] }),
      rollupsByAgent: {
        roger: { day: rollup("roger", "day", 0), week: rollup("roger", "week", 0) },
        cto: { day: rollup("cto", "day", 0), week: rollup("cto", "week", 0) },
        manager: { day: rollup("manager", "day", 0), week: rollup("manager", "week", 0) },
      },
      globalRollup: { day: rollup("_global", "day", 1_500_000), week: rollup("_global", "week", 0) },
      enforcement: "enforce",
      now_iso: NOW_ISO,
      data_freshness_ms: 1000,
    });
    const excluded = resolveExcludedAgents(snap);
    expect(excluded).toContain("roger");
    expect(excluded).toContain("cto");
    expect(excluded).not.toContain("manager"); // exempt
  });

  it("enforce mode + per-agent hard pause → returns only that agent", () => {
    const snap = evaluateGate({
      policy: policy(),
      rollupsByAgent: {
        roger: { day: rollup("roger", "day", 500_000), week: rollup("roger", "week", 0) },
        cto: { day: rollup("cto", "day", 0), week: rollup("cto", "week", 0) },
      },
      globalRollup: { day: rollup("_global", "day", 0), week: rollup("_global", "week", 0) },
      enforcement: "enforce",
      now_iso: NOW_ISO,
      data_freshness_ms: 1000,
    });
    expect(resolveExcludedAgents(snap)).toEqual(["roger"]);
  });
});
