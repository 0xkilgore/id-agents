// T-QA.2 — check a candidate promotion against an agent's declared requirement.

import type { TestCategory } from "../test-taxonomy/types.js";
import type { PromotionCheckResult } from "./types.js";
import { getRequirement } from "./requirements.js";

/**
 * Decide whether `agent` may promote given the categories that passed and
 * whether the tsc build is clean. Pure.
 *
 * ok iff every required category passed AND (if the threshold demands it) the
 * tsc build is clean. An agent with no required categories (a paper agent) is
 * ok as long as any tsc-build requirement is met — which for paper agents it is,
 * since their threshold does not require it.
 */
export function checkAgentPromotion(opts: {
  agent: string;
  passedCategories: TestCategory[];
  /** Whether `npm run build` (tsc strict) is clean. Defaults to false. */
  tscBuildClean?: boolean;
}): PromotionCheckResult {
  const req = getRequirement(opts.agent);
  const passed = new Set(opts.passedCategories);
  const missing = req.required_categories.filter((c) => !passed.has(c));

  const tscRequired = req.threshold === "all_pass_plus_tsc_build";
  const tscOk = opts.tscBuildClean ?? false;

  const categoriesOk = missing.length === 0;
  const buildOk = !tscRequired || tscOk;
  const ok = categoriesOk && buildOk;

  let reason: string;
  if (ok) {
    reason = req.required_categories.length === 0
      ? `${req.agent}: no code-test category gates this promotion`
      : `${req.agent}: all ${req.required_categories.length} required categor${req.required_categories.length === 1 ? "y" : "ies"} green${tscRequired ? " + tsc build clean" : ""}`;
  } else if (!categoriesOk) {
    reason = `${req.agent}: missing required categor${missing.length === 1 ? "y" : "ies"}: ${missing.join(", ")}`;
  } else {
    reason = `${req.agent}: tsc build is required and not clean`;
  }

  return {
    ok,
    agent: req.agent,
    missing_categories: missing,
    tsc_build_required: tscRequired,
    tsc_build_ok: tscOk,
    reason,
  };
}
