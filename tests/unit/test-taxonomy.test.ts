// T-QA.1 — test taxonomy: pin the canonical categories and the path classifier
// so the taxonomy is a versioned, enforceable artifact (not prose).

import { describe, it, expect } from "vitest";
import {
  CANONICAL_TAXONOMY,
  getCategory,
  promotionGatingCategories,
} from "../../src/test-taxonomy/taxonomy.js";
import {
  classifyTest,
  invocationFor,
  gatesPromotion,
  describeTest,
} from "../../src/test-taxonomy/classify.js";
import type { TestCategory } from "../../src/test-taxonomy/types.js";

describe("canonical taxonomy", () => {
  it("defines exactly the six roadmap §4.7 categories, well-formed", () => {
    expect(CANONICAL_TAXONOMY.map((c) => c.id)).toEqual([
      "unit",
      "integration",
      "smoke",
      "regression",
      "live_ui",
      "cross_system",
    ]);
    for (const def of CANONICAL_TAXONOMY) {
      expect(def.role.length).toBeGreaterThan(0);
      expect(def.scope.length).toBeGreaterThan(0);
      expect(def.invocation.command.length).toBeGreaterThan(0);
      expect(def.run_phases.length).toBeGreaterThan(0);
    }
  });

  it("getCategory resolves a known id and throws on an unknown one", () => {
    expect(getCategory("unit").name).toBe("Unit");
    expect(() => getCategory("nope" as TestCategory)).toThrow(/unknown test category/);
  });

  it("promotion-gating categories are unit/integration/smoke/regression/live_ui; cross_system is conditional (not a hard gate)", () => {
    const gating = promotionGatingCategories();
    expect(gating).toEqual(expect.arrayContaining(["unit", "integration", "smoke", "regression", "live_ui"]));
    expect(gating).not.toContain("cross_system");
    expect(gatesPromotion("cross_system")).toBe(false);
    expect(gatesPromotion("unit")).toBe(true);
  });
});

describe("classifyTest — grounded in real repo paths", () => {
  const cases: [string, TestCategory | null][] = [
    ["tests/unit/outputs-reactions-feedback.test.ts", "unit"],
    ["tests/integration/agent-lifecycle.test.ts", "integration"],
    ["tests/unit/dispatch-recovery-integration.test.ts", "integration"], // -integration suffix wins over unit dir
    ["tests/unit/inbox-projection-parity.test.ts", "cross_system"], // parity wins over unit dir
    ["src/deploy-guard/smoke.ts", "smoke"],
    ["kapelle-site/console/reactions.spec.ts", "live_ui"],
    ["docs/README.md", null],
  ];
  for (const [path, expected] of cases) {
    it(`${path} → ${expected ?? "null"}`, () => {
      expect(classifyTest(path)).toBe(expected);
    });
  }

  it("never classifies anything as 'regression' (it is a re-run discipline, not a file pattern)", () => {
    const all = [
      "tests/unit/a.test.ts",
      "tests/integration/b.test.ts",
      "tests/unit/c-integration.test.ts",
      "tests/unit/d-parity.test.ts",
      "src/deploy-guard/smoke.ts",
    ].map(classifyTest);
    expect(all).not.toContain("regression");
  });

  it("is case- and separator-insensitive", () => {
    expect(classifyTest("TESTS\\UNIT\\Foo.Test.TS")).toBe("unit");
  });
});

describe("invocation + describe helpers", () => {
  it("invocationFor returns the repo-grounded command", () => {
    expect(invocationFor("unit").command).toBe("npm test");
    expect(invocationFor("smoke").command).toContain("--smoke");
    expect(invocationFor("integration").command).toBe("npm run test:e2e");
  });

  it("describeTest returns the full def for a classifiable path, null otherwise", () => {
    expect(describeTest("tests/unit/x.test.ts")?.id).toBe("unit");
    expect(describeTest("notatest.md")).toBeNull();
  });
});
