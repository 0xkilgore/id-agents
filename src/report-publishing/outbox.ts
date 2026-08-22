import type { DbAdapter } from '../db/db-adapter.js';
import {
  recordReportPromotionRequest,
  type ReportCandidateReceipt,
  type ReportCandidateWriteResult,
  type ReportPromotionRequest,
} from './candidate.js';

type OutboxRow = {
  dispatch_phid: string;
  report_candidate_request_json: string;
  report_candidate_export_status: string | null;
};

export async function exportReportCandidateOutboxEntry(
  adapter: DbAdapter,
  dispatchId: string,
  configuredDirectory: string | undefined,
  now = new Date().toISOString(),
): Promise<ReportCandidateReceipt | null> {
  const { rows } = await adapter.query<OutboxRow>(
    `SELECT dispatch_phid, report_candidate_request_json, report_candidate_export_status
       FROM dispatch_scheduler_queue
      WHERE dispatch_phid = ? AND report_candidate_request_json IS NOT NULL`,
    [dispatchId],
  );
  const row = rows[0];
  if (!row) return null;

  let request: ReportPromotionRequest;
  try {
    request = JSON.parse(row.report_candidate_request_json) as ReportPromotionRequest;
  } catch {
    const receipt = corruptedOutboxReceipt(dispatchId);
    await markExportResult(adapter, dispatchId, receipt, now);
    return receipt;
  }

  const result = recordReportPromotionRequest(request, configuredDirectory);
  const receipt = publicReceipt(result);
  await markExportResult(adapter, dispatchId, receipt, now);
  return receipt;
}

export async function flushPendingReportCandidateOutbox(
  adapter: DbAdapter,
  configuredDirectory: string | undefined,
  limit = 25,
): Promise<{ attempted: number; exported: number; failed: number }> {
  const boundedLimit = Number.isSafeInteger(limit) ? Math.max(1, Math.min(limit, 100)) : 25;
  const { rows } = await adapter.query<{ dispatch_phid: string }>(
    `SELECT dispatch_phid
       FROM dispatch_scheduler_queue
      WHERE report_candidate_request_json IS NOT NULL
        AND COALESCE(report_candidate_export_status, 'pending') IN ('pending','not_configured','write_failed')
      ORDER BY COALESCE(completed_at, updated_at) ASC, dispatch_phid ASC
      LIMIT ?`,
    [boundedLimit],
  );
  let exported = 0;
  let failed = 0;
  for (const row of rows) {
    const receipt = await exportReportCandidateOutboxEntry(
      adapter,
      row.dispatch_phid,
      configuredDirectory,
    );
    if (receipt?.status === 'recorded' || receipt?.status === 'already_recorded') exported += 1;
    else failed += 1;
  }
  return { attempted: rows.length, exported, failed };
}

export async function loadStoredReportPromotionRequest(
  adapter: DbAdapter,
  dispatchId: string,
): Promise<ReportPromotionRequest | null> {
  const { rows } = await adapter.query<{ report_candidate_request_json: string }>(
    `SELECT report_candidate_request_json
       FROM dispatch_scheduler_queue
      WHERE dispatch_phid = ? AND report_candidate_request_json IS NOT NULL`,
    [dispatchId],
  );
  if (!rows[0]) return null;
  try {
    return JSON.parse(rows[0].report_candidate_request_json) as ReportPromotionRequest;
  } catch {
    return null;
  }
}

function publicReceipt(result: ReportCandidateWriteResult): ReportCandidateReceipt {
  return {
    schema_version: result.schema_version,
    status: result.status,
    candidate_id: result.candidate_id,
    report_ref: result.report_ref,
    error: result.error,
  };
}

async function markExportResult(
  adapter: DbAdapter,
  dispatchId: string,
  receipt: ReportCandidateReceipt,
  now: string,
): Promise<void> {
  await adapter.query(
    `UPDATE dispatch_scheduler_queue
        SET report_candidate_export_status = ?,
            report_candidate_export_attempted_at = ?,
            report_candidate_export_error = ?
      WHERE dispatch_phid = ? AND report_candidate_request_json IS NOT NULL`,
    [receipt.status, now, receipt.error, dispatchId],
  );
}

function corruptedOutboxReceipt(dispatchId: string): ReportCandidateReceipt {
  return {
    schema_version: 'report-candidate-receipt.v1',
    status: 'write_failed',
    candidate_id: `corrupt-${dispatchId.slice(-16)}`,
    report_ref: 'report:outbox:corrupt',
    error: 'REPORT_CANDIDATE_WRITE_FAILED',
  };
}
