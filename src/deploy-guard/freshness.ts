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
  /** Stable incident key for the currently-alerted running/promoted SHA pair. */
  incident_key?: string | null;
}

export const INITIAL_FRESHNESS: FreshnessTrackerState = {
  state: "fresh",
  behind_origin_since: null,
  last_alert_at: null,
};

export const DEFAULT_STALE_THRESHOLD_MS = 15 * 60 * 1000; // 15 minutes
export interface FreshnessInput {
  behind_origin: boolean | null;
  build_sha: string | null;
  origin_main_sha: string | null;
  source_branch_sha?: string | null;
  source_branch_name?: string | null;
  classification?: string | null;
}

export interface FreshnessAlert {
  kind: "stale" | "recovered";
  message: string;
}

export interface FreshnessEvalOptions {
  thresholdMs?: number;
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
 *   stale ≥ thresholdMs, emit one keyed incident per running/promoted SHA pair.
 * - behind_origin === null  → unknown; hold state, never alert (can't decide).
 */
export function evaluateFreshness(
  prev: FreshnessTrackerState,
  input: FreshnessInput,
  nowMs: number,
  opts: FreshnessEvalOptions = {},
): FreshnessEvalResult {
  const thresholdMs = opts.thresholdMs ?? DEFAULT_STALE_THRESHOLD_MS;
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
          message:
            `BUILD_BEHIND_ORIGIN resolved: clean deploy build caught up; ` +
            `running_sha=${short(input.build_sha)} promoted_sha=${short(input.origin_main_sha)}. ` +
            `Incident auto-closed.`,
        },
      };
    }
    return { next: INITIAL_FRESHNESS, alert: null };
  }

  // behind_origin === true
  const since = prev.behind_origin_since ?? nowIso;
  const sinceMs = Date.parse(since);
  const elapsedMs = Number.isFinite(sinceMs) ? nowMs - sinceMs : 0;
  const incidentKey = buildIncidentKey(input);

  if (elapsedMs >= thresholdMs) {
    const shouldAlert =
      prev.state !== "stale_alerted" ||
      prev.incident_key !== incidentKey;
    if (shouldAlert) {
      return {
        next: { state: "stale_alerted", behind_origin_since: since, last_alert_at: nowIso, incident_key: incidentKey },
        alert: {
          kind: "stale",
          message: formatBuildBehindOriginIncident(input, elapsedMs),
        },
      };
    }
    return { next: { ...prev, state: "stale_alerted", behind_origin_since: since, incident_key: incidentKey }, alert: null };
  }

  return { next: { state: "stale", behind_origin_since: since, last_alert_at: prev.last_alert_at, incident_key: prev.incident_key ?? null }, alert: null };
}

function short(sha: string | null): string {
  return sha ? sha.slice(0, 8) : "unknown";
}

function buildIncidentKey(input: FreshnessInput): string {
  return `build_behind_origin:${input.build_sha ?? "unknown"}:${input.origin_main_sha ?? "unknown"}`;
}

function formatBuildBehindOriginIncident(input: FreshnessInput, elapsedMs: number): string {
  const parts = [
    `BUILD_BEHIND_ORIGIN incident: running manager build is behind promoted main for ${Math.round(elapsedMs / 60000)} min.`,
    `running_sha=${short(input.build_sha)}`,
    `promoted_sha=${short(input.origin_main_sha)}`,
  ];
  if (input.source_branch_sha) parts.push(`source_branch_sha=${short(input.source_branch_sha)}`);
  if (input.source_branch_name) parts.push(`source_branch=${input.source_branch_name}`);
  if (input.classification) parts.push(`classification=${input.classification}`);
  parts.push(
    "Action: rebuild/restart from the clean deploy-checkout at origin/main, then verify /health build.build_sha equals build.origin_main_sha.",
  );
  parts.push("Repeated ticks for the same running/promoted SHA pair are suppressed; this incident auto-closes when the clean deploy build catches up.");
  return parts.join(" ");
}
