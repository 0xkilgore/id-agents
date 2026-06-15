// P0 dispatch-recovery (disp-b329f522b1271e1b): the pure decision that turns a
// terminal-failed/expired dispatch into one of landed / retryable /
// unsafe_side_effect / exhausted / needs_operator.

import { describe, expect, it } from "vitest";
import {
  DEFAULT_RECOVERY_CONFIG,
  classifyRecovery,
  type RecoveryInput,
} from "../../src/dispatch-recovery/classifier.js";

function input(over: Partial<RecoveryInput> = {}): RecoveryInput {
  return {
    status: "failed",
    failure_kind: "agent_error",
    failure_detail: "linked query terminated expired",
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

describe("classifyRecovery", () => {
  it("HEADLINE: a failed internal dispatch with 'linked query terminated expired' is RETRYABLE", () => {
    const d = classifyRecovery(input(), DEFAULT_RECOVERY_CONFIG);
    expect(d.decision).toBe("retryable");
    expect(d.reason).toMatch(/expired/);
  });

  it("scheduler_wedged internal failure is retryable", () => {
    const d = classifyRecovery(
      input({ failure_kind: "scheduler_wedged", failure_detail: "stale in_flight claim ..." }),
      DEFAULT_RECOVERY_CONFIG,
    );
    expect(d.decision).toBe("retryable");
  });

  it("a dispatch that actually LANDED (artifact present) is not retried", () => {
    const d = classifyRecovery(input({ artifact_path: "/abs/report.md" }), DEFAULT_RECOVERY_CONFIG);
    expect(d.decision).toBe("landed");
  });

  it("a dispatch with a completed promotion is LANDED", () => {
    const d = classifyRecovery(input({ promotion_completed: true }), DEFAULT_RECOVERY_CONFIG);
    expect(d.decision).toBe("landed");
  });

  it("NO AUTO-RETRY for an external side-effect dispatch without opt-in (email)", () => {
    const d = classifyRecovery(input({ side_effect: "email" }), DEFAULT_RECOVERY_CONFIG);
    expect(d.decision).toBe("unsafe_side_effect");
  });

  it("external side effect on a non-dispatch channel is unsafe without opt-in", () => {
    const d = classifyRecovery(input({ channel: "email", side_effect: "none" }), DEFAULT_RECOVERY_CONFIG);
    expect(d.decision).toBe("unsafe_side_effect");
  });

  it("an external side-effect dispatch WITH explicit allow_auto_retry is retryable", () => {
    const d = classifyRecovery(
      input({ side_effect: "email", allow_auto_retry: true }),
      DEFAULT_RECOVERY_CONFIG,
    );
    expect(d.decision).toBe("retryable");
  });

  it("recovery attempts at the cap are EXHAUSTED (needs operator)", () => {
    const d = classifyRecovery(
      input({ recovery_attempts: DEFAULT_RECOVERY_CONFIG.max_attempts }),
      DEFAULT_RECOVERY_CONFIG,
    );
    expect(d.decision).toBe("exhausted");
  });

  it("landed takes precedence over exhausted (don't panic about work that landed)", () => {
    const d = classifyRecovery(
      input({ recovery_attempts: 99, artifact_path: "/abs/x.md" }),
      DEFAULT_RECOVERY_CONFIG,
    );
    expect(d.decision).toBe("landed");
  });

  it("an unrecognized non-transient failure is needs_operator (not auto-retried)", () => {
    const d = classifyRecovery(
      input({ failure_kind: "validation_failed", failure_detail: "bad input shape" }),
      DEFAULT_RECOVERY_CONFIG,
    );
    expect(d.decision).toBe("needs_operator");
  });

  it("a non-failed dispatch is needs_operator (recovery only acts on terminal failures)", () => {
    const d = classifyRecovery(input({ status: "in_flight" }), DEFAULT_RECOVERY_CONFIG);
    expect(d.decision).toBe("needs_operator");
  });
});
