import { describe, expect, it, vi } from "vitest";
import { startVetraRetryWorker } from "../../src/vetra/retry-worker.js";

describe("startVetraRetryWorker", () => {
  it("drains pending ops every 30 seconds", async () => {
    vi.useFakeTimers();
    const drain = vi.fn().mockResolvedValue(undefined);
    const stop = startVetraRetryWorker(drain);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(drain).toHaveBeenCalledTimes(1);
    stop();
  });
});
