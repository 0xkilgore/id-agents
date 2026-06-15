// SPDX-License-Identifier: MIT
// W2-1 DispatchVerification — pure classifier. See types.ts for the contract.
//
// verifyDispatch decides whether a dispatch row is a "verified landing", a
// recoverable failure, or still pending. It NEVER touches disk: artifacts are
// stat'd only through deps.statArtifact so the function stays a pure mapping
// from (row, deps) -> DispatchVerification.

import {
  DEFAULT_CLOCK_SKEW_MS,
  DEFAULT_EXPIRED_AFTER_MS,
  type ArtifactStat,
  type DispatchArtifactKind,
  type DispatchVerification,
  type DispatchVerificationFailureType,
  type DispatchVerificationStatus,
  type VerifierDispatchRow,
  type VerifyDeps,
} from './types.js';

const NOT_FOUND_SENTINEL = '__not_found__';

const NON_TERMINAL_STATUSES = new Set<string>([
  'queued',
  'in_flight',
  'bounced',
  'needs_clarification',
  'resume_delivery_failed',
]);

const REPORT_EXTS = new Set(['md', 'txt', 'pdf']);
const CODE_EXTS = new Set(['ts', 'js', 'py', 'tsx', 'go', 'rs', 'java', 'sql']);
const DATA_EXTS = new Set(['csv', 'json', 'xlsx', 'parquet']);

function inferKind(artifactPath: string | null): DispatchArtifactKind {
  if (!artifactPath) return 'other';
  const dot = artifactPath.lastIndexOf('.');
  if (dot < 0 || dot === artifactPath.length - 1) return 'other';
  const ext = artifactPath.slice(dot + 1).toLowerCase();
  if (REPORT_EXTS.has(ext)) return 'report';
  if (CODE_EXTS.has(ext)) return 'code';
  if (DATA_EXTS.has(ext)) return 'data';
  return 'other';
}

function parseTime(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
}

/** First non-null of started_at / not_before_at. */
function deliveryWindowStart(row: VerifierDispatchRow): string | null {
  return row.started_at ?? row.not_before_at ?? null;
}

/** Map a `failed` dispatch (strict or provider) to a failure type. */
function classifyFailed(row: VerifierDispatchRow): DispatchVerificationFailureType {
  const kind = row.failure_kind ?? '';
  const detail = row.failure_detail ?? '';

  if (kind === 'strict_mode_classified') {
    if (detail.includes('rate_limit_error')) return 'rate_limited';
    if (detail.includes('dispatch_id_mismatch')) return 'dispatch_id_mismatch';
    if (detail.includes('dispatch_not_found')) return 'dispatch_not_found';
    if (detail.includes('provider_server_error') || detail.includes('provider_auth_error')) {
      return 'provider_error';
    }
    return 'provider_error';
  }

  if (kind === 'provider_rate_limit_exhausted') return 'rate_limited';
  if (
    kind === 'model_api_error_exhausted' ||
    kind === 'harness_empty_result_exhausted' ||
    kind === 'harness_process_error_exhausted'
  ) {
    return 'provider_error';
  }

  return 'provider_error';
}

