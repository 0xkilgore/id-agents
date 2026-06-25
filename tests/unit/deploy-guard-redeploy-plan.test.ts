// T-DEPLOY.3 (2026-06-24) — coordinated-redeploy PLANNER (the all-or-hold gate).
//
// redeploy-coupling.ts answers "is a coordinated redeploy pending?" (detection).
// This is the next safe, reversible step: given the fleet, DECIDE redeploy_all
// vs hold vs noop, and produce the ordered (dry-run) redeploy PLAN. It never
// executes — the destructive cross-repo saga stays HELD (HC-6); this is the
// reversible gate + plan a human/automation runs. All pure.

import { describe, it, expect } from "vitest";
import type { FleetNodeSummary } from "../../src/deploy-guard/fleet-freshness.js";
import {
  decideCoordinatedRedeploy,
  planCoordinatedRedeploySteps,
} from "../../src/deploy-guard/redeploy-plan.js";

function node(node_id: string, build_sha: string | null, origin_main_sha: string | null): FleetNodeSummary {
  return {
    node_id,
    state: "fresh",
    behind_origin: build_sha != null && origin_main_sha != null ? build_sha !== origin_main_sha : null,
    behind_origin_since: null,
    build_sha,
    origin_main_sha,
  };
}

describe("decideCoordinatedRedeploy (all-or-hold gate)", () => {
  it("noop when there are no nodes", () => {
    expect(decideCoordinatedRedeploy([]).action).toBe("noop");
  });

  it("noop when the fleet is coherent AND on the agreed target", () => {
    const d = decideCoordinatedRedeploy([node("manager", "aaa", "aaa"), node("kapelle-site", "aaa", "aaa")]);
    expect(d.action).toBe("noop");
    expect(d.redeploy_nodes).toEqual([]);
  });

  it("ACCEPTANCE: redeploy_all on version skew with an agreed target (I-4)", () => {
    // manager on new build, kapelle-site still on old — the console version-skew case.
    const d = decideCoordinatedRedeploy([node("manager", "new", "new"), node("kapelle-site", "old", "new")]);
    expect(d.action).toBe("redeploy_all");
    expect(d.target_sha).toBe("new");
    expect(d.redeploy_nodes).toEqual(["kapelle-site"]);
  });

  it("redeploy_all when the whole fleet is uniformly behind the agreed target", () => {
    const d = decideCoordinatedRedeploy([node("manager", "old", "new"), node("kapelle-site", "old", "new")]);
    expect(d.action).toBe("redeploy_all");
    expect(d.redeploy_nodes.sort()).toEqual(["kapelle-site", "manager"]);
  });

  it("HOLDS (never redeploys a subset) when any node's build is unreadable", () => {
    const d = decideCoordinatedRedeploy([node("manager", "new", "new"), node("console", null, "new")]);
    expect(d.action).toBe("hold");
    expect(d.blocked_reason).toMatch(/unreadable|console/i);
    expect(d.redeploy_nodes).toEqual([]);
  });

  it("HOLDS when nodes disagree on the origin target (no safe target to converge to)", () => {
    const d = decideCoordinatedRedeploy([node("manager", "a", "x"), node("kapelle-site", "b", "y")]);
    expect(d.action).toBe("hold");
    expect(d.target_sha).toBeNull();
    expect(d.blocked_reason).toMatch(/target/i);
  });

  it("carries the coupling evidence through for the banner/report", () => {
    const d = decideCoordinatedRedeploy([node("manager", "new", "new"), node("kapelle-site", "old", "new")]);
    expect(d.coupling.coordinated_redeploy_pending).toBe(true);
    expect(d.coupling.running_shas).toEqual(["new", "old"]);
  });
});

describe("planCoordinatedRedeploySteps (ordered dry-run plan)", () => {
  const configs = [
    { node_id: "manager", repoDir: "/repo/id-agents" },
    { node_id: "kapelle-site", repoDir: "/repo/kapelle-site" },
  ];

  it("plans pull → build → restart per lagging node, manager LAST", () => {
    const d = decideCoordinatedRedeploy([node("manager", "old", "new"), node("kapelle-site", "old", "new")]);
    const steps = planCoordinatedRedeploySteps(d, configs);
    const labels = steps.map((s) => s.label);
    // kapelle-site fully before manager; each node pull→build→restart.
    expect(labels).toEqual([
      "pull kapelle-site", "build kapelle-site", "restart kapelle-site",
      "pull manager", "build manager", "restart manager",
    ]);
    expect(steps[0].args).toContain("/repo/kapelle-site");
  });

  it("returns an empty plan when the decision is hold or noop", () => {
    const hold = decideCoordinatedRedeploy([node("manager", "new", "new"), node("console", null, "new")]);
    expect(planCoordinatedRedeploySteps(hold, configs)).toEqual([]);
    const noop = decideCoordinatedRedeploy([node("manager", "aaa", "aaa")]);
    expect(planCoordinatedRedeploySteps(noop, configs)).toEqual([]);
  });

  it("skips a redeploy node that has no resolved repo config (cannot plan it)", () => {
    const d = decideCoordinatedRedeploy([node("manager", "new", "new"), node("kapelle-site", "old", "new")]);
    const steps = planCoordinatedRedeploySteps(d, [{ node_id: "manager", repoDir: "/repo/id-agents" }]);
    expect(steps).toEqual([]); // kapelle-site is the only lagging node, no config -> nothing to plan
  });
});
