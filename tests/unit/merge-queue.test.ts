// Merge-queue — storage + worker state machine (CTO spec §5; acceptance 4-7).

import { describe, it, expect, beforeEach } from "vitest";
import { SqliteAdapter } from "../../src/db/sqlite-adapter.js";
import {
  migrateMergeQueueTables,
  enqueueMergeRequest,
  dequeueOldestQueued,
  listMergeRequests,
} from "../../src/merge-queue/storage.js";
import { drainOneMergeRequest, drainRepo, type MergeWorkerDeps } from "../../src/merge-queue/worker.js";
import type { MergeRequestSubmission } from "../../src/merge-queue/types.js";

let adapter: SqliteAdapter;
beforeEach(async () => {
  adapter = new SqliteAdapter(":memory:");
  await migrateMergeQueueTables(adapter);
});

function sub(over: Partial<MergeRequestSubmission> = {}): MergeRequestSubmission {
  return {
    repo_alias: "id-agents",
    repo_root: "/r/id-agents",
    pool_id: "backend",
    branch: "build/brunel-d1-torch",
    head_sha: "sha-aaa",
    builder: "brunel",
    dispatch_id: "phid:disp-1",
    lease_id: "lease-1",
    ...over,
  };
}

// A fully-configurable fake worker dep set + instrumentation.
function makeDeps(over: Partial<{
  needsRebase: boolean;
  rebase: { ok: boolean; conflict: boolean; newHeadSha?: string };
  smoke: { ok: boolean } | null;
  promote: { ok: boolean; promoted_sha?: string; reason?: any; detail?: string };
}> = {}) {
  const calls = { promote: 0, fixForward: 0, leaseReleased: [] as string[], lockAcquires: 0, lockHeldMax: 0 };
  let held = 0;
  const deps: MergeWorkerDeps = {
    git: {
      fetchBase: async () => ({ ok: true, baseTip: "main-tip" }),
      needsRebase: async () => over.needsRebase ?? false,
      rebaseOntoBase: async () => over.rebase ?? { ok: true, conflict: false, newHeadSha: "sha-rebased" },
    },
    promote: async () => {
      calls.promote++;
      return over.promote ?? { ok: true, promoted_sha: "merged-sha" };
    },
    smoke: over.smoke === null ? undefined : async () => over.smoke ?? { ok: true },
    acquireRepoLock: async () => {
      held++;
      calls.lockAcquires++;
      calls.lockHeldMax = Math.max(calls.lockHeldMax, held);
      return async () => {
        held--;
      };
    },
    emitFixForward: async () => {
      calls.fixForward++;
      return `phid:ff-${calls.fixForward}`;
    },
    releaseLease: async (id) => {
      calls.leaseReleased.push(id);
    },
    now: () => new Date("2026-06-23T22:00:00.000Z"),
  };
  return { deps, calls };
}

describe("merge-queue storage", () => {
  it("enqueue is idempotent on repo:branch:head_sha (acceptance 7)", async () => {
    const a = await enqueueMergeRequest(adapter, sub());
    expect(a.created).toBe(true);
    expect(a.mr.state).toBe("queued");
    const b = await enqueueMergeRequest(adapter, sub());
    expect(b.created).toBe(false);
    expect(b.mr.mr_id).toBe(a.mr.mr_id);
    expect((await listMergeRequests(adapter)).length).toBe(1);
  });

  it("a new head_sha is a distinct MR", async () => {
    await enqueueMergeRequest(adapter, sub({ head_sha: "sha-aaa" }));
    const b = await enqueueMergeRequest(adapter, sub({ head_sha: "sha-bbb" }));
    expect(b.created).toBe(true);
    expect((await listMergeRequests(adapter)).length).toBe(2);
  });

  it("dequeue orders north-star > priority > enqueued_at", async () => {
    await enqueueMergeRequest(adapter, sub({ branch: "b1", head_sha: "s1", priority: 5 }), { now: () => new Date("2026-06-23T22:00:00Z") });
    await enqueueMergeRequest(adapter, sub({ branch: "b2", head_sha: "s2", priority: 1 }), { now: () => new Date("2026-06-23T22:00:01Z") });
    await enqueueMergeRequest(adapter, sub({ branch: "b3", head_sha: "s3", priority: 9, is_north_star: true }), { now: () => new Date("2026-06-23T22:00:02Z") });
    const next = await dequeueOldestQueued(adapter, "id-agents");
    expect(next!.branch).toBe("b3"); // north-star wins despite worst priority
  });
});