export function verifyDispatch(
  row: VerifierDispatchRow,
  deps: VerifyDeps,
): DispatchVerification {
  const expiredAfterMs = deps.expiredAfterMs ?? DEFAULT_EXPIRED_AFTER_MS;
  const clockSkewMs = deps.clockSkewMs ?? DEFAULT_CLOCK_SKEW_MS;
  const nowMs = parseTime(deps.now) ?? Date.now();

  const windowStart = deliveryWindowStart(row);
  const windowEnd = row.completed_at;

  const hasArtifact = typeof row.artifact_path === 'string' && row.artifact_path.length > 0;
  const stat: ArtifactStat | null = hasArtifact
    ? deps.statArtifact(row.artifact_path as string)
    : null;

  const artifactExists: boolean | null =
    hasArtifact && stat ? stat.exists && stat.is_file : null;
  const artifactMtime: string | null = stat ? stat.mtime_iso : null;

  let status: DispatchVerificationStatus = 'unverified';
  let verified = false;
  let failureType: DispatchVerificationFailureType | null = null;
  let failureDetail: string | null = row.failure_detail ?? null;

  if (row.status === NOT_FOUND_SENTINEL) {
    // Caller asked us to verify a dispatch_id it expected but couldn't find.
    failureType = 'dispatch_not_found';
    status = 'unverified';
    failureDetail = failureDetail ?? `dispatch not found: ${row.dispatch_id}`;
  } else if (NON_TERMINAL_STATUSES.has(row.status)) {
    const activeAnchor =
      parseTime(row.started_at) ?? parseTime(row.not_before_at) ?? parseTime(row.created_at);
    const activeAge = activeAnchor === null ? Infinity : nowMs - activeAnchor;
    if (activeAge > expiredAfterMs) {
      failureType = 'expired';
      status = 'unverified';
      failureDetail = failureDetail ?? `dispatch expired (status=${row.status})`;
    } else {
      status = 'pending';
      failureType = null;
    }
  } else if (row.status === 'failed') {
    failureType = classifyFailed(row);
    status = 'unverified';
    failureDetail = failureDetail ?? `dispatch failed (${row.failure_kind ?? 'unknown'})`;
  } else if (row.status === 'done') {
    if (!hasArtifact) {
      failureType = 'artifact_missing';
      status = 'unverified';
      failureDetail = failureDetail ?? 'dispatch done without an artifact_path';
    } else if (!stat || !stat.exists || !stat.is_file) {
      failureType = 'artifact_missing';
      status = 'unverified';
      failureDetail = failureDetail ?? `artifact not found at ${row.artifact_path}`;
    } else {
      const mtimeMs = parseTime(stat.mtime_iso);
      const startMs = parseTime(windowStart);
      const endMs = parseTime(windowEnd);
      const tooEarly = startMs !== null && mtimeMs !== null && mtimeMs < startMs;
      const tooLate =
        endMs !== null && mtimeMs !== null && mtimeMs > endMs + clockSkewMs;
      if (mtimeMs === null || tooEarly || tooLate) {
        failureType = 'artifact_stale';
        status = 'unverified';
        failureDetail =
          failureDetail ?? `artifact mtime outside delivery window at ${row.artifact_path}`;
      } else if (row.result_success !== true) {
        // Done but the /agent-done payload did not report success.
        failureType = 'provider_error';
        status = 'unverified';
        failureDetail = failureDetail ?? 'dispatch done without result_success';
      } else {
        verified = true;
        status = 'verified';
        failureType = null;
        failureDetail = null;
      }
    }
  } else {
    // Unknown / unhandled terminal status — treat as provider_error.
    failureType = 'provider_error';
    status = 'unverified';
    failureDetail = failureDetail ?? `unhandled dispatch status (${row.status})`;
  }

  // Promotion gate. Only blocks verification; does not override a failure_type
  // already established by strict/provider/artifact evidence.
  if (row.promotion_required && row.promotion_verified === false) {
    verified = false;
    status = 'unverified';
    // failure_type stays whatever was assigned above (null unless a
    // strict/provider/artifact failure already set it).
  }

  return {
    schema_version: 'dispatch-verification.v1',
    team_id: row.team_id,
    dispatch_id: row.dispatch_id,
    query_id: row.query_id,
    agent_name: row.agent_name,
    status,
    verified,
    failure_type: failureType,
    failure_detail: failureDetail,
    artifact_path: row.artifact_path,
    artifact_exists: artifactExists,
    artifact_mtime: artifactMtime,
    delivery_window_start: windowStart,
    delivery_window_end: windowEnd,
    promotion_required: row.promotion_required,
    promotion_verified: row.promotion_verified,
    promotion_failure_detail: row.promotion_failure_detail,
    dispatch_status: row.status,
    dispatch_created_at: row.created_at,
    dispatch_started_at: row.started_at,
    dispatch_completed_at: row.completed_at,
    result_success: row.result_success,
    tl_dr: row.tl_dr,
    kind: inferKind(row.artifact_path),
    checked_at: deps.now,
    source_metadata: {
      source: 'dispatch_scheduler_queue',
      result_source: row.artifact_path_source,
    },
  };
}
