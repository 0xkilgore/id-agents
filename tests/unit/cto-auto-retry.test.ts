/** Tests for CTO auto-retry — runs BEFORE the implementation (TDD).
 *
 *  Scenario: the manager dispatched to CTO. Sometimes the running
 *  process is in a bad state (the recurring "stale harness" class
 *  caught Sun 5/18 with cto running on claude-code-cli instead of
 *  codex) and the agent silently drops the work — no news events
 *  ever appear. The auto-retry watcher catches this without bothering
 *  the operator: schedule a check 5 minutes out, count news events
 *  for the query_id; if zero, re-dispatch once. After ONE retry,
 *  surface to the operator (so we don't hide a genuinely stuck agent
 *  forever).
 *
 *  Tests pass fakes for I/O so the watcher is fully deterministic and
 *  the test suite stays fast. The real wiring (setTimeout in the
 *  /talk-to handler) is a thin shell around runCtoAutoRetry.
 */

import { describe, expect, it, vi } from "vitest";
import {
  runCtoAutoRetry,
  type CtoRetryContext,
} from "../../src/lib/cto-auto-retry.js";

function buildCtx(overrides: Partial<CtoRetryContext> = {}): CtoRetryContext {
  return {
    queryId: "q-1",
    agentName: "cto",
    message: "review my PR",
    countNewsForQuery: vi.fn().mockResolvedValue(0),
    redispatch: vi
      .fn()
      .mockResolvedValue({ queryId: "q-2" }),
    recordRetryEvent: vi.fn().mockResolvedValue(undefined),
    sleepMs: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe("runCtoAutoRetry", () => {
  it("no retry when news events appear within the delay window", async () => {
    const ctx = buildCtx({
      countNewsForQuery: vi.fn().mockResolvedValue(2), // healthy: 2 events
    });
    const result = await runCtoAutoRetry(ctx, { delayMs: 1, maxRetries: 1 });
    expect(result.retried).toBe(0);
    expect(result.exhausted).toBe(false);
    expect(result.finalQueryId).toBe("q-1");
    expect(ctx.redispatch).not.toHaveBeenCalled();
    expect(ctx.recordRetryEvent).not.toHaveBeenCalled();
  });

  it("retries once when zero news events, healthy after retry", async () => {
    const counts = [0, 3]; // first check: 0 (stuck); second check: 3 (healthy after retry)
    const ctx = buildCtx({
      countNewsForQuery: vi
        .fn()
        .mockImplementation(async () => counts.shift() ?? 0),
    });
    const result = await runCtoAutoRetry(ctx, { delayMs: 1, maxRetries: 1 });
    expect(result.retried).toBe(1);
    expect(result.exhausted).toBe(false);
    // After retry the canonical queryId is the new one.
    expect(result.finalQueryId).toBe("q-2");
    expect(ctx.redispatch).toHaveBeenCalledTimes(1);
    expect(ctx.redispatch).toHaveBeenCalledWith({
      message: "review my PR",
      agentName: "cto",
      previousQueryId: "q-1",
    });
    expect(ctx.recordRetryEvent).toHaveBeenCalledTimes(1);
    expect(ctx.recordRetryEvent).toHaveBeenCalledWith({
      queryId: "q-1",
      retryCount: 1,
      exhausted: false,
    });
  });

  it("marks exhausted when retry also returns zero news events", async () => {
    const ctx = buildCtx({
      countNewsForQuery: vi.fn().mockResolvedValue(0), // always zero
    });
    const result = await runCtoAutoRetry(ctx, { delayMs: 1, maxRetries: 1 });
    expect(result.retried).toBe(1);
    expect(result.exhausted).toBe(true);
    expect(result.finalQueryId).toBe("q-2");
    expect(ctx.recordRetryEvent).toHaveBeenLastCalledWith({
      queryId: "q-1",
      retryCount: 1,
      exhausted: true,
    });
  });

  it("never retries when maxRetries is 0 (escape hatch)", async () => {
    const ctx = buildCtx({
      countNewsForQuery: vi.fn().mockResolvedValue(0),
    });
    const result = await runCtoAutoRetry(ctx, { delayMs: 1, maxRetries: 0 });
    expect(result.retried).toBe(0);
    expect(result.exhausted).toBe(true);
    expect(ctx.redispatch).not.toHaveBeenCalled();
  });

  it("respects the configured delay before checking news", async () => {
    const sleepSpy = vi.fn().mockResolvedValue(undefined);
    const ctx = buildCtx({
      countNewsForQuery: vi.fn().mockResolvedValue(5),
      sleepMs: sleepSpy,
    });
    await runCtoAutoRetry(ctx, { delayMs: 300_000, maxRetries: 1 });
    expect(sleepSpy).toHaveBeenCalledWith(300_000);
  });

  it("defaults to 5-minute delay + 1 retry when options are omitted", async () => {
    const sleepSpy = vi.fn().mockResolvedValue(undefined);
    const ctx = buildCtx({
      countNewsForQuery: vi.fn().mockResolvedValue(1),
      sleepMs: sleepSpy,
    });
    await runCtoAutoRetry(ctx);
    expect(sleepSpy).toHaveBeenCalledWith(5 * 60 * 1000);
  });

  it("if redispatch throws, the original query is marked exhausted", async () => {
    const ctx = buildCtx({
      countNewsForQuery: vi.fn().mockResolvedValue(0),
      redispatch: vi.fn().mockRejectedValue(new Error("agent offline")),
    });
    const result = await runCtoAutoRetry(ctx, { delayMs: 1, maxRetries: 1 });
    expect(result.retried).toBe(0);
    expect(result.exhausted).toBe(true);
    expect(ctx.recordRetryEvent).toHaveBeenLastCalledWith({
      queryId: "q-1",
      retryCount: 0,
      exhausted: true,
    });
  });
});
