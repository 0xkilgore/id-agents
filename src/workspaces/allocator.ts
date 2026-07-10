// T-OSS.2 — Workspace allocator.
//
// Allocates (or validates) a git worktree for a build dispatch so the agent
// writes ONLY inside `<protected_root>/.worktrees/<lease-slug>`, never the
// canonical root. Splits into:
//   - PURE decision logic (`decideAdmission`, path/id generation) — unit-tested.
//   - GIT-backed allocation (`allocateWorktree`) — temp-repo integration-tested.
//
// Never destructively resets an existing branch in the protected root, and never
// checks a build branch out in the protected root itself (spec §"Allocation
// Rules"). Divergent/conflicting branch state blocks rather than forcing.

import { execFileSync } from "node:child_process";
import { writeFileSync, readFileSync, existsSync, mkdirSync, chmodSync } from "node:fs";
import path from "node:path";
import type { ProtectedRootEntry } from "./repo-registry.js";
import type { WorkspaceLease } from "../dispatch-scheduler/types.js";
import {
  ATTRIBUTION_MARKER_FILE,
  HOOK_SENTINEL,
  buildPrepareCommitMsgHook,
  sanitizeAgentName,
} from "../lib/agent-attribution.js";

export type WorkspacePolicy = "default" | "reconcile_dirty_root";

export type AdmissionCode =
  | "ok"
  | "blocked_dirty_protected_root"
  | "stale_base"
  | "needs_clarification"
  | "branch_conflict"
  | "no_protected_root"
  | "is_protected_root";

export interface AdmissionDecision {
  ok: boolean;
  code: AdmissionCode;
  reason: string;
  /** Exact `git status --short` of the protected root when relevant. */
  status_short?: string;
  /** The conflicting worktree path when code === "branch_conflict". */
  conflict_worktree?: string;
}

export interface AdmissionInput {
  /** `git status --porcelain=v1` of the protected root (empty = clean). */
  protected_root_status: string;
  /** `git status --short` of the protected root for human-readable evidence. */
  protected_root_status_short?: string;
  /** Explicit policy from the dispatch; `reconcile_dirty_root` allows a dirty root. */
  workspace_policy?: WorkspacePolicy;
  /**
   * When the requested branch is already checked out in ANOTHER live worktree,
   * its path + the lease that owns it (if any). Reuse only when the existing
   * lease id matches `requested_lease_id`.
   */
  branch_conflict?: { worktree_path: string; lease_id?: string | null } | null;
  stale_base?: { branch: string; base_ref: string; behind: number; threshold: number } | null;
  requested_lease_id?: string | null;
}

/**
 * Pure admission decision for a build dispatch (spec §"Allocation Rules" 3, 6).
 * Order: dirty-root block → stale-base block → branch conflict → ok.
 */
export function decideAdmission(input: AdmissionInput): AdmissionDecision {
  const dirty = input.protected_root_status.trim().length > 0;
  if (dirty && input.workspace_policy !== "reconcile_dirty_root") {
    return {
      ok: false,
      code: "blocked_dirty_protected_root",
      reason: "protected root is dirty; declare workspace_policy=reconcile_dirty_root to proceed",
      status_short: input.protected_root_status_short ?? input.protected_root_status,
    };
  }
  if (input.stale_base && input.stale_base.behind > input.stale_base.threshold) {
    return {
      ok: false,
      code: "stale_base",
      reason: `stale-base: branch ${input.stale_base.branch} is ${input.stale_base.behind} commits behind ${input.stale_base.base_ref}; suggested remediation=fresh-branch-off-origin-main; create a fresh branch off origin/main and reapply only the scoped work`,
    };
  }
  const conflict = input.branch_conflict;
  if (conflict) {
    const sameLease =
      !!input.requested_lease_id && conflict.lease_id != null && conflict.lease_id === input.requested_lease_id;
    if (!sameLease) {
      return {
        ok: false,
        code: "branch_conflict",
        reason: `branch already checked out in another worktree: ${conflict.worktree_path}`,
        conflict_worktree: conflict.worktree_path,
      };
    }
  }
  return { ok: true, code: "ok", reason: "admitted" };
}

/** A filesystem-safe slug of a branch name. */
export function branchSlug(branch: string): string {
  return branch
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "branch";
}

