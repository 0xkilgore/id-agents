// T-DEPLOY.5 (2026-06-22) — auto-rollback decision + last-good build store.
//
// On a passing post-deploy smoke, the current build SHA is recorded as the
// "last good" build. On a FAILING smoke, decideRollback() picks the last-good
// SHA as the rollback target — that is the "bad build auto-rolls back to the
// last good SHA" acceptance. The decision is pure; the store is a tiny JSON
// file the deploy flow reads/writes. Executing the rollback (git checkout +
// rebuild + kickstart) lives in the CLI behind an explicit --execute gate.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface LastGoodBuild {
  build_sha: string;
  recorded_at: string;
}

export interface RollbackDecision {
  should_rollback: boolean;
  target_sha: string | null;
  reason: string;
  /** When we cannot safely roll back, the operator must step in. */
  needs_operator: boolean;
}

/**
 * Pure decision: given the smoke verdict, the current build SHA, and the
 * last-good record, decide whether to roll back and to what.
 */
export function decideRollback(
  smokePass: boolean,
  currentSha: string | null,
  lastGood: LastGoodBuild | null,
): RollbackDecision {
  if (smokePass) {
    return { should_rollback: false, target_sha: null, reason: "smoke passed; no rollback", needs_operator: false };
  }
  if (!lastGood) {
    return {
      should_rollback: false,
      target_sha: null,
      reason: "smoke failed but no last-good build recorded — cannot auto-roll-back, needs operator",
      needs_operator: true,
    };
  }
  if (currentSha && lastGood.build_sha === currentSha) {
    return {
      should_rollback: false,
      target_sha: null,
      reason: "smoke failed but current build IS the last-good build — rolling back to self is futile, needs operator",
      needs_operator: true,
    };
  }
  return {
    should_rollback: true,
    target_sha: lastGood.build_sha,
    reason: `smoke failed — rolling back to last-good build ${lastGood.build_sha.slice(0, 8)} (recorded ${lastGood.recorded_at})`,
    needs_operator: false,
  };
}

const DEFAULT_STORE_PATH = "var/deploy-guard/last-good-build.json";

export function lastGoodStorePath(repoDir: string = process.cwd()): string {
  return `${repoDir.replace(/\/+$/, "")}/${DEFAULT_STORE_PATH}`;
}

export function readLastGood(path: string): LastGoodBuild | null {
  if (!existsSync(path)) return null;
  try {
    const j = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    if (typeof j.build_sha === "string" && j.build_sha.length > 0) {
      return { build_sha: j.build_sha, recorded_at: typeof j.recorded_at === "string" ? j.recorded_at : "" };
    }
    return null;
  } catch {
    return null;
  }
}

/** Record the current build as last-good (called on a passing smoke). */
export function writeLastGood(path: string, build: LastGoodBuild): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(build, null, 2) + "\n", "utf8");
}
