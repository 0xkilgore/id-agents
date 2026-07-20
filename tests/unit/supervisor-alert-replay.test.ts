import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { readRecentAlertRecords } from '../../src/supervisor/watcher.js';

describe('supervisor alert replay reader', () => {
  it('reads every record when the file is below the bound', () => {
    const dir = mkdtempSync(join(tmpdir(), 'supervisor-replay-'));
    const path = join(dir, 'alerts.jsonl');
    writeFileSync(path, '{"id":1}\n{"id":2}\n');
    const result = readRecentAlertRecords(path, 1024);
    expect(result.records).toEqual([{ id: 1 }, { id: 2 }]);
    expect(result.truncated).toBe(false);
  });

  it('bounds replay and discards the partial first line', () => {
    const dir = mkdtempSync(join(tmpdir(), 'supervisor-replay-'));
    const path = join(dir, 'alerts.jsonl');
    const lines = Array.from({ length: 100 }, (_, id) => JSON.stringify({ id }));
    writeFileSync(path, `${lines.join('\n')}\n`);
    const result = readRecentAlertRecords(path, 120);
    expect(result.truncated).toBe(true);
    expect(result.bytesRead).toBe(120);
    expect(result.records.length).toBeGreaterThan(0);
    expect(result.records.at(-1)).toEqual({ id: 99 });
  });

  it('skips malformed records without failing startup', () => {
    const dir = mkdtempSync(join(tmpdir(), 'supervisor-replay-'));
    const path = join(dir, 'alerts.jsonl');
    writeFileSync(path, '{"id":1}\nnot-json\n{"id":2}\n');
    const result = readRecentAlertRecords(path, 1024);
    expect(result.records).toEqual([{ id: 1 }, { id: 2 }]);
  });
});
