// Merge-queue — types (CTO build-pool/merge-queue spec §3.3).
//
// Builds parallelize (N builders in N worktrees); MERGES serialize through a
// single-file, one-at-a-time queue per repo. A MergeRequest is the single-repo
// specialization of the cross-repo saga `step` (D-IPR.4 / powerhouse saga,
// AGPL): durable, idempotency-keyed, explicit terminal states, fix_forward
// recovery only — main is NEVER auto-reverted.

import type { PoolId, RepoAlias } from "../build-pools/types.js";

export type MergeStrategy = "auto" | "fast_forward" | "merge_commit" | "squash";

export type MergeState =
  | "queued" // waiting in FIFO
  | "merging" // worker holds the repo merge-lock, running promote-to-main
  | "rebasing" // base advanced; rebasing branch onto main + retesting
  | "merged" // terminal success
  | "conflict" // rebase hit a real conflict; retry budget remaining
  | "failed" // terminal; fix_forward dispatch emitted to builder
  | "abandoned"; // terminal; superseded/canceled

export type MergeFailureReason =
  | "conflict_exhausted"
  | "smoke_failed"
  | "push_rejected"
  | "abi_mismatch"
  | "operator_canceled";

export interface MergeFailure {
  reason: MergeFailureReason;
  detail: string;
  /** The fix_forward dispatch (a real dispatch back to the builder), never an auto-revert. */
  follow_up_dispatch_id: string | null;
  at: string;
}

export interface MergeRequest {
  mr_id: string; // "mr_<yyyymmdd>_<short-dispatch>_<branch-slug>"
  idempotency_key: string; // `${repo_alias}:${branch}:${head_sha}` — saga contract
  repo_alias: RepoAlias;
  repo_root: string;
  pool_id: PoolId;
  base: string; // "main"
  branch: string; // feature branch the builder pushed
  builder: string; // agent that built it (for fix_forward routing)
  dispatch_id: string;
  lease_id: string | null; // worktree lease to release on success
  head_sha: string; // builder's branch tip at submit
  strategy: MergeStrategy;
  state: MergeState;
  attempts: number;
  max_attempts: number; // default 3
  promoted_sha: string | null; // filled on merge success
  failure: MergeFailure | null;
  priority: number; // tiebreak after north-star; lower fires first
  is_north_star: boolean;
  enqueued_at: string;
  started_at: string | null;
  completed_at: string | null;
}

/** Builder → /agent-done submission (replaces the inline promotion result). */
export interface MergeRequestSubmission {
  repo_alias: RepoAlias;
  repo_root: string;
  pool_id: PoolId;
  branch: string;
  base?: string; // default "main"
  head_sha: string;
  builder: string;
  dispatch_id: string;
  lease_id?: string | null;
  strategy?: MergeStrategy; // default "auto"
  priority?: number;
  is_north_star?: boolean;
}

export const MERGE_QUEUE_SCHEMA_VERSION = "merge.request.v1" as const;
export const DEFAULT_MAX_ATTEMPTS = 3;

/** Stable idempotency key — re-submitting the same key is a no-op when merged. */
export function mergeIdempotencyKey(repoAlias: string, branch: string, headSha: string): string {
  return `${repoAlias}:${branch}:${headSha}`;
}

export function isTerminalMergeState(s: MergeState): boolean {
  return s === "merged" || s === "failed" || s === "abandoned";
}
