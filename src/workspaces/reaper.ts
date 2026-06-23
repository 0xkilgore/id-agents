// T-OSS.2 — Worktree reaper.
//
// Build dispatches create git worktrees (under `<protected_root>/.worktrees/`
// and, historically, as sibling `<repo>-*` checkouts) but nothing tore them
// down, so they accumulated — 50 stale worktrees holding 142 weeks-old .md
// artifacts that the filesystem reconciler then resurfaced as "landed today"
// (P0 worktree-explosion).
//
// The reaper removes a worktree ONLY when it is provably safe:
//   1. it is NOT the protected (canonical) root itself, and
//   2. its branch is fully merged into the base (no unique commits), and
//   3. it has no uncommitted TRACKED changes (untracked node_modules/.worktrees
//      noise is ignored — that is disposable build detritus).
// Anything ahead of base, detached, or carrying tracked edits is KEPT. This is
// conservative by construction: an in-flight build either has committed work
// (ahead > 0 → kept) or uncommitted work (tracked-dirty → kept).

import { execFileSync } from "node:child_process";
import { lstatSync } from "node:fs";
import path from "node:path";
import { listWorktrees, stripWorktreeNoise, type WorktreeEntry } from "./allocator.js";

/**
 * A linked (non-canonical) worktree has a `.git` FILE (gitdir pointer); the
 * canonical checkout has a `.git` DIRECTORY. We only ever reap linked
 * worktrees — this is also robust where a path-equality check against the root
 * would fail (e.g. macOS `/var` ↔ `/private/var` symlink resolution).
 */
function isLinkedWorktreeDir(dir: string): boolean {
  try {
    return lstatSync(path.join(dir, ".git")).isFile();
  } catch {
    return false;
  }
}

function gitSafe(args: string[], cwd?: string): { ok: boolean; out: string } {
  try {
    return {
      ok: true,
      out: execFileSync("git", cwd ? ["-C", cwd, ...args] : args, {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }).toString(),
    };
  } catch (err: any) {
    return { ok: false, out: String(err?.stderr ?? err?.message ?? err) };
  }
}

/** Drop untracked dependency/custody detritus from a porcelain status blob. */
function trackedDirtyLines(porcelain: string): string[] {
  return stripWorktreeNoise(porcelain)
    .split("\n")
    .map((l) => l.trimEnd())
    .filter((l) => l.length > 0)
    // `?? .../node_modules` (and the dir entry itself) is disposable.
    .filter((l) => !/^\?\?\s+.*node_modules(\/|$)/.test(l));
}

/**
 * A branch is "merged" when its tip is an ANCESTOR of base — i.e. every commit
 * on the branch is already reachable from base (fast-forward or merge-commit
 * integration). This is the conservative, correct signal: it is impossible for
 * an ancestor branch to carry unique work. (We deliberately do NOT try to infer
 * squash-merges by patch-id — that is unreliable when a squash commit bundles
 * multiple files, and erring toward "not merged" keeps a worktree, the safe
 * direction.)
 */
function isMerged(protectedRoot: string, base: string, branch: string): boolean | null {
  const r = gitSafe(["merge-base", "--is-ancestor", branch, base], protectedRoot);
  // execFileSync throws on non-zero exit; gitSafe maps that to ok:false. But a
  // genuine git error (bad ref) also yields ok:false — distinguish via stderr.
  if (r.ok) return true;
  if (/Not a valid|unknown revision|bad revision/i.test(r.out)) return null;
  return false; // clean non-zero exit = not an ancestor = not merged
}

export type ReapAction = "removed" | "kept" | "would_remove";

export interface ReapedWorktree {
  path: string;
  branch: string | null;
  action: ReapAction;
  reason: string;
}

export interface ReapResult {
  protected_root: string;
  base: string;
  scanned: number;
  removed: number;
  kept: number;
  worktrees: ReapedWorktree[];
}

export interface ReapOptions {
  /** Base branch to measure "merged" against. Default "main". */
  base?: string;
  /** Also reap sibling `<repo>-*` worktrees (not under `.worktrees/`). Default true. */
  includeSiblings?: boolean;
  /** Report what WOULD be removed without removing. Default false. */
  dryRun?: boolean;
}

/**
 * Reap merged + clean worktrees of a protected root. Pure-ish: all side effects
 * are `git worktree remove`/`prune` on already-merged, tracked-clean worktrees.
 */
export function reapMergedWorktrees(protectedRoot: string, opts: ReapOptions = {}): ReapResult {
  const root = path.resolve(protectedRoot);
  const base = opts.base ?? "main";
  const includeSiblings = opts.includeSiblings !== false;
  const dryRun = opts.dryRun === true;

  const result: ReapResult = {
    protected_root: root,
    base,
    scanned: 0,
    removed: 0,
    kept: 0,
    worktrees: [],
  };

  // Base must resolve, or "merged" is undefined and we reap nothing.
  if (!gitSafe(["rev-parse", "--verify", base], root).ok) {
    return result;
  }

  const worktrees: WorktreeEntry[] = listWorktrees(root);
  for (const wt of worktrees) {
    const wtPath = path.resolve(wt.path);
    // Only linked worktrees are reapable; the canonical checkout (`.git` is a
    // directory) is never touched. Robust against /var↔/private/var symlinks.
    if (!isLinkedWorktreeDir(wtPath)) continue;
    const underCustody = wtPath.split(path.sep).includes(".worktrees");
    if (!underCustody && !includeSiblings) continue;
    result.scanned++;

    const record = (action: ReapAction, reason: string) => {
      result.worktrees.push({ path: wtPath, branch: wt.branch, action, reason });
      if (action === "removed") result.removed++;
      else result.kept++;
    };

    if (!wt.branch) {
      record("kept", "detached HEAD — not provably merged");
      continue;
    }
    const status = gitSafe(["status", "--porcelain=v1"], wtPath);
    if (!status.ok) {
      record("kept", "could not read worktree status");
      continue;
    }
    const dirty = trackedDirtyLines(status.out);
    if (dirty.length > 0) {
      record("kept", `${dirty.length} uncommitted tracked change(s)`);
      continue;
    }
    const merged = isMerged(root, base, wt.branch);
    if (merged === null) {
      record("kept", "could not compare against base");
      continue;
    }
    if (!merged) {
      record("kept", `unmerged: branch not an ancestor of ${base}`);
      continue;
    }

    // Merged + tracked-clean → safe to remove. `--force` only discards the
    // untracked node_modules/build detritus we already vetted as disposable.
    if (dryRun) {
      record("would_remove", `merged into ${base}, tracked-clean`);
      continue;
    }
    const rm = gitSafe(["worktree", "remove", "--force", wtPath], root);
    if (rm.ok) {
      record("removed", `merged into ${base}, tracked-clean`);
    } else {
      record("kept", `git worktree remove failed: ${rm.out.split("\n")[0]}`);
    }
  }

  if (!dryRun && result.removed > 0) {
    gitSafe(["worktree", "prune"], root);
  }
  return result;
}
