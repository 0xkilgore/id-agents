// T-DEPLOY.3 — coupled redeploy DETECTION: cross-node version-skew verdict that
// the /ops banner reads as "coordinated redeploy pending" (incident I-4).

import { describe, it, expect } from "vitest";
import {
  evaluateRedeployCoupling,
  COHERENT_EMPTY_COUPLING,
} from "../../src/deploy-guard/redeploy-coupling.js";
import { evaluateFleetFreshness, type FleetNodeInput } from "../../src/deploy-guard/fleet-freshness.js";
import type { FleetNodeSummary } from "../../src/deploy-guard/fleet-freshness.js";

function summary(over: Partial<FleetNodeSummary> = {}): FleetNodeSummary {
  return {
    node_id: over.node_id ?? "manager",
    state: over.state ?? "fresh",
    behind_origin: over.behind_origin ?? false,
    behind_origin_since: over.behind_origin_since ?? null,
    build_sha: over.build_sha === undefined ? "aaaaaaa" : over.build_sha,
    origin_main_sha: over.origin_main_sha === undefined ? "aaaaaaa" : over.origin_main_sha,
  };
}

describe("evaluateRedeployCoupling", () => {
  it("no nodes → empty/coherent-false verdict", () => {
    expect(evaluateRedeployCoupling([])).toEqual(COHERENT_EMPTY_COUPLING);
  });

  it("all nodes on the same build matching origin → coherent, no redeploy pending", () => {
    const r = evaluateRedeployCoupling([
      summary({ node_id: "manager", build_sha: "abc1234", origin_main_sha: "abc1234" }),
      summary({ node_id: "kapelle-site", build_sha: "abc1234", origin_main_sha: "abc1234" }),
    ]);
    expect(r.coordinated_redeploy_pending).toBe(false);
    expect(r.coherent).toBe(true);
    expect(r.target_sha).toBe("abc1234");
    expect(r.running_shas).toEqual(["abc1234"]);
    expect(r.lagging_nodes).toEqual([]);
    expect(r.reason).toMatch(/coherent/);
  });

  it("version skew (I-4): manager upgraded, console still on old build → redeploy pending", () => {
    const r = evaluateRedeployCoupling([
      summary({ node_id: "manager", build_sha: "new9999", origin_main_sha: "new9999" }),
      summary({
        node_id: "console-server",
        build_sha: "old1111",
        origin_main_sha: "new9999",
        behind_origin: true,
      }),
    ]);
    expect(r.coordinated_redeploy_pending).toBe(true);
    expect(r.coherent).toBe(false);
    expect(r.target_sha).toBe("new9999");
    expect(r.running_shas).toEqual(["new9999", "old1111"]);
    expect(r.lagging_nodes).toEqual(["console-server"]);
    expect(r.reason).toMatch(/coordinated redeploy pending/);
    expect(r.reason).toMatch(/console-server/);
  });

  it("uniform but the whole fleet is behind origin → NOT skew (deploy needed, not coupling)", () => {
    const r = evaluateRedeployCoupling([
      summary({ node_id: "manager", build_sha: "old1111", origin_main_sha: "new9999", behind_origin: true }),
      summary({ node_id: "kapelle-site", build_sha: "old1111", origin_main_sha: "new9999", behind_origin: true }),
    ]);
    expect(r.coordinated_redeploy_pending).toBe(false);
    expect(r.coherent).toBe(true); // they agree with each other (no skew)
    expect(r.target_sha).toBe("new9999");
    expect(r.lagging_nodes).toEqual(["manager", "kapelle-site"]);
    expect(r.reason).toMatch(/behind origin/);
  });

  it("an unreadable node blocks coherence and is surfaced separately", () => {
    const r = evaluateRedeployCoupling([
      summary({ node_id: "manager", build_sha: "abc1234" }),
      summary({ node_id: "console-server", build_sha: null }),
    ]);
    expect(r.coherent).toBe(false);
    expect(r.coordinated_redeploy_pending).toBe(false); // only one KNOWN build
    expect(r.unknown_nodes).toEqual(["console-server"]);
    expect(r.reason).toMatch(/unreadable/);
  });

  it("disagreeing origin across nodes → no agreed target, lagging not computed", () => {
    const r = evaluateRedeployCoupling([
      summary({ node_id: "manager", build_sha: "a", origin_main_sha: "x" }),
      summary({ node_id: "kapelle-site", build_sha: "b", origin_main_sha: "y" }),
    ]);
    expect(r.coordinated_redeploy_pending).toBe(true); // distinct builds
    expect(r.target_sha).toBeNull();
    expect(r.lagging_nodes).toEqual([]); // can't pick a target
  });

  it("single node on origin → coherent, single-node reason", () => {
    const r = evaluateRedeployCoupling([
      summary({ node_id: "manager", build_sha: "solo123", origin_main_sha: "solo123" }),
    ]);
    expect(r.coordinated_redeploy_pending).toBe(false);
    expect(r.coherent).toBe(true);
    expect(r.reason).toMatch(/single node manager/);
  });
});

describe("evaluateFleetFreshness wires the coupling verdict into the summary", () => {
  function node(over: Partial<FleetNodeInput>): FleetNodeInput {
    return {
      node_id: over.node_id ?? "manager",
      behind_origin: over.behind_origin ?? false,
      build_sha: over.build_sha ?? "aaaaaaa",
      origin_main_sha: over.origin_main_sha ?? "aaaaaaa",
    };
  }
  const T0 = Date.parse("2026-06-24T00:00:00.000Z");

  it("surfaces coordinated_redeploy_pending when nodes are skewed", () => {
    const r = evaluateFleetFreshness(
      {},
      [
        node({ node_id: "manager", build_sha: "new9999", origin_main_sha: "new9999" }),
        node({ node_id: "console-server", build_sha: "old1111", origin_main_sha: "new9999", behind_origin: true }),
      ],
      T0,
    );
    expect(r.summary.coupling.coordinated_redeploy_pending).toBe(true);
    expect(r.summary.coupling.lagging_nodes).toEqual(["console-server"]);
    expect(r.summary.fleet_behind).toBe(true); // the behind axis still works
  });

  it("coherent fleet → no redeploy pending in the summary", () => {
    const r = evaluateFleetFreshness({}, [node({ node_id: "manager" }), node({ node_id: "kapelle-site" })], T0);
    expect(r.summary.coupling.coordinated_redeploy_pending).toBe(false);
    expect(r.summary.coupling.coherent).toBe(true);
  });
});
