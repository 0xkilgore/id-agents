// SPDX-License-Identifier: MIT
//
// Slice 2 durability coverage: retry launchd bootstrap with backoff, and
// rollback to the previous manager build when forward bootstrap never starts.

import { describe, expect, it } from 'vitest';
// @ts-expect-error — plain ESM module (no d.ts); imported for its runtime behavior.
import { bootstrapForwardWithRollback } from '../../scripts/deploy-freshness-watchdog.mjs';
// @ts-expect-error — plain ESM module (no d.ts); imported for its runtime behavior.
import { retryLaunchdBootstrap } from '../../scripts/lib/deploy-watchdog-bootstrap.mjs';

describe('deploy-freshness-watchdog bootstrap retry + rollback', () => {
  it('retries bootstrap failures and recovers on the third attempt', async () => {
    const sleeps: number[] = [];
    const attempts: number[] = [];
    let rollbackCalls = 0;

    const result = await retryLaunchdBootstrap({
      service: 'com.example.manager',
      plist: '/tmp/manager.plist',
      backoffMs: [15, 30, 60],
      sleep: async (ms: number) => { sleeps.push(ms); },
      log: () => {},
      run: (cmd: string) => {
        if (!cmd.includes(' bootstrap ')) return;
        const attempt = attempts.length + 1;
        attempts.push(attempt);
        if (attempt < 3) throw new Error(`bootstrap I/O error ${attempt}`);
      },
    });

    expect(result).toMatchObject({
      ok: true,
      attempts: 3,
    });
    expect(attempts).toEqual([1, 2, 3]);
    expect(sleeps).toEqual([15, 30]);
    expect(rollbackCalls).toBe(0);
  });

  it('rolls back to the previous build when every forward bootstrap attempt fails', async () => {
    const attempts: number[] = [];
    let rollbackCalls = 0;

    const result = await bootstrapForwardWithRollback({
      previousTarget: { workingDirectory: '/prev/repo', programArg1: '/prev/start.sh' },
      previousHealth: { buildSha: 'prevsha123' },
      retryBootstrap: async () => {
        const attempt = attempts.length + 1;
        attempts.push(attempt);
        if (attempt === 1) return { ok: false, attempts: 3, error: new Error('bootstrap I/O error') };
        return { ok: true, attempts: 1 };
      },
      restorePlist: () => { rollbackCalls++; },
      log: () => {},
    });

    expect(result).toMatchObject({
      ok: false,
      rolledBack: true,
      rollbackReason: 'bootstrap I/O error',
      promotedSha: 'prevsha123',
    });
    expect(attempts).toEqual([1, 2]);
    expect(rollbackCalls).toBe(1);
  });

  it('throws for loud escalation only when rollback also fails', async () => {
    await expect(bootstrapForwardWithRollback({
      previousTarget: { workingDirectory: '/prev/repo', programArg1: '/prev/start.sh' },
      previousHealth: { buildSha: 'prevsha123' },
      retryBootstrap: async () => ({ ok: false, attempts: 3, error: new Error('bootstrap I/O error') }),
      restorePlist: () => {},
      log: () => {},
    })).rejects.toThrow(/forward bootstrap failed.*rollback bootstrap also failed/);
  });
});
