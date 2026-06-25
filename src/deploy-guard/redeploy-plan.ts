// T-DEPLOY.3 (2026-06-24) — coordinated-redeploy PLANNER: the all-or-hold gate.
//
// redeploy-coupling.ts DETECTS whether a coordinated redeploy is pending (version
// skew across manager / console / kapelle-site — incident I-4). This is the next
// safe step the manager greenlit: DECIDE redeploy_all vs hold vs noop, and emit
// the ordered redeploy PLAN.
//
// "Safest reversible option" by construction:
//   - all-or-HOLD: if the fleet can't be safely converged (a node's build is
//     unreadable, or the nodes don't agree on an origin target) we HOLD ALL and
//     redeploy nothing — never a partial redeploy that deepens the skew.
//   - PLAN only: this produces the ordered steps a human/automation runs; it does
//     NOT execute. The destructive cross-repo execution saga (D-IPR.4) stays HELD
//     on HC-6. Nothing here mutates a repo or restarts a process.
//   - manager LAST: dependents (console, kapelle-site) redeploy before the
//     coordinating manager, so the orchestrator stays up and an early failure
//     never leaves the manager half-redeployed.

import type { FleetNodeSummary } from "./fleet-freshness.js";
import { evaluateRedeployCoupling, type RedeployCouplingSummary } from "./redeploy-coupling.js";

export type RedeployAction = "noop" | "redeploy_all" | "hold";

export interface CoordinatedRedeployDecision {
  action: RedeployAction;
  /** The build every node should converge to (agreed origin/main), or null. */
  target_sha: string | null;
  /** Nodes a coordinated redeploy would bring to target (only when redeploy_all). */
  redeploy_nodes: string[];
  /** Why we hold instead of redeploying (only when action === "hold"). */
  blocked_reason: string | null;
  reason: string;
  /** The detection evidence this decision was derived from. */
  coupling: RedeployCouplingSummary;
}

/** One ordered, dry-run redeploy step (same shape as the rollback plan). */
export interface RedeployStep {
  node_id: string;
  label: string;
  cmd: string;
  args: string[];
}

export interface RedeployNodeConfig {
  node_id: string;
  repoDir: string;
  /** Per-node restart command; defaults to a placeholder env hook. */
  restartCmd?: string;
  /** Per-node build command; defaults to "npm run build". */
  buildCmd?: string;
}

/**
 * Decide the coordinated-redeploy action from the per-node freshness summaries.
 * Pure. The gate is all-or-hold (see file header). Order of checks matters:
 * unreadable nodes and a missing agreed target both force HOLD before we would
 * ever consider a redeploy.
 */
export function decideCoordinatedRedeploy(nodes: FleetNodeSummary[]): CoordinatedRedeployDecision {
  const coupling = evaluateRedeployCoupling(nodes);

  if (nodes.length === 0) {
    return { action: "noop", target_sha: null, redeploy_nodes: [], blocked_reason: null, reason: "no fleet nodes observed", coupling };
  }

  // HOLD: a node's running build is unreadable — we cannot know if it needs the
  // redeploy, so converging "everyone" is unsafe. Never redeploy a subset.
  if (coupling.unknown_nodes.length > 0) {
    return {
      action: "hold",
      target_sha: coupling.target_sha,
      redeploy_nodes: [],
      blocked_reason: `build unreadable on: ${coupling.unknown_nodes.join(", ")}`,
      reason: `hold — cannot coordinate a redeploy while a node's build is unreadable (${coupling.unknown_nodes.join(", ")})`,
      coupling,
    };
  }

  // HOLD: no agreed origin target across nodes — nothing safe to converge to.
  if (coupling.target_sha === null) {
    return {
      action: "hold",
      target_sha: null,
      redeploy_nodes: [],
      blocked_reason: "no agreed origin target across nodes",
      reason: "hold — nodes do not agree on an origin/main target to converge to",
      coupling,
    };
  }

  // Everything readable + an agreed target: any node not on target is a lagging
  // node a coordinated redeploy brings forward. None lagging => already converged.
  if (coupling.lagging_nodes.length === 0) {
    return { action: "noop", target_sha: coupling.target_sha, redeploy_nodes: [], blocked_reason: null, reason: `fleet coherent at target ${coupling.target_sha.slice(0, 7)}`, coupling };
  }

  return {
    action: "redeploy_all",
    target_sha: coupling.target_sha,
    redeploy_nodes: coupling.lagging_nodes,
    blocked_reason: null,
    reason:
      `redeploy_all — bring ${coupling.lagging_nodes.join(", ")} to ${coupling.target_sha.slice(0, 7)} together` +
      (coupling.coordinated_redeploy_pending ? " (version skew)" : " (fleet behind origin)"),
    coupling,
  };
}

/** Deterministic order: dependents first, the coordinating manager LAST. */
function redeployOrder(nodeIds: string[]): string[] {
  return [...nodeIds].sort((a, b) => {
    if (a === "manager") return 1;
    if (b === "manager") return -1;
    return a.localeCompare(b);
  });
}

/**
 * Build the ordered (dry-run) redeploy plan: per lagging node, pull → build →
 * restart, with the manager last. Pure — returns steps, runs nothing. A node
 * without a resolved repo config is skipped (we cannot plan what we cannot
 * locate); for a hold/noop decision the plan is empty.
 */
export function planCoordinatedRedeploySteps(
  decision: CoordinatedRedeployDecision,
  configs: RedeployNodeConfig[],
): RedeployStep[] {
  if (decision.action !== "redeploy_all") return [];

  const byId = new Map(configs.map((c) => [c.node_id, c]));
  const steps: RedeployStep[] = [];

  for (const nodeId of redeployOrder(decision.redeploy_nodes)) {
    const cfg = byId.get(nodeId);
    if (!cfg) continue; // unlocatable node — cannot safely plan it
    const buildCmd = cfg.buildCmd ?? "npm run build";
    const restartCmd = cfg.restartCmd ?? `: "redeploy ${nodeId} — supply restart via REDEPLOY_${nodeId.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_RESTART"`;
    steps.push({ node_id: nodeId, label: `pull ${nodeId}`, cmd: "git", args: ["-C", cfg.repoDir, "pull", "--ff-only"] });
    steps.push({ node_id: nodeId, label: `build ${nodeId}`, cmd: "bash", args: ["-lc", `cd ${cfg.repoDir} && ${buildCmd}`] });
    steps.push({ node_id: nodeId, label: `restart ${nodeId}`, cmd: "bash", args: ["-lc", restartCmd] });
  }

  return steps;
}
