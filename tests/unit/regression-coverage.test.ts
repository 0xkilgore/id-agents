// T-QA.5 — regression-coverage gate: pin the bug-squash §4 "Closed" gate-check
// so the standing rule (every typed failure mode needs a regression test before
// closed) is enforceable code, not prose.

import { describe, it, expect } from "vitest";
import {
  checkBugCoverage,
  gateBugSquashLog,
  blockingViolations,
} from "../../src/regression-coverage/gate.js";
import { FAILURE_MODES, getFailureMode, isKnownFailureMode } from "../../src/regression-coverage/failure-modes.js";
import type { BugRecord } from "../../src/regression-coverage/types.js";

function bug(o: Partial<BugRecord> = {}): BugRecord {
  return {
    id: "BUG-001",
    title: "a bug",
    failure_mode: "false_expire",
    status: "closed",
    regression_test_ref: "tests/unit/co-inflight.test.ts",
    ...o,
  };
}

describe("failure-mode catalog", () => {
  it("catalogs the named typed modes + an 'other' escape hatch", () => {
    const ids = FAILURE_MODES.map((m) => m.id);
    expect(ids).toEqual(expect.arrayContaining(["false_expire", "rate_limit_cascade", "deploy_gap", "backfill_defect", "other"]));
    expect(isKnownFailureMode("false_expire")).toBe(true);
    expect(isKnownFailureMode("not_a_mode")).toBe(false);
    expect(getFailureMode("deploy_gap").name).toMatch(/deploy/i);
    expect(() => getFailureMode("xxx" as never)).toThrow(/unknown failure mode/);
  });
});

describe("checkBugCoverage — the per-bug gate", () => {
  it("passes a closed bug with a real regression test + known mode", () => {
    expect(checkBugCoverage(bug())).toEqual([]);
  });

  it("blocks a closed bug with NO regression test", () => {
    const v = checkBugCoverage(bug({ regression_test_ref: null }));
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({ reason: "closed_without_regression_test", severity: "block" });
  });

  it("blocks a closed bug whose ref is not a test file (points at a doc)", () => {
    const v = checkBugCoverage(bug({ regression_test_ref: "docs/bug-006-writeup.md" }));
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({ reason: "regression_ref_not_a_test", severity: "block" });
  });

  it("warns (does not block) a closed bug typed 'other' but with a real test", () => {
    const v = checkBugCoverage(bug({ failure_mode: "other" }));
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({ reason: "uncatalogued_failure_mode", severity: "warn" });
  });

  it("does not gate bugs that are not yet closed", () => {
    expect(checkBugCoverage(bug({ status: "fixing", regression_test_ref: null }))).toEqual([]);
    expect(checkBugCoverage(bug({ status: "open", regression_test_ref: null }))).toEqual([]);
  });
});

describe("gateBugSquashLog — the §4 Closed gate-check over a whole log", () => {
  it("passes when every closed bug has a real regression test", () => {
    const report = gateBugSquashLog([
      bug({ id: "BUG-001" }),
      bug({ id: "BUG-002", failure_mode: "deploy_gap", regression_test_ref: "tests/integration/deploy-gap.test.ts" }),
      bug({ id: "BUG-003", status: "open", regression_test_ref: null }),
    ]);
    expect(report.total_bugs).toBe(3);
    expect(report.closed_bugs).toBe(2);
    expect(report.covered_closed_bugs).toBe(2);
    expect(report.passes).toBe(true);
    expect(blockingViolations(report)).toHaveLength(0);
  });

  it("fails when a closed bug lacks a regression test", () => {
    const report = gateBugSquashLog([
      bug({ id: "BUG-006", failure_mode: "backfill_defect", regression_test_ref: null }),
      bug({ id: "BUG-007" }),
    ]);
    expect(report.closed_bugs).toBe(2);
    expect(report.covered_closed_bugs).toBe(1); // BUG-007 covered, BUG-006 blocked
    expect(report.passes).toBe(false);
    expect(blockingViolations(report).map((v) => v.bug_id)).toEqual(["BUG-006"]);
  });

  it("warnings alone do not fail the gate", () => {
    const report = gateBugSquashLog([bug({ id: "BUG-008", failure_mode: "other" })]);
    expect(report.passes).toBe(true);
    expect(report.violations).toHaveLength(1);
    expect(report.violations[0].severity).toBe("warn");
  });
});
