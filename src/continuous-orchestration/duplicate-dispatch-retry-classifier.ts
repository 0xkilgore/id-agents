import { DEFAULT_RECOVERY_CONFIG } from "../dispatch-recovery/classifier.js";
import { promotionCompletedAndVerified } from "../dispatch-scheduler/read-model.js";
import type { BacklogItem } from "./types.js";
import type { DispatchOutcome } from "./storage.js";

export const DUPLICATE_DISPATCH_RETRY_CLASSIFICATION_SCHEMA_VERSION =
  "orchestration.duplicate_dispatch_retry_classification.v2" as const;

export type DuplicateDispatchRetryDisposition = "close" | "supersede" | "mark-retry-safe";
export type DuplicateDispatchRetryOperatorDisposition = "close" | "retry" | "reroute" | "hold";
export type DuplicateDispatchRetrySafeRecommendation = "set_true" | "leave_false";
export type DuplicateDispatchFailureClass =
  | "linked_query_expired"
  | "dispatch_route_not_found"
  | "failed_verification"
  | "needs_input"
  | "live_or_queued"
  | "stale_duplicate"
  | "retryable_transient"
  | "non_retryable_failure"
  | "missing_prior_dispatch";

export interface DuplicateDispatchRetryClassificationItem {
  item_id: string;
  title: string;
  owner: string | null;
  readiness_state: "ready";
  prior_dispatch_id: string;
  prior_dispatch_status: string | null;
  prior_recovery_status: string | null;
  failure_kind: string | null;
  failure_detail: string | null;
  failure_class: DuplicateDispatchFailureClass;
  age_ms: number;
  age_hours: number;
  retry_safe_recommendation: DuplicateDispatchRetrySafeRecommendation;
  operator_disposition: DuplicateDispatchRetryOperatorDisposition;
  recommended_disposition: DuplicateDispatchRetryDisposition;
  reason: string;
}

export interface DuplicateDispatchRetryClassificationReport {
  schema_version: typeof DUPLICATE_DISPATCH_RETRY_CLASSIFICATION_SCHEMA_VERSION;
  dry_run: true;
  scanned: number;
  count: number;
  oldest_age_ms: number | null;
  oldest_age_hours: number | null;
  items: DuplicateDispatchRetryClassificationItem[];
}

const TERMINAL_CLOSE_STATUSES = new Set(["done"]);
const TERMINAL_SUPERSEDE_STATUSES = new Set(["cancelled", "moot", "superseded"]);

export function buildDuplicateDispatchRetryClassificationReport(
  items: BacklogItem[],
  outcomes: Map<string, DispatchOutcome>,
  opts: { now?: Date } = {},
): DuplicateDispatchRetryClassificationReport {
  const reportItems: DuplicateDispatchRetryClassificationItem[] = [];
  const nowMs = opts.now?.getTime() ?? Date.now();

  for (const item of items) {
    if (item.readiness_state !== "ready") continue;
    if (!item.last_dispatch_phid) continue;
    if (item.retry_safe) continue;

    const outcome = outcomes.get(item.last_dispatch_phid);
    const disposition = classifyDuplicateDispatchRetryDisposition(outcome);
    const ageMs = ageMsFromIso(item.created_at, nowMs);
    reportItems.push({
      item_id: item.item_id,
      title: item.title,
      owner: item.to_agent ?? null,
      readiness_state: "ready",
      prior_dispatch_id: item.last_dispatch_phid,
      prior_dispatch_status: outcome?.status ?? null,
      prior_recovery_status: outcome?.recovery_status ?? null,
      failure_kind: outcome?.failure_kind ?? null,
      failure_detail: outcome?.failure_detail ?? null,
      failure_class: classifyDuplicateDispatchFailure(outcome),
      age_ms: ageMs,
      age_hours: hours(ageMs),
      retry_safe_recommendation: disposition.retry_safe_recommendation,
      operator_disposition: disposition.operator_disposition,
      recommended_disposition: disposition.recommended_disposition,
      reason: disposition.reason,
    });
  }

  reportItems.sort((a, b) => a.item_id.localeCompare(b.item_id));
  const oldestAgeMs = reportItems.reduce<number | null>(
    (oldest, item) => oldest == null || item.age_ms > oldest ? item.age_ms : oldest,
    null,
  );

  return {
    schema_version: DUPLICATE_DISPATCH_RETRY_CLASSIFICATION_SCHEMA_VERSION,
    dry_run: true,
    scanned: items.length,
    count: reportItems.length,
    oldest_age_ms: oldestAgeMs,
    oldest_age_hours: oldestAgeMs == null ? null : hours(oldestAgeMs),
    items: reportItems,
  };
}

