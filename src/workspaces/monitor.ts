// T-OSS.2 — Dirty-root monitor.
//
// Samples every protected canonical root and emits a manager-visible record:
// branch, ahead/behind drift, dirty file count, a short status preview, and the
// last lease/dispatch that owned it. The point is CUSTODY — who dirtied which
// root, when, and whether a lease owned it — surfaced as "Protected checkout
// dirty" rather than generic repo noise. Spec §"Dirty-Root Monitor".

import { existsSync } from "node:fs";
import {
  gitStatusShort,
  gitCurrentBranch,
  gitAheadBehind,
  gitFetch,
  gitHeadSha,
  gitRevParse,
  protectedRootStatus,
  stripWorktreeNoise,
} from "./allocator.js";
import { RepoRegistry, type ProtectedRootEntry } from "./repo-registry.js";

export type DirtySeverity = "critical" | "warning" | "info";

export interface DirtyRootRecord {
  root: string;
  repo_name: string;
  branch: string | null;
  /** Intended canonical branch from the registry. */
  intended_branch: string;
  head_sha: string | null;
  origin_main_sha: string | null;
  /** True when the checkout is off its intended canonical branch. */
  off_canonical_branch: boolean;
  remote: string;
  base: string;
  ahead: number | null;
  behind: number | null;
  dirty_count: number;
  dirty_tracked_count: number;
  dirty_untracked_count: number;
  /** Truncated `git status --short --branch` preview. */
  status_short: string;
  last_lease_id: string | null;
  last_dispatch_id: string | null;
  severity: DirtySeverity;
  observed_at: string;
  /** Set when the root path does not exist / is not a git repo. */
  error?: string;
}

export interface SampleOptions {
  remote?: string;
  base?: string;
  /** Fetch before computing ahead/behind (network). Default false. */
  fetch?: boolean;
  /** Owner attribution from the manager's lease store, when available. */
  ownership?: { last_lease_id?: string | null; last_dispatch_id?: string | null };
  now?: () => Date;
  /** Truncate the status preview to this many chars. Default 500. */
  preview_chars?: number;
}

/**
 * Severity (spec §"Dirty-Root Monitor"):
 *   critical — deploy/core root dirty, OR canonical root off intended branch.
 *   warning  — non-deploy protected root dirty.
 *   info     — clean root but ahead/behind drift exists.
 */
export function classifySeverity(args: {
  entry: ProtectedRootEntry;
  dirty: boolean;
  offCanonicalBranch: boolean;
  ahead: number | null;
  behind: number | null;
}): DirtySeverity {
  if (args.offCanonicalBranch) return "critical";
  if (args.dirty) return args.entry.dirty_severity; // critical for deploy/core, warning otherwise
  if ((args.ahead ?? 0) > 0 || (args.behind ?? 0) > 0) return "info";
  return "info";
}

/** Sample one protected root. Never throws — filesystem/git errors are recorded. */
export function sampleProtectedRoot(entry: ProtectedRootEntry, opts: SampleOptions = {}): DirtyRootRecord {
  const now = (opts.now ?? (() => new Date()))();
  const remote = opts.remote ?? "origin";
  const base = opts.base ?? entry.intended_canonical_branch;
  const previewChars = opts.preview_chars ?? 500;

  const baseRecord: DirtyRootRecord = {
    root: entry.root,
    repo_name: entry.repo_name,
    branch: null,
    intended_branch: entry.intended_canonical_branch,
    head_sha: null,
    origin_main_sha: null,
    off_canonical_branch: false,
    remote,
    base,
    ahead: null,
    behind: null,
    dirty_count: 0,
    dirty_tracked_count: 0,
    dirty_untracked_count: 0,
    status_short: "",
    last_lease_id: opts.ownership?.last_lease_id ?? null,
    last_dispatch_id: opts.ownership?.last_dispatch_id ?? null,
    severity: "info",
    observed_at: now.toISOString(),
  };

  if (!existsSync(entry.root)) {
    return { ...baseRecord, error: "root path does not exist", severity: "info" };
  }

  if (opts.fetch) gitFetch(entry.root, remote);

  const status = protectedRootStatus(entry.root);
  const statusShortFull = stripWorktreeNoise(gitStatusShort(entry.root));
  const branch = gitCurrentBranch(entry.root);
  const headSha = gitHeadSha(entry.root);
  const originMainSha = gitRevParse(entry.root, `${remote}/${base}`);
  const ab = gitAheadBehind(entry.root, `${remote}/${base}`);
  const dirtyStats = countDirtyStatus(status);
  const dirtyCount = dirtyStats.tracked + dirtyStats.untracked;
  const offCanonical = branch != null && branch !== entry.intended_canonical_branch;

  const severity = classifySeverity({
    entry,
    dirty: dirtyCount > 0,
    offCanonicalBranch: offCanonical,
    ahead: ab?.ahead ?? null,
    behind: ab?.behind ?? null,
  });

  return {
    ...baseRecord,
    branch,
    head_sha: headSha,
    origin_main_sha: originMainSha,
    off_canonical_branch: offCanonical,
    ahead: ab?.ahead ?? null,
    behind: ab?.behind ?? null,
    dirty_count: dirtyCount,
    dirty_tracked_count: dirtyStats.tracked,
    dirty_untracked_count: dirtyStats.untracked,
    status_short: statusShortFull.slice(0, previewChars),
    severity,
  };
}

/** Sample every protected root in the registry. */
export function sampleAll(
  registry: RepoRegistry = RepoRegistry.load(),
  opts: SampleOptions = {},
): DirtyRootRecord[] {
  return registry.list().map((e) => sampleProtectedRoot(e, opts));
}

/** The records worth alerting on (critical/warning), worst-first. */
export function dirtyRootAlerts(records: DirtyRootRecord[]): DirtyRootRecord[] {
  const rank: Record<DirtySeverity, number> = { critical: 0, warning: 1, info: 2 };
  return records
    .filter((r) => r.severity === "critical" || (r.severity === "warning" && r.dirty_count > 0))
    .sort((a, b) => rank[a.severity] - rank[b.severity]);
}

function countDirtyStatus(status: string): { tracked: number; untracked: number } {
  let tracked = 0;
  let untracked = 0;
  for (const line of status.split("\n")) {
    if (!line.trim()) continue;
    if (line.startsWith("??")) untracked += 1;
    else tracked += 1;
  }
  return { tracked, untracked };
}
