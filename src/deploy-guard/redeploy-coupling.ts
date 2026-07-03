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

/** Cross-repo release coherence (spec §3). `n/a` = no manifest couples the nodes
 *  (different-repo SHAs are the normal, non-alarming state); `coherent` = every
 *  manifest-cohort node is at its pinned target; `incoherent` = a cohort node is
 *  off its target (a real, alarmable coupling gap). */
export type ReleaseCohort = "coherent" | "incoherent" | "n/a";

/** Optional release manifest (release-set.json): names a release and pins each
 *  node to a target build. ONLY within such a declared cohort does cross-node
 *  divergence become an alarmable "coordinated redeploy pending". */
export interface ReleaseManifest {
  release: string;
  /** node_id → the build_sha (or tag) this release pins the node to. */
  targets: Record<string, string>;
}

/** Parse a release-set.json body; returns null when absent/invalid (never faked). */
export function parseReleaseManifest(json: string | null | undefined): ReleaseManifest | null {
  if (!json) return null;
  try {
    const v = JSON.parse(json) as { release?: unknown; targets?: unknown };
    if (typeof v?.release !== "string") return null;
    if (!v.targets || typeof v.targets !== "object") return null;
    const targets: Record<string, string> = {};
    for (const [k, val] of Object.entries(v.targets as Record<string, unknown>)) {
      if (typeof val === "string" && val.trim()) targets[k] = val.trim();
    }
    if (Object.keys(targets).length === 0) return null;
    return { release: v.release, targets };
  } catch {
    return null;
  }
}

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
  /** Cross-repo release coherence (spec §3): `n/a` when no manifest couples the
   *  nodes (the normal state), else coherent/incoherent within the manifest cohort. */
  release_cohort: ReleaseCohort;
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
  release_cohort: "n/a",
  reason: "no fleet nodes observed",
};

function short(sha: string | null): string {
  return sha ? sha.slice(0, 7) : "unknown";
}

/**
 * Evaluate cross-node redeploy coupling from the per-node freshness summaries.
 * Pure, deterministic, no I/O.
 *
 * - `coordinated_redeploy_pending` fires ONLY within a coupled cohort:
 *     • with a release `manifest`, when a pinned cohort node is off its target;
 *     • without one, when nodes that AGREE on an origin (target_sha != null — a
 *       shared release line) run >1 distinct build.
 *   Different-repo nodes have DIFFERENT origin_main_shas → target_sha is null → no
 *   pending. This kills the permanent false-positive where manager (id-agents) and
 *   kapelle-site, being different repos, always had distinct build_shas (spec §3:
 *   "different SHAs across different repos is the normal state — never alarm").
 * - `target_sha` is the agreed origin/main; `lagging_nodes` are the nodes not yet
 *   on it (computable only when the target is agreed).
 * - Unreadable nodes (null build_sha) block `coherent` and are listed separately
 *   so the banner can say "console build unreadable" rather than silently passing.
 */
export function evaluateRedeployCoupling(
  nodes: FleetNodeSummary[],
  manifest?: ReleaseManifest | null,
): RedeployCouplingSummary {
  if (nodes.length === 0) return COHERENT_EMPTY_COUPLING;

  const unknown_nodes = nodes.filter((n) => !n.build_sha).map((n) => n.node_id);
  const known = nodes.filter((n) => n.build_sha) as Array<FleetNodeSummary & { build_sha: string }>;

  const running_shas = [...new Set(known.map((n) => n.build_sha))].sort();

  // Agreed origin/main target: all non-null origin_main_sha identical.
  const originShas = [...new Set(nodes.map((n) => n.origin_main_sha).filter((s): s is string => !!s))];
  const target_sha = originShas.length === 1 ? originShas[0] : null;

  const coherentBuilds = unknown_nodes.length === 0 && running_shas.length <= 1;

  // Manifest-driven cohort (spec §3): coupling is a declared, per-cohort target —
  // never inferred from raw cross-repo build_sha distinctness.
  if (manifest) {
    const cohort = nodes.filter((n) => manifest.targets[n.node_id] !== undefined);
    const offTarget = cohort
      .filter((n) => n.build_sha == null || n.build_sha !== manifest.targets[n.node_id])
      .map((n) => n.node_id);
    const pending = offTarget.length > 0;
    return {
      coordinated_redeploy_pending: pending,
      coherent: coherentBuilds,
      target_sha,
      running_shas,
      lagging_nodes: offTarget,
      unknown_nodes,
      release_cohort: pending ? "incoherent" : "coherent",
      reason: pending
        ? `release '${manifest.release}' INCOHERENT — off target: ${offTarget.join(", ")}`
        : `release '${manifest.release}' coherent (${cohort.length} node(s) at target)`,
    };
  }

  // No manifest: coupling only within a shared-origin release line (target_sha
  // agreed). Different-repo nodes disagree on origin → target_sha null → no pending.
  const lagging_nodes = target_sha
    ? known.filter((n) => n.build_sha !== target_sha).map((n) => n.node_id)
    : [];
  const skew = target_sha != null && running_shas.length > 1;

  let reason: string;
  if (skew) {
    const lag = lagging_nodes.length ? ` — lagging: ${lagging_nodes.join(", ")}` : "";
    reason =
      `coordinated redeploy pending: ${running_shas.length} distinct builds on the shared release line ` +
      `(${running_shas.map(short).join(", ")})${lag}`;
  } else if (unknown_nodes.length > 0) {
    reason = `build unreadable on: ${unknown_nodes.join(", ")}`;
  } else if (target_sha && lagging_nodes.length > 0) {
    // Uniform build but the whole fleet is behind the agreed origin — a deploy is
    // needed, but it is not a skew/coupling problem.
    reason = `fleet uniform at ${short(running_shas[0] ?? null)} but behind origin ${short(target_sha)} (deploy needed)`;
  } else if (running_shas.length > 1) {
    // Distinct builds but NO agreed origin → different repos, uncoupled: normal.
    reason = `cross-repo release set: mixed (uncoupled) — ${running_shas.length} distinct builds across repos, no coupling manifest`;
  } else if (known.length === 1) {
    reason = `single node ${known[0].node_id} at ${short(running_shas[0] ?? null)}`;
  } else {
    reason = `fleet coherent at ${short(running_shas[0] ?? null)}`;
  }

  return {
    coordinated_redeploy_pending: skew,
    coherent: coherentBuilds,
    target_sha,
    running_shas,
    lagging_nodes,
    unknown_nodes,
    release_cohort: "n/a",
    reason,
  };
}
