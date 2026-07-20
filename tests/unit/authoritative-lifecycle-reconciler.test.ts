import { describe, expect, it } from "vitest";

import {
  reconcileAuthoritativeLifecycleDryRun,
  type AuthoritativeLifecycleInputs,
} from "../../src/continuous-orchestration/authoritative-lifecycle-reconciler.js";

function inputs(overrides: Partial<AuthoritativeLifecycleInputs> = {}): AuthoritativeLifecycleInputs {
  return {
    dispatch_status: "in_flight",
    task_status: "doing",
    promotion: null,
    deploy: null,
    acceptance: null,
    clarification: { state: "none", owner: null },
    backlog: { state: "in_flight", stale_duplicate: false, prior_dispatch_terminal: false, prior_work_landed: false },
    ...overrides,
  };
}

describe("authoritative lifecycle reconciler dry-run", () => {
  it("keeps a completed promotion-required build done_unintegrated", () => {
    const actual = reconcileAuthoritativeLifecycleDryRun(inputs({
      dispatch_status: "done",
      task_status: "done",
      promotion: { required: true, completed: false, verified: false, promoted_sha: null, remote_main_sha: null },
    }));

    expect(actual).toMatchObject({ mode: "dry_run", mutates: false, status: "done_unintegrated" });
    expect(actual.reason).toContain("required promotion");
  });

  it("classifies matching verified remote-main promotion as promoted", () => {
    const actual = reconcileAuthoritativeLifecycleDryRun(inputs({
      dispatch_status: "done",
      task_status: "done",
      promotion: { required: true, completed: true, verified: true, promoted_sha: "abc", remote_main_sha: "abc" },
    }));

    expect(actual.status).toBe("promoted");
  });

  it("requires running deployment SHA alignment before deployed_fresh", () => {
    const promotion = { required: true, completed: true, verified: true, promoted_sha: "abc", remote_main_sha: "abc" };
    expect(reconcileAuthoritativeLifecycleDryRun(inputs({
      dispatch_status: "done",
      promotion,
      deploy: { fresh: true, running_sha: "abc", promoted_main_sha: "abc" },
    })).status).toBe("deployed_fresh");
    expect(reconcileAuthoritativeLifecycleDryRun(inputs({
      dispatch_status: "done",
      promotion,
      deploy: { fresh: true, running_sha: "old", promoted_main_sha: "abc" },
    })).status).toBe("promoted");
  });

  it("requires evidence before acceptance can win", () => {
    const actual = reconcileAuthoritativeLifecycleDryRun(inputs({
      dispatch_status: "done",
      acceptance: { accepted: true, evidence_refs: ["artifact:/acceptance.md"] },
    }));

    expect(actual.status).toBe("accepted");
    expect(actual.evidence).toContain("artifact:/acceptance.md");
  });

  it("suggests close for a landed stale duplicate and never retry", () => {
    const actual = reconcileAuthoritativeLifecycleDryRun(inputs({
      dispatch_status: "done",
      backlog: { state: "ready", stale_duplicate: true, prior_dispatch_terminal: true, prior_work_landed: true },
    }));

    expect(actual.suggested_actions.map((entry) => entry.action)).toEqual(["auto_close"]);
    expect(actual.suggested_actions.map((entry) => entry.action)).not.toContain("retry_safe_mark");
  });

  it("contains stale clarification blocking to its dependency chain", () => {
    const actual = reconcileAuthoritativeLifecycleDryRun(inputs({
      clarification: { state: "stale", owner: "release-engineering" },
    }));

    expect(actual).toMatchObject({ status: "needs_input", blocks_dependency_chain: true });
    expect(actual.suggested_actions).toContainEqual(expect.objectContaining({ action: "hold" }));
  });

  it("emits resume_failed before generic failure", () => {
    expect(reconcileAuthoritativeLifecycleDryRun(inputs({
      dispatch_status: "resume_delivery_failed",
      clarification: { state: "resume_failed", owner: "roger" },
    })).status).toBe("resume_failed");
  });

  it.each([
    ["superseded", inputs({ backlog: { state: "superseded", stale_duplicate: false, prior_dispatch_terminal: false, prior_work_landed: false } })],
    ["moot", inputs({ dispatch_status: "moot" })],
    ["failed_needs_owner", inputs({ dispatch_status: "failed" })],
    ["active", inputs()],
  ] as const)("emits %s from authoritative structured state", (status, input) => {
    expect(reconcileAuthoritativeLifecycleDryRun(input).status).toBe(status);
  });
});
