// T-QA.5 — the regression-coverage gate (the rule, as a pure function).
//
// Enforces: a bug may only be "closed" if it has a regression_test_ref that
// points at a real test file (validated via T-QA.1's classifyTest). This is the
// bug-squash log §4 "Closed" gate-check, expressed as code so it can be run in
// CI / a log linter instead of being a prose runbook only.

import type { BugRecord, CoverageReport, CoverageViolation } from "./types.js";
import { isKnownFailureMode } from "./failure-modes.js";
import { classifyTest } from "../test-taxonomy/classify.js";

/** Violations for a single bug. Empty array = the bug satisfies the gate.
 *  Only "closed" bugs are gated; open/fixing bugs accrue no violations. */
export function checkBugCoverage(bug: BugRecord): CoverageViolation[] {
  if (bug.status !== "closed") return [];
  const violations: CoverageViolation[] = [];

  const ref = bug.regression_test_ref?.trim();
  if (!ref) {
    violations.push({
      bug_id: bug.id,
      reason: "closed_without_regression_test",
      severity: "block",
      detail: `${bug.id} is closed but has no regression_test_ref — every typed failure mode needs a regression test before closed (T-QA.5).`,
    });
  } else if (classifyTest(ref) === null) {
    // A ref that doesn't classify as a test (e.g. points at a doc or a src file)
    // does not satisfy the rule.
    violations.push({
      bug_id: bug.id,
      reason: "regression_ref_not_a_test",
      severity: "block",
      detail: `${bug.id} regression_test_ref "${ref}" does not classify as a test file (T-QA.1 taxonomy).`,
    });
  }

  // A closed bug typed "other" still closes (it has its test) but is flagged so
  // recurring uncatalogued modes get promoted to a named type.
  if (!isKnownFailureMode(bug.failure_mode) || bug.failure_mode === "other") {
    violations.push({
      bug_id: bug.id,
      reason: "uncatalogued_failure_mode",
      severity: "warn",
      detail: `${bug.id} closed with an uncatalogued failure mode ("${bug.failure_mode}") — type it or add a new mode if it recurs.`,
    });
  }

  return violations;
}

/** Run the gate across a whole bug-squash log. `passes` is false iff any
 *  BLOCKING violation exists (warnings do not fail the gate). */
export function gateBugSquashLog(bugs: BugRecord[]): CoverageReport {
  const violations = bugs.flatMap(checkBugCoverage);
  const closed = bugs.filter((b) => b.status === "closed");
  const blockedIds = new Set(
    violations.filter((v) => v.severity === "block").map((v) => v.bug_id),
  );
  const covered_closed_bugs = closed.filter((b) => !blockedIds.has(b.id)).length;

  return {
    total_bugs: bugs.length,
    closed_bugs: closed.length,
    covered_closed_bugs,
    violations,
    passes: !violations.some((v) => v.severity === "block"),
  };
}

/** Convenience: just the blocking violations (what a CI gate would fail on). */
export function blockingViolations(report: CoverageReport): CoverageViolation[] {
  return report.violations.filter((v) => v.severity === "block");
}
