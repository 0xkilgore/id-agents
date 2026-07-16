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
  needs_clarification: {
    count: number;
    needs_chris_count: number;
    non_chris_count: number;
    stale_non_chris_count: number;
  };
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
  teamName?: string | null,
): Promise<FleetBlockagesReport> {
  const nowMs = Date.now();
  const blockages: FleetBlockage[] = [];

  const { rows: activeStatsRows } = await adapter.query<{
    count: number | string;
    oldest_at: string | null;
  }>(
    `SELECT COUNT(*) as count,
            MIN(COALESCE(started_at, not_before_at, updated_at)) as oldest_at
       FROM dispatch_scheduler_queue
       WHERE team_id = ?
         AND status = 'needs_clarification'
         AND COALESCE(recovery_status, 'none') NOT IN ('moot', 'landed_reconciled', 'verified_done', 'retry_done')`,
    [teamId],
  );

  const { staleParams, staleWhereSql } = staleClarificationSql(adapter, teamId, new Date(nowMs).toISOString());
  const { rows: staleStatsRows } = await adapter.query<{
    stale_count: number | string;
    needs_chris_count: number | string;
    non_chris_count: number | string;
  }>(staleWhereSql, staleParams);

  const clarificationCount = Number(activeStatsRows[0]?.count ?? 0);
  const oldestAt = activeStatsRows[0]?.oldest_at ?? null;
  const staleCount = Number(staleStatsRows[0]?.stale_count ?? 0);
  const needsChrisCount = Number(staleStatsRows[0]?.needs_chris_count ?? 0);
  const nonChrisCount = Number(staleStatsRows[0]?.non_chris_count ?? 0);
  const staleNonChrisCount = nonChrisCount;

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
      message: `${staleCount} clarification(s) past stale threshold; non-Chris=${staleNonChrisCount}, Chris-needed=${needsChrisCount}`,
      count: staleCount,
      oldest_at: oldestAt,
      action: "/ops/dispatches?status=active",
    });
  }

  const orchestrationTeamKeys = [...new Set([teamId, teamName].filter((v): v is string => !!v))];
  const { rows: orchRows } = await adapter.query<{
    mode: string;
    consecutive_zero_ticks: number;
  }>(
    `SELECT mode, consecutive_zero_ticks
       FROM orchestration_state
       WHERE team_id IN (${orchestrationTeamKeys.map(() => "?").join(", ")})
       LIMIT 1`,
    orchestrationTeamKeys,
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
    needs_clarification: {
      count: clarificationCount,
      needs_chris_count: needsChrisCount,
      non_chris_count: nonChrisCount,
      stale_non_chris_count: staleNonChrisCount,
    },
    blockages,
    generated_at: new Date(nowMs).toISOString(),
  };
}

function staleClarificationSql(
  adapter: DbAdapterLike,
  teamId: string,
  nowIso: string,
): { staleParams: unknown[]; staleWhereSql: string } {
  const dialect = (adapter as { dialect?: string }).dialect;
  const staleAtExpr = dialect === "postgres"
    ? "(active_clarification_json::jsonb ->> 'stale_at')"
    : "json_extract(active_clarification_json, '$.stale_at')";
  const needsYouExpr = dialect === "postgres"
    ? "(active_clarification_json::jsonb ->> 'needs_you')"
    : "json_extract(active_clarification_json, '$.needs_you')";
  const requiresChrisExpr = dialect === "postgres"
    ? "(active_clarification_json::jsonb ->> 'requires_chris')"
    : "json_extract(active_clarification_json, '$.requires_chris')";
  const needsChrisExpr = dialect === "postgres"
    ? "(active_clarification_json::jsonb ->> 'needs_chris')"
    : "json_extract(active_clarification_json, '$.needs_chris')";
  const nonChrisPredicate = dialect === "postgres"
    ? `(${needsYouExpr} = 'false' OR ${requiresChrisExpr} = 'false' OR ${needsChrisExpr} = 'false')`
    : `(${needsYouExpr} = 0 OR ${requiresChrisExpr} = 0 OR ${needsChrisExpr} = 0)`;
  const where = `FROM dispatch_scheduler_queue
       WHERE team_id = ?
         AND status = 'needs_clarification'
         AND COALESCE(recovery_status, 'none') NOT IN ('moot', 'landed_reconciled', 'verified_done', 'retry_done')
         AND active_clarification_json IS NOT NULL
         AND ${staleAtExpr} IS NOT NULL
         AND ${staleAtExpr} <= ?`;
  return {
    staleWhereSql: `SELECT COUNT(*) as stale_count,
          SUM(CASE WHEN ${nonChrisPredicate} THEN 0 ELSE 1 END) as needs_chris_count,
          SUM(CASE WHEN ${nonChrisPredicate} THEN 1 ELSE 0 END) as non_chris_count
       ${where}`,
    staleParams: [teamId, nowIso],
  };
}

/** True when a clarification row is older than the stale threshold. */
export function clarificationAgeIsStale(createdAtIso: string | null, nowMs = Date.now()): boolean {
  if (!createdAtIso) return false;
  const createdMs = Date.parse(createdAtIso);
  if (!Number.isFinite(createdMs)) return false;
  return nowMs - createdMs >= STALE_CLARIFICATION_MS;
}
