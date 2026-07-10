// SPDX-License-Identifier: MIT
//
// Slice 2 durability coverage: retry launchd bootstrap with backoff, and
// rollback to the previous manager build when forward bootstrap never starts.

import { describe, expect, it } from 'vitest';
// @ts-expect-error — plain ESM module (no d.ts); imported for its runtime behavior.
import { bootstrapWithRollback } from '../../scripts/deploy-freshness-watchdog.mjs';

describe('deploy-freshness-watchdog bootstrap retry + rollback', () => {
  it('retries bootstrap failures and recovers on the third attempt', async () => {
    const sleeps: number[] = [];
    const attempts: number[] = [];
    let rollbackCalls = 0;

    const result = await bootstrapWithRollback({
      backoffs: [15, 30, 60],
      sleepFn: async (ms: number) => { sleeps.push(ms); },
      logFn: () => {},
      forward: async (attempt: number) => {
        attempts.push(attempt);
        if (attempt < 3) throw new Error(`bootstrap I/O error ${attempt}`);
      },
      rollback: async () => { rollbackCalls++; },
    });

    expect(result).toMatchObject({
      status: 'forward_started',
      attempts: 3,
      rollbackAttempted: false,
    });
    expect(attempts).toEqual([1, 2, 3]);
    expect(sleeps).toEqual([15, 30]);
    expect(rollbackCalls).toBe(0);
  });

  it('rolls back to the previous build when every forward bootstrap attempt fails', async () => {
    const attempts: number[] = [];
    let rollbackCalls = 0;

    const result = await bootstrapWithRollback({
      backoffs: [15, 30, 60],
      sleepFn: async () => {},
      logFn: () => {},
      forward: async (attempt: number) => {
        attempts.push(attempt);
        throw new Error(`bootstrap I/O error ${attempt}`);
      },
      rollback: async () => { rollbackCalls++; },
    });

    expect(result).toMatchObject({
      status: 'rolled_back',
      attempts: 3,
      rollbackAttempted: true,
    });
    expect(attempts).toEqual([1, 2, 3]);
    expect(rollbackCalls).toBe(1);
    expect(result.forwardError).toMatch(/bootstrap failed after 3 attempts/);
  });

  it('throws for loud escalation only when rollback also fails', async () => {
    await expect(bootstrapWithRollback({
      backoffs: [15, 30, 60],
      sleepFn: async () => {},
      logFn: () => {},
      forward: async () => { throw new Error('forward bootstrap failed'); },
      rollback: async () => { throw new Error('rollback bootstrap failed'); },
    })).rejects.toMatchObject({ rollbackFailed: true });
  });
});
