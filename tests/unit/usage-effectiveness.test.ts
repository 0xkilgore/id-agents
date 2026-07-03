// T-RELIABILITY — /usage/effectiveness read-model (quality vs cost by group).

import { describe, it, expect } from "vitest";
import {
  buildUsageEffectiveness,
  type DispatchEffectivenessRow,
} from "../../src/usage-meter/effectiveness.js";

const NOW = "2026-07-02T12:00:00.000Z";

function row(over: Partial<DispatchEffectivenessRow> = {}): DispatchEffectivenessRow {
  return {
    model: "claude-opus-4-8",
    task_class: "routine",
    agent: "roger",
    usd_cost: 0.09,
    latency_ms: 1000,
    reruns: 0,
    cost_source: "metered",
    verified_promotion: true,
    artifact_accepted: true,
    requested_changes: 0,
    failed: false,
    outcome_source: "verified",
    ...over,
  };
}

describe("buildUsageEffectiveness", () => {
  it("empty → honest empty, outcome_quality unavailable", () => {
    const rm = buildUsageEffectiveness([], "model", NOW);
    expect(rm.schema_version).toBe("usage.effectiveness.v1");
    expect(rm.groups).toEqual([]);
    expect(rm.total_dispatches).toBe(0);
    expect(rm.sources.outcome_quality).toBe("unavailable");
  });

  it("groups by model — the Sonnet-vs-Opus money view (quality + cost side by side)", () => {
    const rm = buildUsageEffectiveness(
      [
        row({ model: "claude-opus-4-8", usd_cost: 0.09, verified_promotion: true, failed: false }),
        row({ model: "claude-opus-4-8", usd_cost: 0.09, verified_promotion: true, failed: false }),
        row({ model: "claude-sonnet-4-6", usd_cost: 0.04, verified_promotion: true, failed: false }),
        row({ model: "claude-sonnet-4-6", usd_cost: 0.04, verified_promotion: false, failed: true }),
      ],
      "model",
      NOW,
    );
    const opus = rm.groups.find((g) => g.key === "claude-opus-4-8")!;
    const sonnet = rm.groups.find((g) => g.key === "claude-sonnet-4-6")!;
    expect(opus.count).toBe(2);
    expect(opus.quality.promotion_rate).toBe(1); // 2/2 promoted
    expect(opus.cost.mean_usd_cost).toBe(0.09);
    expect(sonnet.quality.promotion_rate).toBe(0.5); // 1/2
    expect(sonnet.quality.success_rate).toBe(0.5); // 1 failed
    expect(sonnet.cost.mean_usd_cost).toBe(0.04); // cheaper, but lower quality
  });

  it("groups by task_class and exposes the five quality components + composite", () => {
    const rm = buildUsageEffectiveness(
      [
        row({ task_class: "review", verified_promotion: true, artifact_accepted: true, reruns: 0, failed: false, requested_changes: 0 }),
        row({ task_class: "review", verified_promotion: false, artifact_accepted: false, reruns: 2, failed: false, requested_changes: 3 }),
      ],
      "task_class",
      NOW,
    );
    const review = rm.groups.find((g) => g.key === "review")!;
    expect(review.quality.promotion_rate).toBe(0.5);
    expect(review.quality.acceptance_rate).toBe(0.5);
    expect(review.quality.no_rerun_rate).toBe(0.5);
    expect(review.quality.no_requested_changes_rate).toBe(0.5);
    expect(review.quality.success_rate).toBe(1);
    // composite = mean(0.5,0.5,0.5,1,0.5) = 0.6
    expect(review.quality.composite).toBeCloseTo(0.6, 4);
  });

  it("computes cost p50/p95 latency + mean usd (null usd cost excluded)", () => {
    const rm = buildUsageEffectiveness(
      [
        row({ latency_ms: 100, usd_cost: 0.1 }),
        row({ latency_ms: 200, usd_cost: null }), // excluded from mean
        row({ latency_ms: 300, usd_cost: 0.3 }),
        row({ latency_ms: 5000, usd_cost: 0.5 }),
      ],
      "model",
      NOW,
    );
    const g = rm.groups[0];
    expect(g.cost.p50_latency_ms).toBe(200); // nearest-rank p50 of [100,200,300,5000]
    expect(g.cost.p95_latency_ms).toBe(5000);
    expect(g.cost.mean_usd_cost).toBeCloseTo((0.1 + 0.3 + 0.5) / 3, 6);
  });

  it("HONESTY: quality over unverified outcomes is low-confidence, source-tagged", () => {
    const rm = buildUsageEffectiveness(
      [
        row({ outcome_source: "unknown", verified_promotion: null, artifact_accepted: null }),
        row({ outcome_source: "unknown", verified_promotion: null, artifact_accepted: null }),
      ],
      "model",
      NOW,
    );
    const g = rm.groups[0];
    expect(g.confidence).toBe("low");
    expect(g.outcome_coverage.unknown).toBe(2);
    expect(rm.sources.outcome_quality).toBe("unavailable");
    expect(rm.sources.notes.some((n) => /confidence-tagged/.test(n))).toBe(true);
  });

  it("mixed verified/unknown → partial coverage + medium/high confidence by share", () => {
    const rm = buildUsageEffectiveness(
      [
        row({ outcome_source: "verified" }),
        row({ outcome_source: "verified" }),
        row({ outcome_source: "unknown", verified_promotion: null }),
      ],
      "model",
      NOW,
    );
    expect(rm.sources.outcome_quality).toBe("partial");
    expect(rm.groups[0].confidence).toBe("high"); // 2/3 verified >= 0.6
    expect(rm.groups[0].outcome_coverage).toEqual({ verified: 2, partial: 0, unknown: 1 });
  });
});
