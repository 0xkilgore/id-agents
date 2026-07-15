import { DEFAULT_RECOVERY_CONFIG } from "../dispatch-recovery/classifier.js";
import { promotionCompletedAndVerified } from "../dispatch-scheduler/read-model.js";
import type { BacklogItem, BacklogRetryReadiness } from "./types.js";
import type { DispatchOutcome } from "./storage.js";

export const BACKLOG_RETRY_READINESS_SCHEMA_VERSION = "backlog.retry_readiness.v1" as const;
export const BACKLOG_RETRY_CAP = DEFAULT_RECOVERY_CONFIG.max_attempts;

export function attachBacklogRetryReadiness(
  items: BacklogItem[],
  outcomes: Map<string, DispatchOutcome>,
): BacklogItem[] {
  return items.map((item) => ({
    ...item,
    retry_readiness: deriveBacklogRetryReadiness(item, outcomes.get(item.last_dispatch_phid ?? "")),
  }));
}

export function deriveBacklogRetryReadiness(
  item: Pick<BacklogItem, "readiness_state" | "last_dispatch_phid" | "dispatch_retry_count">,
  outcome?: DispatchOutcome,
): BacklogRetryReadiness {
  const base = {
    schema_version: BACKLOG_RETRY_READINESS_SCHEMA_VERSION,
    prior_dispatch_phid: item.last_dispatch_phid ?? null,
    prior_dispatch_status: outcome?.status ?? null,
    dispatch_retry_count: item.dispatch_retry_count,
    retry_cap: BACKLOG_RETRY_CAP,
    failure_kind: outcome?.failure_kind ?? null,
    failure_detail: outcome?.failure_detail ?? null,
    recovery_status: outcome?.recovery_status ?? null,
    manual_promote_required: false,
  };

  if ((item.readiness_state !== "needs_review" && item.readiness_state !== "ready") || !item.last_dispatch_phid) {
    return {
      ...base,
      status: "not_retry_candidate",
      retryable: false,
      stale_duplicate: false,
      next_action: "none",
      reason: "row is not an already-dispatched ready/needs_review retry candidate",
    };
  }

  if (!outcome) {
    return {
      ...base,
      status: "waiting_on_live_dispatch",
      retryable: false,
      stale_duplicate: false,
      next_action: "wait",
      reason: "prior dispatch outcome is not readable yet; do not re-fire blindly",
    };
  }

  if (outcome.status === "queued" || outcome.status === "in_flight" || outcome.status === "needs_clarification") {
    return {
      ...base,
      status: "waiting_on_live_dispatch",
      retryable: false,
      stale_duplicate: false,
      next_action: "wait",
      reason: `prior dispatch is ${outcome.status}; retrying now would duplicate live work`,
    };
  }

  if (
    outcome.status === "done" ||
    outcome.status === "moot" ||
    outcome.status === "superseded" ||
    outcome.status === "cancelled" ||
    promotionCompletedAndVerified(outcome.promotion_result_json)
  ) {
    return {
      ...base,
      status: "stale_duplicate",
      retryable: false,
      stale_duplicate: true,
      next_action: "close_or_ignore",
      reason: "prior dispatch is terminal or landed; this backlog row is stale duplicate state, not retry fuel",
    };
  }

  if (outcome.status !== "failed") {
    return {
      ...base,
      status: "non_retryable_failed_row",
      retryable: false,
      stale_duplicate: false,
      next_action: "operator_review",
      reason: `prior dispatch status ${outcome.status} is not retryable by the backlog reconciler`,
    };
  }

  const attempts = Math.max(item.dispatch_retry_count, outcome.recovery_attempts);
  if (!dispatchFailureRetryable(outcome)) {
    return {
      ...base,
      status: "non_retryable_failed_row",
      retryable: false,
      stale_duplicate: false,
      next_action: "operator_review",
      reason: `prior dispatch failed non-transiently (${outcome.failure_kind ?? "unknown"})`,
    };
  }

  if (attempts >= BACKLOG_RETRY_CAP) {
    return {
      ...base,
      dispatch_retry_count: attempts,
      status: "retry_cap_reached",
      retryable: false,
      stale_duplicate: false,
      next_action: "operator_review",
      reason: `prior dispatch failed transiently but retry cap reached (${attempts}/${BACKLOG_RETRY_CAP})`,
    };
  }

  return {
    ...base,
    dispatch_retry_count: attempts,
    status: "retryable_failed_row",
    retryable: true,
    stale_duplicate: false,
    manual_promote_required: true,
    next_action: "retry",
    reason: `prior dispatch failed with retryable transient; retry ${attempts + 1}/${BACKLOG_RETRY_CAP} is allowed`,
  };
}

function dispatchFailureRetryable(outcome: {
  failure_kind: string | null;
  failure_detail: string | null;
}): boolean {
  if (outcome.failure_kind === "scheduler_wedged") return true;
  const detail = (outcome.failure_detail ?? "").toLowerCase();
  return DEFAULT_RECOVERY_CONFIG.retryable_detail_markers.some((marker) => detail.includes(marker.toLowerCase()));
}
