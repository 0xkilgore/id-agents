// T-RELIABILITY AD1/AD4 — the verification-sweep invariants for bounded, retry-safe
// action delivery: a slow action times out at the bound (no unbounded hang); a
// same-key retry re-delivers ONCE (no double-fire).

import { describe, expect, it } from "vitest";
import { createActionDeliverer } from "../../src/action-delivery/deliver.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("createActionDeliverer", () => {
  it("delivers a fast action with a typed 'delivered' status + value", async () => {
    const { deliverAction } = createActionDeliverer();
    const r = await deliverAction({ idempotency_key: "k1", timeout_ms: 100, run: async () => "ok" });
    expect(r.status).toBe("delivered");
    expect(r.value).toBe("ok");
    expect(r.deduped).toBe(false);
    expect(r.latency_ms).toBeGreaterThanOrEqual(0);
  });

  it("ACCEPTANCE: an action slower than the bound returns 'timed_out' (not an open hang)", async () => {
    const { deliverAction } = createActionDeliverer();
    const r = await deliverAction({ idempotency_key: "slow", timeout_ms: 10, run: async () => { await sleep(200); return "late"; } });
    expect(r.status).toBe("timed_out");
  });

  it("ACCEPTANCE: a retry after a timeout with the SAME key delivers ONCE (no double-fire)", async () => {
    const { deliverAction } = createActionDeliverer();
    let runCalls = 0;
    const run = async () => {
      runCalls += 1;
      await sleep(60);
      return `delivery-${runCalls}`;
    };

    // First attempt: client bound is 10ms → times out while run() is still in flight.
    const first = await deliverAction({ idempotency_key: "action-42", timeout_ms: 10, run });
    expect(first.status).toBe("timed_out");
    expect(runCalls).toBe(1);

    // Retry with the SAME key + a generous bound → reuses the one in-flight delivery.
    const second = await deliverAction({ idempotency_key: "action-42", timeout_ms: 500, run });
    expect(second.status).toBe("delivered");
    expect(second.value).toBe("delivery-1"); // the ORIGINAL run's result
    expect(second.deduped).toBe(true);
    expect(runCalls).toBe(1); // run() invoked exactly ONCE across both attempts
  });

  it("a same-key retry after timeout reuses the original failed delivery", async () => {
    const { deliverAction } = createActionDeliverer();
    let runCalls = 0;
    const run = async () => {
      runCalls += 1;
      await sleep(40);
      throw new Error(`failed-${runCalls}`);
    };

    const first = await deliverAction({ idempotency_key: "slow-fail", timeout_ms: 5, run });
    expect(first.status).toBe("timed_out");

    const second = await deliverAction({ idempotency_key: "slow-fail", timeout_ms: 500, run });
    expect(second.status).toBe("failed");
    expect(second.error).toBe("failed-1");
    expect(second.deduped).toBe(true);
    expect(runCalls).toBe(1);
  });

  it("concurrent same-key calls share one delivery (idempotent fan-in)", async () => {
    const { deliverAction } = createActionDeliverer();
    let runCalls = 0;
    const run = async () => { runCalls += 1; await sleep(20); return "shared"; };
    const [a, b] = await Promise.all([
      deliverAction({ idempotency_key: "dup", timeout_ms: 500, run }),
      deliverAction({ idempotency_key: "dup", timeout_ms: 500, run }),
    ]);
    expect(a.status).toBe("delivered");
    expect(b.status).toBe("delivered");
    expect(runCalls).toBe(1);
    expect(a.deduped !== b.deduped).toBe(true); // exactly one started it, one deduped
  });

  it("a failing action returns a typed 'failed' status with the error", async () => {
    const { deliverAction } = createActionDeliverer();
    const r = await deliverAction({ idempotency_key: "boom", timeout_ms: 100, run: async () => { throw new Error("nope"); } });
    expect(r.status).toBe("failed");
    expect(r.error).toMatch(/nope/);
  });

  it("distinct keys run independently", async () => {
    const { deliverAction } = createActionDeliverer();
    let runCalls = 0;
    const run = async () => { runCalls += 1; return "x"; };
    await deliverAction({ idempotency_key: "a", timeout_ms: 100, run });
    await deliverAction({ idempotency_key: "b", timeout_ms: 100, run });
    expect(runCalls).toBe(2);
  });
});
