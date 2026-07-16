import { promotionCompletedAndVerified } from "../dispatch-scheduler/read-model.js";
import type { BacklogItem, ReadinessState } from "./types.js";
import type { DispatchOutcome } from "./storage.js";

export const STALE_DUPLICATE_BACKLOG_REPORT_SCHEMA_VERSION =
  "orchestration.stale_duplicate_backlog_report.v1" as const;

export type StaleDuplicateRecommendedAction = "mark_done" | "mark_superseded";

export interface StaleDuplicateBacklogCloseoutPayload {
  action: "close_stale_duplicate_backlog_row";
  dry_run: true;
  item_id: string;
  expected_last_dispatch_phid: string;
  from_state: "needs_review" | "ready";
  to_state: "done" | "superseded";
  actor: "operator";
  reason: string;
  evidence: {
    prior_dispatch_phid: string;
    prior_dispatch_status: string;
    promotion_verified: boolean;
  };
}

export interface StaleDuplicateBacklogReportItem {
  item_id: string;
  title: string;
  readiness_state: "needs_review" | "ready";
  prior_dispatch_phid: string;
  prior_terminal_status: string;
  promotion_verified: boolean;
  recommended_action: StaleDuplicateRecommendedAction;
  reason: string;
  safe_closeout_payload: StaleDuplicateBacklogCloseoutPayload;
}

export interface StaleDuplicateBacklogReport {
  schema_version: typeof STALE_DUPLICATE_BACKLOG_REPORT_SCHEMA_VERSION;
  dry_run: true;
  scanned: number;
  limit: number;
  matched: number;
  truncated: boolean;
  count: number;
  items: StaleDuplicateBacklogReportItem[];
}

type ReportableReadinessState = "needs_review" | "ready";

export const DEFAULT_STALE_DUPLICATE_BACKLOG_REPORT_LIMIT = 25;
const REPORTABLE_STATES = new Set<ReadinessState>(["needs_review", "ready"]);
const TERMINAL_STATUSES = new Set(["done", "cancelled", "moot", "superseded"]);
const LANDED_RECOVERY_STATUSES = new Set(["landed_reconciled", "verified_done", "retry_done"]);
const LINKED_QUERY_EXPIRED_RE = /linked query (?:terminated )?expired|linked-query-expired/i;

function isReportableState(state: ReadinessState): state is ReportableReadinessState {
  return REPORTABLE_STATES.has(state);
}

function effectiveTerminalStatus(outcome: DispatchOutcome): string | null {
  if (LANDED_RECOVERY_STATUSES.has(outcome.recovery_status ?? "")) return "done";
  if (outcome.reliability_classification === "superseded") return "superseded";
  if (outcome.status === "moot" || outcome.recovery_status === "moot") return "moot";
  if (TERMINAL_STATUSES.has(outcome.status)) return outcome.status;
  if (
    outcome.status === "failed" &&
    LINKED_QUERY_EXPIRED_RE.test(`${outcome.failure_kind ?? ""} ${outcome.failure_detail ?? ""}`)
  ) {
    return "linked_query_expired";
  }
  if (promotionCompletedAndVerified(outcome.promotion_result_json)) return outcome.status;
  return null;
}

function recommendedAction(status: string, promotionVerified: boolean): StaleDuplicateRecommendedAction {
  return status === "done" || promotionVerified ? "mark_done" : "mark_superseded";
}

export function buildStaleDuplicateBacklogReport(
  items: BacklogItem[],
  outcomes: Map<string, DispatchOutcome>,
  opts: { limit?: number } = {},
): StaleDuplicateBacklogReport {
  const limit = normalizeLimit(opts.limit);
  const selectedItems = selectStaleDuplicateBacklogRows(items, outcomes);
  const reportItems = selectedItems.slice(0, limit);

  return {
    schema_version: STALE_DUPLICATE_BACKLOG_REPORT_SCHEMA_VERSION,
    dry_run: true,
    scanned: items.length,
    limit,
    matched: selectedItems.length,
    truncated: selectedItems.length > reportItems.length,
    count: reportItems.length,
    items: reportItems,
  };
}

export function selectStaleDuplicateBacklogRows(
  items: BacklogItem[],
  outcomes: Map<string, DispatchOutcome>,
): StaleDuplicateBacklogReportItem[] {
  const reportItems: StaleDuplicateBacklogReportItem[] = [];

  for (const item of items) {
    if (!isReportableState(item.readiness_state)) continue;
    if (!item.last_dispatch_phid) continue;
    if (item.retry_safe) continue;

    const outcome = outcomes.get(item.last_dispatch_phid);
    if (!outcome) continue;

    const terminalStatus = effectiveTerminalStatus(outcome);
    if (!terminalStatus) continue;

    const promotionVerified = promotionCompletedAndVerified(outcome.promotion_result_json);
    const action = recommendedAction(terminalStatus, promotionVerified);
    const toState = action === "mark_done" ? "done" : "superseded";
    const reason =
      toState === "done"
        ? "prior dispatch is terminal/verified; backlog row is stale duplicate state and should close as done"
        : `prior dispatch is terminal ${terminalStatus}; backlog row is stale duplicate state and should be superseded`;

    reportItems.push({
      item_id: item.item_id,
      title: item.title,
      readiness_state: item.readiness_state,
      prior_dispatch_phid: item.last_dispatch_phid,
      prior_terminal_status: terminalStatus,
      promotion_verified: promotionVerified,
      recommended_action: action,
      reason,
      safe_closeout_payload: {
        action: "close_stale_duplicate_backlog_row",
        dry_run: true,
        item_id: item.item_id,
        expected_last_dispatch_phid: item.last_dispatch_phid,
        from_state: item.readiness_state,
        to_state: toState,
        actor: "operator",
        reason,
        evidence: {
          prior_dispatch_phid: item.last_dispatch_phid,
          prior_dispatch_status: terminalStatus,
          promotion_verified: promotionVerified,
        },
      },
    });
  }

  reportItems.sort((a, b) => {
    const state = a.readiness_state.localeCompare(b.readiness_state);
    if (state !== 0) return state;
    return a.item_id.localeCompare(b.item_id);
  });

  return reportItems;
}

function normalizeLimit(limit: number | undefined): number {
  if (limit == null || !Number.isFinite(limit)) return DEFAULT_STALE_DUPLICATE_BACKLOG_REPORT_LIMIT;
  return Math.max(1, Math.min(250, Math.floor(limit)));
}
