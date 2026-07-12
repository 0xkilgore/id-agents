import { describe, expect, it, vi } from 'vitest';
import { openManagerDbWithAbiRebuildRetry } from '../../src/manager-startup-db.js';
import type { Db } from '../../src/db.js';

const fakeDb = {} as Db;

function dlopenError(message = 'dlopen failed') {
  return Object.assign(new Error(message), { code: 'ERR_DLOPEN_FAILED' });
}

describe('openManagerDbWithAbiRebuildRetry', () => {
  it('runs rebuild-and-retry exactly once for ERR_DLOPEN_FAILED and retries DB open once', async () => {
    const createDb = vi.fn()
      .mockRejectedValueOnce(dlopenError())
      .mockResolvedValueOnce(fakeDb);
    const migrateDb = vi.fn().mockResolvedValue(undefined);
    const rebuildNativeAbi = vi.fn();
    const logWarn = vi.fn();
    const logError = vi.fn();

    const db = await openManagerDbWithAbiRebuildRetry({
      createDb,
      migrateDb,
      rebuildNativeAbi,
      logWarn,
      logError,
    });

    expect(db).toBe(fakeDb);
    expect(createDb).toHaveBeenCalledTimes(2);
    expect(migrateDb).toHaveBeenCalledTimes(1);
    expect(rebuildNativeAbi).toHaveBeenCalledTimes(1);
    expect(logWarn).toHaveBeenCalledWith(expect.stringContaining('rebuild-and-retry once'));
    expect(logError).not.toHaveBeenCalled();
  });

  it('does not loop when DB open still fails after one rebuild-and-retry', async () => {
    const retryErr = dlopenError('still broken');
    const createDb = vi.fn()
      .mockRejectedValueOnce(dlopenError())
      .mockRejectedValueOnce(retryErr);
    const migrateDb = vi.fn().mockResolvedValue(undefined);
    const rebuildNativeAbi = vi.fn();
    const logWarn = vi.fn();
    const logError = vi.fn();

    await expect(openManagerDbWithAbiRebuildRetry({
      createDb,
      migrateDb,
      rebuildNativeAbi,
      logWarn,
      logError,
    })).rejects.toBe(retryErr);

    expect(createDb).toHaveBeenCalledTimes(2);
    expect(migrateDb).not.toHaveBeenCalled();
    expect(rebuildNativeAbi).toHaveBeenCalledTimes(1);
    expect(logError).toHaveBeenCalledTimes(1);
    expect(logError).toHaveBeenCalledWith(expect.stringContaining('MANAGER_STARTUP_ABI_REBUILD_FAILED'));
  });
});
