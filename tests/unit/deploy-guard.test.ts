// T-DEPLOY.1/.5 (2026-06-22) — fleet freshness + post-deploy smoke + rollback.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  buildDeployFreshnessIncidentOpener,
  DEPLOY_FRESHNESS_TASK_NAME,
  evaluateFreshness,
  INITIAL_FRESHNESS,
  DEFAULT_STALE_THRESHOLD_MS,
  type FreshnessTrackerState,
} from "../../src/deploy-guard/freshness.js";
import { evaluateSmoke, type SmokeProbe } from "../../src/deploy-guard/smoke.js";
import {
  decideRollback,
  readLastGood,
  writeLastGood,
  lastGoodStorePath,
  resolveRollbackPolicy,
  planPostDeployAction,
  type RollbackDecision,
} from "../../src/deploy-guard/rollback.js";
import { planRollbackSteps } from "../../src/deploy-guard/cli.js";

const behindInput = { behind_origin: true, build_sha: "aaaa1111", origin_main_sha: "bbbb2222" };
const freshInput = { behind_origin: false, build_sha: "bbbb2222", origin_main_sha: "bbbb2222" };

describe("freshness tracker (T-DEPLOY.1)", () => {
  it("stays fresh when the build matches origin", () => {
    const r = evaluateFreshness(INITIAL_FRESHNESS, freshInput, 0);
    expect(r.next.state).toBe("fresh");
    expect(r.alert).toBeNull();
  });

  it("starts a stale streak (no alert yet) when first seen behind", () => {
    const r = evaluateFreshness(INITIAL_FRESHNESS, behindInput, 0, { thresholdMs: 1000 });
    expect(r.next.state).toBe("stale");
    expect(r.next.behind_origin_since).toBe(new Date(0).toISOString());
    expect(r.alert).toBeNull();
  });

  it("ACCEPTANCE: an induced behind_origin > 15 min alerts", () => {
    const t0 = Date.parse("2026-06-22T12:00:00.000Z");
    const start = evaluateFreshness(INITIAL_FRESHNESS, behindInput, t0); // default 15min threshold
    expect(start.alert).toBeNull();
    const later = evaluateFreshness(start.next, behindInput, t0 + DEFAULT_STALE_THRESHOLD_MS + 1);
    expect(later.alert?.kind).toBe("stale");
    expect(later.alert?.message).toMatch(/BUILD_BEHIND_ORIGIN incident/);
    expect(later.alert?.message).toContain("running_sha=aaaa1111");
    expect(later.alert?.message).toContain("promoted_sha=bbbb2222");
    expect(later.alert?.message).toContain("clean deploy-checkout");
    expect(later.next.state).toBe("stale_alerted");
  });

  it("suppresses repetitive symptom spam for the same running/promoted SHA pair", () => {
    const t0 = 0;
    const a = evaluateFreshness(INITIAL_FRESHNESS, behindInput, t0, { thresholdMs: 0 });
    expect(a.alert?.kind).toBe("stale");
    const b = evaluateFreshness(a.next, behindInput, t0 + 1000, { thresholdMs: 0 });
    expect(b.alert).toBeNull();
    const c = evaluateFreshness(b.next, behindInput, t0 + 20_000, { thresholdMs: 0 });
    expect(c.alert).toBeNull();
  });

  it("opens a new incident when the promoted SHA changes while the manager is still stale", () => {
    const t0 = 0;
    const a = evaluateFreshness(INITIAL_FRESHNESS, behindInput, t0, { thresholdMs: 0 });
    expect(a.alert?.kind).toBe("stale");
    const b = evaluateFreshness(
      a.next,
      { ...behindInput, origin_main_sha: "cccc3333" },
      t0 + 1000,
      { thresholdMs: 0 },
    );
    expect(b.alert?.kind).toBe("stale");
    expect(b.alert?.message).toContain("promoted_sha=cccc3333");
  });

  it("includes source-branch-stale context in the actionable incident", () => {
    const r = evaluateFreshness(
      INITIAL_FRESHNESS,
      {
        ...behindInput,
        source_branch_sha: "cccc3333",
        source_branch_name: "roger/build-work",
        classification: "server_stale_and_source_unpromoted",
      },
      0,
      { thresholdMs: 0 },
    );

    expect(r.alert?.message).toContain("source_branch_sha=cccc3333");
    expect(r.alert?.message).toContain("source_branch=roger/build-work");
    expect(r.alert?.message).toContain("classification=server_stale_and_source_unpromoted");
  });

  it("emits a recovered alert when the build catches up after alerting", () => {
    const alerted: FreshnessTrackerState = { state: "stale_alerted", behind_origin_since: new Date(0).toISOString(), last_alert_at: new Date(0).toISOString() };
    const r = evaluateFreshness(alerted, freshInput, 10_000);
    expect(r.next.state).toBe("fresh");
    expect(r.alert?.kind).toBe("recovered");
    expect(r.alert?.message).toContain("BUILD_BEHIND_ORIGIN resolved");
    expect(r.alert?.message).toContain("running_sha=bbbb2222");
    expect(r.alert?.message).toContain("promoted_sha=bbbb2222");
    expect(r.alert?.message).toContain("auto-closed");
  });

  it("holds state and never alerts when behind_origin is unknown (null)", () => {
    const r = evaluateFreshness(INITIAL_FRESHNESS, { behind_origin: null, build_sha: null, origin_main_sha: null }, 0);
    expect(r.next).toEqual(INITIAL_FRESHNESS);
    expect(r.alert).toBeNull();
  });
});

