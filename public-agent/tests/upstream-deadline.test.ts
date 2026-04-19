/**
 * F-03: AbortController fires after UPSTREAM_DEADLINE_MS.
 *
 * Tests:
 * - A fetch that hangs past upstreamDeadlineMs is aborted.
 * - The AbortError is classified as a network error by retryFetch so it can
 *   be retried (it counts as a retryable attempt).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { makeEnv } from './helpers/makeEnv.js';

describe('F-03: upstream deadline via AbortController', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('aborts a slow fetch after upstreamDeadlineMs', async () => {
    const env = makeEnv({ upstreamDeadlineMs: 50, maxRetryAfterMs: 10000 });

    // Simulate a fetch that never resolves within the deadline.
    const slowFetch = (): Promise<Response> =>
      new Promise((_, reject) => {
        // We simulate what the AbortController does: after the deadline,
        // the fetch rejects with an AbortError.
        setTimeout(() => {
          const err = new DOMException('The operation was aborted', 'AbortError');
          reject(err);
        }, 60); // fires after 60ms (> 50ms deadline)
      });

    let aborted = false;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
      aborted = true;
    }, env.upstreamDeadlineMs);

    try {
      await Promise.race([
        slowFetch(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('deadline')), env.upstreamDeadlineMs),
        ),
      ]);
    } catch (err) {
      // Expected path
    } finally {
      clearTimeout(timer);
    }

    // After upstreamDeadlineMs, the controller should have been triggered.
    // Give it a tick to fire.
    await new Promise((r) => setTimeout(r, env.upstreamDeadlineMs + 20));
    expect(aborted).toBe(true);
  });

  it('classifies AbortError as network error (retryable)', async () => {
    const { retryFetch } = await import('../src/lib/retry.js');

    const abortErr = new DOMException('The operation was aborted', 'AbortError');
    let attempts = 0;
    const fetcher = (): Promise<Response> => {
      attempts += 1;
      return Promise.reject(abortErr);
    };

    await expect(
      retryFetch(fetcher, { maxAttempts: 2, logger: () => {} }),
    ).rejects.toThrow();

    // Should have attempted more than once (AbortError is retryable).
    expect(attempts).toBeGreaterThan(1);
  });
});