/** Short, stable form of a dispatch id for path/lease naming. */
export function dispatchShort(dispatchId: string): string {
  const cleaned = dispatchId.replace(/^phid:disp-/, "").replace(/[^a-zA-Z0-9]+/g, "");
  return cleaned.slice(0, 8) || "dispatch";
}

/**
 * Default leased worktree path:
 *   <protected_root>/.worktrees/<agent>-<dispatch-short>-<branch-slug>
 */
export function leaseWorktreePath(
  protectedRoot: string,
  agent: string,
  dispatchId: string,
  branch: string,
): string {
  const name = `${agent}-${dispatchShort(dispatchId)}-${branchSlug(branch)}`;
  return path.join(path.resolve(protectedRoot), ".worktrees", name);
}

/** Stable lease id derived from dispatch + agent + branch. */
export function mintLeaseId(dispatchId: string, agent: string, branch: string): string {
  return `wsl_${dispatchShort(dispatchId)}_${agent}_${branchSlug(branch)}`;
}

// ── Git-backed helpers ───────────────────────────────────────────────

function git(args: string[], cwd?: string): string {
  return execFileSync("git", cwd ? ["-C", cwd, ...args] : args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).toString();
}

function gitSafe(args: string[], cwd?: string): { ok: boolean; out: string } {
  try {
    return { ok: true, out: git(args, cwd) };
  } catch (err: any) {
    return { ok: false, out: String(err?.stderr ?? err?.message ?? err) };
  }
}

export function gitStatusPorcelain(root: string): string {
  return gitSafe(["status", "--porcelain=v1"], root).out.replace(/\s+$/, "");
}

export function gitStatusShort(root: string): string {
  return gitSafe(["status", "--short", "--branch"], root).out.replace(/\s+$/, "");
}

/**
 * Strip the manager's OWN worktree custody infra (`.worktrees/`) from a status
 * blob. Our leased worktrees live under `<protected_root>/.worktrees/`; when that
 * dir is not gitignored, git reports it as `?? .worktrees/`. That is custody
 * infrastructure, never user content, so it must not count as "dirtying" the
 * protected root for admission/closeout/monitor purposes.
 */
