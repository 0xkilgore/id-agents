// T-QA.2 — Per-agent pre-promotion verification requirements, encoded AS CODE.
//
// The P-2 fix (roadmap-reset §4.7.2): each owning agent declares the test set it
// must pass before promoting to main, so Spec 054 can enforce per-agent
// requirements instead of one uniform gate — a paper agent isn't blocked by the
// code suite, and a frontend agent IS gated on live-UI. This is the inverse of
// the T-QA.7 smoke-exempt escape hatch: T-QA.2 says what a promotion MUST cover,
// T-QA.7 says what an unrelated red suite need NOT block.
//
// Encoded as a typed catalog + a pure checker (the eval-as-code pattern shared
// with T-QA.1 test-taxonomy, T-QA.5 regression-coverage, T-QA.8 qa-runbook).
// IMPORTANT — reference/decision-support ONLY. Nothing imports this at run time;
// deleting the directory changes zero behavior — the safest reversible option.
// Roger's own row is authoritative; the others are PROPOSED DEFAULTS each owning
// agent ratifies (the `ratified` flag tracks this).

import type { TestCategory } from "../test-taxonomy/types.js";

/** Threshold beyond "the required categories are green". */
export type AcceptanceThreshold =
  | "all_pass" // the required categories all pass
  | "all_pass_plus_tsc_build"; // ...and a clean `npm run build` (tsc strict) + dist

/** One agent's declared pre-promotion requirement. */
export interface AgentPromotionRequirement {
  agent: string;
  /** Categories whose green is REQUIRED before this agent promotes to main. */
  required_categories: TestCategory[];
  threshold: AcceptanceThreshold;
  /** True once the owning agent has ratified its own row (vs a proposed default). */
  ratified: boolean;
  note: string;
}

/** Result of checking a candidate promotion against an agent's requirement. */
export interface PromotionCheckResult {
  ok: boolean;
  agent: string;
  /** Required categories that did NOT pass. */
  missing_categories: TestCategory[];
  tsc_build_required: boolean;
  tsc_build_ok: boolean;
  reason: string;
}
