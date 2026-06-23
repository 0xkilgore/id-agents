// Continuous Orchestration — batch cadence.
//
// Chris's approved rhythm: wide batch admission at 7:15am / 12:30pm / 3:30pm
// (America/Chicago), plus a slow "lane-fill" trickle between batches so lanes
// never sit idle. This module is pure: given a clock + config it answers
// "is this a batch load-point?" and "how many NEW dispatches may this tick admit?".

import type { ContinuousOrchestrationConfig } from "./config.js";

/** Local "HH:mm" for an epoch-ms instant in `tz` (24h, zero-padded). */
export function localHHmm(nowMs: number, tz: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(nowMs));
}

/** True when the current local minute is one of the batch load-points. */
export function isLoadPoint(nowMs: number, config: ContinuousOrchestrationConfig): boolean {
  const hhmm = localHHmm(nowMs, config.timezone);
  return config.cadence_load_points.includes(hhmm);
}

/**
 * How many NEW dispatches this tick may admit.
 *
 * T-ORCH P0 (continuous): EVERY tick may refill the lane up to the in-flight
 * cap — the daemon loads + fires continuously rather than only batch-loading at
 * the 3 cadence points. The actual headroom (`max_in_flight - in_flight`) is
 * applied by `planAdmission` via `slotsFree`, so a tick admits only as many NEW
 * dispatches as there are free slots. `max_new_per_tick` is kept as a floor so
 * a tiny configured cap can't drop the lane-fill below the intended trickle.
 *
 * `_nowMs` is retained for signature stability (load-points still inform the
 * refuel batch heuristic via `isLoadPoint`), but admission no longer gates on it.
 */
export function tickAdmitLimit(_nowMs: number, config: ContinuousOrchestrationConfig): number {
  return Math.max(config.max_in_flight, config.max_new_per_tick);
}
