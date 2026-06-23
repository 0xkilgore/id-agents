// T-OSS.2 — Protected-root closeout validation (pure).
//
// Every /agent-done for a leased build must prove the agent did NOT dirty the
// protected canonical root: the protected-root status after the run must equal
// the status before (spec §"Closeout Rules"). Promotion payloads must echo the
// same lease id + worktree + clean protected-root evidence per repo.

import type { WorkspaceLease, PromotionRepoResult } from "../dispatch-scheduler/types.js";

export interface WorkspaceCloseout {
  lease_id: string;
  worktree_path: string;
  protected_root: string;
  protected_root_status_before: string;
  protected_root_status_after: string;
  worktree_status_after: string;
  cleanup_action?: "kept_for_review" | "removed" | "left_dirty";
}

export interface CloseoutValidation {
  ok: boolean;
  /** Stable failure code for the manager to surface, when ok === false. */
  code?: "lease_mismatch" | "worktree_mismatch" | "protected_root_dirty_after" | "dirty_worktree_on_success";
  errors: string[];
  /** Exact lines that changed in the protected root, when it was dirtied. */
  protected_root_diff?: string[];
}

function normLines(s: string): string[] {
  return s
    .split("\n")
    .map((l) => l.trimEnd())
    .filter((l) => l.length > 0)
    // The manager's own `.worktrees/` custody infra is never "dirt".
    .filter((l) => !/\.worktrees\//.test(l) && !/\.worktrees$/.test(l))
    .sort();
}

/** Lines present in `after` but not `before` (newly-dirtied protected-root paths). */
function diffNew(before: string, after: string): string[] {
  const b = new Set(normLines(before));
  return normLines(after).filter((l) => !b.has(l));
}

/**
 * Validate a leased build's workspace closeout (spec §"Closeout Rules").
 * `dispatchSucceeded` gates the dirty-worktree allowance: a dirty worktree is
 * only acceptable for a failed/blocked dispatch (with the file list as evidence).
 */
export function validateWorkspaceCloseout(
  lease: Pick<WorkspaceLease, "lease_id" | "worktree_path" | "protected_root">,
  evidence: WorkspaceCloseout,
  opts: { dispatchSucceeded: boolean },
): CloseoutValidation {
  const errors: string[] = [];

  if (evidence.lease_id !== lease.lease_id) {
    return {
      ok: false,
      code: "lease_mismatch",
      errors: [`workspace.lease_id '${evidence.lease_id}' does not match dispatch lease '${lease.lease_id}'`],
    };
  }
  if (normPath(evidence.worktree_path) !== normPath(lease.worktree_path)) {
    return {
      ok: false,
      code: "worktree_mismatch",
      errors: [`workspace.worktree_path '${evidence.worktree_path}' does not match leased '${lease.worktree_path}'`],
    };
  }

  // The core custody invariant: the protected root must be byte-for-byte as
  // clean (or dirty) as it was before the run — the agent must not have touched it.
  const newlyDirty = diffNew(evidence.protected_root_status_before, evidence.protected_root_status_after);
  if (newlyDirty.length > 0) {
    return {
      ok: false,
      code: "protected_root_dirty_after",
      errors: [
        `protected root ${lease.protected_root} was mutated during a leased build (${newlyDirty.length} path(s))`,
      ],
      protected_root_diff: newlyDirty,
    };
  }

  // A dirty worktree at closeout is only OK for a failed/blocked dispatch.
  if (opts.dispatchSucceeded && evidence.worktree_status_after.trim().length > 0) {
    errors.push("worktree is dirty at successful closeout (uncommitted changes left behind)");
    return { ok: false, code: "dirty_worktree_on_success", errors };
  }

  return { ok: true, errors: [] };
}

function normPath(p: string): string {
  return p.replace(/\/+$/, "");
}

/**
 * Validate that a promotion repo entry carries matching workspace-lease evidence
 * (spec §"Closeout Rules" promotion JSON). Used when promotion is required.
 */
export function validatePromotionLeaseFields(
  repo: PromotionRepoResult,
  lease: Pick<WorkspaceLease, "lease_id" | "worktree_path">,
): CloseoutValidation {
  const errors: string[] = [];
  if (repo.workspace_lease_id !== lease.lease_id) {
    errors.push(
      `promotion repo workspace_lease_id '${repo.workspace_lease_id ?? "(missing)"}' != lease '${lease.lease_id}'`,
    );
  }
  if (repo.worktree_path !== undefined && normPath(repo.worktree_path) !== normPath(lease.worktree_path)) {
    errors.push(`promotion repo worktree_path '${repo.worktree_path}' != leased '${lease.worktree_path}'`);
  }
  if (repo.protected_root_status_after !== undefined && repo.protected_root_status_after.trim().length > 0) {
    errors.push("promotion repo reports a non-empty protected_root_status_after (protected root not clean)");
  }
  return errors.length > 0
    ? { ok: false, code: "lease_mismatch", errors }
    : { ok: true, errors: [] };
}
