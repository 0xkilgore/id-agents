// P0 worktree-explosion: the filesystem reconciler must NEVER catalog artifacts
// living inside a git worktree — neither a `.worktrees/<name>/` build copy nor a
// working directory that is itself a non-canonical (linked) worktree. Stale
// worktree copies hold weeks-old .md files that were resurfacing as "landed".

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteAdapter } from "../../src/db/sqlite-adapter.js";
import { migrateOutputsTables } from "../../src/outputs/storage.js";
import {
  isLinkedWorktree,
  isUnderWorktreeCustody,
  reconcileFilesystemArtifacts,
} from "../../src/outputs/filesystem-reconciler.js";

const tmpRoots: string[] = [];

afterEach(() => {
  for (const root of tmpRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function mkWork(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "id-agents-wt-scope-"));
  tmpRoots.push(d);
  return d;
}

function write(base: string, rel: string, body = "# x\n"): void {
  const abs = path.join(base, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body);
}

describe("filesystem reconciler — worktree scoping", () => {
  it("catalogs the canonical output/ artifact but NOT the .worktrees/ copy", async () => {
    const adapter = new SqliteAdapter(":memory:");
    await migrateOutputsTables(adapter);
    const workDir = mkWork();
    write(workDir, "output/real-artifact.md");
    write(workDir, ".worktrees/old-build/output/stale-artifact.md");

    const result = await reconcileFilesystemArtifacts(adapter, {
      roots: [{ agent: "cto", workingDirectory: workDir }],
    });

    expect(result.inserted).toBe(1);
    expect(result.files_seen).toBe(1);
  });

  it("skips a working directory that is itself a linked worktree (.git is a file)", async () => {
    const adapter = new SqliteAdapter(":memory:");
    await migrateOutputsTables(adapter);
    const workDir = mkWork();
    // A linked worktree has a `.git` FILE pointing at the real gitdir.
    fs.writeFileSync(path.join(workDir, ".git"), "gitdir: /somewhere/.git/worktrees/x\n");
    write(workDir, "output/should-not-be-seen.md");

    const result = await reconcileFilesystemArtifacts(adapter, {
      roots: [{ agent: "cto", workingDirectory: workDir }],
    });

    expect(result.inserted).toBe(0);
    expect(result.skipped).toBeGreaterThan(0);
  });

  it("isLinkedWorktree distinguishes a .git file from a .git directory", () => {
    const d = mkWork();
    expect(isLinkedWorktree(d)).toBe(false); // no .git
    fs.mkdirSync(path.join(d, ".git"));
    expect(isLinkedWorktree(d)).toBe(false); // .git directory = canonical
    fs.rmSync(path.join(d, ".git"), { recursive: true });
    fs.writeFileSync(path.join(d, ".git"), "gitdir: x\n");
    expect(isLinkedWorktree(d)).toBe(true); // .git file = linked worktree
  });

  it("isUnderWorktreeCustody detects a .worktrees path segment", () => {
    expect(isUnderWorktreeCustody("/a/b/.worktrees/c")).toBe(true);
    expect(isUnderWorktreeCustody("/a/b/c")).toBe(false);
  });
});
