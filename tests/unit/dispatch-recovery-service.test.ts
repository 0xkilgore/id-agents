// P0 dispatch-recovery service — scans terminal failures, classifies, and
// safely auto-recovers internal work while protecting external side effects.

import { describe, expect, it } from "vitest";
import { DEFAULT_RECOVERY_CONFIG } from "../../src/dispatch-recovery/classifier.js";
import {
  DispatchRecoveryService,
  type DispatchRecoveryReactor,
  type RecoverableDispatch,
} from "../../src/dispatch-recovery/service.js";

function dispatch(over: Partial<RecoverableDispatch> = {}): RecoverableDispatch {
  return {
    dispatch_phid: "phid:disp-1",
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

class FakeReactor implements DispatchRecoveryReactor {
  requeued: Array<{ phid: string; reason: string; next_attempt_at: string }> = [];
  landed: string[] = [];
  landedOpts: Array<{ phid: string; recovery_status?: string; reason?: string }> = [];
  outcomes: Array<{ phid: string; decision: string; reason: string }> = [];
  /** Optional separate corpus for the backfill scan; defaults to docs. */
  backfillDocs: RecoverableDispatch[] | null = null;
  constructor(private docs: RecoverableDispatch[]) {}
  async listFailedForRecovery() {
    return this.docs;
  }
  async listStuckForBackfill() {
    return this.backfillDocs ?? this.docs;
  }
  async requeueForRecovery(phid: string, args: { reason: string; next_attempt_at: string }) {
    this.requeued.push({ phid, ...args });
    return true;
  }
  async markRecoveryLanded(phid: string, opts?: { recovery_status?: string; reason?: string }) {
    this.landed.push(phid);
    this.landedOpts.push({ phid, ...opts });
  }
  async recordRecoveryOutcome(phid: string, args: { decision: string; reason: string }) {
    this.outcomes.push({ phid, ...args });
  }
}

function svc(reactor: FakeReactor, over: Partial<ConstructorParameters<typeof DispatchRecoveryService>[0]> = {}) {
  return new DispatchRecoveryService({
    reactor,
    config: DEFAULT_RECOVERY_CONFIG,
    now: () => "2026-06-15T21:00:00.000Z",
    enabled: true,
    budget: 10,
    backoffMs: 30_000,
    ...over,
  });
}

describe("DispatchRecoveryService.runOnce", () => {
  it("REGRESSION: a failed dispatch with 'linked query terminated expired' is auto-requeued", async () => {
    const reactor = new FakeReactor([dispatch({ dispatch_phid: "phid:disp-expired" })]);
    const report = await svc(reactor).runOnce();
    expect(reactor.requeued.map((r) => r.phid)).toEqual(["phid:disp-expired"]);
    expect(report.retried).toBe(1);
    expect(reactor.requeued[0].reason).toMatch(/expired/);
  });

  it("REGRESSION: an external side-effect dispatch is NOT auto-resent (no requeue)", async () => {
    const reactor = new FakeReactor([
      dispatch({ dispatch_phid: "phid:disp-email", side_effect: "email" }),
    ]);
    const report = await svc(reactor).runOnce();
    expect(reactor.requeued).toHaveLength(0);
    expect(report.unsafe_side_effect).toBe(1);
    expect(reactor.outcomes[0].decision).toBe("unsafe_side_effect");
  });

  it("reconciles a landed dispatch instead of retrying it", async () => {
    const reactor = new FakeReactor([
      dispatch({ dispatch_phid: "phid:disp-landed", artifact_path: "/abs/out.md" }),
    ]);
    const report = await svc(reactor).runOnce();
    expect(reactor.landed).toEqual(["phid:disp-landed"]);
    expect(reactor.requeued).toHaveLength(0);
    expect(report.landed).toBe(1);
  });

  it("respects the per-run budget — extra retryable dispatches are deferred, not retried", async () => {
    const reactor = new FakeReactor([
      dispatch({ dispatch_phid: "phid:disp-a" }),
      dispatch({ dispatch_phid: "phid:disp-b" }),
      dispatch({ dispatch_phid: "phid:disp-c" }),
    ]);
    const report = await svc(reactor, { budget: 2 }).runOnce();
    expect(reactor.requeued).toHaveLength(2);
    expect(report.retried).toBe(2);
    expect(report.deferred).toBe(1);
  });

  it("exhausted dispatches go to the operator surface, not requeue", async () => {
    const reactor = new FakeReactor([
      dispatch({ dispatch_phid: "phid:disp-exhausted", recovery_attempts: 3 }),
    ]);
    const report = await svc(reactor).runOnce();
    expect(reactor.requeued).toHaveLength(0);
    expect(report.exhausted).toBe(1);
    expect(reactor.outcomes[0].decision).toBe("exhausted");
  });

  it("applies capped exponential backoff keyed on recovery_attempts", async () => {
    const reactor = new FakeReactor([dispatch({ recovery_attempts: 2 })]);
    await svc(reactor, { backoffMs: 10_000 }).runOnce();
    // now + 10000 * 2^2 = +40s
    expect(reactor.requeued[0].next_attempt_at).toBe("2026-06-15T21:00:40.000Z");
  });

  it("is a no-op when disabled", async () => {
    const reactor = new FakeReactor([dispatch()]);
    const report = await svc(reactor, { enabled: false }).runOnce();
    expect(reactor.requeued).toHaveLength(0);
    expect(report.skipped).toBe(true);
  });

  it("never throws out of runOnce even if a per-dispatch apply fails", async () => {
    const reactor = new FakeReactor([dispatch({ dispatch_phid: "phid:disp-x" })]);
    reactor.requeueForRecovery = async () => {
      throw new Error("db down");
    };
    const report = await svc(reactor).runOnce();
    expect(report.errors).toBe(1); // counted, not thrown
  });

  it("D3: commit-evidence probe rescues a failed row → landed verified_done, NOT retried", async () => {
    const reactor = new FakeReactor([
      dispatch({
        dispatch_phid: "phid:disp-8945b9e",
        promotion_completed: false,
        promoted_sha: "8945b9e",
        repo_path: "/Users/kilgore/Dropbox/Code/agent-platform-task-package-v0",
        base: "main",
      }),
    ]);
    const probed: Array<{ repoPath: string; base: string; sha: string }> = [];
    const service = svc(reactor, {
      commitEvidence: {
        async verifyCommitOnBase(args) {
          probed.push(args);
          return args.sha === "8945b9e"; // git confirms it's on main
        },
      },
    });

    const report = await service.runOnce();

    expect(report.landed).toBe(1);
    expect(report.retried).toBe(0);
    expect(reactor.requeued).toHaveLength(0); // never re-dispatched
    expect(probed).toEqual([
      { repoPath: "/Users/kilgore/Dropbox/Code/agent-platform-task-package-v0", base: "main", sha: "8945b9e" },
    ]);
    expect(reactor.landedOpts[0].recovery_status).toBe("verified_done");
  });

  it("D3: a false probe result leaves the row to the normal retry path (no false landing)", async () => {
    const reactor = new FakeReactor([
      dispatch({ promotion_completed: false, promoted_sha: "deadbeef", repo_path: "/repo", base: "main" }),
    ]);
    const report = await svc(reactor, {
      commitEvidence: { async verifyCommitOnBase() { return false; } },
    }).runOnce();
    expect(report.landed).toBe(0);
    expect(report.retried).toBe(1); // still a recoverable transient
  });
});

describe("DispatchRecoveryService.runBackfill (T1.11)", () => {
  it("reclassifies landed-only rows OUT of failed and counts metrics", async () => {
    const reactor = new FakeReactor([
      dispatch({ dispatch_phid: "phid:disp-landed", promotion_completed: true }), // landed
      dispatch({ dispatch_phid: "phid:disp-stuck" }), // recoverable transient, NOT landed
    ]);
    const s = svc(reactor);

    const report = await s.runBackfill();

    expect(report.scanned).toBe(2);
    expect(report.reclassified).toBe(1); // only the landed one
    expect(report.left).toBe(1); // the stuck one is NOT retried by backfill
    expect(reactor.landed).toEqual(["phid:disp-landed"]);
    expect(reactor.requeued).toHaveLength(0); // backfill never retries
    expect(s.getBackfillMetrics()).toEqual({
      recovery_backfill_runs_total: 1,
      recovery_backfill_rows_reclassified_total: 1,
    });
  });

  it("commit-evidence landings are reclassified verified_done", async () => {
    const reactor = new FakeReactor([
      dispatch({ dispatch_phid: "phid:disp-ce", promotion_completed: false, promoted_sha: "abc123", repo_path: "/r", base: "main" }),
    ]);
    const report = await svc(reactor, {
      commitEvidence: { async verifyCommitOnBase() { return true; } },
    }).runBackfill();
    expect(report.reclassified).toBe(1);
    expect(reactor.landedOpts[0].recovery_status).toBe("verified_done");
  });

  it("is idempotent: metrics accumulate but a settled corpus reclassifies nothing", async () => {
    const reactor = new FakeReactor([dispatch({ promotion_completed: true })]);
    const s = svc(reactor);
    await s.runBackfill();
    // simulate the row now reconciled to done → it drops out of the scan
    reactor.backfillDocs = [];
    const second = await s.runBackfill();
    expect(second.reclassified).toBe(0);
    expect(s.getBackfillMetrics()).toEqual({
      recovery_backfill_runs_total: 2, // both passes ran
      recovery_backfill_rows_reclassified_total: 1, // but only one row ever reclassified
    });
  });

  it("is skipped (no metrics increment) when disabled", async () => {
    const reactor = new FakeReactor([dispatch({ promotion_completed: true })]);
    const s = svc(reactor, { enabled: false });
    const report = await s.runBackfill();
    expect(report.skipped).toBe(true);
    expect(s.getBackfillMetrics().recovery_backfill_runs_total).toBe(0);
  });

  it("never throws even if a per-row apply fails", async () => {
    const reactor = new FakeReactor([dispatch({ promotion_completed: true })]);
    reactor.markRecoveryLanded = async () => { throw new Error("db down"); };
    const report = await svc(reactor).runBackfill();
    expect(report.errors).toBe(1);
    expect(report.reclassified).toBe(0);
  });
});

describe("DispatchRecoveryService.start/stop", () => {
  it("runs a backfill pass immediately on start, then is stoppable", async () => {
    const reactor = new FakeReactor([dispatch()]);
    const s = svc(reactor);
    s.start(300_000);
    // start() fires runOnce() immediately (void); let the microtask drain.
    await new Promise((r) => setTimeout(r, 0));
    expect(reactor.requeued).toHaveLength(1); // backfill pass ran
    s.stop(); // no throw
  });

  it("start() is a no-op when disabled", async () => {
    const reactor = new FakeReactor([dispatch()]);
    const s = svc(reactor, { enabled: false });
    s.start(300_000);
    await new Promise((r) => setTimeout(r, 0));
    expect(reactor.requeued).toHaveLength(0);
    s.stop();
  });
});
