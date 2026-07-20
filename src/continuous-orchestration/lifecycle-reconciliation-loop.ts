import type { DbAdapter } from "../db/db-adapter.js";
import {
  buildDuplicateDispatchRetryClassificationReport,
  type DuplicateDispatchRetryClassificationItem,
} from "./duplicate-dispatch-retry-classifier.js";
import {
  appendDecisions,
  getDispatchOutcomesByPhid,
  listBacklogByState,
  markFailedDuplicateDispatchRetrySafe,
  reconcileStaleAlreadyDispatchedReadyRows,
} from "./storage.js";

export const LIFECYCLE_RECONCILIATION_RECEIPT_SCHEMA_VERSION =
  "orchestration.lifecycle_reconciliation_action_receipt.v1" as const;

export type LifecycleReconciliationAppliedAction = "auto_close" | "supersede" | "mark_retry_safe" | "hold";

export interface LifecycleReconciliationActionReceipt {
  schema_version: typeof LIFECYCLE_RECONCILIATION_RECEIPT_SCHEMA_VERSION;
  cycle_id: string;
  item_id: string;
  dispatch_phid: string;
  classification: DuplicateDispatchRetryClassificationItem["failure_class"];
  recommended_disposition: DuplicateDispatchRetryClassificationItem["recommended_disposition"];
  action: LifecycleReconciliationAppliedAction;
  outcome: "applied" | "would_apply" | "held" | "conflict";
  reason: string;
  dry_run: boolean;
  recorded_at: string;
  /** Receipt emitted by the reused close/supersede surface, when applicable. */
  surface_receipt?: unknown;
}

export interface BoundedLifecycleReconciliationResult {
  schema_version: "orchestration.bounded_lifecycle_reconciliation_cycle.v1";
  cycle_id: string;
  dry_run: boolean;
  cap: number;
  classified: number;
  processed: number;
  truncated: boolean;
  actions: Record<LifecycleReconciliationAppliedAction, number>;
  receipts: LifecycleReconciliationActionReceipt[];
}

/**
 * Classify and safely repair one bounded snapshot. This intentionally consumes
 * Roger's classifier and the existing CAS-safe mutation surfaces. Any class
 * that is not proven landed/terminal or verified transient is held.
 */
export async function runBoundedLifecycleReconciliationCycle(
  adapter: DbAdapter,
  opts: {
    team_id?: string;
    cycle_id: string;
    actor?: string;
    dry_run?: boolean;
    max_actions?: number;
    now?: Date;
  },
): Promise<BoundedLifecycleReconciliationResult> {
  const teamId = opts.team_id ?? "default";
  const actor = opts.actor?.trim() || "continuous-orchestration:lifecycle-reconciler";
  const dryRun = opts.dry_run !== false;
  const cap = Math.max(1, Math.min(100, Math.floor(opts.max_actions ?? 25)));
  const candidates = await listBacklogByState(adapter, { team_id: teamId, state: "ready", limit: 500 });
  const dispatchIds = candidates.flatMap((item) => item.last_dispatch_phid ? [item.last_dispatch_phid] : []);
  const outcomes = await getDispatchOutcomesByPhid(adapter, dispatchIds);
  const report = buildDuplicateDispatchRetryClassificationReport(candidates, outcomes, { now: opts.now });
  const selected = report.items.slice(0, cap);
  const recordedAt = (opts.now ?? new Date()).toISOString();
  const receipts: LifecycleReconciliationActionReceipt[] = [];

  for (const item of selected) {
    let action: LifecycleReconciliationAppliedAction = "hold";
    let outcome: LifecycleReconciliationActionReceipt["outcome"] = "held";
    let reason = item.reason;
    let surfaceReceipt: unknown;

    if (item.failure_class === "stale_duplicate" && item.recommended_disposition === "close") {
      action = "auto_close";
      const applied = await reconcileStaleAlreadyDispatchedReadyRows(adapter, {
        team_id: teamId, actor, item_id: item.item_id, max_rows: 1, dry_run: dryRun,
      });
      outcome = applied.closed === 1 ? (dryRun ? "would_apply" : "applied") : "conflict";
      reason = applied.items[0]?.reason ?? "safe close no longer applied; row changed or evidence no longer qualifies";
      surfaceReceipt = applied.items[0]?.receipt;
    } else if (item.failure_class === "stale_duplicate" && item.recommended_disposition === "supersede") {
      action = "supersede";
      const applied = await reconcileStaleAlreadyDispatchedReadyRows(adapter, {
        team_id: teamId, actor, item_id: item.item_id, max_rows: 1, dry_run: dryRun,
      });
      outcome = applied.superseded === 1 ? (dryRun ? "would_apply" : "applied") : "conflict";
      reason = applied.items[0]?.reason ?? "safe supersede no longer applied; row changed or evidence no longer qualifies";
      surfaceReceipt = applied.items[0]?.receipt;
    } else if (
      item.failure_class === "retryable_transient"
      && item.recommended_disposition === "mark-retry-safe"
      && item.retry_safe_recommendation === "set_true"
    ) {
      action = "mark_retry_safe";
      if (dryRun) {
        outcome = "would_apply";
      } else {
        const applied = await markFailedDuplicateDispatchRetrySafe(adapter, item.item_id, {
          team_id: teamId,
          actor,
          reason: `verified environmental failure: ${item.failure_kind ?? item.failure_class}`,
        });
        outcome = applied.ok ? "applied" : "conflict";
        reason = applied.ok ? item.reason : applied.reason;
      }
    }

    receipts.push({
      schema_version: LIFECYCLE_RECONCILIATION_RECEIPT_SCHEMA_VERSION,
      cycle_id: opts.cycle_id,
      item_id: item.item_id,
      dispatch_phid: item.prior_dispatch_id,
      classification: item.failure_class,
      recommended_disposition: item.recommended_disposition,
      action,
      outcome,
      reason,
      dry_run: dryRun,
      recorded_at: recordedAt,
      ...(surfaceReceipt ? { surface_receipt: surfaceReceipt } : {}),
    });
  }

  // Dry-run is strictly read-only. Live cycles persist one durable ledger row
  // per classified pair, including holds and CAS conflicts.
  if (!dryRun) {
    await appendDecisions(adapter, {
      team_id: teamId,
      tick_id: opts.cycle_id,
      dry_run: false,
      records: receipts.map((receipt) => ({
        item_id: receipt.item_id,
        action: "lifecycle_reconciliation",
        reason: receipt.reason,
        dispatch_phid: receipt.dispatch_phid,
        metadata: { receipt },
      })),
    });
  }

  const actions = { auto_close: 0, supersede: 0, mark_retry_safe: 0, hold: 0 };
  for (const receipt of receipts) {
    if (receipt.outcome !== "conflict") actions[receipt.action] += 1;
  }
  return {
    schema_version: "orchestration.bounded_lifecycle_reconciliation_cycle.v1",
    cycle_id: opts.cycle_id,
    dry_run: dryRun,
    cap,
    classified: report.count,
    processed: receipts.length,
    truncated: report.count > cap,
    actions,
    receipts,
  };
}
