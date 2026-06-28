// T-DEPLOY.1 — fleet freshness aggregator: per-node trackers folded into one
// fleet verdict + per-node alerts, plus the node resolver.

import { describe, it, expect } from "vitest";
import {
  evaluateFleetFreshness,
  inferKapelleSiteRepoDir,
  resolveFleetNodes,
  type FleetFreshnessState,
  type FleetNodeInput,
} from "../../src/deploy-guard/fleet-freshness.js";
import {
  DEFAULT_STALE_THRESHOLD_MS,
  INITIAL_FRESHNESS,
} from "../../src/deploy-guard/freshness.js";

function node(over: Partial<FleetNodeInput> = {}): FleetNodeInput {
  return {
    node_id: over.node_id ?? "manager",
    behind_origin: over.behind_origin === undefined ? false : over.behind_origin,
    build_sha: over.build_sha ?? "aaaaaaa",
    origin_main_sha: over.origin_main_sha ?? "aaaaaaa",
    release_state: over.release_state ?? null,
  };
}

const T0 = Date.parse("2026-06-24T00:00:00.000Z");
const past = (ms: number) => T0 + ms;

describe("evaluateFleetFreshness", () => {
  it("reports a fresh fleet with no alerts", () => {
    const r = evaluateFleetFreshness({}, [node({ node_id: "manager" }), node({ node_id: "kapelle-site" })], T0);
    expect(r.alerts).toHaveLength(0);
    expect(r.summary.fleet_behind).toBe(false);
    expect(r.summary.stale_nodes).toEqual([]);
    expect(r.summary.node_count).toBe(2);
  });

  it("carries kapelle-site release-state diagnosis into the health payload", () => {
    const release_state = {
      repo_dir: "/srv/kapelle-site",
      observed_at: "2026-06-27T00:00:00.000Z",
      status: "red" as const,
      checkout: {
        exists: true,
        is_git: true,
        branch: "feature/local-ops",
        intended_branch: "main",
        upstream: "origin/main",
        ahead: 0,
        behind: 0,
        dirty_count: 1,
        status_short: " M app/ops/page.tsx",
        severity: "red" as const,
        code: "dirty" as const,
        message: "kapelle-site has 1 uncommitted change(s)",
        remediation: "Commit or stash the listed changes, then rebuild and restart /ops from clean origin/main.",
      },
      locks: [],
      actions: ["Commit or stash the listed changes, then rebuild and restart /ops from clean origin/main."],
    };
    const r = evaluateFleetFreshness(
      {},
      [node({ node_id: "kapelle-site", release_state })],
      T0,
    );
    expect(r.summary.nodes[0].release_state?.status).toBe("red");
    expect(r.summary.nodes[0].release_state?.checkout.remediation).toMatch(/rebuild and restart/);
  });

  it("marks a behind node stale (under threshold) without alerting", () => {
    const r = evaluateFleetFreshness(
      {},
      [node({ node_id: "kapelle-site", behind_origin: true, build_sha: "old", origin_main_sha: "new" })],
      T0,
    );
    expect(r.alerts).toHaveLength(0);
    expect(r.summary.fleet_behind).toBe(true);
    expect(r.summary.stale_nodes).toEqual(["kapelle-site"]);
    expect(r.next["kapelle-site"].state).toBe("stale");
  });

  it("alerts the specific node once it is behind past the threshold", () => {
    const behind = node({ node_id: "kapelle-site", behind_origin: true, build_sha: "old", origin_main_sha: "new" });
    const first = evaluateFleetFreshness({}, [behind], T0);
    const later = evaluateFleetFreshness(first.next, [behind], past(DEFAULT_STALE_THRESHOLD_MS + 1));
    expect(later.alerts).toHaveLength(1);
    expect(later.alerts[0].node_id).toBe("kapelle-site");
    expect(later.alerts[0].alert.kind).toBe("stale");
    expect(later.next["kapelle-site"].state).toBe("stale_alerted");
  });

  it("isolates nodes: a stale node does not implicate a fresh one", () => {
    const inputs = [
      node({ node_id: "manager" }),
      node({ node_id: "kapelle-site", behind_origin: true, build_sha: "old", origin_main_sha: "new" }),
    ];
    const first = evaluateFleetFreshness({}, inputs, T0);
    const later = evaluateFleetFreshness(first.next, inputs, past(DEFAULT_STALE_THRESHOLD_MS + 1));
    expect(later.alerts.map((a) => a.node_id)).toEqual(["kapelle-site"]);
    expect(later.next.manager.state).toBe("fresh");
    expect(later.summary.stale_nodes).toEqual(["kapelle-site"]);
  });

  it("emits a one-shot recovered alert when a stale-alerted node catches up", () => {
    const behind = node({ node_id: "manager", behind_origin: true, build_sha: "old", origin_main_sha: "new" });
    const alerted = evaluateFleetFreshness(
      evaluateFleetFreshness({}, [behind], T0).next,
      [behind],
      past(DEFAULT_STALE_THRESHOLD_MS + 1),
    );
    expect(alerted.next.manager.state).toBe("stale_alerted");
    const recovered = evaluateFleetFreshness(alerted.next, [node({ node_id: "manager", behind_origin: false })], past(DEFAULT_STALE_THRESHOLD_MS + 2));
    expect(recovered.alerts).toHaveLength(1);
    expect(recovered.alerts[0].alert.kind).toBe("recovered");
    expect(recovered.next.manager.state).toBe("fresh");
  });

  it("holds state and never alerts on an unknown (null) observation", () => {
    const prev: FleetFreshnessState = { manager: { ...INITIAL_FRESHNESS, state: "stale", behind_origin_since: new Date(T0).toISOString() } };
    const r = evaluateFleetFreshness(prev, [node({ node_id: "manager", behind_origin: null })], past(1000));
    expect(r.alerts).toHaveLength(0);
    expect(r.next.manager.state).toBe("stale");
    expect(r.summary.fleet_behind).toBe(false); // null is not "behind"
  });

  it("drops trackers for nodes no longer observed", () => {
    const prev: FleetFreshnessState = {
      manager: INITIAL_FRESHNESS,
      "retired-node": { ...INITIAL_FRESHNESS, state: "stale_alerted" },
    };
    const r = evaluateFleetFreshness(prev, [node({ node_id: "manager" })], T0);
    expect(Object.keys(r.next)).toEqual(["manager"]);
  });
});

