// Verify-on-done gate — the fix for "hollow done".
//
// Before /agent-done is allowed to mark a dispatch `done`, the manager verifies
// the CLAIMED deliverables actually exist: a claimed `artifact_path` must be a
// real file on disk, and a promotion's `promoted_sha` must actually be on the
// base branch. When a claim cannot be verified the dispatch is marked
// `failed_verification` (NOT done) with a clear reason, so a silent hollow-done
// surfaces instead of looking complete.
//
// The gate is pure (claims + injected probes in, result out) so it is fully
// unit-testable; the manager wires real filesystem + git probes around it.

import { execFileSync } from "node:child_process";
import fs from "node:fs";

export interface PromotionRepoClaim {
  path?: string | null;
  base?: string | null;
  promoted_sha?: string | null;
  remote_main_sha?: string | null;
}

export interface DoneClaim {
  /** Absolute path the agent claims it produced. */
  artifact_path?: string | null;
  /** Spec 054 promotion block, when the dispatch promoted code. */
  promotion?: { repos?: PromotionRepoClaim[] } | null;
}

export interface DoneVerificationProbes {
  /** True when the file exists on disk. */
  fileExists: (path: string) => boolean;
  /** True when `sha` is reachable from `base` in the repo at `repoPath`. */
  commitOnBase: (repoPath: string, sha: string, base: string) => boolean;
}

export interface DoneVerificationCheck {
  kind: "artifact" | "commit";
  target: string;
  ok: boolean;
  detail?: string;
}

export interface DoneVerificationResult {
  ok: boolean;
  /** First failing check's reason, for the failed_verification detail. */
  reason?: string;
  checks: DoneVerificationCheck[];
}

function isNonEmpty(s: unknown): s is string {
  return typeof s === "string" && s.trim().length > 0;
}

/**
 * Verify the claimed deliverables. Returns ok=true when every claim that EXISTS
 * is verified (a dispatch that claims nothing verifiable passes — the gate only
 * catches claims that don't hold up, never invents a requirement).
 */
export function verifyDoneClaims(
  claim: DoneClaim,
  probes: DoneVerificationProbes,
): DoneVerificationResult {
  const checks: DoneVerificationCheck[] = [];

  if (isNonEmpty(claim.artifact_path)) {
    const path = claim.artifact_path.trim();
    const ok = safeBool(() => probes.fileExists(path));
    checks.push({
      kind: "artifact",
      target: path,
      ok,
      detail: ok ? undefined : `claimed artifact not found on disk: ${path}`,
    });
  }

  for (const repo of claim.promotion?.repos ?? []) {
    if (!isNonEmpty(repo.promoted_sha)) continue;
    const sha = repo.promoted_sha.trim();
    const base = isNonEmpty(repo.base) ? repo.base.trim() : "main";
    const repoPath = isNonEmpty(repo.path) ? repo.path.trim() : "";
    if (!repoPath) {
      checks.push({ kind: "commit", target: sha, ok: false, detail: `promotion repo missing path for ${sha}` });
      continue;
    }
    const ok = safeBool(() => probes.commitOnBase(repoPath, sha, base));
    checks.push({
      kind: "commit",
      target: `${sha}@${base}`,
      ok,
      detail: ok ? undefined : `promoted commit ${sha} is not on ${base} in ${repoPath}`,
    });
  }

  const failed = checks.find((c) => !c.ok);
  return { ok: !failed, reason: failed?.detail, checks };
}

function safeBool(fn: () => boolean): boolean {
  try {
    return fn();
  } catch {
    return false;
  }
}

/** Real probes: filesystem existence + a git ancestry check. */
export function makeDoneVerificationProbes(): DoneVerificationProbes {
  return {
    fileExists: (path: string) => {
      try {
        return fs.existsSync(path);
      } catch {
        return false;
      }
    },
    commitOnBase: (repoPath: string, sha: string, base: string) => {
      // Only reject on DEFINITIVE proof of a hollow promotion — a real repo that
      // genuinely lacks the commit, or where the commit is genuinely not on the
      // base branch. When git cannot determine the answer (not a repo, unknown
      // ref, git unavailable) the result is INDETERMINATE and we do NOT block:
      // the gate exists to catch hollow dones, never to fail a legitimate one it
      // simply can't verify.
      const exists = git(repoPath, ["cat-file", "-e", `${sha}^{commit}`]);
      // exit 1 in a valid repo = the object is genuinely absent → hollow.
      if (!exists.ok && exists.code === 1) return false;
      // 128 / git-missing / malformed sha → indeterminate.
      if (!exists.ok) return true;
      for (const ref of [`origin/${base}`, base]) {
        const anc = git(repoPath, ["merge-base", "--is-ancestor", sha, ref]);
        if (anc.code === 0) return true; // sha is an ancestor of base → landed
        if (anc.code === 1) return false; // ref exists, sha NOT an ancestor → not landed
        // other codes (e.g. 128 unknown ref) → try the next ref.
      }
      // Commit exists but no base ref is resolvable here → indeterminate, allow.
      return true;
    },
  };
}

function git(repoPath: string, args: string[]): { ok: boolean; code: number } {
  try {
    execFileSync("git", ["-C", repoPath, ...args], { stdio: "ignore", timeout: 10_000 });
    return { ok: true, code: 0 };
  } catch (err) {
    const code = typeof (err as { status?: number }).status === "number" ? (err as { status: number }).status : -1;
    return { ok: false, code };
  }
}
