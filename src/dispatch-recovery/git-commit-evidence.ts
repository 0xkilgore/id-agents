// D3: real git CommitEvidenceProbe. Ground-truth check for "did this dispatch's
// promoted commit actually land on the target base?" — the signal that rescues a
// failed/expired dispatch whose /agent-done closeout was lost (the Roger Task
// substrate `8945b9e` false-expire).
//
// Uses `git merge-base --is-ancestor <sha> <ref>` (exit 0 = present on ref,
// exit 1 = valid ref but not an ancestor, 128 = bad ref/sha). The remote tip
// (origin/<base>) is the canonical "promoted to main" truth; we fall back to the
// local base branch only when no remote ref exists. Every git call is bounded by
// the R.1 subprocess timeout wrapper so a wedged git can never hang the loop.

import { runWithTimeout } from "../lib/subprocess.js";
import type { CommitEvidenceProbe } from "./service.js";

export function makeGitCommitEvidenceProbe(opts?: { timeoutMs?: number }): CommitEvidenceProbe {
  const timeoutMs = opts?.timeoutMs ?? 10_000;

  const isAncestor = (repoPath: string, sha: string, ref: string): boolean | null => {
    const res = runWithTimeout(
      "git",
      ["-C", repoPath, "merge-base", "--is-ancestor", sha, ref],
      { timeoutMs },
    );
    if (res.ok) return true; // exit 0 → sha is on ref
    // exit 1 → ref is valid but sha is not an ancestor of it (definitively not landed there)
    if (res.kind === "nonzero_exit" && res.code === 1) return false;
    // 128 (bad ref / unknown object), timeout, spawn error → undetermined
    return null;
  };

  return {
    async verifyCommitOnBase({ repoPath, base, sha }) {
      if (!repoPath || !sha) return null;
      const b = base && base.length > 0 ? base : "main";
      // Canonical truth first: the remote tip. A definite yes/no there wins.
      const remote = isAncestor(repoPath, sha, `origin/${b}`);
      if (remote !== null) return remote;
      // No remote ref resolvable — fall back to the local base branch.
      return isAncestor(repoPath, sha, b);
    },
  };
}
