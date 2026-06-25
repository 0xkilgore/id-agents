// P0 control-plane Slice 4 — config wiring for daemon backpressure.
// Asserts the new caps load with safe defaults and that mechanism 4 (the tick
// interval floor) is applied at config-load time.

import { describe, it, expect } from "vitest";
import {
  defaultConfig,
  loadContinuousOrchestrationConfig,
} from "../../src/continuous-orchestration/config.js";

describe("Slice 4 config", () => {
  it("ships the backpressure caps with default-inert ceiling + the documented timing defaults", () => {
    const d = defaultConfig();
    // DEFAULT-INERT: 0 = no shared ceiling (permissive == today). Operator sets
    // a positive cap (e.g. 3) at re-enable to activate the shared write budget.
    expect(d.max_enqueues_per_tick).toBe(0);
    expect(d.slow_tick_ms).toBe(1500);
    expect(d.backoff_max).toBe(8);
    expect(d.min_tick_interval_ms).toBe(5000);
  });

  it("clamps a sub-floor tick_interval_ms up to the floor at load (mechanism 4)", () => {
    const cfg = loadContinuousOrchestrationConfig({
      CONTINUOUS_ORCHESTRATION_TICK_INTERVAL_MS: "1000",
      CONTINUOUS_ORCHESTRATION_MIN_TICK_INTERVAL_MS: "5000",
    } as NodeJS.ProcessEnv);
    expect(cfg.tick_interval_ms).toBe(5000);
  });

  it("leaves an at-or-above-floor tick_interval_ms unchanged", () => {
    const cfg = loadContinuousOrchestrationConfig({
      CONTINUOUS_ORCHESTRATION_TICK_INTERVAL_MS: "60000",
    } as NodeJS.ProcessEnv);
    expect(cfg.tick_interval_ms).toBe(60000);
  });

  it("honors env overrides for the caps", () => {
    const cfg = loadContinuousOrchestrationConfig({
      CONTINUOUS_ORCHESTRATION_MAX_ENQUEUES_PER_TICK: "1",
      CONTINUOUS_ORCHESTRATION_BACKOFF_MAX: "4",
    } as NodeJS.ProcessEnv);
    expect(cfg.max_enqueues_per_tick).toBe(1);
    expect(cfg.backoff_max).toBe(4);
  });
});
