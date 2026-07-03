// T-RELIABILITY E4 — canary routing by task-class (deterministic Sonnet A/B).

import { describe, it, expect } from "vitest";
import {
  decideCanaryRouting,
  DEFAULT_CANARY_CONFIG,
  type CanaryRoutingConfig,
} from "../../src/model-policy/canary.js";

const cfg = (over: Partial<CanaryRoutingConfig> = {}): CanaryRoutingConfig => ({
  baseline_model: "claude-opus-4-8",
  canary_model: "claude-sonnet-4-6",
  fraction_by_task_class: {},
  never_canary_task_classes: ["scope", "review", "novel"],
  ...over,
});

describe("decideCanaryRouting", () => {
  it("high-stakes classes NEVER canary, even at fraction 1", () => {
    for (const tc of ["scope", "review", "novel"]) {
      const d = decideCanaryRouting({ task_class: tc, key: "k", config: cfg({ fraction_by_task_class: { [tc]: 1 } }) });
      expect(d.arm).toBe("baseline");
      expect(d.model).toBe("claude-opus-4-8");
      expect(d.reason).toMatch(/never canaried/);
    }
  });

  it("absent/zero fraction → baseline (Opus)", () => {
    const d = decideCanaryRouting({ task_class: "routine", key: "k", config: cfg() });
    expect(d.arm).toBe("baseline");
    expect(d.model).toBe("claude-opus-4-8");
  });

  it("fraction 1 on an eligible class → full canary (Sonnet)", () => {
    const d = decideCanaryRouting({ task_class: "routine", key: "k", config: cfg({ fraction_by_task_class: { routine: 1 } }) });
    expect(d.arm).toBe("canary");
    expect(d.model).toBe("claude-sonnet-4-6");
  });

  it("is DETERMINISTIC in the key — same dispatch always lands in the same arm", () => {
    const c = cfg({ fraction_by_task_class: { routine: 0.5 } });
    const first = decideCanaryRouting({ task_class: "routine", key: "disp-abc", config: c });
    for (let i = 0; i < 20; i++) {
      expect(decideCanaryRouting({ task_class: "routine", key: "disp-abc", config: c }).arm).toBe(first.arm);
    }
  });

  it("a 50% canary splits ~half the eligible traffic (measurable A/B)", () => {
    const c = cfg({ fraction_by_task_class: { build: 0.5 } });
    let canary = 0;
    const N = 2000;
    for (let i = 0; i < N; i++) {
      if (decideCanaryRouting({ task_class: "build", key: `disp-${i}`, config: c }).arm === "canary") canary += 1;
    }
    const share = canary / N;
    expect(share).toBeGreaterThan(0.42);
    expect(share).toBeLessThan(0.58);
  });

  it("fraction is applied per-class (routine canary doesn't imply build canary)", () => {
    const c = cfg({ fraction_by_task_class: { routine: 1, build: 0 } });
    expect(decideCanaryRouting({ task_class: "routine", key: "k", config: c }).arm).toBe("canary");
    expect(decideCanaryRouting({ task_class: "build", key: "k", config: c }).arm).toBe("baseline");
  });

  it("DEFAULT config is canary-OFF and hard-excludes high-stakes classes", () => {
    expect(decideCanaryRouting({ task_class: "routine", key: "k", config: DEFAULT_CANARY_CONFIG }).arm).toBe("baseline");
    expect(decideCanaryRouting({ task_class: "novel", key: "k", config: { ...DEFAULT_CANARY_CONFIG, fraction_by_task_class: { novel: 1 } } }).arm).toBe("baseline");
  });

  it("clamps an out-of-range fraction (>1 → full, <0 → baseline)", () => {
    expect(decideCanaryRouting({ task_class: "routine", key: "k", config: cfg({ fraction_by_task_class: { routine: 5 } }) }).arm).toBe("canary");
    expect(decideCanaryRouting({ task_class: "routine", key: "k", config: cfg({ fraction_by_task_class: { routine: -1 } }) }).arm).toBe("baseline");
  });
});