describe("resolveFleetNodes", () => {
  it("always lists the manager (self) first, then the kapelle-site sibling by default", () => {
    const nodes = resolveFleetNodes({} as NodeJS.ProcessEnv, "/Users/x/Code/id-agents");
    expect(nodes[0]).toMatchObject({ node_id: "manager", is_self: true });
    expect(nodes[1]).toMatchObject({ node_id: "kapelle-site", repoDir: "/Users/x/Code/kapelle-site" });
  });

  it("infers the real kapelle-site checkout when the manager cwd is under cane/id-agents", () => {
    const nodes = resolveFleetNodes({} as NodeJS.ProcessEnv, "/Users/x/Code/cane/id-agents");
    expect(nodes[0]).toMatchObject({ node_id: "manager", is_self: true });
    expect(nodes[1]).toMatchObject({ node_id: "kapelle-site", repoDir: "/Users/x/Code/kapelle-site" });
    expect(nodes[1].repoDir).not.toBe("/Users/x/Code/cane/kapelle-site");
  });

  it("parses DEPLOY_FLEET_NODES (id:repoDir[:distDir]) over the default", () => {
    const env = { DEPLOY_FLEET_NODES: "console-server:/srv/console:/srv/console/dist, kapelle-site:/srv/site" } as unknown as NodeJS.ProcessEnv;
    const nodes = resolveFleetNodes(env, "/repo/id-agents");
    expect(nodes.map((n) => n.node_id)).toEqual(["manager", "console-server", "kapelle-site"]);
    expect(nodes[1]).toMatchObject({ node_id: "console-server", repoDir: "/srv/console", distDir: "/srv/console/dist" });
    expect(nodes[2]).toMatchObject({ node_id: "kapelle-site", repoDir: "/srv/site", distDir: "/srv/site" });
  });

  it("uses the configured kapelle-site serving checkout instead of the manager cwd sibling", () => {
    const env = {
      DEPLOY_FLEET_NODES: "kapelle-site:/Users/kilgore/Dropbox/Code/kapelle-site",
    } as unknown as NodeJS.ProcessEnv;
    const nodes = resolveFleetNodes(env, "/Users/kilgore/Dropbox/Code/cane/id-agents");
    expect(nodes[1]).toMatchObject({
      node_id: "kapelle-site",
      repoDir: "/Users/kilgore/Dropbox/Code/kapelle-site",
      distDir: "/Users/kilgore/Dropbox/Code/kapelle-site",
    });
    expect(nodes[1].repoDir).not.toBe("/Users/kilgore/Dropbox/Code/cane/kapelle-site");
  });

  it("ignores malformed DEPLOY_FLEET_NODES entries (missing repoDir)", () => {
    const env = { DEPLOY_FLEET_NODES: "bogus,,real:/srv/real" } as unknown as NodeJS.ProcessEnv;
    const nodes = resolveFleetNodes(env, "/repo/id-agents");
    expect(nodes.map((n) => n.node_id)).toEqual(["manager", "real"]);
  });
});

describe("inferKapelleSiteRepoDir", () => {
  it("does not append kapelle-site under cane for the production manager layout", () => {
    expect(inferKapelleSiteRepoDir("/Users/kilgore/Dropbox/Code/cane/id-agents")).toBe(
      "/Users/kilgore/Dropbox/Code/kapelle-site",
    );
  });
});
