// T-DEPLOY.3 — coupled manager+console redeploy: the DETECTION primitive.
//
// Incident I-4: the console server ran a stale build after the manager upgraded
// underneath it (manager + kapelle-site deploy independently, no lockstep), and
// `/ops` broke from the version skew. T-DEPLOY.1 already answers "is a node
// behind origin?" (fleet_behind / stale_nodes). This answers the DIFFERENT,
// coupling-shaped question: "are the fleet nodes running the SAME build, or is
// one behind another?" — i.e. is a *coordinated* redeploy pending.
//
// This is only the detection half. The atomic redeploy execution (the cross-repo
// saga from D-IPR.4) is HELD on saga-POC ownership (HC-6); this primitive is what
// the /ops banner reads to show "coordinated redeploy pending" today, and what
// that future saga will gate on. Pure: derived from the per-node freshness
// summaries, no I/O.

import type { FleetNodeSummary } from "./fleet-freshness.js";

export interface RedeployCouplingSummary {
  /** True when observed nodes are running >1 distinct build (version skew). The
   *  exact I-4 condition: one node has been redeployed and another has not. */
  coordinated_redeploy_pending: boolean;
  /** True when every observed node runs the SAME known build (no skew, no
   *  unreadable node). Whether that shared build is also current vs origin is a
   *  separate axis (fleet_behind in the fleet summary). */
  coherent: boolean;
  /** The build the fleet should converge to: the agreed origin/main across nodes
   *  (all non-null `origin_main_sha` identical), else null when nodes disagree or
   *  none reported one. */
  target_sha: string | null;
  /** Distinct running build SHAs observed across nodes, sorted (the evidence). */
  running_shas: string[];
  /** Nodes whose running build != `target_sha` (only when target is known). The
   *  nodes a coordinated redeploy would bring forward. */
  lagging_nodes: string[];
  /** Nodes whose running build could not be read (null build_sha). */
  unknown_nodes: string[];
  /** Human-readable one-liner for the /ops banner. */
  reason: string;
}

export const COHERENT_EMPTY_COUPLING: RedeployCouplingSummary = {
  coordinated_redeploy_pending: false,
  coherent: false,
  target_sha: null,
  running_shas: [],
  lagging_nodes: [],
  unknown_nodes: [],
  reason: "no fleet nodes observed",
};

function short(sha: string | null): string {
  return sha ? sha.slice(0, 7) : "unknown";
}

/**
 * Evaluate cross-node redeploy coupling from the per-node freshness summaries.
 * Pure, deterministic, no I/O.
 *
 * - `coordinated_redeploy_pending` fires on version SKEW (nodes running >1
 *   distinct build) — the I-4 case, regardless of origin. Nodes uniformly behind
 *   origin at the SAME build are NOT skew (that's fleet_behind's job); they need
 *   a deploy but not a *coordinating* one.
 * - `target_sha` is the agreed origin/main; `lagging_nodes` are the nodes not yet
 *   on it (computable only when the target is agreed).
 * - Unreadable nodes (null build_sha) block `coherent` and are listed separately
 *   so the banner can say "console build unreadable" rather than silently passing.
 */
export function evaluateRedeployCoupling(nodes: FleetNodeSummary[]): RedeployCouplingSummary {
  if (nodes.length === 0) return COHERENT_EMPTY_COUPLING;

  const unknown_nodes = nodes.filter((n) => !n.build_sha).map((n) => n.node_id);
  const known = nodes.filter((n) => n.build_sha) as Array<FleetNodeSummary & { build_sha: string }>;

  const running_shas = [...new Set(known.map((n) => n.build_sha))].sort();

  // Agreed origin/main target: all non-null origin_main_sha identical.
  const originShas = [...new Set(nodes.map((n) => n.origin_main_sha).filter((s): s is string => !!s))];
  const target_sha = originShas.length === 1 ? originShas[0] : null;

  const lagging_nodes = target_sha
    ? known.filter((n) => n.build_sha !== target_sha).map((n) => n.node_id)
    : [];

  const skew = running_shas.length > 1;
  const coherent = unknown_nodes.length === 0 && running_shas.length <= 1;

  let reason: string;
  if (skew) {
    const lag = lagging_nodes.length ? ` — lagging: ${lagging_nodes.join(", ")}` : "";
    reason =
      `coordinated redeploy pending: ${running_shas.length} distinct builds across the fleet ` +
      `(${running_shas.map(short).join(", ")})${lag}`;
  } else if (unknown_nodes.length > 0) {
    reason = `build unreadable on: ${unknown_nodes.join(", ")}`;
  } else if (target_sha && lagging_nodes.length > 0) {
    // Uniform build but the whole fleet is behind the agreed origin — a deploy is
    // needed, but it is not a skew/coupling problem.
    reason = `fleet uniform at ${short(running_shas[0] ?? null)} but behind origin ${short(target_sha)} (deploy needed)`;
  } else if (known.length === 1) {
    reason = `single node ${known[0].node_id} at ${short(running_shas[0] ?? null)}`;
  } else {
    reason = `fleet coherent at ${short(running_shas[0] ?? null)}`;
  }

  return {
    coordinated_redeploy_pending: skew,
    coherent,
    target_sha,
    running_shas,
    lagging_nodes,
    unknown_nodes,
    reason,
  };
}
