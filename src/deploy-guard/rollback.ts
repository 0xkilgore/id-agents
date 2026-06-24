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

/**
 * Q-DEPLOY-2 — what to do with a rollback-eligible smoke failure. `decideRollback`
 * answers "CAN we roll back, and to what"; the POLICY answers "SHOULD we do it
 * automatically, or just alert and let the operator decide".
 */
export type RollbackPolicy = "alert_only" | "auto_rollback";

/**
 * Resolve the post-deploy rollback policy (Q-DEPLOY-2; Maestra resolution in
 * kapelle-roadmap-reset §4.6 + §Q-table): ALERT-ONLY by default (Phase 2 — the
 * manual post-deploy smoke surfaces the failure loudly and lets the operator
 * decide), auto-rollback is opt-in (Phase 3, once deploy automation is proven —
 * the runDeploy pipeline). An explicit `--alert-only` flag wins; otherwise
 * `--auto-rollback` or `DEPLOY_GUARD_ROLLBACK_POLICY=auto_rollback` selects
 * auto-rollback. Unknown env values are ignored (stays alert_only).
 */
export function resolveRollbackPolicy(
  flags: Record<string, string | boolean>,
  env: Record<string, string | undefined>,
): RollbackPolicy {
  if (flags["alert-only"] === true) return "alert_only";
  if (flags["auto-rollback"] === true) return "auto_rollback";
  const e = (env.DEPLOY_GUARD_ROLLBACK_POLICY ?? "").toLowerCase().replace(/-/g, "_");
  if (e === "auto_rollback") return "auto_rollback";
  return "alert_only";
}

/** The action the deploy flow takes after a post-deploy smoke. */
export type PostDeployAction = "none" | "rollback" | "alert" | "needs_operator";

/**
 * Pure: combine the rollback decision with the policy into a single action.
 *   - smoke passed                         → "none"
 *   - smoke failed, cannot roll back safely → "needs_operator" (always surfaced)
 *   - smoke failed, rollback possible, auto → "rollback"
 *   - smoke failed, rollback possible, alert → "alert"
 * `needs_operator` ignores the policy: an unsafe rollback is never auto-run.
 */
export function planPostDeployAction(
  decision: RollbackDecision,
  policy: RollbackPolicy,
): PostDeployAction {
  if (decision.needs_operator) return "needs_operator";
  if (!decision.should_rollback) return "none";
  return policy === "auto_rollback" ? "rollback" : "alert";
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
