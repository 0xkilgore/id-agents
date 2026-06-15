// SPDX-License-Identifier: MIT
/**
 * Tests for verifyDispatch — the pure classifier that decides whether a
 * dispatch row is a "verified landing", a recoverable failure, or still
 * pending. The function never touches disk; artifacts are stat'd only via
 * deps.statArtifact so the tests can inject fixtures.
 */

import { describe, it, expect } from 'vitest';
import { verifyDispatch } from '../../src/dispatch-verification/verifier.js';
import type {
  VerifierDispatchRow,
  VerifyDeps,
  ArtifactStat,
} from '../../src/dispatch-verification/types.js';

const NOW = '2026-06-15T12:00:00.000Z';

function makeRow(overrides: Partial<VerifierDispatchRow> = {}): VerifierDispatchRow {
  return {
    team_id: 'team-1',
    dispatch_id: 'phid:disp-abc',
    query_id: 'query_123',
    agent_name: 'finances',
    status: 'done',
    artifact_path: '/abs/report.md',
    result_success: true,
    tl_dr: 'did the thing',
    failure_kind: null,
    failure_detail: null,
    created_at: '2026-06-15T11:50:00.000Z',
    started_at: '2026-06-15T11:55:00.000Z',
    not_before_at: null,
    completed_at: '2026-06-15T11:59:00.000Z',
    promotion_required: false,
    promotion_verified: null,
    promotion_failure_detail: null,
    artifact_path_source: 'artifact_path',
    ...overrides,
  };
}

/** statArtifact stub: returns the given stat for any path. */
function statStub(stat: Partial<ArtifactStat> = {}): VerifyDeps['statArtifact'] {
  return () => ({
    exists: true,
    is_file: true,
    mtime_iso: '2026-06-15T11:58:00.000Z',
    ...stat,
  });
}

function makeDeps(overrides: Partial<VerifyDeps> = {}): VerifyDeps {
  return {
    statArtifact: statStub(),
    now: NOW,
    ...overrides,
  };
}

