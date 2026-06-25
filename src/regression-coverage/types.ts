// T-QA.5 — Regression coverage requirements, encoded AS CODE.
//
// The standing rule (roadmap-reset §4.7): every typed failure mode (false-expire,
// rate-limit cascade, deploy gap, backfill defect, BUG-006, …) must have a
// regression test before a bug can reach "closed" status — the bug-squash log §4
// "Closed" gate-check. T-QA.5 is a Maestra "(paper rule)" item; encoding it as a
// typed failure-mode catalog + a gate function (instead of a prose runbook)
// makes the rule enforceable and queryable, and is Roger's code charter.
//
// IMPORTANT — reference/decision-support ONLY. Nothing in the codebase imports
// this at run time. Deleting the directory changes zero behavior — the safest
// reversible option. Downstream of T-QA.1 (it consumes that taxonomy's
// classifyTest to confirm a regression_test_ref points at a real test). A real
// enforcement hook (CI / a bug-squash-log linter) is a follow-up, not done here.

/** Canonical typed failure-mode ids the bug-squash log classifies bugs into.
 *  Grounded in real failure classes this team has hit; extend as new typed
 *  modes are named. `other` is the escape hatch (still gated, but uncatalogued). */
export type FailureModeId =
  | "false_expire" // an item wrongly marked expired/stale (e.g. false-STALL on full slots)
  | "rate_limit_cascade" // a transport/error mislabeled as a provider rate limit, cascading
  | "deploy_gap" // shipped code not loaded — process/restart/freshness gap
  | "backfill_defect" // a backfill/projection reading the wrong field (e.g. mtime vs produced_at)
  | "agent_down_vs_provider_error" // a down agent process misattributed to a provider error
  | "placeholder_reuse" // SQL $N placeholder reuse / param-count defect
  | "in_flight_leak" // dispatch in_flight rows not reconciled out → loop strangle
  | "other";

export interface FailureModeDef {
  id: FailureModeId;
  name: string;
  /** What the failure class looks like, so a bug can be typed correctly. */
  description: string;
  /** A representative bug/incident id or note (real, where known). */
  example: string;
}

/** A bug-squash log entry, in the minimal shape the gate needs. */
export interface BugRecord {
  id: string; // e.g. "BUG-006"
  title: string;
  failure_mode: FailureModeId;
  status: "open" | "investigating" | "fixing" | "closed";
  /** Path to the regression test that locks this failure mode, if any. */
  regression_test_ref?: string | null;
  closed_at?: string | null;
}

export type ViolationReason =
  | "closed_without_regression_test" // closed but no regression_test_ref
  | "regression_ref_not_a_test" // ref present but does not classify as a test file
  | "uncatalogued_failure_mode"; // closed with failure_mode "other" (warning-level)

export interface CoverageViolation {
  bug_id: string;
  reason: ViolationReason;
  /** Hard violations block "closed"; soft ones are warnings (uncatalogued mode). */
  severity: "block" | "warn";
  detail: string;
}

export interface CoverageReport {
  total_bugs: number;
  closed_bugs: number;
  /** Closed bugs that satisfy the gate (have a real regression test). */
  covered_closed_bugs: number;
  violations: CoverageViolation[];
  /** True when there are no blocking violations — the §4 Closed gate passes. */
  passes: boolean;
}
