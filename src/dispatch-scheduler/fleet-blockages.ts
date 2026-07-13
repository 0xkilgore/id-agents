import type { DbAdapterLike } from "../supervisor/manager-source-reader.js";
import type { FleetRuntimeDriftSummary } from "./runtime-drift.js";
import { loadContinuousOrchestrationConfig } from "../continuous-orchestration/config.js";
import { readOrchestrationLoopHealthProjection } from "../continuous-orchestration/health-projection.js";

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
const STALE_AGENT_WORK_MS = 30 * 60 * 1000;

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

  const orchestrationTeamKeys = [...new Set([teamId, teamName].filter((v): v is string => !!v))];
  const loopHealth = await readFirstOrchestrationLoopHealth(adapter, orchestrationTeamKeys);
  if (loopHealth?.state === "paused") {
    blockages.push({
      kind: "orchestration_paused",
      severity: "critical",
      message: "Continuous orchestration is paused",
      count: 1,
      oldest_at: null,
      action: "/ops",
    });
  } else if (loopHealth?.state === "stalled_ready_not_launching") {
    const reasons = Object.entries(loopHealth.last_admission_block_reasons ?? {})
      .filter(([, count]) => Number(count) > 0)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([code, count]) => `${code}=${count}`)
      .join(", ");
    blockages.push({
      kind: "co_stall",
      severity: "critical",
      message: reasons
        ? `CO stall: ${loopHealth.consecutive_zero_ticks} ticks admitted nothing; blockers: ${reasons}`
        : `CO stall: ${loopHealth.consecutive_zero_ticks} ticks admitted nothing without structured explanation`,
      count: loopHealth.consecutive_zero_ticks,
      oldest_at: null,
      action: "/ops",
    });
  }

  const drifted = await driftedAgentsWithStaleOrFailedWork(
    adapter,
    teamId,
    driftSummary?.drifted_agents ?? [],
    nowMs,
  );
  if (drifted.length > 0) {
    const oldestDrifted = drifted.reduce<string | null>((oldest, a) => {
      const since = a.oldest_work_at ?? a.since;
      if (!since) return oldest;
      return !oldest || since < oldest ? since : oldest;
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

async function driftedAgentsWithStaleOrFailedWork(
  adapter: DbAdapterLike,
  teamId: string,
  driftedAgents: NonNullable<FleetRuntimeDriftSummary["drifted_agents"]>,
  nowMs: number,
): Promise<Array<FleetRuntimeDriftSummary["drifted_agents"][number] & { stale_or_failed_work_count: number; oldest_work_at: string | null }>> {
  const staleCutoff = new Date(nowMs - STALE_AGENT_WORK_MS).toISOString();
  const rows = await Promise.all(
    driftedAgents.map(async (agent) => {
      if ((agent.lifecycle ?? "always_on") === "optional") return null;
      if (agent.health_probe === "ok") return null;
      const { rows: workRows } = await adapter.query<{ count: number; oldest_work_at: string | null }>(
        `SELECT COUNT(*) AS count,
                MIN(COALESCE(started_at, updated_at)) AS oldest_work_at
           FROM dispatch_scheduler_queue
          WHERE team_id = ?
            AND to_agent = ?
            AND COALESCE(recovery_status, 'none') NOT IN ('moot', 'landed_reconciled', 'verified_done', 'retry_done')
            AND (
              status = 'failed'
              OR (
                status IN ('in_flight', 'bounced', 'resume_delivery_failed')
                AND COALESCE(started_at, updated_at) <= ?
              )
            )`,
        [teamId, agent.agent_name, staleCutoff],
      );
      const count = Number(workRows[0]?.count ?? 0);
      if (count <= 0) return null;
      return {
        ...agent,
        stale_or_failed_work_count: count,
        oldest_work_at: workRows[0]?.oldest_work_at ?? null,
      };
    }),
  );
  return rows.filter((row): row is NonNullable<(typeof rows)[number]> => row !== null);
}

async function readFirstOrchestrationLoopHealth(
  adapter: DbAdapterLike,
  teamKeys: string[],
): Promise<Awaited<ReturnType<typeof readOrchestrationLoopHealthProjection>> | null> {
  const config = loadContinuousOrchestrationConfig();
  for (const teamKey of teamKeys) {
    const { rows } = await adapter.query<{ team_id: string }>(
      `SELECT team_id
         FROM orchestration_state
        WHERE team_id = ?
        LIMIT 1`,
      [teamKey],
    );
    if (rows.length > 0) {
      return readOrchestrationLoopHealthProjection(adapter as Parameters<typeof readOrchestrationLoopHealthProjection>[0], teamKey, {
        stallThresholdTicks: config.stall_threshold_ticks,
      });
    }
  }
  return null;
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
