// T-QA.2 — per-agent pre-promotion requirements catalog + checker.

import { describe, it, expect } from "vitest";
import {
  AGENT_PROMOTION_REQUIREMENTS,
  getRequirement,
  checkAgentPromotion,
} from "../../src/qa-agent-requirements/index.js";
import { CANONICAL_TAXONOMY } from "../../src/test-taxonomy/index.js";

const VALID = new Set(CANONICAL_TAXONOMY.map((c) => c.id));

describe("AGENT_PROMOTION_REQUIREMENTS catalog", () => {
  it("covers the expected agents with no duplicates", () => {
    const agents = AGENT_PROMOTION_REQUIREMENTS.map((r) => r.agent);
    expect(agents).toEqual(["roger", "cane", "sentinel", "regina", "maestra", "cto"]);
    expect(new Set(agents).size).toBe(agents.length);
  });

  it("every required category is a valid taxonomy category (no drift)", () => {
    for (const r of AGENT_PROMOTION_REQUIREMENTS) {
      for (const c of r.required_categories) expect(VALID.has(c)).toBe(true);
    }
  });

  it("Roger's own row is ratified; the others are proposed defaults", () => {
    expect(getRequirement("roger").ratified).toBe(true);
    for (const r of AGENT_PROMOTION_REQUIREMENTS.filter((r) => r.agent !== "roger")) {
      expect(r.ratified).toBe(false);
    }
  });

  it("paper agents gate on no code-test category", () => {
    expect(getRequirement("maestra").required_categories).toEqual([]);
    expect(getRequirement("cto").required_categories).toEqual([]);
  });

  it("frontend (regina) gates on live_ui + smoke, not the backend unit suite", () => {
    expect(getRequirement("regina").required_categories).toEqual(["live_ui", "smoke"]);
  });
});

describe("getRequirement", () => {
  it("is case-insensitive", () => {
    expect(getRequirement("ROGER").agent).toBe("roger");
  });
  it("an unknown agent gets the conservative default (every category + tsc)", () => {
    const r = getRequirement("nobody");
    expect(r.required_categories.length).toBe(CANONICAL_TAXONOMY.length);
    expect(r.threshold).toBe("all_pass_plus_tsc_build");
    expect(r.ratified).toBe(false);
  });
  it("returns a copy callers cannot use to mutate the catalog", () => {
    getRequirement("roger").required_categories.push("live_ui");
    expect(getRequirement("roger").required_categories).not.toContain("live_ui");
  });
});

describe("checkAgentPromotion", () => {
  it("Roger passes only with all code categories green AND a clean tsc build", () => {
    const allCode = ["unit", "integration", "smoke", "regression", "cross_system"] as const;
    const pass = checkAgentPromotion({ agent: "roger", passedCategories: [...allCode], tscBuildClean: true });
    expect(pass.ok).toBe(true);

    const noTsc = checkAgentPromotion({ agent: "roger", passedCategories: [...allCode], tscBuildClean: false });
    expect(noTsc.ok).toBe(false);
    expect(noTsc.reason).toMatch(/tsc build/);

    const missing = checkAgentPromotion({ agent: "roger", passedCategories: ["unit", "smoke"], tscBuildClean: true });
    expect(missing.ok).toBe(false);
    expect(missing.missing_categories).toEqual(["integration", "regression", "cross_system"]);
  });

  it("a paper agent (maestra) passes with nothing green and no tsc build (the P-2 fix)", () => {
    const r = checkAgentPromotion({ agent: "maestra", passedCategories: [], tscBuildClean: false });
    expect(r.ok).toBe(true);
    expect(r.tsc_build_required).toBe(false);
    expect(r.reason).toMatch(/no code-test category/);
  });

  it("regina needs live_ui — a backend-only pass does not satisfy it", () => {
    const r = checkAgentPromotion({ agent: "regina", passedCategories: ["smoke"], tscBuildClean: true });
    expect(r.ok).toBe(false);
    expect(r.missing_categories).toEqual(["live_ui"]);
  });

  it("an unknown agent is conservatively gated on every category", () => {
    const r = checkAgentPromotion({ agent: "ghost", passedCategories: ["unit"], tscBuildClean: true });
    expect(r.ok).toBe(false);
    expect(r.missing_categories.length).toBeGreaterThan(0);
  });
});
