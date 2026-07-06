// SPDX-License-Identifier: MIT
import { describe, expect, it } from 'vitest';
// @ts-expect-error — plain ESM module (no d.ts); imported for its runtime behavior.
import {
  MANIFEST_SCHEMA,
  buildManifest,
  buildDropTaskName,
  buildDropTaskTitle,
  checkBatchComplete,
  generateBatchId,
  validateManifestShape,
} from '../../scripts/lib/agentdrop-manifest.mjs';

describe('generateBatchId', () => {
  it('produces a filesystem/task-name-safe ISO-ish id with no colons', () => {
    const now = new Date('2026-07-04T22:41:00.000Z');
    const id = generateBatchId(now, 'a1b2c3');
    expect(id).toBe('2026-07-04T22-41-00Z-a1b2c3');
    expect(id).not.toContain(':');
  });
});

describe('buildManifest', () => {
  it('builds the exact agentdrop.v1 shape from the spec', () => {
    const now = new Date('2026-07-04T22:41:00.000Z');
    const manifest = buildManifest({
      agent: 'finances',
      sender: 'chris',
      files: ['bank1.csv', 'bank2.csv', 'bank3.csv'],
      now,
      batchId: '2026-07-04T22-41-00Z-a1b2c3',
    });
    expect(manifest).toEqual({
      schema: 'agentdrop.v1',
      batch_id: '2026-07-04T22-41-00Z-a1b2c3',
      agent: 'finances',
      sender: 'chris',
      files: ['bank1.csv', 'bank2.csv', 'bank3.csv'],
      sent_at: '2026-07-04T22:41:00.000Z',
    });
  });

  it('generates a batch_id when none is supplied', () => {
    const manifest = buildManifest({ agent: 'finances', sender: 'chris', files: ['a.csv'] });
    expect(manifest.batch_id).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z-[0-9a-f]{6}$/);
  });

  it('does not mutate the input files array', () => {
    const files = ['a.csv'];
    const manifest = buildManifest({ agent: 'finances', sender: 'chris', files });
    manifest.files.push('b.csv');
    expect(files).toEqual(['a.csv']);
  });
});

describe('validateManifestShape', () => {
  const valid = {
    schema: MANIFEST_SCHEMA,
    batch_id: '2026-07-04T22-41-00Z-a1b2c3',
    agent: 'finances',
    sender: 'chris',
    files: ['a.csv'],
    sent_at: '2026-07-04T22:41:00.000Z',
  };

  it('accepts a well-formed manifest', () => {
    expect(validateManifestShape(valid)).toEqual({ ok: true, manifest: valid });
  });

  it('rejects a non-object (null/array/string)', () => {
    expect(validateManifestShape(null).ok).toBe(false);
    expect(validateManifestShape([1, 2]).ok).toBe(false);
    expect(validateManifestShape('not json').ok).toBe(false);
  });

  it('rejects the wrong schema string', () => {
    const r = validateManifestShape({ ...valid, schema: 'agentdrop.v2' });
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toMatch(/schema/);
  });

  it('rejects a missing/empty batch_id', () => {
    expect(validateManifestShape({ ...valid, batch_id: '' }).ok).toBe(false);
    const { batch_id, ...rest } = valid;
    expect(validateManifestShape(rest).ok).toBe(false);
  });

  it('rejects a missing/empty agent (the spoofed-manifest / unknown-agent guard input)', () => {
    expect(validateManifestShape({ ...valid, agent: '' }).ok).toBe(false);
  });

  it('rejects a non-array or empty files list', () => {
    expect(validateManifestShape({ ...valid, files: [] }).ok).toBe(false);
    expect(validateManifestShape({ ...valid, files: 'a.csv' }).ok).toBe(false);
    expect(validateManifestShape({ ...valid, files: ['a.csv', 42] }).ok).toBe(false);
  });

  it('rejects an invalid sent_at', () => {
    expect(validateManifestShape({ ...valid, sent_at: 'not-a-date' }).ok).toBe(false);
  });

  it('reports every violation, not just the first', () => {
    const r = validateManifestShape({ schema: 'wrong', files: [] });
    expect(r.ok).toBe(false);
    expect(r.errors.length).toBeGreaterThan(1);
  });
});

describe('checkBatchComplete', () => {
  it('is complete when every listed file is present', () => {
    const r = checkBatchComplete({ files: ['a.csv', 'b.csv'] }, ['a.csv', 'b.csv', '_dropmeta.json']);
    expect(r).toEqual({ complete: true, missing: [] });
  });

  it('reports exactly which files are missing', () => {
    const r = checkBatchComplete({ files: ['a.csv', 'b.csv', 'c.csv'] }, ['a.csv']);
    expect(r).toEqual({ complete: false, missing: ['b.csv', 'c.csv'] });
  });
});

describe('buildDropTaskName / buildDropTaskTitle', () => {
  const manifest = { agent: 'finances', batch_id: '2026-07-04T22-41-00Z-a1b2c3', files: ['a.csv', 'b.csv', 'c.csv'] };

  it('matches the spec example task name shape', () => {
    expect(buildDropTaskName(manifest)).toBe('drop-finances-2026-07-04t2241-a1b2c3');
  });

  it('matches the spec example task title shape', () => {
    expect(buildDropTaskTitle(manifest)).toBe('Process file drop: finances (2026-07-04T22-41-00Z-a1b2c3, 3 files)');
  });
});
