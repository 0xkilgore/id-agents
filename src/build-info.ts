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
  local_main_sha: string | null;
  origin_main_sha: string | null;
  source: BuildInfoSource;
}

export interface BuildStatus extends BuildStatusInput {
  /** The running build differs from origin/main → the manager is stale.
   *  null when either side is unknown (can't decide). */
  behind_origin: boolean | null;
}

/** Pure: derive the staleness verdict from the resolved SHAs. */
export function computeBuildStatus(input: BuildStatusInput): BuildStatus {
  const behind_origin =
    input.build_sha && input.origin_main_sha
      ? input.build_sha !== input.origin_main_sha
      : null;
  return { ...input, behind_origin };
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

  return computeBuildStatus({ build_sha, build_time, local_main_sha, origin_main_sha, source });
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
