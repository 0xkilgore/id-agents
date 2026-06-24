// T-DEPLOY.7 — scripted deploy automation: pure planner + injectable runner.

import { describe, it, expect } from "vitest";
import {
  planDeploy,
  planDeploySteps,
  runDeploy,
  type DeployRunnerDeps,
  type DeployStep,
  type PreflightGate,
} from "../../src/deploy-guard/automation.js";
import type { SmokeResult } from "../../src/deploy-guard/smoke.js";

function gate(name: PreflightGate["name"], required: boolean, passed: boolean): PreflightGate {
  return { name, required, passed, detail: passed ? "ok" : "bad" };
}

const PLAN_OPTS = {
  repoDir: "/repo",
  buildCmd: "npm run build",
  kickstartCmd: "echo kick",
};

function smoke(pass: boolean): SmokeResult {
  return { pass, checks: [], failures: pass ? [] : ["smoke failed"], build_sha: "newsha" };
}

/** A runner deps fake that records steps and lets each step's ok be scripted. */
function fakeDeps(over: Partial<DeployRunnerDeps> & { stepFails?: Set<string> } = {}): DeployRunnerDeps {
  const stepFails = over.stepFails ?? new Set<string>();
  return {
    gatherGates: over.gatherGates ?? (() => [gate("abi", true, true), gate("protected_root", true, true)]),
    runStep: over.runStep ?? ((s: DeployStep) => ({ ok: !stepFails.has(s.label) })),
    verify: over.verify ?? (async () => smoke(true)),
    planRollback: over.planRollback ?? ((sha) => [{ label: "rollback", cmd: "git", args: ["checkout", sha] }]),
    lastGoodSha: over.lastGoodSha ?? (() => "lastgoodsha"),
  };
}

describe("planDeploy (pure go/no-go)", () => {
  it("proceeds when every required gate passes, with ordered redeploy steps", () => {
    const plan = planDeploy(
      [gate("abi", true, true), gate("protected_root", true, true), gate("freshness", false, true)],
      PLAN_OPTS,
    );
    expect(plan.proceed).toBe(true);
    expect(plan.halt_reason).toBeNull();
    expect(plan.steps.map((s) => s.label)).toEqual(["build", "kickstart manager"]);
  });

  it("halts (no steps) when a REQUIRED gate fails, naming the gate", () => {
    const plan = planDeploy([gate("abi", true, false), gate("protected_root", true, true)], PLAN_OPTS);
    expect(plan.proceed).toBe(false);
    expect(plan.steps).toEqual([]);
    expect(plan.halt_reason).toContain("abi");
  });

  it("does NOT halt when a non-required gate fails (freshness is informational)", () => {
    const plan = planDeploy([gate("abi", true, true), gate("freshness", false, false)], PLAN_OPTS);
    expect(plan.proceed).toBe(true);
  });

  it("reports ALL failed required gates in the halt reason", () => {
    const plan = planDeploy([gate("abi", true, false), gate("protected_root", true, false)], PLAN_OPTS);
    expect(plan.halt_reason).toContain("abi");
    expect(plan.halt_reason).toContain("protected_root");
  });

  it("sequences coupled redeploy targets AFTER the manager kickstart", () => {
    const steps = planDeploySteps({
      ...PLAN_OPTS,
      coupledTargets: [{ label: "redeploy kapelle-site", cmd: "bash", args: ["-lc", "deploy"] }],
    });
    expect(steps.map((s) => s.label)).toEqual(["build", "kickstart manager", "redeploy kapelle-site"]);
  });
});

describe("runDeploy (injectable executor)", () => {
  it("halts on pre-flight without running any step", async () => {
    const r = await runDeploy(
      fakeDeps({ gatherGates: () => [gate("abi", true, false)] }),
      { ...PLAN_OPTS, execute: true },
    );
    expect(r.outcome).toBe("halted_preflight");
    expect(r.ran).toEqual([]);
  });

  it("dry-run (execute !== true) plans but does not run", async () => {
    const r = await runDeploy(fakeDeps(), PLAN_OPTS);
    expect(r.outcome).toBe("planned");
    expect(r.ran).toEqual([]);
    expect(r.plan.proceed).toBe(true);
  });

  it("executes + verifies clean → deployed", async () => {
    const r = await runDeploy(fakeDeps(), { ...PLAN_OPTS, execute: true });
    expect(r.outcome).toBe("deployed");
    expect(r.ran).toHaveLength(2); // build + kickstart
    expect(r.smoke?.pass).toBe(true);
  });

  it("a failing redeploy step aborts before verify", async () => {
    const r = await runDeploy(
      fakeDeps({ stepFails: new Set(["kickstart manager"]) }),
      { ...PLAN_OPTS, execute: true },
    );
    expect(r.outcome).toBe("deploy_step_failed");
    expect(r.smoke).toBeNull();
  });

  it("verify failure rolls back to last-good", async () => {
    const r = await runDeploy(
      fakeDeps({ verify: async () => smoke(false) }),
      { ...PLAN_OPTS, execute: true },
    );
    expect(r.outcome).toBe("rolled_back");
    expect(r.rollback?.target_sha).toBe("lastgoodsha");
    expect(r.rollback?.ok).toBe(true);
  });

  it("verify failure with no last-good → rollback_failed", async () => {
    const r = await runDeploy(
      fakeDeps({ verify: async () => smoke(false), lastGoodSha: () => null }),
      { ...PLAN_OPTS, execute: true },
    );
    expect(r.outcome).toBe("rollback_failed");
    expect(r.rollback?.target_sha).toBeNull();
  });

  it("a failing rollback step → rollback_failed", async () => {
    const r = await runDeploy(
      fakeDeps({ verify: async () => smoke(false), stepFails: new Set(["rollback"]) }),
      { ...PLAN_OPTS, execute: true },
    );
    expect(r.outcome).toBe("rollback_failed");
    expect(r.rollback?.ok).toBe(false);
  });
});
