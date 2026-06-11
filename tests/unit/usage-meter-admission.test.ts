// OP-7 usage-gating — dispatch admission decision tests.
//
// CTO-3 scope: cto/output/2026-06-10-op7-usage-gating-architecture-scope.md
//
// admitDispatch() is the pure heart of OP-7. Given an agent's budget,
// usage, concurrency, and spacing state it decides whether a dispatch may
// start (delivering), must be blocked (dispatch_blocked, typed reason), or
// must be queued (queued_for_capacity). It NEVER returns delivered/admit
// for over-budget or capacity-limited work in enforce mode, and it NEVER
// blocks in warn mode (Chris's overnight safety mandate — warn-only ships
// by default; enforce is opt-in).

import { describe, expect, it } from "vitest";

import {
  DEFAULT_AGENT_MAX_CONCURRENT,
  DEFAULT_MIN_SPACING_SECONDS,
  DEFAULT_TIER_BUDGETS,
  admitDispatch,
  defaultProviderMaxConcurrent,
  resolveTierBudget,
  type AdmissionInput,
} from "../../src/usage-meter/admission.js";

const NOW = "2026-06-11T17:00:00.000Z";

function baseInput(overrides: Partial<AdmissionInput> = {}): AdmissionInput {
  return {
    dispatch_phid: "phid:disp-abc123",
    agent_id: "vetra",
    provider: "anthropic",
    enforcement: "enforce",
    now_iso: NOW,
    budget: { daily_limit: 1_000_000, weekly_limit: 5_000_000 },
    usage: { daily_used: 0, weekly_used: 0 },
    agent_concurrency: { current: 0 },
    provider_concurrency: { current: 0 },
    spacing: { last_dispatched_at: null },
    ...overrides,
  };
}

describe("seed values (CTO-3 §Data Artifacts)", () => {
  it("cost-tier default budgets match the spec seed values", () => {
    expect(DEFAULT_TIER_BUDGETS.low).toEqual({
      daily_token_equivalent_limit: 2_000_000,
      weekly_token_equivalent_limit: 10_000_000,
    });
    expect(DEFAULT_TIER_BUDGETS.medium).toEqual({
      daily_token_equivalent_limit: 750_000,
      weekly_token_equivalent_limit: 3_500_000,
    });
    expect(DEFAULT_TIER_BUDGETS.high).toEqual({
      daily_token_equivalent_limit: 250_000,
      weekly_token_equivalent_limit: 1_250_000,
    });
  });

  it("resolveTierBudget returns the tier limits", () => {
    expect(resolveTierBudget("medium")).toEqual({
      daily_limit: 750_000,
      weekly_limit: 3_500_000,
    });
  });

  it("default per-agent concurrency is 1; provider anthropic is 3", () => {
    expect(DEFAULT_AGENT_MAX_CONCURRENT).toBe(1);
    expect(defaultProviderMaxConcurrent("anthropic")).toBe(3);
    expect(defaultProviderMaxConcurrent("openai")).toBe(3);
    expect(DEFAULT_MIN_SPACING_SECONDS).toBe(30);
  });
});

describe("admitDispatch — happy path", () => {
  it("under budget, idle concurrency, no recent dispatch → delivering, no gate", () => {
    const r = admitDispatch(baseInput());
    expect(r.admit).toBe(true);
    expect(r.status).toBe("delivering");
    expect(r.gate).toBeNull();
  });
});

describe("admitDispatch — budget gating (enforce)", () => {
  it("daily budget exhausted → dispatch_blocked, gate reason budget_exhausted, NOT delivering", () => {
    const r = admitDispatch(
      baseInput({ usage: { daily_used: 1_000_000, weekly_used: 1_000_000 } }),
    );
    expect(r.admit).toBe(false);
    expect(r.status).toBe("dispatch_blocked");
    expect(r.gate).not.toBeNull();
    expect(r.gate!.gate_state).toBe("blocked");
    expect(r.gate!.gate_reason).toBe("budget_exhausted");
    expect(r.gate!.dispatch_phid).toBe("phid:disp-abc123");
  });

  it("weekly budget exhausted (daily fine) → dispatch_blocked budget_exhausted", () => {
    const r = admitDispatch(
      baseInput({ usage: { daily_used: 10, weekly_used: 5_000_000 } }),
    );
    expect(r.status).toBe("dispatch_blocked");
    expect(r.gate!.gate_reason).toBe("budget_exhausted");
  });

  it("near budget + require_override → dispatch_blocked, reason near_budget_requires_override", () => {
    const r = admitDispatch(
      baseInput({
        usage: { daily_used: 950_000, weekly_used: 10 },
        near_budget_pct: 0.9,
        require_override_near_budget: true,
      }),
    );
    expect(r.admit).toBe(false);
    expect(r.status).toBe("dispatch_blocked");
    expect(r.gate!.gate_reason).toBe("near_budget_requires_override");
  });

  it("near budget WITHOUT require_override → delivering (warn-only near band)", () => {
    const r = admitDispatch(
      baseInput({
        usage: { daily_used: 950_000, weekly_used: 10 },
        near_budget_pct: 0.9,
        require_override_near_budget: false,
      }),
    );
    expect(r.admit).toBe(true);
    expect(r.status).toBe("delivering");
  });

  it("missing budget config → delivering with a typed missing_budget_config warning (does NOT block)", () => {
    const r = admitDispatch(baseInput({ budget: null }));
    expect(r.admit).toBe(true);
    expect(r.status).toBe("delivering");
    expect(r.warnings.some((w) => w.includes("missing_budget_config"))).toBe(true);
  });
});

