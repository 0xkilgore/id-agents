import {
  reconcileAuthoritativeLifecycleDryRun,
  type AuthoritativeLifecycleInputs,
  type ReconciliationAction,
} from "./authoritative-lifecycle-reconciler.js";

export type LifecycleProjectionSource = "task" | "dispatch";

export interface LifecycleStatusProjection {
  schema_version: "orchestration.lifecycle_status_projection.v1";
  source: { kind: LifecycleProjectionSource; id: string };
  reconciliation: {
    state: ReturnType<typeof reconcileAuthoritativeLifecycleDryRun>["status"];
    reason: string;
    evidence: string[];
    blocks_dependency_chain: boolean;
  };
  owner: { id: string | null; assigned: boolean };
  next_action: {
    kind: ReconciliationAction | "promote" | "deploy" | "verify_acceptance" | "none";
    reason: string;
    evidence: string[];
  };
  promotion_validation: {
    required: boolean;
    completed: boolean;
    verified: boolean;
    sha_match: boolean;
    state: "not_required" | "missing" | "invalid" | "verified";
    promoted_sha: string | null;
    remote_main_sha: string | null;
  };
  deploy_freshness: {
    available: boolean;
    fresh: boolean;
    sha_match: boolean;
    state: "unavailable" | "stale" | "fresh";
    running_sha: string | null;
    promoted_main_sha: string | null;
  };
  read_only: true;
}

function fallbackNextAction(
  state: LifecycleStatusProjection["reconciliation"]["state"],
): LifecycleStatusProjection["next_action"] {
  if (state === "done_unintegrated") return { kind: "promote", reason: "verify and complete required promotion", evidence: ["reconciliation.state"] };
  if (state === "promoted") return { kind: "deploy", reason: "deploy promoted main and verify runtime freshness", evidence: ["reconciliation.state"] };
  if (state === "deployed_fresh") return { kind: "verify_acceptance", reason: "record explicit acceptance evidence", evidence: ["reconciliation.state"] };
  return { kind: "none", reason: "no lifecycle action is currently derived", evidence: ["reconciliation.state"] };
}

/** Stable read-only contract shared by task and dispatch views. */
export function projectLifecycleStatus(input: {
  source: { kind: LifecycleProjectionSource; id: string };
  owner: string | null;
  facts: AuthoritativeLifecycleInputs;
}): LifecycleStatusProjection {
  const dryRun = reconcileAuthoritativeLifecycleDryRun(input.facts);
  const promotion = input.facts.promotion;
  const promotionShaMatch = Boolean(promotion?.promoted_sha && promotion.remote_main_sha && promotion.promoted_sha === promotion.remote_main_sha);
  const promotionState = !promotion?.required
    ? "not_required"
    : !promotion.completed
      ? "missing"
      : promotion.verified && promotionShaMatch
        ? "verified"
        : "invalid";
  const deploy = input.facts.deploy;
  const deployShaMatch = Boolean(deploy?.running_sha && deploy.promoted_main_sha && deploy.running_sha === deploy.promoted_main_sha);
  const deployState = !deploy?.health_available ? "unavailable" : deploy.fresh && deployShaMatch ? "fresh" : "stale";
  const suggested = dryRun.suggested_actions[0];

  return {
    schema_version: "orchestration.lifecycle_status_projection.v1",
    source: input.source,
    reconciliation: {
      state: dryRun.status,
      reason: dryRun.reason,
      evidence: dryRun.evidence,
      blocks_dependency_chain: dryRun.blocks_dependency_chain,
    },
    owner: { id: input.owner, assigned: input.owner !== null },
    next_action: suggested
      ? { kind: suggested.action, reason: suggested.reason, evidence: suggested.evidence }
      : fallbackNextAction(dryRun.status),
    promotion_validation: {
      required: promotion?.required ?? false,
      completed: promotion?.completed ?? false,
      verified: promotion?.verified ?? false,
      sha_match: promotionShaMatch,
      state: promotionState,
      promoted_sha: promotion?.promoted_sha ?? null,
      remote_main_sha: promotion?.remote_main_sha ?? null,
    },
    deploy_freshness: {
      available: deploy?.health_available ?? false,
      fresh: deploy?.fresh ?? false,
      sha_match: deployShaMatch,
      state: deployState,
      running_sha: deploy?.running_sha ?? null,
      promoted_main_sha: deploy?.promoted_main_sha ?? null,
    },
    read_only: true,
  };
}
