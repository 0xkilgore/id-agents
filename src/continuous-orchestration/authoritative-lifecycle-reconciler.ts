/**
 * Pure, dry-run lifecycle reconciliation for one orchestration unit.
 *
 * This module deliberately owns no storage or mutation path. Callers assemble
 * bounded read-model facts, then may inspect the derived status and suggested
 * ledger actions. A later apply slice can execute those suggestions with its
 * own authorization and receipt contract.
 */

export type AuthoritativeLifecycleStatus =
  | "active"
  | "needs_input"
  | "resume_failed"
  | "done_unintegrated"
  | "promoted"
  | "deployed_fresh"
  | "accepted"
  | "superseded"
  | "failed_needs_owner"
  | "moot";

export type ReconciliationAction =
  | "auto_close"
  | "supersede"
  | "retry_safe_mark"
  | "hold"
  | "release";

export interface LifecyclePromotionRead {
  required: boolean;
  completed: boolean;
  verified: boolean;
  promoted_sha: string | null;
  remote_main_sha: string | null;
}

export interface LifecycleDeployRead {
  fresh: boolean;
  running_sha: string | null;
  promoted_main_sha: string | null;
}

export interface LifecycleAcceptanceRead {
  accepted: boolean;
  evidence_refs: string[];
}

export interface LifecycleClarificationRead {
  state: "none" | "active" | "stale" | "resume_failed";
  owner: string | null;
}

export interface LifecycleBacklogRead {
  state: string | null;
  stale_duplicate: boolean;
  prior_dispatch_terminal: boolean;
  prior_work_landed: boolean;
}

export interface AuthoritativeLifecycleInputs {
  dispatch_status: string | null;
  dispatch_recovery_status?: string | null;
  task_status: string | null;
  promotion: LifecyclePromotionRead | null;
  deploy: LifecycleDeployRead | null;
  acceptance: LifecycleAcceptanceRead | null;
  clarification: LifecycleClarificationRead | null;
  backlog: LifecycleBacklogRead | null;
}

export interface LifecycleActionSuggestion {
  action: ReconciliationAction;
  reason: string;
  evidence: string[];
}

export interface AuthoritativeLifecycleDryRun {
  schema_version: "orchestration.authoritative_lifecycle_reconciliation.v1";
  mode: "dry_run";
  status: AuthoritativeLifecycleStatus;
  reason: string;
  evidence: string[];
  suggested_actions: LifecycleActionSuggestion[];
  blocks_dependency_chain: boolean;
  mutates: false;
}

export interface AuthoritativeLifecycleDryRunCounts {
  schema_version: "orchestration.authoritative_lifecycle_reconciliation_counts.v1";
  mode: "dry_run";
  total: number;
  counts: Record<AuthoritativeLifecycleStatus, number>;
  results: AuthoritativeLifecycleDryRun[];
  mutates: false;
}

const LIFECYCLE_STATUSES: readonly AuthoritativeLifecycleStatus[] = [
  "active",
  "needs_input",
  "resume_failed",
  "done_unintegrated",
  "promoted",
  "deployed_fresh",
  "accepted",
  "superseded",
  "failed_needs_owner",
  "moot",
];

const ACTIVE_DISPATCH = new Set(["queued", "claimed", "in_flight", "running"]);
const DONE_DISPATCH = new Set(["done", "done_recovered"]);
const FAILED_DISPATCH = new Set(["failed", "expired", "resume_delivery_failed"]);
const DONE_TASK = new Set(["done", "landed", "promoted", "shipped", "closed"]);
const FAILED_TASK = new Set(["failed", "blocked", "cancelled"]);
const LANDED_RECOVERY = new Set(["done_recovered", "failed_work_landed_recoverable", "work_landed"]);

function promotionVerified(read: LifecyclePromotionRead | null): boolean {
  if (!read?.completed || !read.verified) return false;
  return Boolean(read.promoted_sha && read.remote_main_sha && read.promoted_sha === read.remote_main_sha);
}

function deployFresh(read: LifecycleDeployRead | null, promotion: LifecyclePromotionRead | null): boolean {
  if (!read?.fresh || !promotionVerified(promotion)) return false;
  return Boolean(read.running_sha && read.promoted_main_sha && read.running_sha === read.promoted_main_sha);
}

function staleDuplicateSuggestion(backlog: LifecycleBacklogRead | null): LifecycleActionSuggestion[] {
  if (!backlog?.stale_duplicate || (!backlog.prior_dispatch_terminal && !backlog.prior_work_landed)) return [];
  if (backlog.prior_work_landed) {
    return [{
      action: "auto_close",
      reason: "stale duplicate points to landed work; close it instead of retrying",
      evidence: ["backlog.stale_duplicate", "backlog.prior_work_landed"],
    }];
  }
  return [{
    action: "supersede",
    reason: "stale duplicate points to a terminal dispatch; supersede it instead of retrying",
    evidence: ["backlog.stale_duplicate", "backlog.prior_dispatch_terminal"],
  }];
}

