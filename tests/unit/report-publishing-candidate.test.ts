import { afterEach, describe, expect, it } from 'vitest';
import { linkSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  admitReportCandidateArtifact,
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
    artifact: admitReportCandidateArtifact(artifactPath, root),
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
      schemaVersion: 'report-promotion-request.v2',
      contentPath: join(root, 'output.md'),
      title: 'Verified output',
      reportRef: 'report:dispatch:phid:dispatch:abc-123',
      sourceRef: 'kapelle-dispatch://phid%3Adispatch%3Aabc-123',
      expectedContentHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      expectedByteSize: Buffer.byteLength('# Verified output\n'),
      producer: { kind: 'SERVICE', id: 'agent-manager', label: 'Agent Manager' },
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

  it('emits the shared Report Registry v2 golden request byte-for-byte', () => {
    const golden = JSON.parse(readFileSync(new URL('../fixtures/report-promotion-request.manager-golden.v2.json', import.meta.url), 'utf8'));
    const request = buildReportPromotionRequest(candidate({
      title: 'Cleveland Park decision',
      project_ref: 'project:cleveland-park',
      attention: {
        request: 'DECIDE',
        reason_code: 'operator_decision',
        reason: 'Choose the bounded path.',
      },
    }), {
      dispatchId: 'phid:dispatch:abc-123',
      artifact: {
        contentPath: '/srv/id-agents/output/cleveland-park-decision.md',
        contentHash: '3c7ebdf0e0a70ae53cdba8d15ed9a2cee7ee1c43262e8895ad7af4c2059f9e57',
        byteSize: 26,
      },
      defaultTitle: 'ignored',
      occurredAt: '2026-08-21T15:00:00.000Z',
    });
    expect(request).toEqual(golden);
    expect(`${JSON.stringify(request, null, 2)}\n`).toBe(readFileSync(
      new URL('../fixtures/report-promotion-request.manager-golden.v2.json', import.meta.url),
      'utf8',
    ));
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

  it('admits only canonical safe Markdown beneath the configured root', () => {
    const root = temporaryRoot();
    expect(() => admitReportCandidateArtifact('output.md', root)).toThrow(
      'REPORT_CANDIDATE_ARTIFACT_PATH_NOT_ABSOLUTE',
    );
    const pdf = join(root, 'output.pdf');
    writeFileSync(pdf, 'pdf');
    expect(() => admitReportCandidateArtifact(pdf, root)).toThrow(
      'REPORT_CANDIDATE_ARTIFACT_TYPE_UNSUPPORTED',
    );
    expect(() => admitReportCandidateArtifact(join(root, 'missing.md'), root)).toThrow(
      'REPORT_CANDIDATE_ARTIFACT_INVALID',
    );
    const original = join(root, 'original.md');
    writeFileSync(original, '# Original\n');
    const linked = join(root, 'linked.md');
    linkSync(original, linked);
    expect(() => admitReportCandidateArtifact(original, root)).toThrow(
      'REPORT_CANDIDATE_ARTIFACT_NOT_SAFE_REGULAR_FILE',
    );
    const symlink = join(root, 'symlink.md');
    symlinkSync(original, symlink);
    expect(() => admitReportCandidateArtifact(symlink, root)).toThrow(
      'REPORT_CANDIDATE_ARTIFACT_PATH_NOT_CANONICAL',
    );
    const oversized = join(root, 'oversized.md');
    writeFileSync(oversized, Buffer.alloc(256 * 1024 + 1, 0x61));
    expect(() => admitReportCandidateArtifact(oversized, root)).toThrow('REPORT_CANDIDATE_ARTIFACT_TOO_LARGE');
    const invalid = join(root, 'invalid.md');
    writeFileSync(invalid, Buffer.from([0xff, 0xfe, 0x80]));
    expect(() => admitReportCandidateArtifact(invalid, root)).toThrow('REPORT_CANDIDATE_ARTIFACT_ENCODING_INVALID');
  });
});

describe('report promotion request handoff', () => {
  it('writes one owner-only request and recognizes an exact retry', () => {
    const root = temporaryRoot();
    const directory = join(root, 'requests');
    const request = buildReportPromotionRequest(candidate(), context(root));

    const first = recordReportPromotionRequest(request, directory);
    expect(first).toMatchObject({ status: 'recorded', error: null });
    expect(first.requestPath).not.toBeNull();
    expect(lstatSync(directory).mode & 0o777).toBe(0o700);
    expect(lstatSync(first.requestPath!).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(first.requestPath!, 'utf8'))).toEqual(request);

    const retry = recordReportPromotionRequest(request, directory);
    expect(retry).toEqual({ ...first, status: 'already_recorded' });

    const publicationWindow = join(directory, `.${first.candidate_id}.race.tmp`);
    linkSync(first.requestPath!, publicationWindow);
    expect(recordReportPromotionRequest(request, directory)).toEqual({ ...first, status: 'already_recorded' });
    unlinkSync(publicationWindow);
  });

  it('preserves the first request and reports a stable-source conflict', () => {
    const root = temporaryRoot();
    const directory = join(root, 'requests');
    const request = buildReportPromotionRequest(candidate(), context(root));
    const first = recordReportPromotionRequest(request, directory);
    const before = readFileSync(first.requestPath!, 'utf8');

    const conflict = recordReportPromotionRequest({ ...request, title: 'Changed after completion' }, directory);
    expect(conflict).toMatchObject({
      status: 'conflict',
      requestPath: first.requestPath,
      error: 'REPORT_CANDIDATE_CONFLICT',
    });
    expect(readFileSync(first.requestPath!, 'utf8')).toBe(before);
  });

  it('makes disabled and unsafe handoff states explicit without writing', () => {
    const root = temporaryRoot();
    const request = buildReportPromotionRequest(candidate(), context(root));
    expect(recordReportPromotionRequest(request, undefined)).toMatchObject({
      status: 'not_configured',
      requestPath: null,
      error: 'REPORT_PROMOTION_REQUEST_DIR_NOT_CONFIGURED',
    });

    const openDirectory = join(root, 'open');
    mkdirSync(openDirectory, { mode: 0o755 });
    expect(recordReportPromotionRequest(request, openDirectory)).toMatchObject({
      status: 'write_failed',
      requestPath: null,
    });

    const safeDirectory = join(root, 'safe');
    mkdirSync(safeDirectory, { mode: 0o700 });
    const linkedDirectory = join(root, 'linked');
    symlinkSync(safeDirectory, linkedDirectory);
    expect(recordReportPromotionRequest(request, resolve(linkedDirectory))).toMatchObject({
      status: 'write_failed',
      requestPath: null,
    });
  });
});
