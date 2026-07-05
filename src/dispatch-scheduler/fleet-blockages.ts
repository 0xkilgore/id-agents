import type { DbAdapterLike } from "../supervisor/manager-source-reader.js";
import type { FleetRuntimeDriftSummary } from "./runtime-drift.js";

export type FleetBlockageKind =
  | "needs_clarification"
  | "stale_clarification"
  | "co_stall"
  | "orchestration_paused"
  | "usage_gate_enforced"
  | "stall_class_pending_agent";

export type FleetBlockage = {
  kind: FleetBlockageKind;
  severity: "warn" | "critical";
  message: string;
  count: number;
  oldest_at: string | null;
  action: string;
};

export type FleetBlockagesReport = {
  blocked: boolean;
  blockages: FleetBlockage[];
  generated_at: string;
};

const STALE_CLARIFICATION_MS = 30 * 60 * 1000;
const CO_STALL_TICK_THRESHOLD = 3;

export async function readFleetBlockages(
  adapter: DbAdapterLike,
  teamId: string,
  /**
   * RD-014 drift-guard Ticket A: the runtime-drift tracker is in-memory
   * (same durability class as the deploy-guard freshness tracker), not a DB
   * table like every other blockage source here — so it can't be queried
   * inside this function. The caller (the periodic tick that owns the
   * tracker) passes its current summary through instead of this function
   * reaching for global state.
   */
  driftSummary?: FleetRuntimeDriftSummary | null,
): Promise<FleetBlockagesReport> {
  const nowMs = Date.now();
  const blockages: FleetBlockage[] = [];

  const { rows } = await adapter.query<{
    active_clarification_json: string | null;
    updated_at: string | null;
  }>(
    `SELECT active_clarification_json, updated_at
       FROM dispatch_scheduler_queue
       WHERE team_id = ?
         AND status = 'needs_clarification'
         AND COALESCE(recovery_status, 'none') NOT IN ('moot', 'landed_reconciled', 'verified_done', 'retry_done')`,
    [teamId],
  );

  let oldestAt: string | null = null;
  let staleCount = 0;
  for (const row of rows) {
    const active = parseActiveClarification(row.active_clarification_json);
    const createdAt = active?.created_at ?? row.updated_at ?? null;
    if (createdAt && (!oldestAt || createdAt < oldestAt)) oldestAt = createdAt;
    const staleAt = active?.stale_at ?? null;
    if (staleAt && Date.parse(staleAt) <= nowMs) staleCount += 1;
    else if (clarificationAgeIsStale(createdAt, nowMs)) staleCount += 1;
  }
  const clarificationCount = rows.length;

  if (clarificationCount > 0) {
    blockages.push({
      kind: "needs_clarification",
      severity: clarificationCount >= 5 || staleCount > 0 ? "critical" : "warn",
      message: `${clarificationCount} dispatch(es) waiting on operator clarification`,
      count: clarificationCount,
      oldest_at: oldestAt,
      action: "/ops/dispatches?status=active",
    });
  }
  if (staleCount > 0) {
    blockages.push({
      kind: "stale_clarification",
      severity: "critical",
      message: `${staleCount} clarification(s) past stale threshold`,
      count: staleCount,
      oldest_at: oldestAt,
      action: "/ops/dispatches?status=active",
    });
  }

  const { rows: orchRows } = await adapter.query<{
    mode: string;
    consecutive_zero_ticks: number;
  }>(
    `SELECT mode, consecutive_zero_ticks
       FROM orchestration_state
       WHERE team_id = ?
       LIMIT 1`,
    [teamId],
  );
  const orch = orchRows[0];
  if (orch?.mode === "paused") {
    blockages.push({
      kind: "orchestration_paused",
      severity: "critical",
      message: "Continuous orchestration is paused",
      count: 1,
      oldest_at: null,
      action: "/ops",
    });
  } else if (Number(orch?.consecutive_zero_ticks ?? 0) >= CO_STALL_TICK_THRESHOLD) {
    blockages.push({
      kind: "co_stall",
      severity: "critical",
      message: `CO stall: ${orch?.consecutive_zero_ticks} ticks admitted nothing`,
      count: Number(orch?.consecutive_zero_ticks ?? 0),
      oldest_at: null,
      action: "/ops",
    });
  }

  const drifted = driftSummary?.drifted_agents ?? [];
  if (drifted.length > 0) {
    const oldestDrifted = drifted.reduce<string | null>((oldest, a) => {
      if (!a.since) return oldest;
      return !oldest || a.since < oldest ? a.since : oldest;
    }, null);
    blockages.push({
      kind: "stall_class_pending_agent",
      severity: "critical",
      message: `${drifted.length} agent(s) drifted off healthy: ${drifted
        .map((a) => `${a.agent_name} (${a.state})`)
        .join(", ")}`,
      count: drifted.length,
      oldest_at: oldestDrifted,
      action: "/ops/agents",
    });
  }

  const blocked = blockages.some((b) => b.severity === "critical") || blockages.length > 0;
  return {
    blocked,
    blockages,
    generated_at: new Date(nowMs).toISOString(),
  };
}

function parseActiveClarification(
  raw: string | null,
): { created_at?: string; stale_at?: string | null } | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { created_at?: string; stale_at?: string | null };
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

/** True when a clarification row is older than the stale threshold. */
export function clarificationAgeIsStale(createdAtIso: string | null, nowMs = Date.now()): boolean {
  if (!createdAtIso) return false;
  const createdMs = Date.parse(createdAtIso);
  if (!Number.isFinite(createdMs)) return false;
  return nowMs - createdMs >= STALE_CLARIFICATION_MS;
}
