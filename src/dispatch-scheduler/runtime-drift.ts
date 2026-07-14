// RD-014 drift-guard Ticket A (2026-07-05) — agent runtime liveness is
// re-derived statelessly on every check (computeFleetAdmissionExclusions),
// with no persisted prior state and no transition detection: a healthy->
// pending flip is never noticed as an EVENT, only as a snapshot. That is
// exactly how the overnight-audit cascade went unnoticed — agents silently
// flipped to pending while admission kept dispatching to them anyway.
//
// Mirrors the three-layer shape already established for this problem class
// in deploy-guard/freshness.ts + fleet-freshness.ts: a pure per-node state
// machine (evaluateRuntimeDrift), a fleet wrapper folding many nodes into one
// tick (evaluateFleetRuntimeDrift), and a normalizer turning existing raw
// signals into the state machine's input (deriveRuntimeDriftState). The
// caller persists FleetRuntimeDriftState in memory across ticks (same
// durability class as fleetFreshnessState) and does the I/O (Telegram alert).

import type { AgentRow } from "../db/types.js";
import type { RoutingHealthReadModel } from "../routing-health/types.js";
import {
  LIVE_AGENT_STATUSES,
  OFFLINE_AGENT_STATUSES,
  providersConstrainedByRoutingHealth,
} from "./manager-integration.js";
import { resolveProviderFromRuntime } from "./types.js";

export type RuntimeDriftState = "healthy" | "pending" | "offline" | "unknown";

export interface AgentDriftTrackerState {
  state: RuntimeDriftState;
  /** ISO timestamp when the current state started. */
  since: string | null;
  /** ISO timestamp of the last alert fired for the current degraded streak. */
  last_alert_at: string | null;
}

export const INITIAL_DRIFT: AgentDriftTrackerState = {
  state: "unknown",
  since: null,
  last_alert_at: null,
};

export const DEFAULT_DRIFT_RE_ALERT_MS = 60 * 60 * 1000; // hourly, mirrors freshness.ts

export interface DriftEvalOptions {
  reAlertMs?: number;
}

export interface DriftAlert {
  kind: "drifted" | "recovered";
  message: string;
}

export interface DriftEvalResult {
  next: AgentDriftTrackerState;
  alert: DriftAlert | null;
}

function isDegraded(s: RuntimeDriftState): boolean {
  return s === "pending" || s === "offline";
}

/**
 * Advance one agent's drift tracker by one observation.
 *
 * - curr === "unknown"      → can't decide this tick; hold prior state, never alert.
 * - prev.state === "unknown" (no baseline yet) → establish curr as the baseline,
 *   never alert — this is what makes "no alert for agents that were never live" hold:
 *   an agent whose FIRST observation is already pending/offline has no known-healthy
 *   moment to have drifted FROM.
 * - healthy -> pending/offline → one-shot "drifted" alert.
 * - pending/offline -> pending/offline → bounded re-alert (every reAlertMs), same
 *   semantics as freshness.ts's hourly stale re-nudge.
 * - pending/offline -> healthy → one-shot "recovered" alert.
 */
export function evaluateRuntimeDrift(
  prev: AgentDriftTrackerState,
  curr: RuntimeDriftState,
  nowMs: number,
  opts: DriftEvalOptions = {},
): DriftEvalResult {
  const reAlertMs = opts.reAlertMs ?? DEFAULT_DRIFT_RE_ALERT_MS;
  const nowIso = new Date(nowMs).toISOString();

  if (curr === "unknown") {
    return { next: prev, alert: null };
  }

  if (prev.state === "unknown") {
    return { next: { state: curr, since: nowIso, last_alert_at: null }, alert: null };
  }

  if (curr === "healthy") {
    if (isDegraded(prev.state)) {
      return {
        next: { state: "healthy", since: nowIso, last_alert_at: null },
        alert: { kind: "recovered", message: `Agent runtime recovered — was ${prev.state}, now healthy.` },
      };
    }
    return { next: prev.state === "healthy" ? prev : { state: "healthy", since: nowIso, last_alert_at: null }, alert: null };
  }

  // curr is "pending" or "offline"
  if (prev.state === "healthy") {
    return {
      next: { state: curr, since: nowIso, last_alert_at: nowIso },
      alert: { kind: "drifted", message: `Agent runtime flipped healthy -> ${curr}.` },
    };
  }

  // prev.state is pending/offline and curr is pending/offline: bounded re-alert.
  const lastAlertMs = prev.last_alert_at ? Date.parse(prev.last_alert_at) : NaN;
  const shouldReAlert = !Number.isFinite(lastAlertMs) || nowMs - lastAlertMs >= reAlertMs;
  if (shouldReAlert) {
    return {
      next: { state: curr, since: prev.since ?? nowIso, last_alert_at: nowIso },
      alert: {
        kind: "drifted",
        message: `Agent runtime still ${curr} (since ${prev.since ?? "unknown"}).`,
      },
    };
  }
  return { next: { state: curr, since: prev.since ?? nowIso, last_alert_at: prev.last_alert_at }, alert: null };
}

/** One agent's drift observation for a tick. */
export interface AgentDriftInput {
  agent_id: string;
  agent_name: string;
  state: RuntimeDriftState;
}

export type RuntimeDriftAgent = Pick<AgentRow, "id" | "name" | "status" | "runtime">;

/** Per-agent drift tracker state, keyed by agent_id. */
export type FleetRuntimeDriftState = Record<string, AgentDriftTrackerState>;

export interface AgentDriftAlert {
  agent_id: string;
  agent_name: string;
  alert: DriftAlert;
}

