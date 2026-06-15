// SPDX-License-Identifier: MIT
/**
 * Pure read-model builders for the Agents effectiveness/dispatches endpoints.
 *
 * No I/O. The route layer feeds these builders the typed DispatchVerification
 * projection rows (already window-filtered for the per-agent dispatches list)
 * and they shape the public response objects.
 *
 * Reconciliation invariant: fleet totals are derived by SUMMING the per-agent
 * rollups, never computed independently. This guarantees
 *   fleet.dispatches_completed === sum(agents[].dispatches_completed)
 *   fleet.verified_landings     === sum(agents[].verified_landings)
 *   fleet.failure_breakdown[x]  === sum over agents of that agent's count of x
 * hold exactly.
 */

import {
  DISPATCH_VERIFICATION_FAILURE_TYPES,
  WINDOW_DAYS,
  type DispatchVerification,
  type DispatchVerificationFailureType,
  type DispatchArtifactKind,
  type EffectivenessWindow,
} from './types.js';

export interface AgentsEffectivenessResponse {
  schema_version: 'agents.effectiveness.v1';
  generated_at: string;
  window: EffectivenessWindow;
  fleet: {
    dispatches_completed: number;
    verified_landings: number;
    verified_landing_rate: number;
    throughput_per_week: number;
    failure_breakdown: Record<DispatchVerificationFailureType, number>;
    trend_4w: number[];
  };
  agents: Array<{
    name: string;
    status: string;
    dispatches_completed: number;
    verified_landings: number;
    verified_landing_rate: number;
    throughput: number;
    top_failure_type: DispatchVerificationFailureType | null;
    in_flight_dispatch_id: string | null;
    last_verified_landing: {
      timestamp: string;
      artifact_path: string;
      tl_dr: string | null;
      kind: DispatchArtifactKind;
    } | null;
  }>;
}

export interface AgentDispatchesResponse {
  schema_version: 'agents.dispatches.v1';
  generated_at: string;
  agent_name: string;
  window: EffectivenessWindow;
  items: Array<{
    dispatch_id: string;
    query_id: string | null;
    time: string;
    subject: string;
    dispatch_status: string;
    verification_status: DispatchVerification['status'];
    verified: boolean;
    failure_type: DispatchVerificationFailureType | null;
    failure_detail: string | null;
    artifact_path: string | null;
    artifact_exists: boolean | null;
    artifact_mtime: string | null;
    promotion_required: boolean;
    promotion_verified: boolean | null;
    promotion_failure_detail: string | null;
    tl_dr: string | null;
    kind: DispatchArtifactKind;
  }>;
}

interface RosterEntry {
  name: string;
  status: string;
  in_flight_dispatch_id?: string | null;
}

/** Round to n decimals, returning a plain number (no trailing-zero strings). */
function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function emptyFailureBreakdown(): Record<DispatchVerificationFailureType, number> {
  const out = {} as Record<DispatchVerificationFailureType, number>;
  for (const ft of DISPATCH_VERIFICATION_FAILURE_TYPES) out[ft] = 0;
  return out;
}

interface AgentRollup {
  dispatches_completed: number;
  verified_landings: number;
  failure_breakdown: Record<DispatchVerificationFailureType, number>;
  last_verified_landing: AgentsEffectivenessResponse['agents'][number]['last_verified_landing'];
}

function emptyRollup(): AgentRollup {
  return {
    dispatches_completed: 0,
    verified_landings: 0,
    failure_breakdown: emptyFailureBreakdown(),
    last_verified_landing: null,
  };
}

export function buildAgentsEffectiveness(
  rows: DispatchVerification[],
  roster: RosterEntry[],
  window: EffectivenessWindow,
  generatedAtIso: string,
): AgentsEffectivenessResponse {
  // Group rows by agent into per-agent rollups.
  const rollups = new Map<string, AgentRollup>();
  const ensure = (name: string): AgentRollup => {
    let r = rollups.get(name);
    if (!r) {
      r = emptyRollup();
      rollups.set(name, r);
    }
    return r;
  };

  for (const row of rows) {
    const r = ensure(row.agent_name);

    // "completed" = reached a terminal/classified verification state.
    if (row.status !== 'pending') r.dispatches_completed += 1;

    if (row.verified) {
      r.verified_landings += 1;

      // Track the latest verified landing that has an artifact_path.
      if (row.artifact_path != null) {
        const prev = r.last_verified_landing;
        if (
          prev === null ||
          isAfter(row.dispatch_completed_at, prev.timestamp)
        ) {
          r.last_verified_landing = {
            timestamp: row.dispatch_completed_at ?? '',
            artifact_path: row.artifact_path,
            tl_dr: row.tl_dr,
            kind: row.kind,
          };
        }
      }
    }

    if (row.failure_type != null) {
      r.failure_breakdown[row.failure_type] += 1;
    }
  }

  // Roster lookup for status + in_flight_dispatch_id.
  const rosterByName = new Map<string, RosterEntry>();
  for (const entry of roster) rosterByName.set(entry.name, entry);

  // Every roster agent + every agent observed in rows.
  const allNames = new Set<string>();
  for (const entry of roster) allNames.add(entry.name);
  for (const name of rollups.keys()) allNames.add(name);

  const windowDays = WINDOW_DAYS[window];

  const agents = [...allNames]
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .map((name) => {
      const r = rollups.get(name) ?? emptyRollup();
      const rosterEntry = rosterByName.get(name);
      const status = rosterEntry ? rosterEntry.status : 'unknown';
      const inFlight = rosterEntry?.in_flight_dispatch_id ?? null;

      const rate =
        r.dispatches_completed === 0
          ? 0
          : round(r.verified_landings / r.dispatches_completed, 4);
      const throughput = round((r.verified_landings / windowDays) * 7, 2);

      return {
        name,
        status,
        dispatches_completed: r.dispatches_completed,
        verified_landings: r.verified_landings,
        verified_landing_rate: rate,
        throughput,
        top_failure_type: topFailureType(r.failure_breakdown),
        in_flight_dispatch_id: inFlight,
        last_verified_landing: r.last_verified_landing,
      };
    });

  // Fleet totals derived by SUMMING the per-agent rollups (reconciliation).
  const fleetFailureBreakdown = emptyFailureBreakdown();
  let fleetCompleted = 0;
  let fleetVerified = 0;
  for (const agent of agents) {
    fleetCompleted += agent.dispatches_completed;
    fleetVerified += agent.verified_landings;
  }
  for (const r of rollups.values()) {
    for (const ft of DISPATCH_VERIFICATION_FAILURE_TYPES) {
      fleetFailureBreakdown[ft] += r.failure_breakdown[ft];
    }
  }

  const fleetRate =
    fleetCompleted === 0 ? 0 : round(fleetVerified / fleetCompleted, 4);
  const fleetThroughput = round((fleetVerified / windowDays) * 7, 2);

  return {
    schema_version: 'agents.effectiveness.v1',
    generated_at: generatedAtIso,
    window,
    fleet: {
      dispatches_completed: fleetCompleted,
      verified_landings: fleetVerified,
      verified_landing_rate: fleetRate,
      throughput_per_week: fleetThroughput,
      failure_breakdown: fleetFailureBreakdown,
      trend_4w: buildTrend4w(rows, generatedAtIso),
    },
    agents,
  };
}

