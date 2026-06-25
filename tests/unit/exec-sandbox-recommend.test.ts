// RF1 — exec-sandbox recommender tests. Pins the decision math so the
// integrate-vs-operate-own call is a versioned, testable artifact (not prose).

import { describe, it, expect } from "vitest";
import {
  recommendProvider,
  compareIntegrateVsOperate,
  estimateHostedMonthlyUsd,
  estimateOperateOwnMonthlyUsd,
  DEFAULT_COST_ASSUMPTIONS,
} from "../../src/exec-sandbox/recommend.js";
import { E2B, DAYTONA, LOCAL_PROCESS, DEFAULT_CATALOG } from "../../src/exec-sandbox/catalog.js";
import type { SandboxProvider, SandboxRequirements } from "../../src/exec-sandbox/types.js";

// Untrusted-agent-code requirements: microVM isolation is the floor.
const UNTRUSTED: SandboxRequirements = {
  min_isolation: "microvm",
  require_self_host: false,
  needed_session_seconds: 3600,
  needed_languages: ["typescript"],
  need_persistent_fs: true,
  need_snapshots: true,
  expected_concurrent_sandboxes: 10,
  expected_sandbox_hours_per_month: 1000,
};

function provider(overrides: Partial<SandboxProvider>): SandboxProvider {
  return {
    id: "synthetic",
    name: "Synthetic",
    url: "",
    open_source: false,
    capabilities: {
      persistent_fs: true,
      snapshots: true,
      network_egress: true,
      isolation: "microvm",
      startup_ms: 250,
      max_session_seconds: 86400,
      sdk_languages: ["typescript", "python"],
    },
    hosted_cost: {
      billing_unit: "per_second",
      usd_per_sandbox_hour: 0.1,
      free_tier_usd_per_month: 0,
      provenance: { as_of: "2026-06-24", confidence: "low" },
    },
    self_host: {
      available: false,
      setup_effort_person_days: 0,
      ops_burden_person_days_per_month: 0,
      infra_usd_per_month: 0,
      provenance: { as_of: "2026-06-24", confidence: "low" },
    },
    provenance: { as_of: "2026-06-24", confidence: "low" },
    ...overrides,
  };
}

describe("hard gates", () => {
  it("disqualifies container/process isolation when microVM is required", () => {
    const rec = recommendProvider(UNTRUSTED);
    const daytona = rec.ranking.find((r) => r.provider_id === "daytona")!;
    const local = rec.ranking.find((r) => r.provider_id === "local_process")!;
    expect(daytona.disqualifiers).toContain("insufficient_isolation");
    expect(local.disqualifiers).toContain("insufficient_isolation");
    // E2B (microVM) is the only eligible provider → the recommendation.
    expect(rec.recommended_provider_id).toBe("e2b");
  });

  it("gates not_self_hostable when self-host is required", () => {
    const rec = recommendProvider(
      { ...UNTRUSTED, require_self_host: true },
      { catalog: [provider({ id: "hosted_only", self_host: { available: false, setup_effort_person_days: 0, ops_burden_person_days_per_month: 0, infra_usd_per_month: 0, provenance: { as_of: "x", confidence: "low" } } })] },
    );
    expect(rec.ranking[0].disqualifiers).toContain("not_self_hostable");
    expect(rec.recommended_provider_id).toBeNull();
  });

  it("gates session_too_short, no_snapshots, and missing_language", () => {
    const short = provider({ id: "short", capabilities: { ...provider({}).capabilities, max_session_seconds: 600 } });
    const noSnap = provider({ id: "nosnap", capabilities: { ...provider({}).capabilities, snapshots: false } });
    const noLang = provider({ id: "nolang", capabilities: { ...provider({}).capabilities, sdk_languages: ["python"] } });
    const rec = recommendProvider(UNTRUSTED, { catalog: [short, noSnap, noLang] });
    expect(rec.ranking.find((r) => r.provider_id === "short")!.disqualifiers).toContain("session_too_short");
    expect(rec.ranking.find((r) => r.provider_id === "nosnap")!.disqualifiers).toContain("no_snapshots");
    expect(rec.ranking.find((r) => r.provider_id === "nolang")!.disqualifiers).toContain("missing_language:typescript");
    expect(rec.recommended_provider_id).toBeNull(); // all gated
  });
});

