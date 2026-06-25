// T-QA.1 — classify a test by its path/name into the canonical taxonomy.
//
// Pure, deterministic mapping from id-agents' file conventions to a category.
// Checks most-specific → least-specific. Note: "regression" is a RE-RUN
// DISCIPLINE over the existing corpus, not a file-naming convention, so it is
// never returned here (a file is unit/integration/etc.; running them ALL is the
// regression pass). Returns null when no convention matches.

import type { TestCategory, TestCategoryDef } from "./types.js";
import { getCategory } from "./taxonomy.js";

function norm(p: string): string {
  return p.replace(/\\/g, "/").toLowerCase();
}

export function classifyTest(filePath: string): TestCategory | null {
  const p = norm(filePath);

  // cross-system / parity — most specific first (a *-parity.test.ts under
  // tests/unit/ is cross-system, not unit).
  if (/(^|\/|[-_.])parity[-_.]/.test(p) || p.includes("cross-system") || p.includes("cross_system")) {
    return "cross_system";
  }
  // live-UI — kapelle-site specs / Playwright.
  if (p.includes("kapelle-site/") || p.endsWith(".spec.ts") || /[-_.]live[-_.]/.test(p) || p.includes("live-ui")) {
    return "live_ui";
  }
  // smoke — deploy-guard smoke or *smoke* tests.
  if (p.includes("deploy-guard/smoke") || /[-_.]smoke[-_.]/.test(p) || p.includes("/smoke/")) {
    return "smoke";
  }
  // integration — the integration dir or the -integration suffix used in unit/.
  if (p.includes("tests/integration/") || /[-_.]integration\.test\.[tj]s$/.test(p)) {
    return "integration";
  }
  // unit — the default for anything under tests/unit/.
  if (p.includes("tests/unit/") || /\.test\.[tj]s$/.test(p)) {
    return "unit";
  }
  return null;
}

/** The invocation convention for a category (how to run it in this repo). */
export function invocationFor(category: TestCategory): TestCategoryDef["invocation"] {
  return getCategory(category).invocation;
}

/** Whether a failure in this category blocks promotion to main. */
export function gatesPromotion(category: TestCategory): boolean {
  return getCategory(category).gates_promotion;
}

/** Classify + return the full category definition (or null). */
export function describeTest(filePath: string): TestCategoryDef | null {
  const cat = classifyTest(filePath);
  return cat ? getCategory(cat) : null;
}