describe("merge-queue worker", () => {
  it("clean merge (no rebase) → merged + promoted_sha + lease released (acceptance 4)", async () => {
    const { mr } = await enqueueMergeRequest(adapter, sub());
    const { deps, calls } = makeDeps({ needsRebase: false, promote: { ok: true, promoted_sha: "main-123" } });
    const out = await drainOneMergeRequest(adapter, "id-agents", deps);
    expect(out!.state).toBe("merged");
    expect(out!.promoted_sha).toBe("main-123");
    expect(out!.completed_at).not.toBeNull();
    expect(calls.leaseReleased).toEqual([mr.lease_id]);
    expect(calls.lockHeldMax).toBe(1); // one merge in flight
  });

  it("rebase-on-base → retest → merge (acceptance 5)", async () => {
    await enqueueMergeRequest(adapter, sub());
    const { deps, calls } = makeDeps({
      needsRebase: true,
      rebase: { ok: true, conflict: false, newHeadSha: "sha-reb" },
      smoke: { ok: true },
      promote: { ok: true, promoted_sha: "main-9" },
    });
    const out = await drainOneMergeRequest(adapter, "id-agents", deps);
    expect(out!.state).toBe("merged");
    expect(out!.head_sha).toBe("sha-reb"); // branch tip advanced by rebase
    expect(calls.promote).toBe(1);
  });

  it("conflict with retry budget → requeued as conflict, promote NOT called", async () => {
    await enqueueMergeRequest(adapter, sub()); // max_attempts default 3
    const { deps, calls } = makeDeps({ needsRebase: true, rebase: { ok: false, conflict: true } });
    const out = await drainOneMergeRequest(adapter, "id-agents", deps);
    expect(out!.state).toBe("conflict");
    expect(out!.attempts).toBe(1);
    expect(calls.promote).toBe(0);
    // still drainable next pass
    expect((await dequeueOldestQueued(adapter, "id-agents"))!.mr_id).toBe(out!.mr_id);
  });

  it("conflict exhausted → failed + fix_forward dispatch, main NOT auto-reverted (acceptance 6)", async () => {
    const { mr } = await enqueueMergeRequest(adapter, sub());
    await adapter.query(`UPDATE merge_requests SET max_attempts = 1 WHERE mr_id = $1`, [mr.mr_id]);
    const { deps, calls } = makeDeps({ needsRebase: true, rebase: { ok: false, conflict: true } });
    const out = await drainOneMergeRequest(adapter, "id-agents", deps);
    expect(out!.state).toBe("failed");
    expect(out!.failure!.reason).toBe("conflict_exhausted");
    expect(out!.failure!.follow_up_dispatch_id).toBe("phid:ff-1");
    expect(calls.promote).toBe(0); // never merged → nothing to revert
    expect(calls.fixForward).toBe(1);
  });

  it("smoke failure on rebased branch → failed smoke_failed", async () => {
    await enqueueMergeRequest(adapter, sub());
    const { deps, calls } = makeDeps({ needsRebase: true, rebase: { ok: true, conflict: false }, smoke: { ok: false } });
    const out = await drainOneMergeRequest(adapter, "id-agents", deps);
    expect(out!.state).toBe("failed");
    expect(out!.failure!.reason).toBe("smoke_failed");
    expect(calls.promote).toBe(0);
  });

  it("promote failure → failed + fix_forward (no merged state)", async () => {
    await enqueueMergeRequest(adapter, sub());
    const { deps, calls } = makeDeps({ needsRebase: false, promote: { ok: false, reason: "push_rejected", detail: "remote moved" } });
    const out = await drainOneMergeRequest(adapter, "id-agents", deps);
    expect(out!.state).toBe("failed");
    expect(out!.failure!.reason).toBe("push_rejected");
    expect(calls.fixForward).toBe(1);
  });

  it("drainRepo serializes N merges one-at-a-time to terminal (acceptance 4)", async () => {
    for (let i = 0; i < 3; i++) await enqueueMergeRequest(adapter, sub({ branch: `b${i}`, head_sha: `s${i}` }));
    const { deps, calls } = makeDeps({ needsRebase: false, promote: { ok: true, promoted_sha: "x" } });
    const drained = await drainRepo(adapter, "id-agents", deps);
    expect(drained).toHaveLength(3);
    expect(drained.every((m) => m.state === "merged")).toBe(true);
    expect(calls.lockHeldMax).toBe(1); // never two merges concurrently
    expect((await listMergeRequests(adapter, { state: "merged" })).length).toBe(3);
  });
});

describe("merge-queue concurrent drain (RD-038)", () => {
  it("two overlapping drains of one queued MR → promote runs once, merged, attempts=1", async () => {
    await enqueueMergeRequest(adapter, sub());

    let promoteCalls = 0;
    // Barrier: hold BOTH entrants at the lock until each has already dequeued the
    // same queued MR (reproducing the lock-free-SELECT race), then serialize the
    // critical section so the second must re-validate under the lock and bail.
    let reachedLock = 0;
    let bothReached!: () => void;
    const bothReachedP = new Promise<void>((res) => {
      bothReached = res;
    });
    let lockChain = Promise.resolve();

    const deps: MergeWorkerDeps = {
      git: {
        fetchBase: async () => ({ ok: true, baseTip: "main-tip" }),
        needsRebase: async () => false,
        rebaseOntoBase: async () => ({ ok: true, conflict: false, newHeadSha: "sha-r" }),
      },
      promote: async () => {
        promoteCalls++;
        return { ok: true, promoted_sha: "merged-sha" };
      },
      smoke: async () => ({ ok: true }),
      acquireRepoLock: async () => {
        reachedLock++;
        if (reachedLock === 2) bothReached();
        await bothReachedP; // both entrants have dequeued the same MR
        let release!: () => void;
        const gate = new Promise<void>((r) => {
          release = r;
        });
        const prev = lockChain;
        lockChain = lockChain.then(() => gate);
        await prev; // serialize: wait for the previous holder to release
        return async () => {
          release();
        };
      },
      emitFixForward: async () => "phid:ff",
      releaseLease: async () => {},
      now: () => new Date("2026-06-23T22:00:00.000Z"),
    };

    await Promise.all([
      drainOneMergeRequest(adapter, "id-agents", deps),
      drainOneMergeRequest(adapter, "id-agents", deps),
    ]);

    // The loser re-validated under the lock and bailed: exactly one merge ran.
    expect(promoteCalls).toBe(1);
    const all = await listMergeRequests(adapter);
    expect(all).toHaveLength(1);
    expect(all[0].state).toBe("merged");
    expect(all[0].attempts).toBe(1);
  });
});
