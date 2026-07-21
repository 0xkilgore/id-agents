import { describe, expect, it } from "vitest";
import { projectLifecycleStatus } from "../../src/continuous-orchestration/lifecycle-status-projection.js";
import type { AuthoritativeLifecycleInputs } from "../../src/continuous-orchestration/authoritative-lifecycle-reconciler.js";

function facts(overrides: Partial<AuthoritativeLifecycleInputs> = {}): AuthoritativeLifecycleInputs {
  return {
    dispatch_status: "done",
    task_status: "done",
    promotion: { required: true, completed: false, verified: false, promoted_sha: null, remote_main_sha: null },
    deploy: null,
    acceptance: null,
    clarification: { state: "none", owner: null },
    backlog: null,
    ...overrides,
  };
}

describe("lifecycle status projection acceptance matrix", () => {
  it.each([
    ["task", "task-a"],
    ["dispatch", "phid:disp-a"],
  ] as const)("provides the same structured contract to the %s view", (kind, id) => {
    const actual = projectLifecycleStatus({ source: { kind, id }, owner: "roger", facts: facts() });
    expect(actual).toMatchObject({
      schema_version: "orchestration.lifecycle_status_projection.v1",
      source: { kind, id },
      reconciliation: { state: "done_unintegrated" },
      owner: { id: "roger", assigned: true },
      next_action: { kind: "promote" },
      promotion_validation: { state: "missing", required: true, sha_match: false },
      deploy_freshness: { state: "unavailable", available: false },
      read_only: true,
    });
  });

  it.each([
    { name: "missing", promotion: { required: true, completed: false, verified: false, promoted_sha: null, remote_main_sha: null }, state: "missing", match: false },
    { name: "invalid", promotion: { required: true, completed: true, verified: true, promoted_sha: "a", remote_main_sha: "b" }, state: "invalid", match: false },
    { name: "verified", promotion: { required: true, completed: true, verified: true, promoted_sha: "a", remote_main_sha: "a" }, state: "verified", match: true },
  ] as const)("projects $name promotion validation without parsing text", ({ promotion, state, match }) => {
    const actual = projectLifecycleStatus({ source: { kind: "dispatch", id: "d" }, owner: null, facts: facts({ promotion }) });
    expect(actual.promotion_validation).toMatchObject({ state, sha_match: match });
  });

  it.each([
    { deploy: null, state: "unavailable" },
    { deploy: { health_available: true, fresh: true, running_sha: "old", promoted_main_sha: "new" }, state: "stale" },
    { deploy: { health_available: true, fresh: true, running_sha: "new", promoted_main_sha: "new" }, state: "fresh" },
  ] as const)("projects $state deploy freshness from structured facts", ({ deploy, state }) => {
    const promotion = { required: true, completed: true, verified: true, promoted_sha: "new", remote_main_sha: "new" };
    const actual = projectLifecycleStatus({ source: { kind: "dispatch", id: "d" }, owner: null, facts: facts({ promotion, deploy }) });
    expect(actual.deploy_freshness.state).toBe(state);
  });

  it("surfaces reconciliation-ledger actions ahead of release fallbacks", () => {
    const actual = projectLifecycleStatus({
      source: { kind: "task", id: "duplicate" },
      owner: "substrate-orch-codex",
      facts: facts({ backlog: { state: "ready", stale_duplicate: true, prior_dispatch_terminal: true, prior_work_landed: true } }),
    });
    expect(actual.next_action).toMatchObject({ kind: "auto_close", evidence: ["backlog.stale_duplicate", "backlog.prior_work_landed"] });
  });
});
