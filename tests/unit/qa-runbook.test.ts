// T-QA.8 — QA-and-testing runbook (assembled from the shipped T-QA substrate).
//
// The point of these tests is DRIFT PROTECTION: the taxonomy + regression
// sections must reflect the actual code (CANONICAL_TAXONOMY / FAILURE_MODES), so
// adding a category or a failure mode without updating the runbook fails here.

import { describe, it, expect } from "vitest";
import { buildQaRunbook, renderRunbookMarkdown } from "../../src/qa-runbook/index.js";
import { CANONICAL_TAXONOMY } from "../../src/test-taxonomy/index.js";
import { FAILURE_MODES } from "../../src/regression-coverage/index.js";

describe("buildQaRunbook", () => {
  const runbook = buildQaRunbook();

  it("assembles the full set of T-QA sections with unique ids", () => {
    const ids = runbook.sections.map((s) => s.id);
    expect(ids).toEqual([
      "test-taxonomy",
      "promotion-gate",
      "regression-coverage",
      "escape-hatches",
      "per-agent-requirements",
      "vercel-preview",
      "sentinel-cadence",
    ]);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("DRIFT: the taxonomy section lists every canonical test category", () => {
    const section = runbook.sections.find((s) => s.id === "test-taxonomy")!;
    const text = section.body.join("\n");
    for (const cat of CANONICAL_TAXONOMY) {
      expect(text).toContain(`\`${cat.id}\``);
    }
  });

  it("DRIFT: the regression section lists every catalogued failure mode", () => {
    const section = runbook.sections.find((s) => s.id === "regression-coverage")!;
    const text = section.body.join("\n");
    for (const mode of FAILURE_MODES) {
      expect(text).toContain(`\`${mode.id}\``);
    }
  });

  it("flags held + phase-2 practices honestly (not all 'live')", () => {
    const byId = Object.fromEntries(runbook.sections.map((s) => [s.id, s.status]));
    expect(byId["vercel-preview"]).toBe("held");
    expect(byId["sentinel-cadence"]).toBe("phase2");
    expect(byId["test-taxonomy"]).toBe("live");
  });
});

describe("renderRunbookMarkdown", () => {
  it("renders a deterministic canonical doc with title, contents, and every section header", () => {
    const a = renderRunbookMarkdown();
    const b = renderRunbookMarkdown();
    expect(a).toBe(b); // deterministic
    expect(a).toContain("# Kapelle QA & Testing Runbook");
    expect(a).toContain("## Contents");
    for (const s of buildQaRunbook().sections) {
      expect(a).toContain(`## ${s.title}`);
      expect(a).toContain(`<a id="${s.id}"></a>`);
    }
    expect(a.endsWith("\n")).toBe(true);
  });

  it("documents the T-QA.7 escape hatch with the real flag", () => {
    expect(renderRunbookMarkdown()).toContain("--smoke-exempt");
  });

  it("states the three-part promotion gate (test + tsc build + dist)", () => {
    const md = renderRunbookMarkdown();
    expect(md).toMatch(/npm test/);
    expect(md).toMatch(/npm run build/);
    expect(md).toMatch(/dist\//);
  });
});