export interface DriftedAgentSummary {
  agent_id: string;
  agent_name: string;
  state: RuntimeDriftState;
  since: string | null;
}

export interface FleetRuntimeDriftSummary {
  /** Agents currently pending or offline (i.e. drifted from healthy, or never confirmed healthy). */
  drifted_agents: DriftedAgentSummary[];
}

export interface FleetDriftResult {
  next: FleetRuntimeDriftState;
  alerts: AgentDriftAlert[];
  summary: FleetRuntimeDriftSummary;
}

export const EMPTY_FLEET_DRIFT_SUMMARY: FleetRuntimeDriftSummary = { drifted_agents: [] };

export function isDesiredOnlineAgent(agent: Pick<AgentRow, "status">): boolean {
  const status = (agent.status ?? "").trim().toLowerCase();
  return LIVE_AGENT_STATUSES.has(status);
}

export function deriveFleetRuntimeDriftInputs(
  agents: RuntimeDriftAgent[],
  model: RoutingHealthReadModel | null | undefined,
): AgentDriftInput[] {
  return agents
    .filter(isDesiredOnlineAgent)
    .map((agent) => ({
      agent_id: agent.id,
      agent_name: agent.name,
      state: deriveRuntimeDriftState(agent, model),
    }));
}

function formatAlertLine(alert: AgentDriftAlert): string {
  return `- ${alert.agent_name}: ${alert.alert.message}`;
}

export function formatFleetRuntimeDriftAlert(alerts: AgentDriftAlert[]): string | null {
  if (alerts.length === 0) return null;

  const drifted = alerts.filter((a) => a.alert.kind === "drifted");
  const recovered = alerts.filter((a) => a.alert.kind === "recovered");
  const parts = ["Runtime drift incident"];

  if (drifted.length > 0) {
    parts.push(`Drifted desired-online agents (${drifted.length}):`, ...drifted.map(formatAlertLine));
  }
  if (recovered.length > 0) {
    parts.push(`Recovered desired-online agents (${recovered.length}):`, ...recovered.map(formatAlertLine));
  }

  return parts.join("\n");
}

/**
 * Advance every agent's drift tracker by one observation, folding the results
 * into one fleet summary + the list of per-agent alerts to emit. Unobserved
 * agents (present in `prev` but not in `inputs` this tick, e.g. deleted) are
 * dropped from `next` — same "only track what's currently observed" rule
 * evaluateFleetFreshness uses, so a removed agent can't leak a tracker forever.
 */
export function evaluateFleetRuntimeDrift(
  prev: FleetRuntimeDriftState,
  inputs: AgentDriftInput[],
  nowMs: number,
  opts: DriftEvalOptions = {},
): FleetDriftResult {
  const next: FleetRuntimeDriftState = {};
  const alerts: AgentDriftAlert[] = [];
  const drifted: DriftedAgentSummary[] = [];

  for (const input of inputs) {
    const prevState = prev[input.agent_id] ?? INITIAL_DRIFT;
    const { next: nodeNext, alert } = evaluateRuntimeDrift(prevState, input.state, nowMs, opts);
    next[input.agent_id] = nodeNext;
    if (alert) alerts.push({ agent_id: input.agent_id, agent_name: input.agent_name, alert });
    if (isDegraded(nodeNext.state)) {
      drifted.push({
        agent_id: input.agent_id,
        agent_name: input.agent_name,
        state: nodeNext.state,
        since: nodeNext.since,
      });
    }
  }

  return { next, alerts, summary: { drifted_agents: drifted } };
}

/**
 * Normalize an agent row's existing signals into a RuntimeDriftState.
 *
 * Reuses LIVE_AGENT_STATUSES/OFFLINE_AGENT_STATUSES (the same sets the
 * fleet-composition admission gate uses) rather than re-declaring a second
 * status vocabulary that could drift out of sync, and reuses
 * providersConstrainedByRoutingHealth + resolveProviderFromRuntime (the same
 * provider-level mapping RD-014 Ticket B's claim-time gate uses) rather than
 * comparing routing-health's coarse runtime labels against agent.runtime
 * directly.
 *
 * - No status at all               → "unknown" (can't decide).
 * - status in OFFLINE_AGENT_STATUSES → "offline".
 * - status in LIVE_AGENT_STATUSES   → "healthy", UNLESS routing-health reports
 *   this agent's own lane down, in which case it's "pending" — this is the
 *   exact "agent row still says running/healthy while its runtime cannot
 *   execute anything" gap the overnight-audit cascade exposed. `model` absent
 *   (routing-health not wired this tick) fails open to "healthy" here, same
 *   as providersConstrainedByRoutingHealth's own fail-safe posture.
 * - any other status string (e.g. the manager's own literal "pending" set on
 *   a pending restart) → "pending": a soft/ambiguous signal, never treated as
 *   confirmed-healthy.
 */
export function deriveRuntimeDriftState(
  agent: Pick<AgentRow, "status" | "runtime">,
  model: RoutingHealthReadModel | null | undefined,
): RuntimeDriftState {
  const status = (agent.status ?? "").trim().toLowerCase();
  if (!status) return "unknown";
  if (OFFLINE_AGENT_STATUSES.has(status)) return "offline";
  if (LIVE_AGENT_STATUSES.has(status)) {
    const laneDown = providersConstrainedByRoutingHealth(model).includes(
      resolveProviderFromRuntime(agent.runtime),
    );
    return laneDown ? "pending" : "healthy";
  }
  return "pending";
}
