// T-RELIABILITY (model-effectiveness E4) — canary routing by task-class.
//
// Shadow/canary A/B: route a FRACTION of a low-risk task-class (routine, then
// build) to the efficient Sonnet 4.6, keep Opus 4.8 as baseline, and NEVER canary
// high-stakes classes (scope/review/novel). The arm is a deterministic function of
// a stable per-dispatch key, so the same dispatch always lands in the same arm —
// reproducible and measurable on the /usage/effectiveness read-model.
//
// This is the ROUTING mechanism only; the decision to enable/promote a fraction is
// Chris's, encoded as config (E5: recommend → approve → route). Never an automatic
// cost-downgrade.

export type CanaryArm = "canary" | "baseline";

export interface CanaryRoutingConfig {
  /** The high-quality baseline (e.g. claude-opus-4-8). */
  baseline_model: string;
  /** The efficient canary candidate (e.g. claude-sonnet-4-6). */
  canary_model: string;
  /** Per-task-class canary fraction in [0,1]. Absent → 0 (baseline only). */
  fraction_by_task_class: Record<string, number>;
  /** Task classes that MUST NEVER canary regardless of fraction — a safety floor
   *  for high-stakes work even if a fraction is mis-set (scope/review/novel). */
  never_canary_task_classes?: string[];
}

export interface CanaryDecision {
  arm: CanaryArm;
  model: string;
  task_class: string;
  /** The effective fraction applied (0 for never-canary / absent classes). */
  fraction: number;
  reason: string;
}

/** Default: canary OFF (all fractions 0 until Chris enables per class); high-stakes
 *  classes hard-excluded. Enable by setting fraction_by_task_class per the spec
 *  (routine first, then build). */
export const DEFAULT_CANARY_CONFIG: CanaryRoutingConfig = {
  baseline_model: "claude-opus-4-8",
  canary_model: "claude-sonnet-4-6",
  fraction_by_task_class: {},
  never_canary_task_classes: ["scope", "review", "novel", "destructive", "costly", "external"],
};

/** Stable, dependency-free FNV-1a → a uniform bucket in [0, 10000). Deterministic
 *  so the same key always resolves to the same arm. */
function bucket(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) % 10000;
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

/**
 * Decide the canary arm + model for one dispatch. Pure + deterministic in `key`.
 */
export function decideCanaryRouting(args: {
  task_class: string;
  /** Stable per-dispatch key (dispatch_id / dedup_key). */
  key: string;
  config: CanaryRoutingConfig;
}): CanaryDecision {
  const { task_class, key, config } = args;
  const never = new Set(config.never_canary_task_classes ?? []);

  if (never.has(task_class)) {
    return {
      arm: "baseline",
      model: config.baseline_model,
      task_class,
      fraction: 0,
      reason: `high-stakes class '${task_class}' is never canaried`,
    };
  }

  const fraction = clamp01(config.fraction_by_task_class[task_class] ?? 0);
  if (fraction <= 0) {
    return { arm: "baseline", model: config.baseline_model, task_class, fraction, reason: `no canary for '${task_class}' (fraction 0)` };
  }
  if (fraction >= 1) {
    return { arm: "canary", model: config.canary_model, task_class, fraction, reason: `full canary for '${task_class}'` };
  }

  // Per-class-independent deterministic assignment (so a key canaried for one class
  // isn't correlated with another).
  const inCanary = bucket(`${task_class}:${key}`) < Math.round(fraction * 10000);
  return inCanary
    ? { arm: "canary", model: config.canary_model, task_class, fraction, reason: `canary ${Math.round(fraction * 100)}% of '${task_class}'` }
    : { arm: "baseline", model: config.baseline_model, task_class, fraction, reason: `baseline ${Math.round((1 - fraction) * 100)}% of '${task_class}'` };
}
