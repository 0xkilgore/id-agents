// Merge-queue — serial drainer (CTO spec §5.2).
//
// ONE worker per repo, ONE merge in flight per repo (a per-repo merge-lock
// serializes even across manager restarts). The worker dequeues the oldest
// QUEUED MergeRequest, rebases onto base if base advanced (retest), then runs
// promote-to-main. fix_forward is the ONLY recovery — main is NEVER
// auto-reverted (saga rollback_policy.automatic_revert_allowed=false).
//
// Control flow is dependency-injected so the state machine is unit-testable
// without real git/promote/flock; the real wiring lives in factory.ts.

import type { DbAdapter } from "../db/db-adapter.js";
import {
  dequeueOldestQueued,
  updateMergeRequest,
} from "./storage.js";
import { isTerminalMergeState, type MergeFailure, type MergeFailureReason, type MergeRequest } from "./types.js";

export interface MergeGitDeps {
  /** Fetch the base ref; returns the current remote base tip sha. */
  fetchBase(repoRoot: string, remote: string, base: string): Promise<{ ok: boolean; baseTip: string | null; error?: string }>;
  /** True when `base` is NOT already an ancestor of `branch` (a rebase is needed). */
  needsRebase(repoRoot: string, branch: string, base: string): Promise<boolean>;
  /** Rebase `branch` onto `base` in the builder's worktree; conflict aborts cleanly. */
  rebaseOntoBase(
    repoRoot: string,
    branch: string,
    base: string,
  ): Promise<{ ok: boolean; conflict: boolean; newHeadSha?: string; error?: string }>;
}

export interface MergePromoteResult {
  ok: boolean;
  promoted_sha?: string;
  reason?: MergeFailureReason; // when !ok
  detail?: string;
}

export interface MergeWorkerDeps {
  git: MergeGitDeps;
  /** Runs `promote-to-main` (the serial merge tool) and returns its result. */
  promote(mr: MergeRequest): Promise<MergePromoteResult>;
  /** Optional smoke/test gate on the rebased branch before merge. */
  smoke?: (mr: MergeRequest) => Promise<{ ok: boolean; detail?: string }>;
  /** Per-repo merge-lock; resolves to a release fn. Blocking-fast. */
  acquireRepoLock(repoRoot: string): Promise<() => Promise<void>>;
  /** Emit the fix_forward dispatch back to the builder; returns its dispatch id. */
  emitFixForward(mr: MergeRequest, failure: Omit<MergeFailure, "follow_up_dispatch_id">): Promise<string | null>;
  /** Eager worktree lease release on merge success (reaper also catches it). */
  releaseLease?: (leaseId: string) => Promise<void>;
  remote?: string; // default "origin"
  now?: () => Date;
}

function nowIso(deps: MergeWorkerDeps): string {
  return (deps.now ? deps.now() : new Date()).toISOString();
}

async function fail(
  adapter: DbAdapter,
  deps: MergeWorkerDeps,
  mr: MergeRequest,
  reason: MergeFailureReason,
  detail: string,
): Promise<MergeRequest> {
  const at = nowIso(deps);
  // fix_forward = a real dispatch back to the builder. NEVER an auto-revert.
  let followUp: string | null = null;
  try {
    followUp = await deps.emitFixForward(mr, { reason, detail, at });
  } catch {
    followUp = null;
  }
  const failure: MergeFailure = { reason, detail, follow_up_dispatch_id: followUp, at };
  return (
    (await updateMergeRequest(adapter, mr.mr_id, { state: "failed", failure, completed_at: at })) ?? {
      ...mr,
      state: "failed",
      failure,
      completed_at: at,
    }
  );
}

/**
 * Drain exactly ONE merge request for a repo to a terminal state, a requeued
 * `conflict` (retry budget remaining), or a no-op when the queue is empty.
 * Holds the per-repo merge-lock for the whole transition so only one merge is
 * ever in flight per repo. Returns the resulting MR, or null if nothing queued.
 */