function result(
  status: AuthoritativeLifecycleStatus,
  reason: string,
  evidence: string[],
  suggested_actions: LifecycleActionSuggestion[],
  blocksDependencyChain = false,
): AuthoritativeLifecycleDryRun {
  return {
    schema_version: "orchestration.authoritative_lifecycle_reconciliation.v1",
    mode: "dry_run",
    status,
    reason,
    evidence,
    suggested_actions,
    blocks_dependency_chain: blocksDependencyChain,
    mutates: false,
  };
}

/** Derive one roadmap-reset lifecycle status without applying mutations. */
export function reconcileAuthoritativeLifecycleDryRun(
  input: AuthoritativeLifecycleInputs,
): AuthoritativeLifecycleDryRun {
  const dispatch = input.dispatch_status?.toLowerCase() ?? null;
  const task = input.task_status?.toLowerCase() ?? null;
  const backlog = input.backlog?.state?.toLowerCase() ?? null;
  const recovery = input.dispatch_recovery_status?.toLowerCase() ?? null;
  const duplicateActions = staleDuplicateSuggestion(input.backlog);

  if (backlog === "superseded" || dispatch === "superseded") {
    return result("superseded", "the unit is explicitly superseded", [backlog === "superseded" ? "backlog.state" : "dispatch.status"], duplicateActions);
  }
  if (backlog === "moot" || dispatch === "moot" || dispatch === "cancelled") {
    return result("moot", "the unit has no remaining work to perform", [backlog === "moot" ? "backlog.state" : "dispatch.status"], duplicateActions);
  }
  if (input.clarification?.state === "resume_failed" || dispatch === "resume_delivery_failed") {
    return result("resume_failed", "clarification resume delivery failed", ["clarification.state"], [
      ...duplicateActions,
      { action: "hold", reason: "hold only this dependency chain until resume repair is owned", evidence: ["clarification.state", "clarification.owner"] },
    ], true);
  }
  if (input.clarification && input.clarification.state !== "none") {
    return result("needs_input", `${input.clarification.state} clarification requires input`, ["clarification.state", "clarification.owner"], [
      ...duplicateActions,
      { action: "hold", reason: "hold only the clarification dependency chain", evidence: ["clarification.state"] },
    ], true);
  }
  if ((dispatch && FAILED_DISPATCH.has(dispatch)) || (task && FAILED_TASK.has(task))) {
    return result("failed_needs_owner", "terminal failure needs an explicit owner and disposition", [dispatch && FAILED_DISPATCH.has(dispatch) ? "dispatch.status" : "task.status"], duplicateActions);
  }
  if (input.acceptance?.accepted && input.acceptance.evidence_refs.length > 0) {
    return result("accepted", "acceptance is backed by explicit evidence", ["acceptance.accepted", ...input.acceptance.evidence_refs], duplicateActions);
  }
  if (deployFresh(input.deploy, input.promotion)) {
    return result("deployed_fresh", "running and promoted main SHAs are aligned", ["promotion.verified", "deploy.fresh", "deploy.running_sha=deploy.promoted_main_sha"], duplicateActions);
  }
  if (promotionVerified(input.promotion)) {
    return result("promoted", "promotion completed, verified, and remote main matches", ["promotion.completed", "promotion.verified", "promotion.promoted_sha=promotion.remote_main_sha"], duplicateActions);
  }

  const completed =
    (dispatch !== null && DONE_DISPATCH.has(dispatch))
    || (task !== null && DONE_TASK.has(task))
    || (recovery !== null && LANDED_RECOVERY.has(recovery))
    || input.backlog?.prior_work_landed === true;
  if (completed) {
    const promotionMissing = input.promotion?.required === true;
    return result(
      "done_unintegrated",
      promotionMissing ? "work is done but required promotion is not verified" : "work is done but release/acceptance integration is not proven",
      [dispatch && DONE_DISPATCH.has(dispatch) ? "dispatch.status" : task && DONE_TASK.has(task) ? "task.status" : "dispatch.recovery_status"],
      duplicateActions,
    );
  }

  if ((dispatch && ACTIVE_DISPATCH.has(dispatch)) || backlog === "queued" || backlog === "in_flight" || task === "doing") {
    return result("active", "the dispatch, task, or backlog row is active", [dispatch && ACTIVE_DISPATCH.has(dispatch) ? "dispatch.status" : task === "doing" ? "task.status" : "backlog.state"], duplicateActions);
  }

  return result("active", "no terminal or integration evidence is present", ["default.non_terminal"], duplicateActions);
}

/** Classify a bounded caller-provided snapshot and return stable dry-run counts. */
export function reconcileAuthoritativeLifecycleBatchDryRun(
  inputs: readonly AuthoritativeLifecycleInputs[],
): AuthoritativeLifecycleDryRunCounts {
  const counts = Object.fromEntries(
    LIFECYCLE_STATUSES.map((status) => [status, 0]),
  ) as Record<AuthoritativeLifecycleStatus, number>;
  const results = inputs.map((input) => reconcileAuthoritativeLifecycleDryRun(input));
  for (const entry of results) counts[entry.status] += 1;

  return {
    schema_version: "orchestration.authoritative_lifecycle_reconciliation_counts.v1",
    mode: "dry_run",
    total: results.length,
    counts,
    results,
    mutates: false,
  };
}
