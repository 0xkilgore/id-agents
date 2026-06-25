// Defect fix for T1.11/T13.2: prove the landed-evidence matcher recovers the
// real failed-row corpus (commit on the promotion repo's base / completed
// promotion / artifact on disk) and leaves genuinely-failed rows alone.

import { describe, it, expect } from "vitest";
import {
  resolveLandedEvidence,
  planReconcile,
  type FailedRowEvidence,
  type GitAncestorCheck,
} from "../../src/dispatch-recovery/evidence-reconcile.js";
import { deriveEffectiveState } from "../../src/dispatch-scheduler/read-model.js";

function row(over: Partial<FailedRowEvidence> = {}): FailedRowEvidence {
  return {
    dispatch_phid: "phid:disp-x",
    status: "failed",
    failure_kind: "agent_error",
    recovery_status: "none",
    promotion_result_json: null,
    artifact_path: null,
    ...over,
  };
}

const promo = (repo: { path: string; base?: string; promoted_sha: string }, completed = true) =>
  JSON.stringify({ required: true, completed, repos: [{ ...repo, verified: true, pushed: true }] });

// A fake git: only these (repo, sha, ref) triples are "on base".
function fakeGit(landed: Array<[string, string, string]>): GitAncestorCheck {
  const set = new Set(landed.map(([r, s, f]) => `${r}|${s}|${f}`));
  return (repoPath, sha, ref) => set.has(`${repoPath}|${sha}|${ref}`);
}

describe("resolveLandedEvidence", () => {
  it("LANDED: promoted commit present on the id-agents origin/main (the actor-foundation casualty)", () => {
    const r = row({
      dispatch_phid: "phid:disp-73605204a8a0688d",
      promotion_result_json: promo({ path: "/repo/id-agents", base: "main", promoted_sha: "1d80c61" }, false),
    });
    const ev = resolveLandedEvidence(r, {
      gitAncestor: fakeGit([["/repo/id-agents", "1d80c61", "origin/main"]]),
    });
    expect(ev.landed).toBe(true);
    expect(ev.kind).toBe("commit_on_base");
    expect(ev.commit_sha).toBe("1d80c61");
  });

  it("LANDED via a NON-id-agents repo (the agent-platform Task-substrate casualty) — per-repo verification", () => {
    const r = row({
      dispatch_phid: "phid:disp-a0f3f17f35d53ab4",
      promotion_result_json: promo({ path: "/repo/agent-platform", base: "main", promoted_sha: "8945b9e" }, false),
    });
    // NOT on id-agents main, but IS on agent-platform main → must still land.
    const ev = resolveLandedEvidence(r, {
      gitAncestor: fakeGit([["/repo/agent-platform", "8945b9e", "origin/main"]]),
    });
    expect(ev.landed).toBe(true);
    expect(ev.repo).toBe("/repo/agent-platform");
  });

  it("LANDED: completed=true promotion even when git can't confirm the SHA", () => {
    const r = row({ promotion_result_json: promo({ path: "/repo/x", promoted_sha: "abc" }, true) });
    const ev = resolveLandedEvidence(r, { gitAncestor: fakeGit([]) });
    expect(ev.landed).toBe(true);
    expect(ev.kind).toBe("promotion_completed");
  });

  it("LANDED: artifact present on disk", () => {
    const r = row({ artifact_path: "/out/report.md" });
    const ev = resolveLandedEvidence(r, { fileExists: (p) => p === "/out/report.md" });
    expect(ev.landed).toBe(true);
    expect(ev.kind).toBe("artifact_present");
  });

  it("NOT landed: no promotion, no artifact (genuine failure stays needs-operator)", () => {
    expect(resolveLandedEvidence(row(), { gitAncestor: fakeGit([]) }).landed).toBe(false);
  });

  it("NOT landed: promoted_sha NOT on any base and completed=false", () => {
    const r = row({ promotion_result_json: promo({ path: "/repo/x", promoted_sha: "deadbeef" }, false) });
    expect(resolveLandedEvidence(r, { gitAncestor: fakeGit([]) }).landed).toBe(false);
  });
});

describe("planReconcile + effective_state flip", () => {
  it("a completed-promotion casualty surfaces landed before reconcile and done_recovered after", () => {
    const r = row({
      failure_kind: "agent_error",
      promotion_result_json: promo({ path: "/repo/id-agents", base: "main", promoted_sha: "1d80c61" }, true),
    });
    // before mutation: read-model already treats completed+verified promotion as landed.
    expect(deriveEffectiveState({ ...r } as any)).toBe("failed_work_landed_recoverable");

    const plan = planReconcile(r, { gitAncestor: fakeGit([["/repo/id-agents", "1d80c61", "origin/main"]]) });
    expect(plan.landed).toBe(true);
    expect(plan.next_recovery_status).toBe("verified_done");

    // after applying: status=done, recovery_status=verified_done -> done_recovered
    expect(
      deriveEffectiveState({ ...r, status: "done", recovery_status: "verified_done" } as any),
    ).toBe("done_recovered");
  });

  it("is idempotent: an already-reconciled row is left alone", () => {
    const r = row({ recovery_status: "verified_done", status: "done" });
    const plan = planReconcile(r);
    expect(plan.next_recovery_status).toBeNull();
    expect(plan.detail).toMatch(/already reconciled/);
  });

  it("a genuine failure stays failed_needs_operator (no over-reach)", () => {
    const r = row({ failure_kind: "agent_error" });
    expect(planReconcile(r, { gitAncestor: fakeGit([]) }).landed).toBe(false);
    expect(deriveEffectiveState({ ...r } as any)).toBe("failed_needs_operator");
  });
});
