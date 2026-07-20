import { describe, expect, it } from "vitest";

import {
  reconcileAuthoritativeLifecycleBatchDryRun,
  reconcileAuthoritativeLifecycleDryRun,
  type AuthoritativeLifecycleInputs,
  type AuthoritativeLifecycleStatus,
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
  it("keeps the versioned dry-run response envelope stable", () => {
    expect(reconcileAuthoritativeLifecycleDryRun(inputs())).toEqual({
      schema_version: "orchestration.authoritative_lifecycle_reconciliation.v1",
      mode: "dry_run",
      status: "active",
      reason: "the dispatch, task, or backlog row is active",
      evidence: ["dispatch.status"],
      suggested_actions: [],
      blocks_dependency_chain: false,
      mutates: false,
    });
  });

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

  it("suggests supersede for a terminal stale duplicate whose work did not land", () => {
    const actual = reconcileAuthoritativeLifecycleDryRun(inputs({
      backlog: { state: "ready", stale_duplicate: true, prior_dispatch_terminal: true, prior_work_landed: false },
    }));

    expect(actual.suggested_actions).toEqual([{
      action: "supersede",
      reason: "stale duplicate points to a terminal dispatch; supersede it instead of retrying",
      evidence: ["backlog.stale_duplicate", "backlog.prior_dispatch_terminal"],
    }]);
  });

  it("does not emit an action-ledger entry without terminal or landed evidence", () => {
    const actual = reconcileAuthoritativeLifecycleDryRun(inputs({
      backlog: { state: "ready", stale_duplicate: true, prior_dispatch_terminal: false, prior_work_landed: false },
    }));

    expect(actual.suggested_actions).toEqual([]);
  });

  it("prefers auto_close over supersede when both duplicate evidence paths are present", () => {
    const actual = reconcileAuthoritativeLifecycleDryRun(inputs({
      backlog: { state: "ready", stale_duplicate: true, prior_dispatch_terminal: true, prior_work_landed: true },
    }));

    expect(actual.suggested_actions).toHaveLength(1);
    expect(actual.suggested_actions[0]?.action).toBe("auto_close");
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

  it.each<[AuthoritativeLifecycleStatus, AuthoritativeLifecycleInputs]>([
    ["active", inputs()],
    ["needs_input", inputs({ clarification: { state: "active", owner: "operator" } })],
    ["resume_failed", inputs({ dispatch_status: "resume_delivery_failed", clarification: { state: "resume_failed", owner: "roger" } })],
    ["done_unintegrated", inputs({ dispatch_status: "done", task_status: "done" })],
    ["promoted", inputs({ promotion: { required: true, completed: true, verified: true, promoted_sha: "abc", remote_main_sha: "abc" } })],
    ["deployed_fresh", inputs({
      promotion: { required: true, completed: true, verified: true, promoted_sha: "abc", remote_main_sha: "abc" },
      deploy: { fresh: true, running_sha: "abc", promoted_main_sha: "abc" },
    })],
    ["accepted", inputs({ acceptance: { accepted: true, evidence_refs: ["artifact:/acceptance.md"] } })],
    ["superseded", inputs({ backlog: { state: "superseded", stale_duplicate: false, prior_dispatch_terminal: false, prior_work_landed: false } })],
    ["failed_needs_owner", inputs({ dispatch_status: "failed" })],
    ["moot", inputs({ dispatch_status: "moot" })],
  ])("emits %s from authoritative structured state", (status, input) => {
    expect(reconcileAuthoritativeLifecycleDryRun(input).status).toBe(status);
  });

  it("keeps every suggested action ledger-ready and the input untouched", () => {
    const input = inputs({
      clarification: { state: "stale", owner: "release-engineering" },
      backlog: { state: "ready", stale_duplicate: true, prior_dispatch_terminal: true, prior_work_landed: false },
    });
    const before = structuredClone(input);
    const actual = reconcileAuthoritativeLifecycleDryRun(input);

    expect(input).toEqual(before);
    expect(actual.mutates).toBe(false);
    expect(actual.suggested_actions).toEqual([
      {
        action: "supersede",
        reason: expect.any(String),
        evidence: ["backlog.stale_duplicate", "backlog.prior_dispatch_terminal"],
      },
      {
        action: "hold",
        reason: "hold only the clarification dependency chain",
        evidence: ["clarification.state"],
      },
    ]);
    for (const entry of actual.suggested_actions) {
      expect(entry.reason.length).toBeGreaterThan(0);
      expect(entry.evidence.length).toBeGreaterThan(0);
    }
  });

  it("returns stable dry-run counts for a bounded fixture snapshot", () => {
    const fixtures = [
      inputs(),
      inputs({ clarification: { state: "active", owner: "operator" } }),
      inputs({ dispatch_status: "done", task_status: "done" }),
      inputs({ dispatch_status: "failed" }),
      inputs({ dispatch_status: "moot" }),
    ];
    const before = structuredClone(fixtures);

    expect(reconcileAuthoritativeLifecycleBatchDryRun(fixtures)).toEqual({
      schema_version: "orchestration.authoritative_lifecycle_reconciliation_counts.v1",
      mode: "dry_run",
      total: 5,
      counts: {
        active: 1,
        needs_input: 1,
        resume_failed: 0,
        done_unintegrated: 1,
        promoted: 0,
        deployed_fresh: 0,
        accepted: 0,
        superseded: 0,
        failed_needs_owner: 1,
        moot: 1,
      },
      results: fixtures.map((fixture) => reconcileAuthoritativeLifecycleDryRun(fixture)),
      mutates: false,
    });
    expect(fixtures).toEqual(before);
  });

  it("reports an explicit zero for every lifecycle class in an empty dry-run", () => {
    expect(reconcileAuthoritativeLifecycleBatchDryRun([])).toMatchObject({
      total: 0,
      counts: Object.fromEntries([
        "active", "needs_input", "resume_failed", "done_unintegrated", "promoted",
        "deployed_fresh", "accepted", "superseded", "failed_needs_owner", "moot",
      ].map((status) => [status, 0])),
      results: [],
      mutates: false,
    });
  });
});
