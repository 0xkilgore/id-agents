import { DEFAULT_RECOVERY_CONFIG } from "../dispatch-recovery/classifier.js";
import { promotionCompletedAndVerified } from "../dispatch-scheduler/read-model.js";
import type { DispatchOutcome } from "./storage.js";

export const DUPLICATE_DISPATCH_RETRY_RECEIPT_SCHEMA_VERSION =
  "orchestration.duplicate_dispatch_retry_receipt.v1" as const;

export type DuplicateDispatchRetryNextAction =
  | "wait_on_prior_dispatch"
  | "close_duplicate_row"
  | "supersede_duplicate_row"
  | "mark_retry_safe_to_refire";

export interface DuplicateDispatchRetryReceipt {
  schema_version: typeof DUPLICATE_DISPATCH_RETRY_RECEIPT_SCHEMA_VERSION;
  last_dispatch_phid: string;
  retry_safe: false;
  retry_safe_required: true;
  prior_dispatch_status: string | null;
  prior_recovery_status: string | null;
  next_action: DuplicateDispatchRetryNextAction;
  operator_disposition: "hold" | "close" | "retry";
  retry_safe_recommendation: "leave_false" | "set_true";
  reason: string;
}

export function duplicateDispatchRetryReceipt(
  lastDispatchPhid: string,
  outcome: DispatchOutcome | undefined,
): DuplicateDispatchRetryReceipt {
  const base = {
    schema_version: DUPLICATE_DISPATCH_RETRY_RECEIPT_SCHEMA_VERSION,
    last_dispatch_phid: lastDispatchPhid,
    retry_safe: false,
    retry_safe_required: true,
    prior_dispatch_status: outcome?.status ?? null,
    prior_recovery_status: outcome?.recovery_status ?? null,
  } as const;

  if (!outcome) {
    return {
      ...base,
      next_action: "wait_on_prior_dispatch",
      operator_disposition: "hold",
      retry_safe_recommendation: "leave_false",
      reason: "prior dispatch outcome is not readable yet; hold this row instead of firing a duplicate dispatch",
    };
  }

  if (promotionCompletedAndVerified(outcome.promotion_result_json) || outcome.status === "done") {
    return {
      ...base,
      next_action: "close_duplicate_row",
      operator_disposition: "close",
      retry_safe_recommendation: "leave_false",
      reason: `prior dispatch ${outcome.dispatch_phid} is terminal or promotion-verified; close the duplicate ready row`,
    };
  }

  if (outcome.status === "cancelled" || outcome.status === "moot") {
    return {
      ...base,
      next_action: "supersede_duplicate_row",
      operator_disposition: "close",
      retry_safe_recommendation: "leave_false",
      reason: `prior dispatch ${outcome.dispatch_phid} is ${outcome.status}; supersede the stale duplicate ready row`,
    };
  }

  if (outcome.status === "failed" && dispatchFailureRetryable(outcome)) {
    return {
      ...base,
      next_action: "mark_retry_safe_to_refire",
      operator_disposition: "retry",
      retry_safe_recommendation: "set_true",
      reason: `prior dispatch ${outcome.dispatch_phid} failed with retryable transient evidence; set retry_safe only for an intentional bounded refire`,
    };
  }

  if (outcome.status === "failed") {
    return {
      ...base,
      next_action: "supersede_duplicate_row",
      operator_disposition: "close",
      retry_safe_recommendation: "leave_false",
      reason: `prior dispatch ${outcome.dispatch_phid} failed non-transiently (${outcome.failure_kind ?? "unknown"}); supersede instead of blind retry`,
    };
  }

  return {
    ...base,
    next_action: "wait_on_prior_dispatch",
    operator_disposition: "hold",
    retry_safe_recommendation: "leave_false",
    reason: `prior dispatch ${outcome.dispatch_phid} is ${outcome.status}; wait or supersede rather than refiring this row`,
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
