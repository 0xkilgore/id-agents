// T-QA.5 — Regression coverage module.
//
// Reference/decision-support ONLY: nothing imports this at run time. It is the
// T-QA.5 standing rule (each typed failure mode needs a regression test before
// "closed") expressed as a typed failure-mode catalog + a pure gate function, so
// the bug-squash-log §4 Closed gate-check is enforceable/queryable instead of
// prose. Deleting this directory changes zero runtime behavior. Consumes T-QA.1
// (classifyTest) to validate that a regression ref is a real test.

export * from "./types.js";
export { FAILURE_MODES, getFailureMode, isKnownFailureMode } from "./failure-modes.js";
export { checkBugCoverage, gateBugSquashLog, blockingViolations } from "./gate.js";
