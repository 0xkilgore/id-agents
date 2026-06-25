// T-QA.1 — Test taxonomy, encoded AS CODE.
//
// Defines the canonical test categories + per-category invocation conventions +
// per-category role (roadmap-reset §4.7). T-QA.1 is a CTO/Maestra "(paper)"
// definition task; encoding it as a typed, machine-readable module (instead of a
// prose reference doc) makes the taxonomy versioned, queryable, and consumable
// by tooling/CI — and is squarely Roger's code charter.
//
// IMPORTANT — reference/decision-support ONLY. Nothing in the codebase imports
// this at run time; it is the taxonomy expressed as data + a classifier.
// Deleting the directory changes zero behavior — the safest reversible option.
// (A follow-up — T-QA.2, per-agent pre-promotion verification — can consume
// this taxonomy to enforce conventions; that wiring is intentionally not done
// here.)

/** The six canonical test categories (roadmap-reset §4.7). */
export type TestCategory =
  | "unit"
  | "integration"
  | "smoke"
  | "regression"
  | "live_ui"
  | "cross_system";

/** When a category is expected to run. */
export type RunPhase =
  | "local" // developer machine, pre-commit
  | "ci" // on every push / PR
  | "pre_promotion" // gate before merging to main (CLAUDE.md checklist)
  | "post_deploy" // after the artifact is deployed (smoke)
  | "scheduled"; // periodic (e.g. weekly parity lane)

/** Relative speed/cost of the category, to set expectations on when it runs. */
export type Speed = "fast" | "medium" | "slow";

/** A concrete, repo-grounded way to invoke the category. */
export interface InvocationConvention {
  /** The command as run in this repo (id-agents), or the owning surface. */
  command: string;
  /** Glob(s) that identify tests of this category by path/name, if any. */
  path_globs: string[];
  /** Env or preconditions required to run it. */
  requires?: string[];
  note?: string;
}

export interface TestCategoryDef {
  id: TestCategory;
  name: string;
  /** What class of failure this category exists to catch (its role). */
  role: string;
  /** What the test actually exercises (its scope). */
  scope: string;
  invocation: InvocationConvention;
  run_phases: RunPhase[];
  /** Whether a failure in this category blocks promotion to main. */
  gates_promotion: boolean;
  speed: Speed;
  /** Real example test paths/surfaces in this repo. */
  examples: string[];
}