export async function drainOneMergeRequest(
  adapter: DbAdapter,
  repoAlias: string,
  deps: MergeWorkerDeps,
): Promise<MergeRequest | null> {
  const picked = await dequeueOldestQueued(adapter, repoAlias);
  if (!picked) return null;

  const remote = deps.remote ?? "origin";
  const release = await deps.acquireRepoLock(picked.repo_root);
  try {
    let mr =
      (await updateMergeRequest(adapter, picked.mr_id, {
        state: "merging",
        attempts: picked.attempts + 1,
        started_at: picked.started_at ?? nowIso(deps),
      })) ?? picked;

    const fetched = await deps.git.fetchBase(mr.repo_root, remote, mr.base);
    if (!fetched.ok) {
      return await fail(adapter, deps, mr, "push_rejected", `fetch ${remote} ${mr.base} failed: ${fetched.error ?? "unknown"}`);
    }

    if (await deps.git.needsRebase(mr.repo_root, mr.branch, mr.base)) {
      mr = (await updateMergeRequest(adapter, mr.mr_id, { state: "rebasing" })) ?? mr;
      const reb = await deps.git.rebaseOntoBase(mr.repo_root, mr.branch, mr.base);
      if (reb.conflict || !reb.ok) {
        if (!reb.conflict) {
          return await fail(adapter, deps, mr, "push_rejected", `rebase failed: ${reb.error ?? "unknown"}`);
        }
        // Real conflict. Retry budget?
        if (mr.attempts >= mr.max_attempts) {
          return await fail(adapter, deps, mr, "conflict_exhausted", `rebase conflict after ${mr.attempts} attempt(s)`);
        }
        // Re-queue for a later drain (bounded backoff handled by the caller cadence).
        return (await updateMergeRequest(adapter, mr.mr_id, { state: "conflict" })) ?? mr;
      }
      if (reb.newHeadSha) {
        mr = (await updateMergeRequest(adapter, mr.mr_id, { head_sha: reb.newHeadSha })) ?? mr;
      }
      if (deps.smoke) {
        const sm = await deps.smoke(mr);
        if (!sm.ok) {
          return await fail(adapter, deps, mr, "smoke_failed", `smoke failed on rebased branch: ${sm.detail ?? ""}`);
        }
      }
      mr = (await updateMergeRequest(adapter, mr.mr_id, { state: "merging" })) ?? mr;
    }

    const result = await deps.promote(mr);
    if (result.ok && result.promoted_sha) {
      const at = nowIso(deps);
      const merged =
        (await updateMergeRequest(adapter, mr.mr_id, {
          state: "merged",
          promoted_sha: result.promoted_sha,
          completed_at: at,
        })) ?? { ...mr, state: "merged", promoted_sha: result.promoted_sha, completed_at: at };
      if (merged.lease_id && deps.releaseLease) {
        try {
          await deps.releaseLease(merged.lease_id);
        } catch {
          /* reaper will catch it within 6h */
        }
      }
      return merged;
    }
    return await fail(adapter, deps, mr, result.reason ?? "push_rejected", result.detail ?? "promote-to-main failed");
  } finally {
    await release();
  }
}

/** Drain a repo until no QUEUED items remain (each conflict requeue ends the pass). */
export async function drainRepo(
  adapter: DbAdapter,
  repoAlias: string,
  deps: MergeWorkerDeps,
  opts?: { maxDrains?: number },
): Promise<MergeRequest[]> {
  const out: MergeRequest[] = [];
  const cap = opts?.maxDrains ?? 50;
  for (let n = 0; n < cap; n++) {
    const mr = await drainOneMergeRequest(adapter, repoAlias, deps);
    if (!mr) break;
    out.push(mr);
    // A non-terminal result (a conflict requeue) would otherwise be re-picked
    // immediately; stop the pass so the caller's next tick retries after backoff.
    if (!isTerminalMergeState(mr.state)) break;
  }
  return out;
}
