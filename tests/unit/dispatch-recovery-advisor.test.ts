// T-REMOTE P1c — dispatch recovery advisor: maps a failed dispatch to the
// operator advisory class (landed-recoverable/verify-first/refire/moot/needs-human).

import { describe, expect, it } from "vitest";
import { classifyDispatchRecoveryAdvisor } from "../../src/dispatch-recovery/advisor.js";
import type { RecoveryInput } from "../../src/dispatch-recovery/classifier.js";

function input(over: Partial<RecoveryInput> = {}): RecoveryInput {
  return {
    status: "failed",
    failure_kind: "agent_error",
    failure_detail: null,
    agent_query_id: null,
    attempt_count: 1,
    recovery_attempts: 0,
    artifact_path: null,
    promotion_completed: null,
    channel: "dispatch",
    side_effect: "none",
    allow_auto_retry: false,
    ...over,
  };
}

describe("classifyDispatchRecoveryAdvisor", () => {
  it("ACCEPTANCE: an EXPIRED LINKED QUERY whose work LANDED classifies landed-recoverable, NOT refire", () => {
    const r = classifyDispatchRecoveryAdvisor(
      input({
        agent_query_id: "agent-q-1",
        failure_detail: "linked query terminated expired",
        artifact_path: "/out/2026-07-02-work.md", // landed evidence
      }),
    );
    expect(r.advisor_class).toBe("landed-recoverable");
  });

  it("commit-verified-on-base landed work → landed-recoverable", () => {
    const r = classifyDispatchRecoveryAdvisor(input({ commit_verified_on_base: true }));
    expect(r.advisor_class).toBe("landed-recoverable");
  });

  it("expired linked query with NO landed proof → verify-first (don't blind-refire)", () => {
    const r = classifyDispatchRecoveryAdvisor(
      input({ agent_query_id: "agent-q-2", failure_detail: "linked query terminated expired" }),
    );
    expect(r.advisor_class).toBe("verify-first");
    expect(r.reason).toMatch(/verify landed work/i);
  });

  it("a recoverable transient (not a linked query) → refire", () => {
    const r = classifyDispatchRecoveryAdvisor(input({ failure_kind: "scheduler_wedged" }));
    expect(r.advisor_class).toBe("refire");
  });

  it("operator-cancelled / superseded (no landed work) → moot", () => {
    const r = classifyDispatchRecoveryAdvisor(
      input({ failure_kind: "cancelled", failure_detail: "superseded by fresh retry" }),
    );
    expect(r.advisor_class).toBe("moot");
  });

  it("landed work wins even over a cancelled marker (recover, don't dismiss)", () => {
    const r = classifyDispatchRecoveryAdvisor(input({ failure_kind: "cancelled", promotion_completed: true }));
    expect(r.advisor_class).toBe("landed-recoverable");
  });

  it("external side effect without opt-in → needs-human", () => {
    const r = classifyDispatchRecoveryAdvisor(input({ side_effect: "email" }));
    expect(r.advisor_class).toBe("needs-human");
  });

  it("recovery attempts exhausted → needs-human", () => {
    const r = classifyDispatchRecoveryAdvisor(input({ failure_kind: "scheduler_wedged", recovery_attempts: 5 }));
    expect(r.advisor_class).toBe("needs-human");
  });

  it("a non-transient ambiguous failure → needs-human (never blind refire)", () => {
    const r = classifyDispatchRecoveryAdvisor(input({ failure_kind: "validation_failed", failure_detail: "bad schema" }));
    expect(r.advisor_class).toBe("needs-human");
  });
});
