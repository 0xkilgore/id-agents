// T11.1 build-stamp: expose the RUNNING build identity so we can SEE when the
// live manager is behind origin/main (the gap that hid a week of fixes).
//
//   build_sha / build_time   — embedded at COMPILE time (scripts/write-build-info.mjs
//                              writes dist/build-info.json during `npm run build`).
//                              This is the commit the running binary was built from.
//   local_main_sha           — the repo's current local main (runtime).
//   origin_main_sha          — the last-fetched origin/main (runtime).
//   behind_origin            — build_sha !== origin_main_sha (the staleness signal).
//
// The pure decision (computeBuildStatus) is split from the I/O (loadBuildStatus)
// so it is unit-testable without git or a filesystem.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { runWithTimeout } from "./lib/subprocess.js";

export type BuildInfoSource = "build_stamp" | "runtime_fallback" | "unknown";

export interface BuildStatusInput {
  build_sha: string | null;
  build_time: string | null;
  source_branch_sha: string | null;
  source_branch_name: string | null;
  local_main_sha: string | null;
  origin_main_sha: string | null;
  source: BuildInfoSource;
}

export type BuildFreshnessClassification =
  | "fresh"
  | "server_not_rebuilt"
  | "stale_by_design_cross_repo_diff"
  | "server_stale_and_source_unpromoted"
  | "unknown";

export interface BuildFreshnessSignal {
  classification: BuildFreshnessClassification;
  /** SHA the running manager process was built from. */
  running_manager_build_sha: string | null;
  /** SHA currently checked out in the manager source repo. */
  source_branch_sha: string | null;
  /** Branch currently checked out in the manager source repo, when readable. */
  source_branch_name: string | null;
  /** Canonical pushed main SHA that promotion made visible to deploys. */
  promoted_main_sha: string | null;
  /** Back-compat staleness axis: running manager build differs from promoted main. */
  behind_promoted_main: boolean | null;
  /** Source branch is ahead/different from promoted main; often intentional build work. */
  source_differs_from_promoted_main: boolean | null;
  message: string;
}

export interface BuildStatus extends BuildStatusInput {
  /** The running build differs from origin/main → the manager is stale.
   *  null when either side is unknown (can't decide). */
  behind_origin: boolean | null;
  /** Read-model signal for consoles: separates deploy freshness from source drift. */
  freshness: BuildFreshnessSignal;
}

/** Pure: derive the staleness verdict from the resolved SHAs. */
export function computeBuildStatus(input: BuildStatusInput): BuildStatus {
  const behind_origin =
    input.build_sha && input.origin_main_sha
      ? input.build_sha !== input.origin_main_sha
      : null;
  const sourceDiffers =
    input.source_branch_sha && input.origin_main_sha
      ? input.source_branch_sha !== input.origin_main_sha
      : null;
  const freshness = classifyBuildFreshness({
    running_manager_build_sha: input.build_sha,
    source_branch_sha: input.source_branch_sha,
    source_branch_name: input.source_branch_name,
    promoted_main_sha: input.origin_main_sha,
    behind_promoted_main: behind_origin,
    source_differs_from_promoted_main: sourceDiffers,
  });
  return { ...input, behind_origin, freshness };
}

export function classifyBuildFreshness(input: Omit<BuildFreshnessSignal, "classification" | "message">): BuildFreshnessSignal {
  const {
    running_manager_build_sha,
    source_branch_sha,
    source_branch_name,
    promoted_main_sha,
    behind_promoted_main,
    source_differs_from_promoted_main,
  } = input;

  let classification: BuildFreshnessClassification;
  let message: string;
  if (behind_promoted_main === null) {
    classification = "unknown";
    message = "manager build freshness unknown; running build or promoted main SHA is unreadable";
  } else if (behind_promoted_main) {
    classification =
      source_differs_from_promoted_main === true
        ? "server_stale_and_source_unpromoted"
        : "server_not_rebuilt";
    message =
      classification === "server_not_rebuilt"
        ? "code is promoted to main, but the running manager process was built from an older SHA"
        : "running manager is behind promoted main, and the checked-out source branch also differs from promoted main";
  } else if (source_differs_from_promoted_main) {
    classification = "stale_by_design_cross_repo_diff";
    message = "running manager matches promoted main; source branch differs from main by design";
  } else {
    classification = "fresh";
    message = "running manager build, source branch, and promoted main are aligned";
  }

  return {
    classification,
    running_manager_build_sha,
    source_branch_sha,
    source_branch_name,
    promoted_main_sha,
    behind_promoted_main,
    source_differs_from_promoted_main,
    message,
  };
}

