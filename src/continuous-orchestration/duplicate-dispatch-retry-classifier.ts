import { DEFAULT_RECOVERY_CONFIG } from "../dispatch-recovery/classifier.js";
import { promotionCompletedAndVerified } from "../dispatch-scheduler/read-model.js";
import type { BacklogItem } from "./types.js";
import type { DispatchOutcome } from "./storage.js";

export const DUPLICATE_DISPATCH_RETRY_CLASSIFICATION_SCHEMA_VERSION =
  "orchestration.duplicate_dispatch_retry_classification.v1" as const;

export type DuplicateDispatchRetryDisposition = "close" | "supersede" | "mark-retry-safe";

export interface DuplicateDispatchRetryClassificationItem {
  item_id: string;
  title: string;
  owner: string | null;
  readiness_state: "ready";
  prior_dispatch_id: string;
  prior_dispatch_status: string | null;
  prior_recovery_status: string | null;
  recommended_disposition: DuplicateDispatchRetryDisposition;
  reason: string;
}

export interface DuplicateDispatchRetryClassificationReport {
  schema_version: typeof DUPLICATE_DISPATCH_RETRY_CLASSIFICATION_SCHEMA_VERSION;
  dry_run: true;
  scanned: number;
  count: number;
  items: DuplicateDispatchRetryClassificationItem[];
}

const TERMINAL_CLOSE_STATUSES = new Set(["done"]);
const TERMINAL_SUPERSEDE_STATUSES = new Set(["cancelled", "moot"]);

export function buildDuplicateDispatchRetryClassificationReport(
  items: BacklogItem[],
  outcomes: Map<string, DispatchOutcome>,
): DuplicateDispatchRetryClassificationReport {
  const reportItems: DuplicateDispatchRetryClassificationItem[] = [];

  for (const item of items) {
    if (item.readiness_state !== "ready") continue;
    if (!item.last_dispatch_phid) continue;
    if (item.retry_safe) continue;

    const outcome = outcomes.get(item.last_dispatch_phid);
    const disposition = classifyDisposition(outcome);
    reportItems.push({
      item_id: item.item_id,
      title: item.title,
      owner: item.to_agent ?? null,
      readiness_state: "ready",
      prior_dispatch_id: item.last_dispatch_phid,
      prior_dispatch_status: outcome?.status ?? null,
      prior_recovery_status: outcome?.recovery_status ?? null,
      recommended_disposition: disposition.recommended_disposition,
      reason: disposition.reason,
    });
  }

  reportItems.sort((a, b) => a.item_id.localeCompare(b.item_id));

  return {
    schema_version: DUPLICATE_DISPATCH_RETRY_CLASSIFICATION_SCHEMA_VERSION,
    dry_run: true,
    scanned: items.length,
    count: reportItems.length,
    items: reportItems,
  };
}

function classifyDisposition(outcome: DispatchOutcome | undefined): {
  recommended_disposition: DuplicateDispatchRetryDisposition;
  reason: string;
} {
  if (!outcome) {
    return {
      recommended_disposition: "supersede",
      reason: "prior dispatch id is recorded but no dispatch row is readable; supersede the duplicate ready row before any refire",
    };
  }

  if (promotionCompletedAndVerified(outcome.promotion_result_json) || TERMINAL_CLOSE_STATUSES.has(outcome.status)) {
    return {
      recommended_disposition: "close",
      reason: `prior dispatch ${outcome.dispatch_phid} is ${outcome.status} or promotion-verified; close the duplicate ready blocker`,
    };
  }

  if (TERMINAL_SUPERSEDE_STATUSES.has(outcome.status)) {
    return {
      recommended_disposition: "supersede",
      reason: `prior dispatch ${outcome.dispatch_phid} is terminal ${outcome.status}; supersede the stale duplicate ready row`,
    };
  }

  if (outcome.status === "failed" && dispatchFailureRetryable(outcome)) {
    return {
      recommended_disposition: "mark-retry-safe",
      reason: `prior dispatch ${outcome.dispatch_phid} failed with retryable transient evidence; mark retry_safe only if the operator wants a bounded refire`,
    };
  }

  if (outcome.status === "failed") {
    return {
      recommended_disposition: "supersede",
      reason: `prior dispatch ${outcome.dispatch_phid} failed non-transiently (${outcome.failure_kind ?? "unknown"}); supersede instead of blind retry`,
    };
  }

  return {
    recommended_disposition: "supersede",
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
