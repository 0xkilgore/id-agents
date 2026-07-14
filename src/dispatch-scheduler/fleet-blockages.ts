import type { DbAdapterLike } from "../supervisor/manager-source-reader.js";
import type { FleetRuntimeDriftSummary } from "./runtime-drift.js";
import { loadContinuousOrchestrationConfig } from "../continuous-orchestration/config.js";
import { readOrchestrationLoopHealthProjection } from "../continuous-orchestration/health-projection.js";
import { classifyPromotionHygieneFailure } from "../loops/worktree-hygiene.js";

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
    dispatch_phid: string;
    query_id: string | null;
    to_agent: string | null;
    active_clarification_json: string | null;
    updated_at: string | null;
  }>(
    `SELECT dispatch_phid, query_id, to_agent, active_clarification_json, updated_at
       FROM dispatch_scheduler_queue
       WHERE team_id = ?
         AND status = 'needs_clarification'
         AND COALESCE(recovery_status, 'none') NOT IN ('moot', 'landed_reconciled', 'verified_done', 'retry_done')`,
    [teamId],
  );

  let oldestAt: string | null = null;
  let staleCount = 0;
  let needsChrisCount = 0;
  let nonChrisCount = 0;
  let staleNonChrisCount = 0;
  for (const row of rows) {
    const active = parseActiveClarification(row.active_clarification_json);
    const createdAt = active?.created_at ?? row.updated_at ?? null;
    if (createdAt && (!oldestAt || createdAt < oldestAt)) oldestAt = createdAt;
    const staleAt = active?.stale_at ?? null;
    const stale = (staleAt && Date.parse(staleAt) <= nowMs) || clarificationAgeIsStale(createdAt, nowMs);
    if (stale) staleCount += 1;
    if (clarificationNeedsChris(row)) {
      needsChrisCount += 1;
    } else {
      nonChrisCount += 1;
      if (stale) staleNonChrisCount += 1;
    }
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
): { created_at?: string; stale_at?: string | null; question?: string | null } | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { created_at?: string; stale_at?: string | null; question?: string | null };
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function clarificationNeedsChris(row: {
  dispatch_phid: string;
  query_id: string | null;
  to_agent: string | null;
  active_clarification_json: string | null;
}): boolean {
  const payload = parseJson(row.active_clarification_json);
  const active = payload && typeof payload === "object" ? payload as Record<string, unknown> : null;
  const text = [
    row.dispatch_phid,
    row.query_id,
    row.to_agent,
    typeof active?.question === "string" ? active.question : null,
    row.active_clarification_json,
  ]
    .filter((x): x is string => typeof x === "string" && x.length > 0)
    .join(" ");

  const hygieneIncident = classifyPromotionHygieneFailure({
    dispatch_id: row.dispatch_phid,
    text,
    payload,
  });
  if (hygieneIncident) return false;

  if (active?.needs_you === false || active?.requires_chris === false || active?.needs_chris === false) {
    return false;
  }
  return true;
}

function parseJson(raw: string | null): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
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