describe("deploy freshness task opener", () => {
  it("fresh: does not create an incident task when the running build matches origin", () => {
    const opener = buildDeployFreshnessIncidentOpener({
      ...freshInput,
      behind_origin_since: null,
    });

    expect(opener.action).toBe("none");
    expect(opener.task_name).toBe(DEPLOY_FRESHNESS_TASK_NAME);
  });

  it("stale-new: creates one deploy/restart task with target SHA and safe runbook", () => {
    const opener = buildDeployFreshnessIncidentOpener({
      ...behindInput,
      behind_origin_since: "2026-07-15T10:00:00.000Z",
      classification: "server_stale_promoted_main_ahead",
    });

    expect(opener.action).toBe("create");
    expect(opener.task_name).toBe(DEPLOY_FRESHNESS_TASK_NAME);
    expect(opener.target_sha).toBe("bbbb2222");
    expect(opener.description).toContain("target_sha: bbbb2222");
    expect(opener.description).toContain("running_sha: aaaa1111");
    expect(opener.description).toContain("Safe runbook:");
    expect(opener.description).toContain("Do not restart manager from the freshness monitor");
  });

  it("stale-existing-incident: updates the bounded incident instead of opening another task", () => {
    const opener = buildDeployFreshnessIncidentOpener(
      {
        ...behindInput,
        origin_main_sha: "cccc3333",
        behind_origin_since: "2026-07-15T10:00:00.000Z",
      },
      {
        name: DEPLOY_FRESHNESS_TASK_NAME,
        status: "todo",
        description: "incident_key: build_behind_origin:aaaa1111:bbbb2222",
      },
    );

    expect(opener.action).toBe("update");
    expect(opener.task_name).toBe(DEPLOY_FRESHNESS_TASK_NAME);
    expect(opener.description).toContain("incident_key: build_behind_origin:aaaa1111:cccc3333");
    expect(opener.description).toContain("target_sha: cccc3333");
  });
});

describe("post-deploy smoke (T-DEPLOY.5)", () => {
  const good: SmokeProbe = {
    pid_before: 100,
    pid_after: 200,
    build_sha: "newsha",
    origin_main_sha: "newsha",
    behind_origin: false,
    routes: [{ path: "/health", status: 200 }, { path: "/loops", status: 200 }],
  };

  it("passes when pid changed, build==origin, not behind, routes 200", () => {
    expect(evaluateSmoke(good).pass).toBe(true);
  });

  it("fails when the pid did not change (manager never restarted)", () => {
    const r = evaluateSmoke({ ...good, pid_after: 100 });
    expect(r.pass).toBe(false);
    expect(r.failures.join()).toMatch(/pid_changed/);
  });

  it("fails when the running build != origin", () => {
    const r = evaluateSmoke({ ...good, build_sha: "oldsha", behind_origin: true });
    expect(r.pass).toBe(false);
    expect(r.failures.join()).toMatch(/build_sha_matches_origin/);
    expect(r.failures.join()).toMatch(/not_behind_origin/);
  });

  it("fails when a key route is not 200", () => {
    const r = evaluateSmoke({ ...good, routes: [{ path: "/health", status: 200 }, { path: "/loops", status: 500 }] });
    expect(r.pass).toBe(false);
    expect(r.failures.join()).toMatch(/\/loops/);
  });

  it("fails on a boot-error class even when /health + routes look healthy (P1b)", () => {
    // Stamp matches, pid changed, routes 200 — but the boot logged a migration
    // error. A healthy-looking /health must NOT pass smoke.
    const r = evaluateSmoke({ ...good, startup_errors: ["no such column: provider"] });
    expect(r.pass).toBe(false);
    expect(r.failures.join()).toMatch(/zero_startup_errors/);
    expect(r.failures.join()).toMatch(/provider/);
  });

  it("passes with an explicit clean boot (empty startup_errors)", () => {
    expect(evaluateSmoke({ ...good, startup_errors: [] }).pass).toBe(true);
  });

  it("fails on nominal=false only when nominality is required", () => {
    const degraded = { ...good, nominal: false, nominal_reasons: ["supervisor_disabled"] };
    expect(evaluateSmoke(degraded).pass).toBe(true);
    const r = evaluateSmoke(degraded, { requireNominal: true });
    expect(r.pass).toBe(false);
    expect(r.failures.join()).toMatch(/manager_nominal/);
    expect(r.failures.join()).toMatch(/supervisor_disabled/);
  });

  it("passes required nominality when /health reports nominal=true", () => {
    expect(evaluateSmoke({ ...good, nominal: true, nominal_reasons: [] }, { requireNominal: true }).pass).toBe(true);
  });
});

