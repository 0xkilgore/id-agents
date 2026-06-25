// P0 control-plane Slice 4 — daemon backpressure pure helpers.
//
// Unit coverage for the adaptive tick backoff + the shared per-tick write
// budget (auto-refire caps). Config-driven, default-inert: with permissive
// inputs these reduce to today's behavior (see the "permissive == today"
// regression cases).

import { describe, it, expect } from "vitest";
import {
  computeNextDelay,
  tickWriteCaps,
  clampTickInterval,
  UNLIMITED_ADMIT,
} from "../../src/continuous-orchestration/backpressure.js";

const SLOW = 1500;
const BACKOFF_MAX = 8;

describe("computeNextDelay — adaptive backoff", () => {
  it("grows the multiplier (×2) on a slow tick", () => {
    const { delayMs, mult } = computeNextDelay(5000, /*last*/ 2000, SLOW, BACKOFF_MAX, /*prev*/ 1);
    expect(mult).toBe(2);
    expect(delayMs).toBe(10000);
  });

  it("decays the multiplier (÷2) on a fast tick", () => {
    const { delayMs, mult } = computeNextDelay(5000, /*last*/ 200, SLOW, BACKOFF_MAX, /*prev*/ 4);
    expect(mult).toBe(2);
    expect(delayMs).toBe(10000);
  });

  it("clamps growth at backoffMax (delay never exceeds base*backoffMax)", () => {
    const { delayMs, mult } = computeNextDelay(5000, 9999, SLOW, BACKOFF_MAX, /*prev*/ 8);
    expect(mult).toBe(8); // already at the cap, stays
    expect(delayMs).toBe(40000); // 5000 * 8
  });

  it("clamps decay at 1 (delay never drops below base)", () => {
    const { delayMs, mult } = computeNextDelay(5000, 10, SLOW, BACKOFF_MAX, /*prev*/ 1);
    expect(mult).toBe(1);
    expect(delayMs).toBe(5000);
  });

  it("treats exactly slow_tick_ms as slow (>=)", () => {
    expect(computeNextDelay(5000, SLOW, SLOW, BACKOFF_MAX, 1).mult).toBe(2);
  });
});

describe("tickWriteCaps — shared per-tick write budget", () => {
  const cfg = { maxEnqueuesPerTick: 3, maxFleshPerTick: 5, maxNewPerTick: 1 };

  it("caps refuel fleshes at the global budget (min of flesh cap and budget)", () => {
    expect(tickWriteCaps(cfg, 0).refuelCap).toBe(3); // min(5, 3)
  });

  it("suppresses admission entirely when the refuel fleshed this tick (mechanism 2)", () => {
    expect(tickWriteCaps(cfg, /*refuelFleshed*/ 2).admitCap).toBe(0);
  });

  it("gives admission the full remaining budget when refuel fleshed nothing", () => {
    expect(tickWriteCaps(cfg, 0).admitCap).toBe(3); // budget - 0
  });

  it("never lets refuelFleshed + admitCap exceed the budget (when active)", () => {
    for (const fleshed of [0, 1, 2, 3]) {
      const { admitCap } = tickWriteCaps(cfg, fleshed);
      expect(fleshed + admitCap).toBeLessThanOrEqual(cfg.maxEnqueuesPerTick);
    }
  });

  it("is DEFAULT-INERT when budget <= 0: admission uncapped, refuel keeps its flesh cap (permissive == today)", () => {
    const inert = { maxEnqueuesPerTick: 0, maxFleshPerTick: 5, maxNewPerTick: 1 };
    expect(tickWriteCaps(inert, 0).admitCap).toBe(UNLIMITED_ADMIT);
    expect(tickWriteCaps(inert, 3).admitCap).toBe(UNLIMITED_ADMIT); // not even suppressed when inert
    expect(tickWriteCaps(inert, 0).refuelCap).toBe(5); // unchanged flesh cap
  });
});

describe("clampTickInterval — interval floor (mechanism 4)", () => {
  it("raises a sub-floor interval to the floor", () => {
    expect(clampTickInterval(1000, 5000)).toBe(5000);
  });
  it("leaves an at-or-above-floor interval unchanged", () => {
    expect(clampTickInterval(60000, 5000)).toBe(60000);
  });
});