interface BuildStamp {
  build_sha: string | null;
  build_time: string | null;
}

/** Read the compile-time stamp written by scripts/write-build-info.mjs. */
function readBuildStamp(distDir: string): BuildStamp | null {
  const file = join(distDir, "build-info.json");
  if (!existsSync(file)) return null;
  try {
    const j = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    const sha = typeof j.build_sha === "string" && j.build_sha.length > 0 ? j.build_sha : null;
    const time = typeof j.build_time === "string" && j.build_time.length > 0 ? j.build_time : null;
    if (!sha) return null;
    return { build_sha: sha, build_time: time };
  } catch {
    return null;
  }
}

/** Resolve a git ref to a full SHA (timeout-bounded; null on any failure). */
function gitRev(repoDir: string, ref: string): string | null {
  const r = runWithTimeout("git", ["-C", repoDir, "rev-parse", ref], { timeoutMs: 5000 });
  if (!r.ok) return null;
  const sha = r.stdout.trim();
  return /^[0-9a-f]{7,40}$/.test(sha) ? sha : null;
}

function gitBranchName(repoDir: string): string | null {
  const r = runWithTimeout("git", ["-C", repoDir, "branch", "--show-current"], { timeoutMs: 5000 });
  if (!r.ok) return null;
  const branch = r.stdout.trim();
  return branch.length > 0 ? branch : null;
}

export interface LoadBuildStatusOptions {
  /** Repo dir the manager runs from (for local/origin main lookups). */
  repoDir: string;
  /** Dir holding build-info.json (the compiled dist dir). */
  distDir: string;
}

/**
 * Resolve the full build status. Uses the compile-time stamp for build_sha when
 * present; in dev/test (no stamp) falls back to the current HEAD so the field is
 * never empty. Never throws.
 */
export function loadBuildStatus(opts: LoadBuildStatusOptions): BuildStatus {
  const stamp = readBuildStamp(opts.distDir);
  let build_sha = stamp?.build_sha ?? null;
  let build_time = stamp?.build_time ?? null;
  let source: BuildInfoSource = stamp ? "build_stamp" : "unknown";

  if (!build_sha) {
    const head = gitRev(opts.repoDir, "HEAD");
    if (head) {
      build_sha = head;
      source = "runtime_fallback";
    }
  }

  const local_main_sha = gitRev(opts.repoDir, "main") ?? gitRev(opts.repoDir, "HEAD");
  const origin_main_sha = gitRev(opts.repoDir, "origin/main");
  const source_branch_sha = gitRev(opts.repoDir, "HEAD");
  const source_branch_name = gitBranchName(opts.repoDir);

  return computeBuildStatus({
    build_sha,
    build_time,
    source_branch_sha,
    source_branch_name,
    local_main_sha,
    origin_main_sha,
    source,
  });
}

// Short in-process cache so a hot /health endpoint doesn't spawn git on every
// hit. build_sha is fixed for the process; local/origin main change rarely.
let cache: { at: number; value: BuildStatus } | null = null;

export function getBuildStatusCached(
  opts: LoadBuildStatusOptions,
  ttlMs = 30_000,
  now: number = Date.now(),
): BuildStatus {
  if (cache && now - cache.at < ttlMs) return cache.value;
  const value = loadBuildStatus(opts);
  cache = { at: now, value };
  return value;
}

/** Test seam: reset the module cache. */
export function __resetBuildStatusCache(): void {
  cache = null;
}