describe("rollback decision + last-good store (T-DEPLOY.5)", () => {
  it("no rollback on a passing smoke", () => {
    expect(decideRollback(true, "x", { build_sha: "y", recorded_at: "" }).should_rollback).toBe(false);
  });

  it("ACCEPTANCE: a failed smoke rolls back to the last-good SHA", () => {
    const d = decideRollback(false, "badsha", { build_sha: "goodsha", recorded_at: "2026-06-22T00:00:00Z" });
    expect(d.should_rollback).toBe(true);
    expect(d.target_sha).toBe("goodsha");
  });

  it("needs operator when there is no last-good build", () => {
    const d = decideRollback(false, "badsha", null);
    expect(d.should_rollback).toBe(false);
    expect(d.needs_operator).toBe(true);
  });

  it("needs operator when the current build IS the last-good (rolling back to self is futile)", () => {
    const d = decideRollback(false, "samesha", { build_sha: "samesha", recorded_at: "" });
    expect(d.should_rollback).toBe(false);
    expect(d.needs_operator).toBe(true);
  });

  it("last-good store round-trips", () => {
    const dir = mkdtempSync(join(tmpdir(), "deploy-guard-"));
    try {
      const p = lastGoodStorePath(dir);
      expect(readLastGood(p)).toBeNull();
      writeLastGood(p, { build_sha: "abc123", recorded_at: "2026-06-22T01:00:00Z" });
      expect(readLastGood(p)?.build_sha).toBe("abc123");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("rollback policy — Q-DEPLOY-2 (T-DEPLOY.5)", () => {
  const canRollback: RollbackDecision = {
    should_rollback: true,
    target_sha: "goodsha",
    reason: "smoke failed — rolling back",
    needs_operator: false,
  };
  const passed: RollbackDecision = {
    should_rollback: false,
    target_sha: null,
    reason: "smoke passed",
    needs_operator: false,
  };
  const unsafe: RollbackDecision = {
    should_rollback: false,
    target_sha: null,
    reason: "no last-good",
    needs_operator: true,
  };

  it("DEFAULT is alert-only (Phase 2) — no flags, no env", () => {
    expect(resolveRollbackPolicy({}, {})).toBe("alert_only");
  });

  it("--auto-rollback or env opts into auto-rollback (Phase 3)", () => {
    expect(resolveRollbackPolicy({ "auto-rollback": true }, {})).toBe("auto_rollback");
    expect(resolveRollbackPolicy({}, { DEPLOY_GUARD_ROLLBACK_POLICY: "auto_rollback" })).toBe("auto_rollback");
    expect(resolveRollbackPolicy({}, { DEPLOY_GUARD_ROLLBACK_POLICY: "auto-rollback" })).toBe("auto_rollback");
  });

  it("--alert-only wins over --auto-rollback and over env", () => {
    expect(resolveRollbackPolicy({ "alert-only": true, "auto-rollback": true }, {})).toBe("alert_only");
    expect(
      resolveRollbackPolicy({ "alert-only": true }, { DEPLOY_GUARD_ROLLBACK_POLICY: "auto_rollback" }),
    ).toBe("alert_only");
  });

  it("ignores unknown env values (stays alert-only)", () => {
    expect(resolveRollbackPolicy({}, { DEPLOY_GUARD_ROLLBACK_POLICY: "yolo" })).toBe("alert_only");
  });

  it("planPostDeployAction: passing smoke → none", () => {
    expect(planPostDeployAction(passed, "auto_rollback")).toBe("none");
    expect(planPostDeployAction(passed, "alert_only")).toBe("none");
  });

  it("planPostDeployAction: rollback-eligible failure → policy decides (alert vs rollback)", () => {
    expect(planPostDeployAction(canRollback, "alert_only")).toBe("alert");
    expect(planPostDeployAction(canRollback, "auto_rollback")).toBe("rollback");
  });

  it("planPostDeployAction: unsafe rollback is NEVER auto-run — needs_operator under any policy", () => {
    expect(planPostDeployAction(unsafe, "alert_only")).toBe("needs_operator");
    expect(planPostDeployAction(unsafe, "auto_rollback")).toBe("needs_operator");
  });
});

describe("rollback plan (T-DEPLOY.5)", () => {
  it("plans checkout(last-good) → rebuild → kickstart", () => {
    const steps = planRollbackSteps("goodsha", { repoDir: "/repo", rebuildCmd: "npm run build", kickstartCmd: "launchctl kickstart -k foo" });
    expect(steps.map((s) => s.label)).toEqual(["checkout last-good build", "rebuild", "kickstart manager"]);
    expect(steps[0].args).toContain("goodsha");
    expect(steps[0].args).toContain("/repo");
  });
});
