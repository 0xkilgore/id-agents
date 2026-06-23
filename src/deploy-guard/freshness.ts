// T-DEPLOY.1 (2026-06-22) — fleet freshness tracker.
//
// "merged != running" drift cost a manual recovery today. This tracks how long
// the running build has been behind origin/main and raises an alert once it has
// stayed stale past a threshold (default 15 min), with bounded re-alerting. The
// decision is pure (no I/O, clock injected) so the threshold + alert behavior
// are unit-testable without a running manager.

export type FreshnessState = "fresh" | "stale" | "stale_alerted";

export interface FreshnessTrackerState {
  state: FreshnessState;
  /** ISO timestamp when behind_origin first became true in the current streak. */
  behind_origin_since: string | null;
  /** ISO timestamp of the last alert fired in the current stale streak. */
  last_alert_at: string | null;
}

export const INITIAL_FRESHNESS: FreshnessTrackerState = {
  state: "fresh",
  behind_origin_since: null,
  last_alert_at: null,
};

export const DEFAULT_STALE_THRESHOLD_MS = 15 * 60 * 1000; // 15 minutes
export const DEFAULT_RE_ALERT_MS = 60 * 60 * 1000; // re-nudge hourly while stale

export interface FreshnessInput {
  behind_origin: boolean | null;
  build_sha: string | null;
  origin_main_sha: string | null;
}

export interface FreshnessAlert {
  kind: "stale" | "recovered";
  message: string;
}

export interface FreshnessEvalOptions {
  thresholdMs?: number;
  reAlertMs?: number;
}

export interface FreshnessEvalResult {
  next: FreshnessTrackerState;
  alert: FreshnessAlert | null;
}

/**
 * Advance the freshness tracker by one observation.
 *
 * - behind_origin === false → fresh; if we had alerted, emit a one-shot
 *   "recovered" alert and reset.
 * - behind_origin === true  → start/continue the stale streak; once it has been
 *   stale ≥ thresholdMs, emit a "stale" alert (re-alerting every reAlertMs).
 * - behind_origin === null  → unknown; hold state, never alert (can't decide).
 */
export function evaluateFreshness(
  prev: FreshnessTrackerState,
  input: FreshnessInput,
  nowMs: number,
  opts: FreshnessEvalOptions = {},
): FreshnessEvalResult {
  const thresholdMs = opts.thresholdMs ?? DEFAULT_STALE_THRESHOLD_MS;
  const reAlertMs = opts.reAlertMs ?? DEFAULT_RE_ALERT_MS;
  const nowIso = new Date(nowMs).toISOString();

  if (input.behind_origin === null) {
    return { next: prev, alert: null };
  }

  if (input.behind_origin === false) {
    if (prev.state === "stale_alerted") {
      return {
        next: INITIAL_FRESHNESS,
        alert: {
          kind: "recovered",
          message: `✅ Manager build is fresh again — running build matches origin/main (${short(input.build_sha)}).`,
        },
      };
    }
    return { next: INITIAL_FRESHNESS, alert: null };
  }

  // behind_origin === true
  const since = prev.behind_origin_since ?? nowIso;
  const sinceMs = Date.parse(since);
  const elapsedMs = Number.isFinite(sinceMs) ? nowMs - sinceMs : 0;

  if (elapsedMs >= thresholdMs) {
    const lastAlertMs = prev.last_alert_at ? Date.parse(prev.last_alert_at) : NaN;
    const shouldAlert =
      prev.state !== "stale_alerted" ||
      !Number.isFinite(lastAlertMs) ||
      nowMs - lastAlertMs >= reAlertMs;
    if (shouldAlert) {
      return {
        next: { state: "stale_alerted", behind_origin_since: since, last_alert_at: nowIso },
        alert: {
          kind: "stale",
          message:
            `⚠️ Manager build is STALE — behind origin/main for ${Math.round(elapsedMs / 60000)} min. ` +
            `running=${short(input.build_sha)} origin=${short(input.origin_main_sha)}. ` +
            `Run the deploy refresh (manager-deploy-runbook.md).`,
        },
      };
    }
    return { next: { ...prev, state: "stale_alerted", behind_origin_since: since }, alert: null };
  }

  return { next: { state: "stale", behind_origin_since: since, last_alert_at: prev.last_alert_at }, alert: null };
}

function short(sha: string | null): string {
  return sha ? sha.slice(0, 8) : "unknown";
}
