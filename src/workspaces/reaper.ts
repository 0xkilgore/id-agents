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
//   3. it has no uncommitted changes, including untracked files.
// Anything ahead of base, detached, or carrying tracked edits is KEPT. This is
// conservative by construction: an in-flight build either has committed work
// (ahead > 0 → kept) or uncommitted work (tracked-dirty → kept).

import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { listWorktrees, stripWorktreeNoise } from "./allocator.js";

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

function dirSizeBytes(dir: string): number {
  try {
    const out = execFileSync("du", ["-sk", dir], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).toString();
    const kib = Number(out.trim().split(/\s+/)[0]);
    return Number.isFinite(kib) ? kib * 1024 : 0;
  } catch {
    return 0;
  }
}

/** Any porcelain entry is dirty for cleanup purposes, including untracked files. */
function dirtyLines(porcelain: string): string[] {
  return stripWorktreeNoise(porcelain)
    .split("\n")
    .map((l) => l.trimEnd())
    .filter((l) => l.length > 0);
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
export type ReapCandidateKind = "linked_worktree" | "sibling_clone";

export interface ReapedWorktree {
  path: string;
  branch: string | null;
  kind: ReapCandidateKind;
  action: ReapAction;
  reason: string;
  clean: boolean;
  merged: boolean | null;
  reclaimable_bytes: number;
}

export interface ReapResult {
  schema_version: "worktree-cleanup.v2";
  protected_root: string;
  base: string;
  dry_run: boolean;
  scanned: number;
  removed: number;
  kept: number;
  would_remove: number;
  bytes_reclaimed: number;
  bytes_reclaimable_dry_run: number;
  worktrees: ReapedWorktree[];
}

export interface ReapOptions {
  /** Base branch to measure "merged" against. Default "main". */
  base?: string;
  /** Also reap sibling `<repo>-*` worktrees (not under `.worktrees/`). Default true. */
  includeSiblings?: boolean;
  /** Report what WOULD be removed without removing. Default false. */
  dryRun?: boolean;
  /** Restrict sibling clone cleanup to clones whose origin URL matches the protected root. Default true. */
  sameOriginOnly?: boolean;
}

interface ReapCandidate {
  path: string;
  branch: string | null;
  kind: ReapCandidateKind;
}

function currentBranch(repo: string): string | null {
  const r = gitSafe(["rev-parse", "--abbrev-ref", "HEAD"], repo);
  if (!r.ok) return null;
  const branch = r.out.trim();
  return branch === "HEAD" ? null : branch;
}

function remoteOrigin(repo: string): string | null {
  const r = gitSafe(["config", "--get", "remote.origin.url"], repo);
  if (!r.ok) return null;
  const url = r.out.trim();
  return url.length > 0 ? url : null;
}

function resolveBaseRef(repo: string, base: string): string | null {
  if (gitSafe(["rev-parse", "--verify", base], repo).ok) return base;
  const originBase = `origin/${base}`;
  if (gitSafe(["rev-parse", "--verify", originBase], repo).ok) return originBase;
  return null;
}

function discoverSiblingClones(root: string, rootOrigin: string | null, sameOriginOnly: boolean): ReapCandidate[] {
  const parent = path.dirname(root);
  const prefix = `${path.basename(root)}-`;
  let entries: string[] = [];
  try {
    entries = readdirSync(parent);
  } catch {
    return [];
  }

  return entries
    .filter((name) => name.startsWith(prefix))
    .map((name) => path.join(parent, name))
    .filter((candidate) => {
      if (path.resolve(candidate) === root) return false;
      try {
        if (!lstatSync(candidate).isDirectory()) return false;
      } catch {
        return false;
      }
      const gitDir = path.join(candidate, ".git");
      if (!existsSync(gitDir) || !lstatSync(gitDir).isDirectory()) return false;
      if (sameOriginOnly) {
        if (!rootOrigin) return false;
        if (remoteOrigin(candidate) !== rootOrigin) return false;
      }
      return true;
    })
    .map((candidate) => ({
      path: path.resolve(candidate),
      branch: currentBranch(candidate),
      kind: "sibling_clone" as const,
    }));
}

export function discoverCleanupCandidates(protectedRoot: string, opts: ReapOptions = {}): ReapCandidate[] {
  const root = path.resolve(protectedRoot);
  const includeSiblings = opts.includeSiblings !== false;
  const sameOriginOnly = opts.sameOriginOnly !== false;
  const rootOrigin = remoteOrigin(root);
  const candidates = new Map<string, ReapCandidate>();

  for (const wt of listWorktrees(root)) {
    const wtPath = path.resolve(wt.path);
    if (!isLinkedWorktreeDir(wtPath)) continue;
    const underCustody = wtPath.split(path.sep).includes(".worktrees");
    if (!underCustody && !includeSiblings) continue;
    candidates.set(wtPath, { path: wtPath, branch: wt.branch, kind: "linked_worktree" });
  }

  if (includeSiblings) {
    for (const clone of discoverSiblingClones(root, rootOrigin, sameOriginOnly)) {
      candidates.set(clone.path, clone);
    }
  }

  return [...candidates.values()].sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * Reap merged + clean worktrees of a protected root. Pure-ish: all side effects
 * are `git worktree remove`/`prune` on already-merged, tracked-clean worktrees.
 */
export function reapMergedWorktrees(protectedRoot: string, opts: ReapOptions = {}): ReapResult {
  const root = path.resolve(protectedRoot);
  const base = opts.base ?? "main";
  const dryRun = opts.dryRun === true;

  const result: ReapResult = {
    schema_version: "worktree-cleanup.v2",
    protected_root: root,
    base,
    dry_run: dryRun,
    scanned: 0,
    removed: 0,
    kept: 0,
    would_remove: 0,
    bytes_reclaimed: 0,
    bytes_reclaimable_dry_run: 0,
    worktrees: [],
  };

  // Base must resolve, or "merged" is undefined and we reap nothing.
  if (!resolveBaseRef(root, base)) {
    return result;
  }

  for (const wt of discoverCleanupCandidates(root, opts)) {
    const wtPath = wt.path;
    result.scanned++;

    const record = (action: ReapAction, reason: string, clean: boolean, merged: boolean | null, reclaimableBytes = 0) => {
      result.worktrees.push({
        path: wtPath,
        branch: wt.branch,
        kind: wt.kind,
        action,
        reason,
        clean,
        merged,
        reclaimable_bytes: reclaimableBytes,
      });
      if (action === "removed") {
        result.removed++;
        result.bytes_reclaimed += reclaimableBytes;
      } else if (action === "would_remove") {
        result.would_remove++;
        result.kept++;
        result.bytes_reclaimable_dry_run += reclaimableBytes;
      } else {
        result.kept++;
      }
    };

    if (!wt.branch) {
      record("kept", "detached HEAD — not provably merged", false, null);
      continue;
    }
    const status = gitSafe(["status", "--porcelain=v1", "--untracked-files=all", "--ignored=matching"], wtPath);
    if (!status.ok) {
      record("kept", "could not read worktree status", false, null);
      continue;
    }
    const dirty = dirtyLines(status.out);
    if (dirty.length > 0) {
      record("kept", `${dirty.length} uncommitted change(s)`, false, null);
      continue;
    }
    const baseRef = wt.kind === "sibling_clone" ? resolveBaseRef(wtPath, base) : resolveBaseRef(root, base);
    if (!baseRef) {
      record("kept", "could not resolve base", true, null);
      continue;
    }
    const merged = isMerged(wt.kind === "sibling_clone" ? wtPath : root, baseRef, wt.branch);
    if (merged === null) {
      record("kept", "could not compare against base", true, null);
      continue;
    }
    if (!merged) {
      record("kept", `unmerged: branch not an ancestor of ${baseRef}`, true, false);
      continue;
    }

    const reclaimableBytes = dirSizeBytes(wtPath);
    if (dryRun) {
      record("would_remove", `merged into ${baseRef}, clean`, true, true, reclaimableBytes);
      continue;
    }
    let removed = false;
    let removeError = "";
    if (wt.kind === "linked_worktree") {
      const rm = gitSafe(["worktree", "remove", wtPath], root);
      removed = rm.ok;
      removeError = rm.out;
    } else {
      try {
        rmSync(wtPath, { recursive: true, force: false });
        removed = true;
      } catch (err) {
        removeError = err instanceof Error ? err.message : String(err);
      }
    }
    if (removed) {
      record("removed", `merged into ${baseRef}, clean`, true, true, reclaimableBytes);
    } else {
      record("kept", `remove failed: ${removeError.split("\n")[0]}`, true, true);
    }
  }

  if (!dryRun && result.removed > 0) {
    gitSafe(["worktree", "prune"], root);
  }
  return result;
}
