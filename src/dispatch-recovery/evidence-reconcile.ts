// Defect fix for T1.11/T13.2: failed dispatches whose work actually LANDED were
// stuck at effective_state=failed_needs_operator because the recovery service
// never reconciled them, and the commit matcher only looked at promotion repo[0]
// / dispatch_id. This module matches on real LANDED EVIDENCE — a completed
// promotion, a promoted commit present on its repo's base (ANY repo in the
// promotion result, verified per-repo), or an artifact on disk — never the
// dispatch_id in a commit message. Pure decision + injectable git/fs so it is
// unit-testable on the real failed-row corpus.

import { runWithTimeout } from "../lib/subprocess.js";

export interface PromotionRepo {
  path?: string;
  base?: string;
  promoted_sha?: string;
  remote_main_sha?: string;
  verified?: boolean;
}

export interface PromotionResult {
  completed?: boolean;
  repos?: PromotionRepo[];
}

export interface FailedRowEvidence {
  dispatch_phid: string;
  status: string;
  failure_kind: string | null;
  recovery_status: string | null;
  promotion_result_json: string | null;
  artifact_path: string | null;
}

export type LandedKind =
  | "promotion_completed"
  | "commit_on_base"
  | "artifact_present"
  | "none";

export interface LandedEvidence {
  landed: boolean;
  kind: LandedKind;
  detail: string;
  commit_sha: string | null;
  repo: string | null;
}

/** True iff `sha` is an ancestor of (or equal to) `ref` in the repo. */
export type GitAncestorCheck = (repoPath: string, sha: string, ref: string) => boolean;

const realGitAncestor: GitAncestorCheck = (repoPath, sha, ref) => {
  const r = runWithTimeout(
    "git",
    ["-C", repoPath, "merge-base", "--is-ancestor", sha, ref],
    { timeoutMs: 8000 },
  );
  return r.ok; // exit 0 = ancestor present
};

function parsePromotion(json: string | null): PromotionResult | null {
  if (!json) return null;
  try {
    const j = JSON.parse(json) as PromotionResult;
    return j && typeof j === "object" ? j : null;
  } catch {
    return null;
  }
}

export interface ResolveOptions {
  gitAncestor?: GitAncestorCheck;
  fileExists?: (path: string) => boolean;
}

/**
 * Resolve whether a failed row's work demonstrably landed. Order: artifact on
 * disk → completed promotion → a promoted commit present on its repo's base
 * (checked for EVERY repo in the promotion result, against origin/<base> then
 * the local <base>). Conservative: only a positive signal returns landed.
 */
export function resolveLandedEvidence(
  row: FailedRowEvidence,
  opts: ResolveOptions = {},
): LandedEvidence {
  const gitAncestor = opts.gitAncestor ?? realGitAncestor;

  if (row.artifact_path && opts.fileExists && opts.fileExists(row.artifact_path)) {
    return {
      landed: true,
      kind: "artifact_present",
      detail: `artifact present at ${row.artifact_path}`,
      commit_sha: null,
      repo: null,
    };
  }

  const promo = parsePromotion(row.promotion_result_json);
  if (promo) {
    const repos = Array.isArray(promo.repos) ? promo.repos : [];
    // Commit evidence is the strongest proof — check it first so the reason
    // names the repo + SHA even when completed=true.
    for (const repo of repos) {
      const sha = typeof repo.promoted_sha === "string" ? repo.promoted_sha : null;
      const path = typeof repo.path === "string" ? repo.path : null;
      const base = typeof repo.base === "string" && repo.base.length > 0 ? repo.base : "main";
      if (!sha || !path) continue;
      for (const ref of [`origin/${base}`, base]) {
        if (gitAncestor(path, sha, ref)) {
          return {
            landed: true,
            kind: "commit_on_base",
            detail: `commit ${sha} present on ${ref} in ${path}`,
            commit_sha: sha,
            repo: path,
          };
        }
      }
    }
    if (promo.completed === true) {
      const sha = repos.find((r) => typeof r.promoted_sha === "string")?.promoted_sha ?? null;
      return {
        landed: true,
        kind: "promotion_completed",
        detail: "promotion result completed=true",
        commit_sha: sha,
        repo: repos.find((r) => typeof r.path === "string")?.path ?? null,
      };
    }
  }

  return { landed: false, kind: "none", detail: "no landed evidence on the row", commit_sha: null, repo: null };
}

export interface ReconcilePlanRow {
  dispatch_phid: string;
  landed: boolean;
  kind: LandedKind;
  detail: string;
  /** The recovery_status to set when landed (drives effective_state). */
  next_recovery_status: "verified_done" | null;
}

/** Build the (idempotent) reconcile plan for one failed row. Already-landed rows
 *  (recovery_status in a landed status) are left alone. */
export function planReconcile(
  row: FailedRowEvidence,
  opts: ResolveOptions = {},
): ReconcilePlanRow {
  const alreadyLanded =
    row.recovery_status === "verified_done" || row.recovery_status === "landed_reconciled";
  if (alreadyLanded) {
    return { dispatch_phid: row.dispatch_phid, landed: true, kind: "none", detail: "already reconciled", next_recovery_status: null };
  }
  const ev = resolveLandedEvidence(row, opts);
  return {
    dispatch_phid: row.dispatch_phid,
    landed: ev.landed,
    kind: ev.kind,
    detail: ev.detail,
    next_recovery_status: ev.landed ? "verified_done" : null,
  };
}
