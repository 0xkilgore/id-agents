import { DEFAULT_RECOVERY_CONFIG } from "../dispatch-recovery/classifier.js";
import { duplicateDispatchTerminalDisposition } from "./duplicate-dispatch-terminal-disposition.js";
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
  readiness_state: "ready" | "needs_review";
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

export interface StaleNeedsClarificationRetryBlockerReport {
  schema_version: "orchestration.stale_needs_clarification_retry_blockers.v1";
  dry_run: true;
  older_than_hours: number;
  limit: number;
  matched: number;
  count: number;
  truncated: boolean;
  guidance: string;
  items: Array<DuplicateDispatchRetryClassificationItem & {
    prior_dispatch_updated_at: string;
    prior_dispatch_age_ms: number;
    prior_dispatch_age_hours: number;
    operator_action: "review_then_supersede";
  }>;
}

export function buildStaleNeedsClarificationRetryBlockerReport(
  items: BacklogItem[],
  outcomes: Map<string, DispatchOutcome>,
  opts: { now?: Date; olderThanHours?: number; limit?: number } = {},
): StaleNeedsClarificationRetryBlockerReport {
  const nowMs = opts.now?.getTime() ?? Date.now();
  const olderThanHours = Math.max(1, opts.olderThanHours ?? 24);
  const limit = Math.max(1, Math.min(100, Math.floor(opts.limit ?? 25)));
  const cutoffMs = olderThanHours * 60 * 60 * 1000;
  const classified = buildDuplicateDispatchRetryClassificationReport(items, outcomes, { now: opts.now });
  const matches = classified.items.flatMap((item) => {
    const outcome = outcomes.get(item.prior_dispatch_id);
    if (outcome?.status !== "needs_clarification" || !outcome.updated_at) return [];
    const dispatchAgeMs = ageMsFromIso(outcome.updated_at, nowMs);
    if (dispatchAgeMs <= cutoffMs) return [];
    return [{
      ...item,
      prior_dispatch_updated_at: outcome.updated_at,
      prior_dispatch_age_ms: dispatchAgeMs,
      prior_dispatch_age_hours: hours(dispatchAgeMs),
      operator_action: "review_then_supersede" as const,
      retry_safe_recommendation: "leave_false" as const,
      recommended_disposition: "supersede" as const,
      reason:
        `prior dispatch ${item.prior_dispatch_id} has needed clarification for more than ${olderThanHours}h; ` +
        "after operator review, supersede the blocked ready row without marking retry_safe",
    }];
  }).sort((a, b) => b.prior_dispatch_age_ms - a.prior_dispatch_age_ms || a.item_id.localeCompare(b.item_id));

  return {
    schema_version: "orchestration.stale_needs_clarification_retry_blockers.v1",
    dry_run: true,
    older_than_hours: olderThanHours,
    limit,
    matched: matches.length,
    count: Math.min(matches.length, limit),
    truncated: matches.length > limit,
    guidance: "Review the outstanding clarification and prior dispatch context; if obsolete, explicitly supersede the ready row. Do not mark retry_safe.",
    items: matches.slice(0, limit),
  };
}

export function buildDuplicateDispatchRetryClassificationReport(
  items: BacklogItem[],
  outcomes: Map<string, DispatchOutcome>,
  opts: { now?: Date } = {},
): DuplicateDispatchRetryClassificationReport {
  const reportItems: DuplicateDispatchRetryClassificationItem[] = [];
  const nowMs = opts.now?.getTime() ?? Date.now();

  for (const item of items) {
    if (item.readiness_state !== "ready" && item.readiness_state !== "needs_review") continue;
    if (!item.last_dispatch_phid) continue;
    if (item.retry_safe) continue;

    const outcome = outcomes.get(item.last_dispatch_phid);
    const disposition = classifyDuplicateDispatchRetryDisposition(outcome);
    const ageMs = ageMsFromIso(item.created_at, nowMs);
    reportItems.push({
      item_id: item.item_id,
      title: item.title,
      owner: item.to_agent ?? null,
      readiness_state: item.readiness_state,
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
  if (duplicateDispatchTerminalDisposition(outcome).terminal) return "stale_duplicate";
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

  const terminal = duplicateDispatchTerminalDisposition(outcome);
  if (terminal.terminal && terminal.status === "done") {
    return {
      recommended_disposition: "close",
      operator_disposition: "close",
      retry_safe_recommendation: "leave_false",
      reason: `prior dispatch ${outcome.dispatch_phid} is terminal or promotion-verified; close the duplicate ready blocker`,
    };
  }

  if (terminal.terminal && terminal.status) {
    return {
      recommended_disposition: "supersede",
      operator_disposition: "close",
      retry_safe_recommendation: "leave_false",
      reason: `prior dispatch ${outcome.dispatch_phid} is terminal ${terminal.status}; supersede the stale duplicate ready row`,
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

  if (outcome.status === "failed" && isLinkedQueryExpired(outcome)) {
    return {
      recommended_disposition: "supersede",
      operator_disposition: "close",
      retry_safe_recommendation: "leave_false",
      reason: `prior dispatch ${outcome.dispatch_phid} ended after linked query expiry; supersede the stale duplicate ready row instead of refiring`,
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
  if (duplicateDispatchTerminalDisposition(outcome).promotion_verified) return false;
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
