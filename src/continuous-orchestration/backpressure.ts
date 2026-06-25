// P0 control-plane Slice 4 — daemon backpressure (pure helpers).
//
// Two mechanisms, both config-driven and DEFAULT-INERT (permissive config ==
// today's behavior):
//   - adaptive tick backoff (computeNextDelay): the self-scheduling tick loop
//     grows its delay on slow ticks and decays on fast ones, bounded.
//   - shared per-tick write budget (tickWriteCaps): refuel + admission draw from
//     ONE ceiling, and a refuel write-burst suppresses admission that tick so
//     the daemon can't stack two write bursts in a single tick.
// Nothing here runs until continuous orchestration is re-enabled.

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), hi);
}

/**
 * Adaptive tick backoff. Returns the next delay + the carried multiplier.
 * The multiplier grows ×2 on a slow tick (lastTickMs >= slowTickMs) and decays
 * ÷2 on a fast tick, clamped to [1, backoffMax]; the delay is therefore always
 * within [baseMs, baseMs*backoffMax]. Pure.
 */
export function computeNextDelay(
  baseMs: number,
  lastTickMs: number,
  slowTickMs: number,
  backoffMax: number,
  prevMult: number,
): { delayMs: number; mult: number } {
  const cap = Math.max(1, backoffMax);
  const prev = clamp(prevMult, 1, cap);
  const slow = lastTickMs >= slowTickMs;
  const mult = slow ? Math.min(prev * 2, cap) : Math.max(prev / 2, 1);
  const delayMs = Math.round(clamp(baseMs * mult, baseMs, baseMs * cap));
  return { delayMs, mult };
}

export interface TickWriteCaps {
  /** Max skeletons the refuel pass may flesh this tick: the global per-tick
   *  write budget intersected with the per-tick flesh cap. */
  refuelCap: number;
  /** Max NEW dispatches admission may fire this tick. 0 once the refuel has
   *  fleshed anything this tick (no stacked write burst). */
  admitCap: number;
}

/**
 * Shared per-tick write budget across refuel + admission. `refuelFleshed` is how
 * many items the refuel pass actually fleshed this tick (pass 0 before refuel
 * runs to read `refuelCap`; pass the real count after to read `admitCap`).
 * Pure. Guarantees refuelFleshed + admitCap <= maxEnqueuesPerTick whenever the
 * refuel respected refuelCap.
 */
/** Sentinel: an admission cap that imposes no ceiling (min() with it is a no-op). */
export const UNLIMITED_ADMIT = Number.MAX_SAFE_INTEGER;

export function tickWriteCaps(
  cfg: { maxEnqueuesPerTick: number; maxFleshPerTick: number; maxNewPerTick?: number },
  refuelFleshed: number,
): TickWriteCaps {
  const budget = cfg.maxEnqueuesPerTick;
  const maxFlesh = Math.max(0, cfg.maxFleshPerTick);
  // DEFAULT-INERT: a non-positive budget means "no shared ceiling" — refuel keeps
  // its own flesh cap and admission is uncapped (today's behavior). The operator
  // sets max_enqueues_per_tick > 0 at re-enable to activate backpressure.
  if (budget <= 0) {
    return { refuelCap: maxFlesh, admitCap: UNLIMITED_ADMIT };
  }
  const refuelCap = Math.min(maxFlesh, budget);
  const fleshed = Math.max(0, refuelFleshed);
  // Mechanism 1: admission draws from the SAME budget as refuel (remaining =
  // budget - fleshed). Mechanism 2: any refuel write this tick suppresses
  // admission entirely so two write bursts never stack in one tick.
  const admitCap = fleshed > 0 ? 0 : Math.max(0, budget - fleshed);
  return { refuelCap, admitCap };
}

/** Clamp the configured tick interval to its floor (mechanism 4). Pure. */
export function clampTickInterval(tickIntervalMs: number, minTickIntervalMs: number): number {
  return Math.max(tickIntervalMs, Math.max(0, minTickIntervalMs));
}