describe("cost estimation", () => {
  it("estimateHostedMonthlyUsd applies the free tier and floors at 0", () => {
    // E2B: $0.10/hr, $100 free. At 100 hrs → 10 - 100 → floored 0.
    expect(estimateHostedMonthlyUsd(E2B, { ...UNTRUSTED, expected_sandbox_hours_per_month: 100 })).toBe(0);
    // At 1000 hrs → 100 - 100 free = 0; at 2000 hrs → 200 - 100 = 100.
    expect(estimateHostedMonthlyUsd(E2B, { ...UNTRUSTED, expected_sandbox_hours_per_month: 2000 })).toBeCloseTo(100, 5);
  });

  it("estimateOperateOwnMonthlyUsd = infra + ops + amortized setup, Infinity when not self-hostable", () => {
    // E2B: 300 + 3*800 + (10*800)/12 = 300 + 2400 + 666.67 = 3366.67
    expect(estimateOperateOwnMonthlyUsd(E2B, DEFAULT_COST_ASSUMPTIONS)).toBeCloseTo(3366.67, 1);
    expect(estimateOperateOwnMonthlyUsd(provider({ self_host: { available: false, setup_effort_person_days: 0, ops_burden_person_days_per_month: 0, infra_usd_per_month: 0, provenance: { as_of: "x", confidence: "low" } } }), DEFAULT_COST_ASSUMPTIONS)).toBe(Number.POSITIVE_INFINITY);
  });
});

describe("integrate vs operate-own", () => {
  it("low volume → integrate_hosted (hosted free tier wins)", () => {
    const r = compareIntegrateVsOperate(E2B, { ...UNTRUSTED, expected_sandbox_hours_per_month: 100 });
    expect(r.verdict).toBe("integrate_hosted");
    expect(r.hosted_usd_per_month).toBe(0);
  });

  it("high volume → operate_own (self-host amortizes below hosted)", () => {
    const r = compareIntegrateVsOperate(E2B, { ...UNTRUSTED, expected_sandbox_hours_per_month: 50000 });
    expect(r.verdict).toBe("operate_own");
    expect(r.operate_own_usd_per_month).toBeCloseTo(3366.67, 1);
  });

  it("near the crossover → too_close_to_call", () => {
    // hosted ≈ operate-own (~$3367/mo) within the 15% margin band.
    const r = compareIntegrateVsOperate(E2B, { ...UNTRUSTED, expected_sandbox_hours_per_month: 34000 });
    expect(r.verdict).toBe("too_close_to_call");
  });

  it("a non-self-hostable provider always says integrate_hosted", () => {
    const r = compareIntegrateVsOperate(provider({ self_host: { available: false, setup_effort_person_days: 0, ops_burden_person_days_per_month: 0, infra_usd_per_month: 0, provenance: { as_of: "x", confidence: "low" } } }), UNTRUSTED);
    expect(r.verdict).toBe("integrate_hosted");
    expect(r.operate_own_usd_per_month).toBe(-1); // Infinity sentinel
  });
});

describe("recommendProvider end-to-end", () => {
  it("ranks eligible before disqualified, is deterministic, and attaches the integrate/operate call", () => {
    const rec = recommendProvider(UNTRUSTED, { now: () => new Date("2026-06-24T00:00:00.000Z") });
    expect(rec.generated_at).toBe("2026-06-24T00:00:00.000Z");
    // eligible (e2b) sorts ahead of the two gated providers
    expect(rec.ranking[0].provider_id).toBe("e2b");
    expect(rec.ranking[0].disqualifiers).toHaveLength(0);
    expect(rec.ranking.slice(1).every((r) => r.disqualifiers.length > 0)).toBe(true);
    // the integrate-vs-operate call is attached for the winner
    expect(rec.integrate_vs_operate?.provider_id).toBe("e2b");
    expect(["integrate_hosted", "operate_own", "too_close_to_call"]).toContain(rec.integrate_vs_operate!.verdict);
  });

  it("with container isolation acceptable, both E2B and Daytona are eligible (no gate)", () => {
    const rec = recommendProvider({ ...UNTRUSTED, min_isolation: "container" });
    const eligible = rec.ranking.filter((r) => r.disqualifiers.length === 0).map((r) => r.provider_id);
    expect(eligible).toContain("e2b");
    expect(eligible).toContain("daytona");
    expect(eligible).not.toContain("local_process"); // process < container
  });

  it("ships a non-empty default catalog covering E2B and Daytona", () => {
    expect(DEFAULT_CATALOG.map((p) => p.id)).toEqual(expect.arrayContaining(["e2b", "daytona"]));
    expect(E2B.open_source && DAYTONA.open_source).toBe(true);
    // pricing rows are flagged for re-verification (honesty gate)
    expect(E2B.hosted_cost.provenance.verify_before_use).toBe(true);
    expect(DAYTONA.hosted_cost.provenance.verify_before_use).toBe(true);
    expect(LOCAL_PROCESS.capabilities.isolation).toBe("process");
  });
});
