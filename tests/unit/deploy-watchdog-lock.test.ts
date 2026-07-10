// SPDX-License-Identifier: MIT

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { rm, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
// @ts-expect-error — plain ESM module (no d.ts); imported for runtime behavior.
import {
  acquireWatchdogLock,
  shouldBreakWatchdogLock,
} from '../../scripts/lib/deploy-watchdog-lock.mjs';

async function withTempDir<T>(fn: (dir: string) => Promise<T> | T): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'deploy-watchdog-lock-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function makeOld(path: string, ageMs: number, nowMs: number) {
  const date = new Date(nowMs - ageMs);
  await utimes(path, date, date);
}

describe('deploy watchdog lock handling', () => {
  it('keeps a recent lock so overlapping watchdog runs stay single-flight', async () => {
    await withTempDir(async (dir) => {
      const lockFile = join(dir, 'watchdog.lock');
      writeFileSync(lockFile, JSON.stringify({ pid: 123, startedAt: 'now' }));

      const decision = shouldBreakWatchdogLock({
        lockFile,
        nowMs: 10_000,
        staleMs: 60_000,
        processAlive: () => false,
      });

      expect(decision.breakLock).toBe(false);
      expect(decision.reason).toMatch(/stale threshold/);
    });
  });

  it('breaks an old zero-byte lock so stale_alerted cannot be hidden forever', async () => {
    await withTempDir(async (dir) => {
      const lockFile = join(dir, 'watchdog.lock');
      const nowMs = 2_000_000;
      writeFileSync(lockFile, '');
      await makeOld(lockFile, 120_000, nowMs);

      const logs: string[] = [];
      const result = acquireWatchdogLock({
        lockFile,
        nowMs,
        staleMs: 60_000,
        processAlive: () => false,
        log: (line: string) => logs.push(line),
      });

      expect(result.acquired).toBe(true);
      expect(result.brokeStaleLock).toBe(true);
      expect(logs.join('\n')).toMatch(/breaking stale deploy watchdog lock/);
      expect(JSON.parse(readFileSync(lockFile, 'utf8'))).toMatchObject({ brokeStaleLock: true });
    });
  });

  it('keeps an old lock when its recorded pid is still alive', async () => {
    await withTempDir(async (dir) => {
      const lockFile = join(dir, 'watchdog.lock');
      const nowMs = 2_000_000;
      writeFileSync(lockFile, JSON.stringify({ pid: 42, startedAt: 'old' }));
      await makeOld(lockFile, 120_000, nowMs);

      const result = acquireWatchdogLock({
        lockFile,
        nowMs,
        staleMs: 60_000,
        processAlive: (pid: number) => pid === 42,
        log: () => {},
      });

      expect(result.acquired).toBe(false);
      expect(readFileSync(lockFile, 'utf8')).toContain('"pid":42');
    });
  });
});
