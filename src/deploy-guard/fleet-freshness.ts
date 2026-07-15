// T-DEPLOY.1 — freshness detection ACROSS THE FLEET.
//
// Single-node freshness (freshness.ts) tracked only the manager's running build.
// But "merged != running" drift can hit ANY node — the manager, the console
// server, or the kapelle-site checkout. This aggregates per-node freshness into
// one fleet verdict + per-node alerts, REUSING the pure single-node evaluator so
// the threshold/alert/recovery semantics stay identical per node.
//
// Pure decision (clock injected, no I/O). resolveFleetNodes only parses env +
// derives default paths (no fs), so the whole module is unit-testable without a
// running manager or git.

import path from "node:path";
import {
  evaluateFreshness,
  INITIAL_FRESHNESS,
  type FreshnessAlert,
  type FreshnessEvalOptions,
  type FreshnessInput,
  type FreshnessState,
  type FreshnessTrackerState,
} from "./freshness.js";
import {
  evaluateRedeployCoupling,
  COHERENT_EMPTY_COUPLING,
  type RedeployCouplingSummary,
} from "./redeploy-coupling.js";
import type { ReleaseState } from "./release-state.js";

/** One node's freshness observation for a tick. */
export interface FleetNodeInput extends FreshnessInput {
  /** Stable node identity, e.g. "manager", "console-server", "kapelle-site". */
  node_id: string;
  /** Optional serving-checkout/lock diagnosis for non-manager ops nodes. */
  release_state?: ReleaseState | null;
}

/** Per-node freshness tracker state, keyed by node_id. */
export type FleetFreshnessState = Record<string, FreshnessTrackerState>;

export interface FleetNodeSummary {
  node_id: string;
  state: FreshnessState;
  behind_origin: boolean | null;
  behind_origin_since: string | null;
  build_sha: string | null;
  origin_main_sha: string | null;
  /** Checkout/lock guardrail: present for kapelle-site and other ops nodes. */
  release_state?: ReleaseState | null;
}

export interface FleetFreshnessSummary {
  /** True when ANY node is behind origin/main right now. */
  fleet_behind: boolean;
  /** Node ids that are stale (past the threshold, alerted or not). */
  stale_nodes: string[];
  /** Total nodes observed this tick. */
  node_count: number;
  nodes: FleetNodeSummary[];
  /** T-DEPLOY.3 — cross-node version-skew / coordinated-redeploy verdict. */
  coupling: RedeployCouplingSummary;
}

export interface FleetNodeAlert {
  node_id: string;
  alert: FreshnessAlert;
}

export interface FleetFreshnessResult {
  next: FleetFreshnessState;
  alerts: FleetNodeAlert[];
  summary: FleetFreshnessSummary;
}

export const EMPTY_FLEET_SUMMARY: FleetFreshnessSummary = {
  fleet_behind: false,
  stale_nodes: [],
  node_count: 0,
  nodes: [],
  coupling: COHERENT_EMPTY_COUPLING,
};

/**
 * Advance every fleet node's freshness tracker by one observation. Each node is
 * evaluated independently via the single-node evaluator (so a node's 15-min
 * stale threshold + hourly re-alert + recovery behavior are unchanged), then
 * folded into a fleet-wide summary + the list of per-node alerts to emit.
 *
 * Unobserved nodes (present in `prev` but not in `inputs` this tick) are dropped
 * from `next` — only currently-observed nodes are tracked, so a removed node
 * can't leak a stale tracker forever.
 */
export function evaluateFleetFreshness(
  prev: FleetFreshnessState,
  inputs: FleetNodeInput[],
  nowMs: number,
  opts: FreshnessEvalOptions = {},
): FleetFreshnessResult {
  const next: FleetFreshnessState = {};
  const alerts: FleetNodeAlert[] = [];
  const nodes: FleetNodeSummary[] = [];

  for (const input of inputs) {
    const prevState = prev[input.node_id] ?? INITIAL_FRESHNESS;
    const { next: nodeNext, alert } = evaluateFreshness(
      prevState,
      {
        behind_origin: input.behind_origin,
        build_sha: input.build_sha,
        origin_main_sha: input.origin_main_sha,
        source_branch_sha: input.source_branch_sha,
        source_branch_name: input.source_branch_name,
        classification: input.classification,
      },
      nowMs,
      opts,
    );
    next[input.node_id] = nodeNext;
    if (alert) alerts.push({ node_id: input.node_id, alert });
    nodes.push({
      node_id: input.node_id,
      state: nodeNext.state,
      behind_origin: input.behind_origin,
      behind_origin_since: nodeNext.behind_origin_since,
      build_sha: input.build_sha,
      origin_main_sha: input.origin_main_sha,
      release_state: input.release_state ?? null,
    });
  }

  const stale_nodes = nodes
    .filter((n) => n.state === "stale" || n.state === "stale_alerted")
    .map((n) => n.node_id);

  return {
    next,
    alerts,
    summary: {
      fleet_behind: nodes.some((n) => n.behind_origin === true),
      stale_nodes,
      node_count: nodes.length,
      nodes,
      coupling: evaluateRedeployCoupling(nodes),
    },
  };
}

/** A fleet node the manager should poll for build freshness. */
export interface FleetNodeConfig {
  node_id: string;
  /** True for the manager's own process — its build status is supplied directly
   *  by the caller (the running compiled stamp), not read from a repo dir. */
  is_self?: boolean;
  /** Git repo dir to read build status from (non-self nodes). */
  repoDir?: string;
  /** Dir holding build-info.json (non-self nodes; defaults to repoDir). */
  distDir?: string;
}

/**
 * Resolve the fleet to monitor. The manager (self) is always node 0. Additional
 * nodes come from `DEPLOY_FLEET_NODES` (comma list of `id:repoDir[:distDir]`).
 * Empty/stranger installs stay self-only by default so boot does not leak or
 * warn about operator-specific sibling checkouts. Set
 * `DEPLOY_FLEET_INFER_KAPELLE_SITE=true` to opt into the legacy inferred
 * kapelle-site sibling.
 */
export function resolveFleetNodes(
  env: NodeJS.ProcessEnv,
  managerRepoDir: string,
): FleetNodeConfig[] {
  const nodes: FleetNodeConfig[] = [{ node_id: "manager", is_self: true }];
  const raw = env.DEPLOY_FLEET_NODES?.trim();
  if (raw) {
    for (const entry of raw.split(",").map((s) => s.trim()).filter(Boolean)) {
      const [node_id, repoDir, distDir] = entry.split(":").map((s) => s.trim());
      if (node_id && repoDir) {
        nodes.push({ node_id, repoDir, distDir: distDir || repoDir });
      }
    }
    return nodes;
  }
  if (env.DEPLOY_FLEET_INFER_KAPELLE_SITE !== "true") {
    return nodes;
  }
  const kapelleSite = inferKapelleSiteRepoDir(managerRepoDir);
  nodes.push({ node_id: "kapelle-site", repoDir: kapelleSite, distDir: kapelleSite });
  return nodes;
}

export function inferKapelleSiteRepoDir(managerRepoDir: string): string {
  const managerParent = path.dirname(managerRepoDir);
  if (path.basename(managerRepoDir) === "id-agents" && path.basename(managerParent) === "cane") {
    return path.join(path.dirname(managerParent), "kapelle-site");
  }
  return path.join(managerParent, "kapelle-site");
}
