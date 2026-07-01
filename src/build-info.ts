// T11.1 build-stamp: expose the RUNNING build identity so we can SEE when the
// live manager is behind origin/main (the gap that hid a week of fixes).
//
//   build_sha / build_time   — embedded at COMPILE time (scripts/write-build-info.mjs
//                              writes dist/build-info.json during `npm run build`).
//                              This is the commit the running binary was built from.
//   local_main_sha           — the repo's current local main (runtime).
//   origin_main_sha          — the last-fetched origin/main (runtime).
//   behind_origin            — the EXACT-SHA staleness signal: true only when the
//                              promoted main has commits the running build lacks
//                              that actually change the built binary. A build that
//                              is even-with/AHEAD of main, or behind only by a
//                              runtime-read config/docs commit, is NOT stale (this
//                              kills the false drift where any SHA difference —
//                              e.g. a runtime-policy-only commit — flagged stale).
//
// The pure decision (computeBuildStatus) is split from the I/O (loadBuildStatus)
// so it is unit-testable without git or a filesystem. The exact behind-delta
// (files promoted main has that the build does not) is resolved by git in the
// I/O layer and passed to the pure decision.

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

/** Paths read at RUNTIME by the manager (not compiled into `dist/`), so a commit
 *  confined to these does NOT make the running binary stale. Kept deliberately
 *  tight: runtime policy/config (e.g. configs/model-policy.json) + pure docs.
 *  Everything else (src/, scripts/, package manifests, tsconfig, …) is
 *  build-affecting and DOES require a rebuild. */
export function isRuntimeOnlyPath(path: string): boolean {
  const p = path.trim();
  if (p === "") return false;
  return (
    p.startsWith("configs/") || // runtime-read policy/config (model-policy.json, …)
    p.startsWith("docs/") ||
    /^[^/]+\.md$/.test(p) // top-level markdown (README.md, CHANGELOG.md, NOTICE …)
  );
}

/** True when EVERY path in the behind-delta is runtime-only (no rebuild needed).
 *  An empty delta is not "policy-only" — the caller treats [] as "not behind". */
export function isRuntimePolicyOnlyDelta(paths: readonly string[]): boolean {
  return paths.length > 0 && paths.every(isRuntimeOnlyPath);
}

/**
 * Pure: derive the EXACT-SHA staleness verdict.
 *
 * `behindPaths` is the set of files that commits on promoted main have but the
 * running build does NOT — the three-dot `build_sha...origin_main_sha` delta:
 *   - `undefined`/`null` → the delta could not be computed; fall back to the raw
 *     SHA comparison (any difference = behind), preserving the legacy signal.
 *   - `[]`               → the build is even-with or AHEAD of promoted main (e.g.
 *     a just-promoted build while the local origin ref lags) → NOT behind.
 *   - only runtime-only paths (config/docs) → a by-design advance the running
 *     manager reads live → NOT a stale binary (fixes the false drift).
 *   - any build-affecting path (src/, scripts/, …) → genuinely behind.
 */
export function computeBuildStatus(
  input: BuildStatusInput,
  behindPaths?: readonly string[] | null,
): BuildStatus {
  const behind_origin = computeBehindOrigin(input, behindPaths);
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

/** The exact-SHA behind verdict (see computeBuildStatus for the `behindPaths`
 *  contract). Pure; `null` when either SHA is unreadable. */
function computeBehindOrigin(
  input: BuildStatusInput,
  behindPaths?: readonly string[] | null,
): boolean | null {
  const { build_sha, origin_main_sha } = input;
  if (!build_sha || !origin_main_sha) return null; // can't decide
  if (build_sha === origin_main_sha) return false; // exact match → fresh
  if (behindPaths === undefined || behindPaths === null) {
    return build_sha !== origin_main_sha; // exact delta unknown → raw comparison
  }
  if (behindPaths.length === 0) return false; // build is even-with/ahead of main
  // Promoted main is ahead: stale only if a build-affecting path changed. A delta
  // confined to runtime-read config/docs is not a stale binary.
  return !isRuntimePolicyOnlyDelta(behindPaths);
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

/**
 * Files that promoted main (`originSha`) has ahead of the running build
 * (`buildSha`) — the three-dot delta (changes on the origin side since the merge
 * base). `[]` when the build is even-with or AHEAD of main. `null` on any git
 * failure (e.g. the build SHA isn't in this repo, or unrelated histories) so the
 * caller falls back to the raw SHA comparison rather than trusting an empty diff.
 */
function gitBehindPaths(repoDir: string, buildSha: string, originSha: string): string[] | null {
  const r = runWithTimeout(
    "git",
    ["-C", repoDir, "diff", "--name-only", `${buildSha}...${originSha}`],
    { timeoutMs: 5000 },
  );
  if (!r.ok) return null;
  return r.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
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

  // Resolve the exact behind-delta (files promoted main has that the running
  // build lacks) so a build that is ahead/even, or behind only by a runtime-read
  // config/docs commit, is not flagged stale. Only computed when both SHAs are
  // known and differ; git failure → null → raw-SHA fallback in the pure decision.
  const behind_paths =
    build_sha && origin_main_sha && build_sha !== origin_main_sha
      ? gitBehindPaths(opts.repoDir, build_sha, origin_main_sha)
      : build_sha && origin_main_sha
        ? []
        : null;

  return computeBuildStatus(
    {
      build_sha,
      build_time,
      source_branch_sha,
      source_branch_name,
      local_main_sha,
      origin_main_sha,
      source,
    },
    behind_paths,
  );
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