describe("admitDispatch — concurrency + spacing gating (enforce)", () => {
  it("agent at concurrency cap → queued_for_capacity, reason over_concurrency", () => {
    const r = admitDispatch(
      baseInput({ agent_concurrency: { current: 1, max: 1 } }),
    );
    expect(r.admit).toBe(false);
    expect(r.status).toBe("queued_for_capacity");
    expect(r.gate!.gate_state).toBe("queued");
    expect(r.gate!.gate_reason).toBe("over_concurrency");
  });

  it("provider at concurrency cap → queued_for_capacity, reason provider_capacity_full", () => {
    const r = admitDispatch(
      baseInput({ provider_concurrency: { current: 3, max: 3 } }),
    );
    expect(r.status).toBe("queued_for_capacity");
    expect(r.gate!.gate_reason).toBe("provider_capacity_full");
  });

  it("min spacing not yet elapsed → queued_for_capacity, reason over_concurrency, with next_dispatch_no_earlier_than", () => {
    // last dispatch 10s ago, min spacing 30s → must wait.
    const r = admitDispatch(
      baseInput({
        spacing: { min_seconds: 30, last_dispatched_at: "2026-06-11T16:59:50.000Z" },
      }),
    );
    expect(r.admit).toBe(false);
    expect(r.status).toBe("queued_for_capacity");
    expect(r.gate!.gate_reason).toBe("over_concurrency");
    expect(r.gate!.gate_metadata.kind).toBe("spacing");
    expect(r.gate!.gate_metadata.next_dispatch_no_earlier_than).toBe(
      "2026-06-11T17:00:20.000Z",
    );
  });

  it("min spacing elapsed → delivering", () => {
    const r = admitDispatch(
      baseInput({
        spacing: { min_seconds: 30, last_dispatched_at: "2026-06-11T16:59:00.000Z" },
      }),
    );
    expect(r.status).toBe("delivering");
  });

  it("budget exhaustion takes precedence over concurrency (blocked beats queued)", () => {
    const r = admitDispatch(
      baseInput({
        usage: { daily_used: 1_000_000, weekly_used: 0 },
        agent_concurrency: { current: 5, max: 1 },
      }),
    );
    expect(r.status).toBe("dispatch_blocked");
    expect(r.gate!.gate_reason).toBe("budget_exhausted");
  });
});

describe("admitDispatch — pauses", () => {
  it("provider_paused → dispatch_blocked provider_paused, NOT bypassable by force_dispatch", () => {
    const r = admitDispatch(
      baseInput({
        provider_paused: true,
        override: { force_dispatch: true, reason: "urgent", actor: "chris" },
      }),
    );
    expect(r.admit).toBe(false);
    expect(r.status).toBe("dispatch_blocked");
    expect(r.gate!.gate_reason).toBe("provider_paused");
  });

  it("operator_paused → dispatch_blocked operator_paused (no override)", () => {
    const r = admitDispatch(baseInput({ operator_paused: true }));
    expect(r.status).toBe("dispatch_blocked");
    expect(r.gate!.gate_reason).toBe("operator_paused");
  });
});

describe("admitDispatch — operator override", () => {
  it("force_dispatch with reason+actor over budget_exhausted → overridden + delivering", () => {
    const r = admitDispatch(
      baseInput({
        usage: { daily_used: 2_000_000, weekly_used: 0 },
        override: { force_dispatch: true, reason: "ship the hotfix", actor: "chris" },
      }),
    );
    expect(r.admit).toBe(true);
    expect(r.status).toBe("delivering");
    expect(r.gate!.gate_state).toBe("overridden");
    expect(r.gate!.operator_override.forced).toBe(true);
    expect(r.gate!.operator_override.actor).toBe("chris");
    expect(r.gate!.operator_override.reason).toBe("ship the hotfix");
    expect(r.gate!.operator_override.at).toBe(NOW);
  });

  it("force_dispatch WITHOUT a reason is invalid → not forced, still blocked + warning", () => {
    const r = admitDispatch(
      baseInput({
        usage: { daily_used: 2_000_000, weekly_used: 0 },
        override: { force_dispatch: true, reason: "  ", actor: "chris" },
      }),
    );
    expect(r.admit).toBe(false);
    expect(r.status).toBe("dispatch_blocked");
    expect(r.warnings.some((w) => w.includes("override"))).toBe(true);
  });
});

describe("admitDispatch — warn-only mode (safety default)", () => {
  it("warn mode + budget exhausted → admit=true, delivering, but records a shadow gate for /ops", () => {
    const r = admitDispatch(
      baseInput({
        enforcement: "warn",
        usage: { daily_used: 2_000_000, weekly_used: 0 },
      }),
    );
    expect(r.admit).toBe(true);
    expect(r.status).toBe("delivering");
    // The would-be block is still observable.
    expect(r.gate).not.toBeNull();
    expect(r.gate!.gate_metadata.shadow).toBe(true);
    expect(r.gate!.gate_reason).toBe("budget_exhausted");
    expect(r.warnings.length).toBeGreaterThan(0);
  });

  it("warn mode + concurrency cap → admit=true delivering with shadow queued gate", () => {
    const r = admitDispatch(
      baseInput({
        enforcement: "warn",
        agent_concurrency: { current: 9, max: 1 },
      }),
    );
    expect(r.admit).toBe(true);
    expect(r.status).toBe("delivering");
    expect(r.gate!.gate_metadata.shadow).toBe(true);
    expect(r.gate!.gate_reason).toBe("over_concurrency");
  });
});
