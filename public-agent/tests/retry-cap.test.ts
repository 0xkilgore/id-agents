/**
 * F-03: parseRetryAfter is clamped to maxRetryAfterMs.
 *
 * Tests:
 * - Retry-After: 3600 (1 hour) is clamped to maxRetryAfterMs (10s default).
 * - retryFetch passes the capped wait to the logger (asserted via logger spy).
 * - Small Retry-After values pass through unchanged.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { parseRetryAfter, retryFetch } from '../src/lib/retry.js';

describe('F-03: Retry-After cap', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('parseRetryAfter clamps 3600s to maxRetryAfterMs=10000ms', () => {
    const capMs = 10_000;
    const result = parseRetryAfter('3600', Date.now(), capMs);
    expect(result).toBe(10_000);
  });

  it('parseRetryAfter passes 2s through (under cap)', () => {
    const capMs = 10_000;
    const result = parseRetryAfter('2', Date.now(), capMs);
    expect(result).toBe(2_000);
  });

  it('parseRetryAfter without cap returns full value', () => {
    const result = parseRetryAfter('3600', Date.now());
    expect(result).toBe(3_600_000);
  });

  it('retryFetch clamps Retry-After wait via maxRetryAfterMs option', async () => {
    // Capture the wait ms reported to the logger without actually sleeping.
    const loggedWaits: number[] = [];
    const logger = vi.fn((rec: { waitMs: number }) => {
      loggedWaits.push(rec.waitMs);
    });

    let attempt = 0;
    const fetcher = (): Promise<Response> => {
      attempt += 1;
      if (attempt === 1) {
        // Return 429 with Retry-After: 3600 (1 hour).
        return Promise.resolve(
          new Response('rate limited', {
            status: 429,
            headers: { 'Retry-After': '3600' },
          }),
        );
      }
      // Second attempt: succeed.
      return Promise.resolve(new Response('ok', { status: 200 }));
    };

    // Use a very small actual sleep by overriding the wait via the logger —
    // we don't need to actually sleep in tests. retryFetch will still call
    // sleep(), but we assert the *reported* waitMs is clamped.
    // To avoid sleeping 10s in CI, we mock setTimeout at the global level.
    const originalSetTimeout = globalThis.setTimeout;
    const timeoutSpy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(
      (fn: TimerHandler, ms?: number, ...args: unknown[]) => {
        // Run the callback immediately instead of waiting.
        if (typeof fn === 'function') fn(...args);
        return 0 as unknown as ReturnType<typeof setTimeout>;
      },
    );

    try {
      await retryFetch(fetcher, {
        maxAttempts: 3,
        maxRetryAfterMs: 10_000,
        logger: logger as Parameters<typeof retryFetch>[1]['logger'],
      });
    } finally {
      timeoutSpy.mockRestore();
    }

    // The logger must have been called at least once.
    expect(logger).toHaveBeenCalled();
    // All reported waits must be at most 10,000 ms.
    for (const ms of loggedWaits) {
      expect(ms).toBeLessThanOrEqual(10_000);
    }
    // The wait for the 429 should be exactly 10,000 ms (the cap).
    expect(loggedWaits[0]).toBe(10_000);
  });
});
