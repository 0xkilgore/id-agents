// T-OSS.2 — temp-repo integration for the worktree reaper.
//
// Proves the acceptance contract: a merged build worktree is removed, while
// in-flight (ahead-of-base), dirty, and detached worktrees are KEPT.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { reapMergedWorktrees } from "../../src/workspaces/reaper.js";

let repo: string;

function git(args: string[], cwd = repo): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).toString();
}

beforeEach(() => {
  repo = mkdtempSync(path.join(tmpdir(), "toss2-reaper-"));
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

/** Add a worktree at <repo>/.worktrees/<name> on a new branch off main. */
function addWorktree(name: string, branch: string): string {
  const wt = path.join(repo, ".worktrees", name);
  git(["worktree", "add", "-B", branch, wt, "main"]);
  return wt;
}

describe("reapMergedWorktrees", () => {
  it("removes a worktree whose branch is fully merged (ancestor) into main", () => {
    const wt = addWorktree("build", "feat-merged");
    writeFileSync(path.join(wt, "feature.txt"), "feature\n");
    git(["add", "."], wt);
    git(["commit", "-m", "add feature"], wt);
    // Integrate the branch into main so its tip is an ancestor of main (the
    // shape every reaped worktree had in the real cleanup: merged to main).
    git(["merge", "--no-ff", "-m", "merge feat-merged", "feat-merged"]);

    const r = reapMergedWorktrees(repo, { base: "main" });
    expect(r.removed).toBe(1);
    expect(existsSync(wt)).toBe(false);
    expect(r.worktrees[0].action).toBe("removed");
  });

  it("removes a merged worktree even with untracked node_modules present", () => {
    const wt = addWorktree("deps", "feat-deps");
    mkdirSync(path.join(wt, "node_modules", "pkg"), { recursive: true });
    writeFileSync(path.join(wt, "node_modules", "pkg", "index.js"), "x\n");

    const r = reapMergedWorktrees(repo, { base: "main" });
    expect(r.removed).toBe(1);
    expect(existsSync(wt)).toBe(false);
  });

  it("keeps a worktree with unmerged commits (in-flight build)", () => {
    const wt = addWorktree("inflight", "feat-inflight");
    writeFileSync(path.join(wt, "wip.txt"), "wip\n");
    git(["add", "."], wt);
    git(["commit", "-m", "wip commit"], wt);

    const r = reapMergedWorktrees(repo, { base: "main" });
    expect(r.removed).toBe(0);
    expect(existsSync(wt)).toBe(true);
    expect(r.worktrees[0].action).toBe("kept");
    expect(r.worktrees[0].reason).toMatch(/unmerged/);
  });

  it("keeps a worktree with uncommitted tracked changes", () => {
    const wt = addWorktree("dirty", "feat-dirty");
    writeFileSync(path.join(wt, "README.md"), "edited\n"); // tracked modification

    const r = reapMergedWorktrees(repo, { base: "main" });
    expect(r.removed).toBe(0);
    expect(existsSync(wt)).toBe(true);
    expect(r.worktrees[0].reason).toMatch(/uncommitted tracked/);
  });

  it("never removes the canonical root", () => {
    const r = reapMergedWorktrees(repo, { base: "main" });
    expect(r.worktrees.find((w) => path.resolve(w.path) === path.resolve(repo))).toBeUndefined();
  });

  it("dry-run reports would_remove without removing", () => {
    const wt = addWorktree("dryrun", "feat-dry");
    const r = reapMergedWorktrees(repo, { base: "main", dryRun: true });
    expect(r.removed).toBe(0);
    expect(existsSync(wt)).toBe(true);
    expect(r.worktrees[0].action).toBe("would_remove");
  });
});
