// T-OSS.2 — temp-repo integration: clean allocation, dirty protected-root
// refusal, branch-in-use refusal, and protected-root mutation detection.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { allocateWorktree, gitStatusPorcelain, protectedRootStatus } from "../../src/workspaces/allocator.js";
import { validateWorkspaceCloseout } from "../../src/workspaces/closeout.js";
import type { ProtectedRootEntry } from "../../src/workspaces/repo-registry.js";

let repo: string;

function git(args: string[], cwd = repo): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).toString();
}

function entry(root: string): ProtectedRootEntry {
  return {
    root,
    repo_name: "tmp",
    role: "test",
    intended_canonical_branch: "main",
    dirty_severity: "critical",
    block_builds_without_lease: true,
  };
}

function allocate(over: Partial<Parameters<typeof allocateWorktree>[0]> = {}) {
  return allocateWorktree({
    dispatch_id: "phid:disp-abc12345",
    agent_id: "roger",
    repo,
    protected: entry(repo),
    remote: "origin",
    base: "main",
    branch: "feat-x",
    skip_fetch: true,
    ...over,
  });
}

beforeEach(() => {
  repo = mkdtempSync(path.join(tmpdir(), "toss2-"));
  execFileSync("git", ["init", "-b", "main", repo]);
  git(["config", "user.email", "t@t.dev"]);
  git(["config", "user.name", "t"]);
  writeFileSync(path.join(repo, "README.md"), "hi\n");
  git(["add", "."]);
  git(["commit", "-m", "init"]);
});

afterEach(() => {
  try {
    rmSync(repo, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

describe("allocateWorktree — clean allocation", () => {
  it("creates a worktree under .worktrees/ and never touches the protected root", () => {
    const before = gitStatusPorcelain(repo);
    const r = allocate();
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.lease.worktree_path.startsWith(path.join(repo, ".worktrees") + path.sep)).toBe(true);
    expect(existsSync(r.lease.worktree_path)).toBe(true);
    expect(r.lease.branch).toBe("feat-x");
    expect(r.lease.base_sha).toBeTruthy();
    expect(r.lease.protected_root_status_before).toBe(before);
    // Allocating the worktree did NOT dirty the canonical root (ignoring the
    // manager's own .worktrees/ custody dir).
    expect(protectedRootStatus(repo)).toBe(before);
    // The protected root is still on main, not the feature branch.
    expect(git(["rev-parse", "--abbrev-ref", "HEAD"]).trim()).toBe("main");
  });
});

describe("allocateWorktree — dirty protected-root refusal", () => {
  it("blocks when the protected root is dirty (no workspace_policy)", () => {
    writeFileSync(path.join(repo, "uncommitted.txt"), "wip\n");
    const r = allocate();
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.decision.code).toBe("blocked_dirty_protected_root");
    expect(r.decision.status_short).toContain("uncommitted.txt");
  });

  it("proceeds with workspace_policy=reconcile_dirty_root", () => {
    writeFileSync(path.join(repo, "uncommitted.txt"), "wip\n");
    const r = allocate({ workspace_policy: "reconcile_dirty_root" });
    expect(r.ok).toBe(true);
  });
});

describe("allocateWorktree — branch-in-use refusal", () => {
  it("blocks a second allocation of a branch already in another worktree", () => {
    const first = allocate();
    expect(first.ok).toBe(true);
    // A different dispatch asking for the SAME branch must be refused, not reset.
    const second = allocate({ dispatch_id: "phid:disp-def67890" });
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.decision.code).toBe("branch_conflict");
    expect(second.decision.conflict_worktree).toBeTruthy();
    // The canonical root is still clean + on main.
    expect(protectedRootStatus(repo)).toBe("");
    expect(git(["rev-parse", "--abbrev-ref", "HEAD"]).trim()).toBe("main");
  });
});

describe("protected-root mutation detection at closeout", () => {
  it("flags protected_root_dirty_after when the agent dirties the canonical root", () => {
    const r = allocate();
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // Simulate an agent that wrongly wrote into the protected root.
    writeFileSync(path.join(repo, "leaked.txt"), "oops\n");
    const after = gitStatusPorcelain(repo);

    const v = validateWorkspaceCloseout(
      r.lease,
      {
        lease_id: r.lease.lease_id,
        worktree_path: r.lease.worktree_path,
        protected_root: r.lease.protected_root,
        protected_root_status_before: r.lease.protected_root_status_before,
        protected_root_status_after: after,
        worktree_status_after: "",
        cleanup_action: "kept_for_review",
      },
      { dispatchSucceeded: true },
    );
    expect(v.ok).toBe(false);
    expect(v.code).toBe("protected_root_dirty_after");
    expect(v.protected_root_diff?.some((l) => l.includes("leaked.txt"))).toBe(true);
  });
});