describe('verifyDispatch', () => {
  it('verifies a done+success dispatch with a fresh artifact and no promotion', () => {
    const out = verifyDispatch(makeRow(), makeDeps());
    expect(out.status).toBe('verified');
    expect(out.verified).toBe(true);
    expect(out.failure_type).toBeNull();
    expect(out.artifact_exists).toBe(true);
    expect(out.artifact_mtime).toBe('2026-06-15T11:58:00.000Z');
    expect(out.schema_version).toBe('dispatch-verification.v1');
    expect(out.source_metadata.source).toBe('dispatch_scheduler_queue');
    expect(out.source_metadata.result_source).toBe('artifact_path');
  });

  it('flags artifact_missing when statArtifact reports exists:false', () => {
    const out = verifyDispatch(
      makeRow(),
      makeDeps({ statArtifact: statStub({ exists: false, is_file: false, mtime_iso: null }) }),
    );
    expect(out.status).toBe('unverified');
    expect(out.verified).toBe(false);
    expect(out.failure_type).toBe('artifact_missing');
    expect(out.artifact_exists).toBe(false);
  });

  it('flags artifact_missing when status done but artifact_path is null', () => {
    const out = verifyDispatch(makeRow({ artifact_path: null }), makeDeps());
    expect(out.failure_type).toBe('artifact_missing');
    expect(out.verified).toBe(false);
    expect(out.artifact_exists).toBeNull();
    expect(out.kind).toBe('other');
  });

  it('flags artifact_stale when mtime is before the delivery window start', () => {
    // window start = started_at = 11:55:00; mtime before that
    const out = verifyDispatch(
      makeRow(),
      makeDeps({ statArtifact: statStub({ mtime_iso: '2026-06-15T11:50:00.000Z' }) }),
    );
    expect(out.failure_type).toBe('artifact_stale');
    expect(out.verified).toBe(false);
    expect(out.status).toBe('unverified');
  });

  it('flags artifact_stale when mtime is after completed_at + clock skew', () => {
    // completed_at 11:59 + 60s skew = 12:00:00; mtime past that
    const out = verifyDispatch(
      makeRow(),
      makeDeps({ statArtifact: statStub({ mtime_iso: '2026-06-15T12:05:00.000Z' }) }),
    );
    expect(out.failure_type).toBe('artifact_stale');
    expect(out.verified).toBe(false);
  });

  it('marks an in_flight dispatch older than the expiry window as expired', () => {
    // started_at 11:55, now 12:00 -> 5min. expiredAfterMs default = 5min, so use older.
    const out = verifyDispatch(
      makeRow({
        status: 'in_flight',
        started_at: '2026-06-15T11:50:00.000Z',
        completed_at: null,
        result_success: null,
        artifact_path: null,
      }),
      makeDeps(),
    );
    expect(out.failure_type).toBe('expired');
    expect(out.status).toBe('unverified');
    expect(out.verified).toBe(false);
  });

  it('marks an in_flight dispatch younger than the expiry window as pending', () => {
    const out = verifyDispatch(
      makeRow({
        status: 'in_flight',
        started_at: '2026-06-15T11:58:00.000Z',
        completed_at: null,
        result_success: null,
        artifact_path: null,
      }),
      makeDeps(),
    );
    expect(out.status).toBe('pending');
    expect(out.verified).toBe(false);
    expect(out.failure_type).toBeNull();
  });

  it('classifies strict_mode rate_limit_error as rate_limited', () => {
    const out = verifyDispatch(
      makeRow({
        status: 'failed',
        failure_kind: 'strict_mode_classified',
        failure_detail: 'strict_mode:rate_limit_error:429 too many',
        artifact_path: null,
        result_success: false,
        completed_at: null,
      }),
      makeDeps(),
    );
    expect(out.failure_type).toBe('rate_limited');
    expect(out.verified).toBe(false);
  });

  it('classifies strict_mode provider_auth_error as provider_error', () => {
    const out = verifyDispatch(
      makeRow({
        status: 'failed',
        failure_kind: 'strict_mode_classified',
        failure_detail: 'strict_mode:provider_auth_error:401',
        artifact_path: null,
        result_success: false,
        completed_at: null,
      }),
      makeDeps(),
    );
    expect(out.failure_type).toBe('provider_error');
  });

  it('classifies strict_mode dispatch_id_mismatch', () => {
    const out = verifyDispatch(
      makeRow({
        status: 'failed',
        failure_kind: 'strict_mode_classified',
        failure_detail: 'strict_mode:dispatch_id_mismatch: got X want Y',
        artifact_path: null,
        result_success: false,
        completed_at: null,
      }),
      makeDeps(),
    );
    expect(out.failure_type).toBe('dispatch_id_mismatch');
  });

  it('maps provider_rate_limit_exhausted failed dispatch to rate_limited', () => {
    const out = verifyDispatch(
      makeRow({
        status: 'failed',
        failure_kind: 'provider_rate_limit_exhausted',
        failure_detail: 'gave up after retries',
        artifact_path: null,
        result_success: false,
        completed_at: null,
      }),
      makeDeps(),
    );
    expect(out.failure_type).toBe('rate_limited');
  });

  it('maps other exhausted failed dispatches to provider_error', () => {
    const out = verifyDispatch(
      makeRow({
        status: 'failed',
        failure_kind: 'model_api_error_exhausted',
        artifact_path: null,
        result_success: false,
        completed_at: null,
      }),
      makeDeps(),
    );
    expect(out.failure_type).toBe('provider_error');
  });

  it('maps the __not_found__ sentinel to dispatch_not_found', () => {
    const out = verifyDispatch(makeRow({ status: '__not_found__' }), makeDeps());
    expect(out.failure_type).toBe('dispatch_not_found');
    expect(out.status).toBe('unverified');
    expect(out.verified).toBe(false);
  });

  it('verifies a build dispatch when promotion is required and verified', () => {
    const out = verifyDispatch(
      makeRow({
        artifact_path: '/abs/feature.ts',
        promotion_required: true,
        promotion_verified: true,
      }),
      makeDeps(),
    );
    expect(out.status).toBe('verified');
    expect(out.verified).toBe(true);
    expect(out.failure_type).toBeNull();
    expect(out.promotion_required).toBe(true);
    expect(out.promotion_verified).toBe(true);
  });

  it('leaves failure_type null but unverified when promotion is required and failed', () => {
    const out = verifyDispatch(
      makeRow({
        promotion_required: true,
        promotion_verified: false,
        promotion_failure_detail: 'main not fast-forwarded',
      }),
      makeDeps(),
    );
    expect(out.verified).toBe(false);
    expect(out.status).toBe('unverified');
    expect(out.promotion_verified).toBe(false);
    expect(out.failure_type).toBeNull();
    expect(out.promotion_failure_detail).toBe('main not fast-forwarded');
  });

  it('infers kind report for .md and code for .ts', () => {
    const report = verifyDispatch(makeRow({ artifact_path: '/x/report.md' }), makeDeps());
    expect(report.kind).toBe('report');
    const code = verifyDispatch(
      makeRow({ artifact_path: '/x/mod.ts' }),
      makeDeps(),
    );
    expect(code.kind).toBe('code');
  });
});
