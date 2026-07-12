// T-OSS.2 — Protected canonical-checkout registry.
//
// The registry is the source of truth for which filesystem roots are
// "canonical/protected" — roots a build dispatch may READ but never mutate
// outside a workspace lease. A build dispatch's `repo` path is normalized and
// resolved to the protected root that contains it; the lease then writes only to
// a git worktree under `<protected_root>/.worktrees/`.
//
// The registry format is portable and safe for public examples — the real
// absolute paths for Chris/Liz machines live in a private overlay
// (`IDAGENTS_REPO_REGISTRY` JSON file or env), so public `kapelle` ships
// synthetic fixtures. See spec §"OSS Lift".

import { readFileSync } from "node:fs";
import path from "node:path";

export type ProtectedRootSeverity = "critical" | "warning" | "info";

export interface ProtectedRootEntry {
  /** Absolute canonical root path. */
  root: string;
  /** Short repo name for status surfaces. */
  repo_name: string;
  /** Role description (deploy/core vs planning/ops). */
  role: string;
  /**
   * The branch this root is INTENDED to sit on. Most are "main"; some canonical
   * checkouts are intentionally off-main today (recorded so a dirty off-main
   * root is still flagged but the intended branch is known).
   */
  intended_canonical_branch: string;
  /**
   * Severity when this root is dirty: deploy/core roots are `critical`,
   * planning/non-deploy roots are `warning`.
   */
  dirty_severity: Extract<ProtectedRootSeverity, "critical" | "warning">;
  /** When true, build dispatches may only run via a registered lease subpath. */
  block_builds_without_lease: boolean;
}

/**
 * Default protected roots (spec §"Protected Roots"). Absolute paths are the
 * Chris-machine canonical checkouts; a private overlay can replace these.
 */
export const DEFAULT_PROTECTED_ROOTS: ProtectedRootEntry[] = [
  {
    root: "/Users/kilgore/Dropbox/Code/cane/id-agents-deploy-main",
    repo_name: "id-agents-deploy-main",
    role: "public manager/runtime, clean launchd deploy checkout",
    intended_canonical_branch: "main",
    dirty_severity: "critical",
    block_builds_without_lease: true,
  },
  {
    root: "/Users/kilgore/Dropbox/Code/cane/id-agents",
    repo_name: "id-agents",
    role: "public manager/runtime source checkout",
    intended_canonical_branch: "main",
    dirty_severity: "critical",
    block_builds_without_lease: true,
  },
  {
    root: "/Users/kilgore/Dropbox/Code/kapelle-site",
    repo_name: "kapelle-site",
    role: "private console, Vercel/local ops checkout",
    intended_canonical_branch: "main",
    dirty_severity: "critical",
    block_builds_without_lease: true,
  },
  {
    root: "/Users/kilgore/Dropbox/Code/cane",
    repo_name: "cane",
    role: "taskview/ops SoT and future split source",
    intended_canonical_branch: "cane-tier-a-reconcile-stopgap",
    dirty_severity: "warning",
    block_builds_without_lease: true,
  },
  {
    root: "/Users/kilgore/Dropbox/Code/agent-platform",
    repo_name: "agent-platform",
    role: "private planning/research root",
    intended_canonical_branch: "inbox-docmodel-v0",
    dirty_severity: "warning",
    block_builds_without_lease: true,
  },
  {
    root: "/Users/kilgore/Dropbox/Code/kapelle",
    repo_name: "kapelle",
    role: "public monorepo target (canonical from day zero)",
    intended_canonical_branch: "main",
    dirty_severity: "critical",
    block_builds_without_lease: true,
  },
];

/** Normalize a path for containment checks (absolute, no trailing slash). */
export function normalizeRoot(p: string): string {
  const abs = path.resolve(p);
  return abs.length > 1 && abs.endsWith(path.sep) ? abs.slice(0, -1) : abs;
}

/** True when `child` is `root` or lives inside `root`. */
export function isWithin(root: string, child: string): boolean {
  const r = normalizeRoot(root);
  const c = normalizeRoot(child);
  if (c === r) return true;
  return c.startsWith(r + path.sep);
}

export class RepoRegistry {
  private readonly entries: ProtectedRootEntry[];

  constructor(entries: ProtectedRootEntry[] = DEFAULT_PROTECTED_ROOTS) {
    // Longest root first so the MOST specific protected root wins containment.
    this.entries = [...entries].sort((a, b) => normalizeRoot(b.root).length - normalizeRoot(a.root).length);
  }

  /** Load a registry from a private-overlay JSON file, falling back to defaults. */
  static load(env: NodeJS.ProcessEnv = process.env): RepoRegistry {
    const file = env.IDAGENTS_REPO_REGISTRY;
    if (file) {
      try {
        const raw = JSON.parse(readFileSync(file, "utf8"));
        const arr = Array.isArray(raw) ? raw : Array.isArray(raw?.protected_roots) ? raw.protected_roots : null;
        if (arr && arr.length > 0) return new RepoRegistry(arr as ProtectedRootEntry[]);
      } catch (err) {
        console.warn(
          `[repo-registry] failed to load ${file}; using defaults: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return new RepoRegistry();
  }

  list(): ProtectedRootEntry[] {
    return [...this.entries];
  }

  /** Resolve the protected root that contains `repoPath`, or null if none. */
  resolve(repoPath: string): ProtectedRootEntry | null {
    const target = normalizeRoot(repoPath);
    for (const e of this.entries) {
      if (isWithin(e.root, target)) return e;
    }
    return null;
  }

  /** True when `repoPath` is exactly a registered protected root (not a subpath). */
  isProtectedRoot(repoPath: string): boolean {
    const target = normalizeRoot(repoPath);
    return this.entries.some((e) => normalizeRoot(e.root) === target);
  }
}