export function stripWorktreeNoise(status: string): string {
  return status
    .split("\n")
    .filter((l) => !/(^|\s)\.worktrees(\/|$)/.test(l) && !/\.worktrees\//.test(l))
    .join("\n")
    .replace(/\s+$/, "");
}

/** Protected-root porcelain status with worktree custody noise removed. */
export function protectedRootStatus(root: string): string {
  return stripWorktreeNoise(gitStatusPorcelain(root));
}

export function gitHeadSha(root: string): string | null {
  const r = gitSafe(["rev-parse", "HEAD"], root);
  return r.ok ? r.out.trim() : null;
}

export function gitCurrentBranch(root: string): string | null {
  const r = gitSafe(["rev-parse", "--abbrev-ref", "HEAD"], root);
  if (!r.ok) return null;
  const b = r.out.trim();
  return b === "HEAD" ? null : b; // detached
}

/** ahead/behind of HEAD relative to `upstream` (e.g. "origin/main"). */
export function gitAheadBehind(root: string, upstream: string): { ahead: number; behind: number } | null {
  return gitRefAheadBehind(root, "HEAD", upstream);
}

/** ahead/behind of `ref` relative to `upstream` (e.g. branch vs "origin/main"). */
export function gitRefAheadBehind(root: string, ref: string, upstream: string): { ahead: number; behind: number } | null {
  const r = gitSafe(["rev-list", "--left-right", "--count", `${upstream}...${ref}`], root);
  if (!r.ok) return null;
  const m = r.out.trim().split(/\s+/);
  if (m.length < 2) return null;
  const behind = Number(m[0]);
  const ahead = Number(m[1]);
  return Number.isFinite(ahead) && Number.isFinite(behind) ? { ahead, behind } : null;
}

export function gitFetch(root: string, remote: string): boolean {
  return gitSafe(["fetch", remote], root).ok;
}

export interface WorktreeEntry {
  path: string;
  branch: string | null;
}

/** Parse `git worktree list --porcelain` into {path, branch} entries. */
export function listWorktrees(root: string): WorktreeEntry[] {
  const out = gitSafe(["worktree", "list", "--porcelain"], root).out;
  const entries: WorktreeEntry[] = [];
  let cur: Partial<WorktreeEntry> = {};
  for (const line of out.split("\n")) {
    if (line.startsWith("worktree ")) {
      if (cur.path) entries.push({ path: cur.path, branch: cur.branch ?? null });
      cur = { path: line.slice("worktree ".length).trim() };
    } else if (line.startsWith("branch ")) {
      cur.branch = line.slice("branch ".length).trim().replace(/^refs\/heads\//, "");
    }
  }
  if (cur.path) entries.push({ path: cur.path, branch: cur.branch ?? null });
  return entries;
}

/** Find a live worktree (other than the protected root) holding `branch`. */
export function findBranchWorktree(root: string, branch: string): WorktreeEntry | null {
  const normRoot = path.resolve(root);
  for (const wt of listWorktrees(root)) {
    if (wt.branch === branch && path.resolve(wt.path) !== normRoot) return wt;
  }
  return null;
}

/**
 * Install by-agent commit attribution for a freshly-allocated worktree.
 *
 * Two pieces, both invisible to `git status` (they live under `.git/`):
 *   - A marker file `<worktree-git-dir>/agent-attribution` holding the agent
 *     name. Per-worktree, so the protected root and other worktrees are
 *     unaffected.
 *   - A `prepare-commit-msg` hook in the SHARED (common) hooks dir that reads
 *     that marker and appends an `Agent: <name>` trailer. Linked worktrees
 *     share the common hooks dir, so one install covers them all; the hook is a
 *     strict no-op anywhere there is no marker (e.g. the protected root).
 *
 * Best-effort: any failure is swallowed so attribution never blocks a build.
 * A pre-existing foreign hook is left untouched (we only manage our own,
 * recognized by the embedded sentinel).
 */
export function installAgentAttribution(
  worktreePath: string,
  protectedRoot: string,
  agentId: string,
): void {
  try {
    const agent = sanitizeAgentName(agentId);
    if (!agent) return;

    const worktreeGitDir = gitSafe(["rev-parse", "--absolute-git-dir"], worktreePath);
    if (!worktreeGitDir.ok) return;
    const markerPath = path.join(worktreeGitDir.out.trim(), ATTRIBUTION_MARKER_FILE);
    writeFileSync(markerPath, `${agent}\n`, "utf8");

    const hooksPathOut = gitSafe(["rev-parse", "--git-path", "hooks"], protectedRoot);
    if (!hooksPathOut.ok) return;
    const raw = hooksPathOut.out.trim();
    const hooksDir = path.isAbsolute(raw) ? raw : path.resolve(protectedRoot, raw);
    const hookPath = path.join(hooksDir, "prepare-commit-msg");

    if (existsSync(hookPath)) {
      // Only (re)write a hook we own; never clobber a foreign one.
      const existing = readFileSync(hookPath, "utf8");
      if (!existing.includes(HOOK_SENTINEL)) return;
    } else {
      mkdirSync(hooksDir, { recursive: true });
    }
    writeFileSync(hookPath, buildPrepareCommitMsgHook(), "utf8");
    chmodSync(hookPath, 0o755);
  } catch {
    /* best effort — attribution must never break allocation */
  }
}

export interface AllocateInput {
  dispatch_id: string;
  agent_id: string;
  repo: string;
  protected: ProtectedRootEntry;
  remote: string;
  base: string;
  branch: string;
  workspace_policy?: WorkspacePolicy;
  /** Skip the network fetch (tests / offline). Default false. */
  skip_fetch?: boolean;
  /** Lease id of an existing worktree we are allowed to reuse. */
  requested_lease_id?: string | null;
  /** Existing branches more than this many commits behind base are refused. Default 20. */
  stale_base_behind_threshold?: number;
}

export type AllocateResult =
  | { ok: true; lease: WorkspaceLease }
  | { ok: false; decision: AdmissionDecision };

/**
 * Allocate (or validate+reuse) a worktree for a build dispatch and return the
 * WorkspaceLease. Blocks — never forces — on a dirty protected root or a branch
 * already checked out elsewhere. Snapshots protected-root + worktree status.
 */
export function allocateWorktree(input: AllocateInput): AllocateResult {
  const protectedRoot = path.resolve(input.protected.root);
  const baseRef = `${input.remote}/${input.base}`;
  const staleThreshold = input.stale_base_behind_threshold ?? 20;

  // 1-2. Snapshot the protected root status BEFORE any mutation. Strip our own
  // `.worktrees/` custody infra so it never counts as dirtying the root.
  const protectedStatus = stripWorktreeNoise(gitStatusPorcelain(protectedRoot));
  const protectedStatusShort = stripWorktreeNoise(gitStatusShort(protectedRoot));

  // 4. Fetch the remote (best-effort; offline tests skip).
  if (!input.skip_fetch) gitSafe(["fetch", input.remote], protectedRoot);

  const existingBranch = gitSafe(["rev-parse", "--verify", "--quiet", input.branch], protectedRoot).ok;
  const staleBase = existingBranch
    ? (() => {
        const ab = gitRefAheadBehind(protectedRoot, input.branch, baseRef);
        return ab && ab.behind > staleThreshold
          ? { branch: input.branch, base_ref: baseRef, behind: ab.behind, threshold: staleThreshold }
          : null;
      })()
    : null;

  // 6. Branch already checked out in another live worktree?
  const conflict = findBranchWorktree(protectedRoot, input.branch);

  // 3 + 6. Admission decision.
  const decision = decideAdmission({
    protected_root_status: protectedStatus,
    protected_root_status_short: protectedStatusShort,
    workspace_policy: input.workspace_policy,
    stale_base: staleBase,
    branch_conflict: conflict ? { worktree_path: conflict.path, lease_id: null } : null,
    requested_lease_id: input.requested_lease_id ?? null,
  });
  if (!decision.ok) return { ok: false, decision };

  const worktreePath = leaseWorktreePath(protectedRoot, input.agent_id, input.dispatch_id, input.branch);
  const baseSha = (() => {
    const r = gitSafe(["rev-parse", baseRef], protectedRoot);
    if (r.ok) return r.out.trim();
    const local = gitSafe(["rev-parse", input.base], protectedRoot);
    return local.ok ? local.out.trim() : null;
  })();

  // 5 + 7. Create the worktree off <remote>/<base> WITHOUT touching the
  // protected root's working tree. `-B` creates/resets the branch in the NEW
  // worktree only. Prefer remote base; fall back to local base when offline.
  const startPoint = baseSha ?? baseRef;
  const add = gitSafe(["worktree", "add", "-B", input.branch, worktreePath, startPoint], protectedRoot);
  if (!add.ok) {
    // Fall back to the local base ref if the remote ref was unavailable.
    const add2 = gitSafe(["worktree", "add", "-B", input.branch, worktreePath, input.base], protectedRoot);
    if (!add2.ok) {
      return {
        ok: false,
        decision: {
          ok: false,
          code: "needs_clarification",
          reason: `worktree add failed: ${add.out.split("\n")[0]} / ${add2.out.split("\n")[0]}`,
        },
      };
    }
  }

  // 7b. Install by-agent commit attribution (best-effort; never blocks
  // allocation). Writes a per-worktree marker + a shared prepare-commit-msg
  // hook so commits made in this worktree carry an `Agent: <name>` trailer and
  // commit-stats.py can slice by agent.
  installAgentAttribution(worktreePath, protectedRoot, input.agent_id);

  // 8. Snapshot worktree + record source sha.
  const worktreeStatus = gitStatusPorcelain(worktreePath);
  const sourceShaBefore = gitHeadSha(worktreePath);

  const lease: WorkspaceLease = {
    lease_id: input.requested_lease_id ?? mintLeaseId(input.dispatch_id, input.agent_id, input.branch),
    dispatch_id: input.dispatch_id,
    agent_id: input.agent_id,
    repo: path.resolve(input.repo),
    protected_root: protectedRoot,
    worktree_path: worktreePath,
    remote: input.remote,
    base: input.base,
    branch: input.branch,
    base_sha: baseSha,
    source_sha_before: sourceShaBefore,
    protected_root_status_before: protectedStatus,
    worktree_status_before: worktreeStatus,
    created_at: new Date().toISOString(),
    state: "active",
  };
  return { ok: true, lease };
}
