// RF3 — observability-stack recommender tests. Pin the decision math so the
// adopt-vs-build call for a Kapelle Observe/Audit tier is a versioned, testable
// artifact (not prose).

import { describe, it, expect } from "vitest";
import {
  recommendStack,
  computeAdoptVsBuild,
  requiredCapabilities,
  adoptMonthlyUsd,
  buildOwnMonthlyUsd,
  DEFAULT_COST_ASSUMPTIONS,
} from "../../src/observability-eval/recommend.js";
import {
  LANGFUSE,
  PROMPTFOO,
  OPENTELEMETRY,
  USAGE_METER,
  DEFAULT_CATALOG,
} from "../../src/observability-eval/catalog.js";
import type { ObserveTierRequirements } from "../../src/observability-eval/types.js";

// Full Observe/Audit tier: needs the whole checklist.
const FULL_TIER: ObserveTierRequirements = {
  need_runtime_tracing: true,
  need_eval_harness: true,
  need_prompt_management: true,
  need_cost_tracking: true,
  need_audit_log: true,
  need_datasets: true,
  require_self_host: false,
  prefer_otel: true,
  needed_languages: ["typescript"],
  expected_events_per_month: 1_000_000,
};

describe("required capabilities", () => {
  it("derives the capability checklist from the need_* flags", () => {
    expect(requiredCapabilities(FULL_TIER).sort()).toEqual(
      ["audit_log", "cost_tracking", "datasets", "eval_harness", "prompt_management", "runtime_tracing"].sort(),
    );
    expect(requiredCapabilities({ ...FULL_TIER, need_audit_log: false, need_datasets: false })).not.toContain("audit_log");
  });
});

describe("cost helpers", () => {
  it("adoptMonthlyUsd takes the cheaper of hosted vs fully-loaded self-host", () => {
    // Langfuse hosted $100; self-host = 150 + 2*800 + 5*800/12 = 2083.33 → min 100
    expect(adoptMonthlyUsd(LANGFUSE, FULL_TIER, DEFAULT_COST_ASSUMPTIONS)).toBeCloseTo(100, 5);
    // When self-host is required, the self-host cost is used.
    expect(adoptMonthlyUsd(LANGFUSE, { ...FULL_TIER, require_self_host: true }, DEFAULT_COST_ASSUMPTIONS)).toBeCloseTo(2083.33, 1);
  });

  it("buildOwnMonthlyUsd = infra + ops + amortized setup", () => {
    // 200 + 3*800 + 40*800/12 = 200 + 2400 + 2666.67 = 5266.67
    expect(buildOwnMonthlyUsd(DEFAULT_COST_ASSUMPTIONS)).toBeCloseTo(5266.67, 1);
  });
});

describe("stack selection", () => {
  it("recommends a minimal stack covering the full tier (Langfuse covers the checklist)", () => {
    const rec = recommendStack(FULL_TIER, { now: () => new Date("2026-06-24T00:00:00.000Z") });
    expect(rec.generated_at).toBe("2026-06-24T00:00:00.000Z");
    expect(rec.recommended_stack).toEqual(["langfuse"]);
    expect(rec.uncovered_requirements).toHaveLength(0);
    // Langfuse is the top-ranked component for this tier.
    expect(rec.ranking[0].component_id).toBe("langfuse");
  });

  it("composes a multi-component stack and reports uncovered caps when no single tool covers all", () => {
    // Drop Langfuse: now no component offers prompt_management or audit_log.
    const rec = recommendStack(FULL_TIER, { catalog: [PROMPTFOO, OPENTELEMETRY, USAGE_METER] });
    expect(rec.recommended_stack).toEqual(expect.arrayContaining(["promptfoo", "opentelemetry", "usage_meter"]));
    expect(rec.uncovered_requirements.sort()).toEqual(["audit_log", "prompt_management"].sort());
  });

  it("returns an empty stack (no requirements) cleanly", () => {
    const none: ObserveTierRequirements = {
      need_runtime_tracing: false, need_eval_harness: false, need_prompt_management: false,
      need_cost_tracking: false, need_audit_log: false, need_datasets: false,
      require_self_host: false, prefer_otel: false, needed_languages: [], expected_events_per_month: 0,
    };
    const rec = recommendStack(none);
    expect(rec.recommended_stack).toEqual([]);
    expect(rec.uncovered_requirements).toHaveLength(0);
    expect(rec.adopt_vs_build).toBeNull();
  });
});

describe("adopt vs build", () => {
  it("default tier → adopt_and_extend (MIT tools far cheaper than building from scratch)", () => {
    const rec = recommendStack(FULL_TIER);
    expect(rec.adopt_vs_build?.verdict).toBe("adopt_and_extend");
    expect(rec.adopt_vs_build?.stack_is_oss).toBe(true);
    expect(rec.adopt_vs_build?.adopt_usd_per_month).toBeCloseTo(100, 5);
    expect(rec.adopt_vs_build?.build_own_usd_per_month).toBeCloseTo(5266.67, 1);
  });

  it("when building is made free, the verdict flips to build_own", () => {
    const av = computeAdoptVsBuild(["langfuse"], DEFAULT_CATALOG, FULL_TIER, {
      ...DEFAULT_COST_ASSUMPTIONS,
      build_own_setup_person_days: 0,
      build_own_ops_person_days_per_month: 0,
      build_own_infra_usd_per_month: 0,
    });
    expect(av.verdict).toBe("build_own");
  });

  it("near the crossover → too_close_to_call", () => {
    // adopt(langfuse hosted)=100; tune build-own to ~100.
    const av = computeAdoptVsBuild(["langfuse"], DEFAULT_CATALOG, FULL_TIER, {
      ...DEFAULT_COST_ASSUMPTIONS,
      build_own_setup_person_days: 0,
      build_own_ops_person_days_per_month: 0,
      build_own_infra_usd_per_month: 100,
    });
    expect(av.verdict).toBe("too_close_to_call");
  });
});

describe("catalog honesty", () => {
  it("ships Promptfoo + Langfuse, both OSS, with pricing flagged for re-verification", () => {
    expect(DEFAULT_CATALOG.map((c) => c.id)).toEqual(expect.arrayContaining(["promptfoo", "langfuse"]));
    expect(LANGFUSE.open_source && PROMPTFOO.open_source).toBe(true);
    expect(LANGFUSE.hosted_cost.provenance.verify_before_use).toBe(true);
    // Promptfoo is the eval half (no runtime tracing); Langfuse is the tracing half.
    expect(PROMPTFOO.capabilities.runtime_tracing).toBe(false);
    expect(PROMPTFOO.capabilities.eval_harness).toBe(true);
    expect(LANGFUSE.capabilities.runtime_tracing).toBe(true);
  });
});
