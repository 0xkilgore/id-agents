// T-DEPLOY.1/.5 (2026-06-22) — fleet freshness + post-deploy smoke + rollback.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
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
    expect(later.alert?.message).toMatch(/STALE/);
    expect(later.next.state).toBe("stale_alerted");
  });

  it("does not re-alert before the re-alert window, then re-alerts after", () => {
    const t0 = 0;
    const a = evaluateFreshness(INITIAL_FRESHNESS, behindInput, t0, { thresholdMs: 0 });
    expect(a.alert?.kind).toBe("stale");
    const b = evaluateFreshness(a.next, behindInput, t0 + 1000, { thresholdMs: 0, reAlertMs: 10_000 });
    expect(b.alert).toBeNull(); // within re-alert window
    const c = evaluateFreshness(b.next, behindInput, t0 + 20_000, { thresholdMs: 0, reAlertMs: 10_000 });
    expect(c.alert?.kind).toBe("stale"); // re-alert fired
  });

  it("emits a recovered alert when the build catches up after alerting", () => {
    const alerted: FreshnessTrackerState = { state: "stale_alerted", behind_origin_since: new Date(0).toISOString(), last_alert_at: new Date(0).toISOString() };
    const r = evaluateFreshness(alerted, freshInput, 10_000);
    expect(r.next.state).toBe("fresh");
    expect(r.alert?.kind).toBe("recovered");
  });

  it("holds state and never alerts when behind_origin is unknown (null)", () => {
    const r = evaluateFreshness(INITIAL_FRESHNESS, { behind_origin: null, build_sha: null, origin_main_sha: null }, 0);
    expect(r.next).toEqual(INITIAL_FRESHNESS);
    expect(r.alert).toBeNull();
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

describe("rollback plan (T-DEPLOY.5)", () => {
  it("plans checkout(last-good) → rebuild → kickstart", () => {
    const steps = planRollbackSteps("goodsha", { repoDir: "/repo", rebuildCmd: "npm run build", kickstartCmd: "launchctl kickstart -k foo" });
    expect(steps.map((s) => s.label)).toEqual(["checkout last-good build", "rebuild", "kickstart manager"]);
    expect(steps[0].args).toContain("goodsha");
    expect(steps[0].args).toContain("/repo");
  });
});