export function classifyDuplicateDispatchFailure(outcome: DispatchOutcome | undefined): DuplicateDispatchFailureClass {
  if (!outcome) return "missing_prior_dispatch";
  if (promotionCompletedAndVerified(outcome.promotion_result_json) || TERMINAL_CLOSE_STATUSES.has(outcome.status)) {
    return "stale_duplicate";
  }
  if (TERMINAL_SUPERSEDE_STATUSES.has(outcome.status)) return "stale_duplicate";
  if (outcome.status === "needs_clarification") return "needs_input";
  if (outcome.status === "queued" || outcome.status === "in_flight" || outcome.status === "bounced") {
    return "live_or_queued";
  }
  if (outcome.status === "failed" && isDispatchRouteNotFound(outcome)) return "dispatch_route_not_found";
  if (outcome.status === "failed" && isLinkedQueryExpired(outcome)) return "linked_query_expired";
  if (outcome.status === "failed" && isFailedVerification(outcome)) return "failed_verification";
  if (outcome.status === "failed" && dispatchFailureRetryable(outcome)) return "retryable_transient";
  if (outcome.status === "failed") return "non_retryable_failure";
  return "live_or_queued";
}

export function classifyDuplicateDispatchRetryDisposition(outcome: DispatchOutcome | undefined): {
  recommended_disposition: DuplicateDispatchRetryDisposition;
  operator_disposition: DuplicateDispatchRetryOperatorDisposition;
  retry_safe_recommendation: DuplicateDispatchRetrySafeRecommendation;
  reason: string;
} {
  if (!outcome) {
    return {
      recommended_disposition: "supersede",
      operator_disposition: "hold",
      retry_safe_recommendation: "leave_false",
      reason: "prior dispatch id is recorded but no dispatch row is readable; supersede the duplicate ready row before any refire",
    };
  }

  if (promotionCompletedAndVerified(outcome.promotion_result_json) || TERMINAL_CLOSE_STATUSES.has(outcome.status)) {
    return {
      recommended_disposition: "close",
      operator_disposition: "close",
      retry_safe_recommendation: "leave_false",
      reason: `prior dispatch ${outcome.dispatch_phid} is ${outcome.status} or promotion-verified; close the duplicate ready blocker`,
    };
  }

  if (TERMINAL_SUPERSEDE_STATUSES.has(outcome.status)) {
    return {
      recommended_disposition: "supersede",
      operator_disposition: "close",
      retry_safe_recommendation: "leave_false",
      reason: `prior dispatch ${outcome.dispatch_phid} is terminal ${outcome.status}; supersede the stale duplicate ready row`,
    };
  }

  if (outcome.status === "failed" && isDispatchRouteNotFound(outcome)) {
    return {
      recommended_disposition: "supersede",
      operator_disposition: "reroute",
      retry_safe_recommendation: "leave_false",
      reason:
        `prior dispatch ${outcome.dispatch_phid} failed because the target route returned HTTP 404; ` +
        "reroute to a healthy compatible owner or supersede the stale target pin before retry",
    };
  }

  if (outcome.status === "failed" && dispatchFailureRetryable(outcome)) {
    return {
      recommended_disposition: "mark-retry-safe",
      operator_disposition: "retry",
      retry_safe_recommendation: "set_true",
      reason: `prior dispatch ${outcome.dispatch_phid} failed with retryable transient evidence; mark retry_safe only if the operator wants a bounded refire`,
    };
  }

  if (outcome.status === "failed" && isFailedVerification(outcome)) {
    return {
      recommended_disposition: "supersede",
      operator_disposition: "hold",
      retry_safe_recommendation: "leave_false",
      reason: `prior dispatch ${outcome.dispatch_phid} failed promotion verification; operator review required before replacing or closing the row`,
    };
  }

  if (outcome.status === "failed") {
    return {
      recommended_disposition: "supersede",
      operator_disposition: "close",
      retry_safe_recommendation: "leave_false",
      reason: `prior dispatch ${outcome.dispatch_phid} failed non-transiently (${outcome.failure_kind ?? "unknown"}); supersede instead of blind retry`,
    };
  }

  return {
    recommended_disposition: "supersede",
    operator_disposition: "hold",
    retry_safe_recommendation: "leave_false",
    reason: `prior dispatch ${outcome.dispatch_phid} is non-terminal ${outcome.status}; supersede or wait on the prior dispatch rather than refiring this ready row`,
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

function isLinkedQueryExpired(outcome: { failure_detail: string | null }): boolean {
  return (outcome.failure_detail ?? "").toLowerCase().includes("linked query terminated expired");
}

function isDispatchRouteNotFound(outcome: { failure_kind: string | null; failure_detail: string | null }): boolean {
  const text = `${outcome.failure_kind ?? ""}\n${outcome.failure_detail ?? ""}`.toLowerCase();
  if (!/(?:\bhttp\s*404\b|\b404\b|not found|not_found|no url for agent|agent .* not found)/i.test(text)) {
    return false;
  }
  return /(?:dispatch|route|routing|target|agent|gaudi|verification|verify)/i.test(text);
}

function isFailedVerification(outcome: DispatchOutcome): boolean {
  if (!outcome.promotion_result_json) return false;
  if (promotionCompletedAndVerified(outcome.promotion_result_json)) return false;
  try {
    const parsed = JSON.parse(outcome.promotion_result_json) as { required?: unknown; completed?: unknown; repos?: unknown };
    return parsed.completed === false || parsed.required === true || Array.isArray(parsed.repos);
  } catch {
    return true;
  }
}

function ageMsFromIso(value: string, nowMs: number): number {
  const then = Date.parse(value);
  if (!Number.isFinite(then)) return 0;
  return Math.max(0, nowMs - then);
}

function hours(ms: number): number {
  return Math.round((ms / 3_600_000) * 100) / 100;
}
