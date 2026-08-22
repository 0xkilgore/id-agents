import { afterEach, describe, expect, it } from 'vitest';
import { lstatSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  buildReportPromotionRequest,
  parseAgentReportCandidate,
  recordReportPromotionRequest,
} from '../../src/report-publishing/candidate.js';

const roots: string[] = [];

function temporaryRoot(): string {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'report-publishing-candidate-test-')));
  roots.push(root);
  return root;
}

function candidate(overrides: Record<string, unknown> = {}) {
  return {
    schema_version: 'report-candidate.v1',
    attention: { request: 'READ' },
    ...overrides,
  };
}

function context(root: string) {
  const artifactPath = join(root, 'output.md');
  writeFileSync(artifactPath, '# Verified output\n');
  return {
    dispatchId: 'phid:dispatch:abc-123',
    artifactPath,
    agentId: 'maestra',
    defaultTitle: 'Verified output',
    occurredAt: '2026-08-21T15:00:00.000Z',
  };
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('report candidate contract', () => {
  it('derives trusted source, producer, content path, and default report identity', () => {
    const root = temporaryRoot();
    const request = buildReportPromotionRequest(candidate(), context(root));

    expect(request).toEqual({
      schemaVersion: 'report-promotion-request.v1',
      contentPath: join(root, 'output.md'),
      title: 'Verified output',
      reportRef: 'report:dispatch:phid:dispatch:abc-123',
      sourceRef: 'kapelle-dispatch://phid%3Adispatch%3Aabc-123',
      producer: { kind: 'AGENT', id: 'maestra', label: 'maestra' },
      attention: { request: 'READ' },
      occurredAt: '2026-08-21T15:00:00.000Z',
    });
  });

  it('maps only explicit candidate metadata into the publisher request', () => {
    const root = temporaryRoot();
    const request = buildReportPromotionRequest(candidate({
      title: 'Decision memo',
      report_ref: 'report:cleveland-park:decision-1',
      project_ref: 'project:cleveland-park',
      family_ref: 'family:development',
      attention: {
        request: 'DECIDE',
        reason_code: 'operator_decision',
        reason: 'Choose the bounded path.',
        review_by: '2026-08-22T17:00:00.000Z',
        expires_at: '2026-08-24T17:00:00.000Z',
      },
    }), context(root));

    expect(request).toMatchObject({
      title: 'Decision memo',
      reportRef: 'report:cleveland-park:decision-1',
      projectRef: 'project:cleveland-park',
      familyRef: 'family:development',
      attention: {
        request: 'DECIDE',
        reasonCode: 'operator_decision',
        reason: 'Choose the bounded path.',
        reviewBy: '2026-08-22T17:00:00.000Z',
        expiresAt: '2026-08-24T17:00:00.000Z',
      },
    });
  });

  it('rejects ambiguous, unknown, malformed, or overlong candidate input', () => {
    expect(() => parseAgentReportCandidate({ ...candidate(), surprise: true })).toThrow('REPORT_CANDIDATE_UNKNOWN_FIELD');
    expect(() => parseAgentReportCandidate(candidate({ schema_version: 'report-candidate.v2' }))).toThrow('REPORT_CANDIDATE_SCHEMA_UNSUPPORTED');
    expect(() => parseAgentReportCandidate(candidate({ report_ref: 'missing-colon' }))).toThrow('REPORT_CANDIDATE_REPORT_REF_INVALID');
    expect(() => parseAgentReportCandidate(candidate({ attention: { request: 'NONE', reason: 'secret inference' } }))).toThrow(
      'REPORT_CANDIDATE_ATTENTION_METADATA_WITHOUT_REQUEST',
    );
    expect(() => parseAgentReportCandidate(candidate({ attention: { request: 'DECIDE', review_by: 'tomorrow' } }))).toThrow(
      'REPORT_CANDIDATE_ATTENTION_REVIEW_BY_INVALID',
    );
    expect(() => parseAgentReportCandidate(candidate({ title: '🚩'.repeat(126) }))).toThrow('REPORT_CANDIDATE_TITLE_INVALID');
  });

  it('requires the manager-derived artifact path to be absolute', () => {
    const root = temporaryRoot();
    expect(() => buildReportPromotionRequest(candidate(), { ...context(root), artifactPath: 'output.md' })).toThrow(
      'REPORT_CANDIDATE_ARTIFACT_PATH_NOT_ABSOLUTE',
    );
    expect(() => buildReportPromotionRequest(candidate(), { ...context(root), artifactPath: join(root, 'output.pdf') })).toThrow(
      'REPORT_CANDIDATE_ARTIFACT_TYPE_UNSUPPORTED',
    );
  });
});

describe('report promotion request handoff', () => {
  it('writes one owner-only request and recognizes an exact retry', () => {
    const root = temporaryRoot();
    const directory = join(root, 'requests');
    const request = buildReportPromotionRequest(candidate(), context(root));

    const first = recordReportPromotionRequest(request, directory);
    expect(first).toMatchObject({ status: 'recorded', error: null });
    expect(first.request_path).not.toBeNull();
    expect(lstatSync(directory).mode & 0o777).toBe(0o700);
    expect(lstatSync(first.request_path!).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(first.request_path!, 'utf8'))).toEqual(request);

    const retry = recordReportPromotionRequest(request, directory);
    expect(retry).toEqual({ ...first, status: 'already_recorded' });
  });

  it('preserves the first request and reports a stable-source conflict', () => {
    const root = temporaryRoot();
    const directory = join(root, 'requests');
    const request = buildReportPromotionRequest(candidate(), context(root));
    const first = recordReportPromotionRequest(request, directory);
    const before = readFileSync(first.request_path!, 'utf8');

    const conflict = recordReportPromotionRequest({ ...request, title: 'Changed after completion' }, directory);
    expect(conflict).toMatchObject({
      status: 'conflict',
      request_path: first.request_path,
      error: 'REPORT_CANDIDATE_CONFLICT',
    });
    expect(readFileSync(first.request_path!, 'utf8')).toBe(before);
  });

  it('makes disabled and unsafe handoff states explicit without writing', () => {
    const root = temporaryRoot();
    const request = buildReportPromotionRequest(candidate(), context(root));
    expect(recordReportPromotionRequest(request, undefined)).toMatchObject({
      status: 'not_configured',
      request_path: null,
      error: 'REPORT_PROMOTION_REQUEST_DIR_NOT_CONFIGURED',
    });

    const openDirectory = join(root, 'open');
    mkdirSync(openDirectory, { mode: 0o755 });
    expect(recordReportPromotionRequest(request, openDirectory)).toMatchObject({
      status: 'write_failed',
      request_path: null,
    });

    const safeDirectory = join(root, 'safe');
    mkdirSync(safeDirectory, { mode: 0o700 });
    const linkedDirectory = join(root, 'linked');
    symlinkSync(safeDirectory, linkedDirectory);
    expect(recordReportPromotionRequest(request, resolve(linkedDirectory))).toMatchObject({
      status: 'write_failed',
      request_path: null,
    });
  });
});