/** Highest-count failure type; tie-break by enum order (earlier wins). */
function topFailureType(
  breakdown: Record<DispatchVerificationFailureType, number>,
): DispatchVerificationFailureType | null {
  let best: DispatchVerificationFailureType | null = null;
  let bestCount = 0;
  for (const ft of DISPATCH_VERIFICATION_FAILURE_TYPES) {
    const count = breakdown[ft];
    if (count > bestCount) {
      bestCount = count;
      best = ft;
    }
  }
  return best;
}

/**
 * Four verified-landing counts in consecutive 7-day buckets ending at
 * generatedAtIso (oldest first). Bucket i covers
 *   [generatedAt - (4-i)*7d, generatedAt - (3-i)*7d).
 * Bucketed by dispatch_completed_at; only verified rows count. Independent of
 * the requested window.
 */
export function buildTrend4w(
  rows: DispatchVerification[],
  generatedAtIso: string,
): number[] {
  const generatedAt = Date.parse(generatedAtIso);
  const weekMs = 7 * 24 * 60 * 60 * 1000;
  const buckets = [0, 0, 0, 0];

  for (const row of rows) {
    if (!row.verified) continue;
    if (row.dispatch_completed_at == null) continue;
    const t = Date.parse(row.dispatch_completed_at);
    if (Number.isNaN(t)) continue;
    for (let i = 0; i < 4; i++) {
      const start = generatedAt - (4 - i) * weekMs;
      const end = generatedAt - (3 - i) * weekMs;
      if (t >= start && t < end) {
        buckets[i] += 1;
        break;
      }
    }
  }
  return buckets;
}

/** True when a (later) is strictly after b. Null `a` never wins. */
function isAfter(a: string | null, b: string | null): boolean {
  if (a == null) return false;
  if (b == null) return true;
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  if (Number.isNaN(ta)) return false;
  if (Number.isNaN(tb)) return true;
  return ta > tb;
}

export function buildAgentDispatches(
  rows: DispatchVerification[],
  agentName: string,
  window: EffectivenessWindow,
  limit: number,
  generatedAtIso: string,
): AgentDispatchesResponse {
  const sorted = [...rows].sort((a, b) => {
    const ta = a.dispatch_completed_at ?? a.dispatch_created_at;
    const tb = b.dispatch_completed_at ?? b.dispatch_created_at;
    const pa = Date.parse(ta);
    const pb = Date.parse(tb);
    if (Number.isNaN(pa) && Number.isNaN(pb)) return 0;
    if (Number.isNaN(pa)) return 1;
    if (Number.isNaN(pb)) return -1;
    return pb - pa; // DESC
  });

  const items = sorted.slice(0, Math.max(0, limit)).map((row) => {
    const subject =
      (row as { subject?: string }).subject ?? row.tl_dr ?? '';
    return {
      dispatch_id: row.dispatch_id,
      query_id: row.query_id,
      time: row.dispatch_completed_at ?? row.dispatch_created_at,
      subject,
      dispatch_status: row.dispatch_status,
      verification_status: row.status,
      verified: row.verified,
      failure_type: row.failure_type,
      failure_detail: row.failure_detail,
      artifact_path: row.artifact_path,
      artifact_exists: row.artifact_exists,
      artifact_mtime: row.artifact_mtime,
      promotion_required: row.promotion_required,
      promotion_verified: row.promotion_verified,
      promotion_failure_detail: row.promotion_failure_detail,
      tl_dr: row.tl_dr,
      kind: row.kind,
    };
  });

  return {
    schema_version: 'agents.dispatches.v1',
    generated_at: generatedAtIso,
    agent_name: agentName,
    window,
    items,
  };
}
