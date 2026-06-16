// Monitor — read-only fleet health and completions routes.
// Mount via mountMonitorRoutes(app, adapter) from the manager startup.

import type { Application, Request, Response } from 'express';
import type { DbAdapter } from '../db/db-adapter.js';
import type {
  MonitorFleetResponse,
  FleetAgentRow,
  MonitorCompletionsResponse,
} from './types.js';
import {
  projectCompletions,
  projectPromotionOutcomes,
  buildSourceCoverage,
  type NewsEvent,
} from './completions-projection.js';

const DEFAULT_RECENT_LIMIT = 50;
const DEFAULT_LOOKBACK_MS = 4 * 60 * 60 * 1000; // 4 hours
const FRESHNESS_THRESHOLD_MS = 90_000; // 90 seconds

export interface MonitorRouteDeps {
  /** T1.11: dispatch-recovery boot-backfill metrics getter for /monitor/fleet. */
  recoveryBackfillMetrics?: () => MonitorFleetResponse['recovery_backfill'] | null;
  /** T11.1: running build identity getter for /monitor/fleet. */
  buildStatus?: () => MonitorFleetResponse['build'] | null;
}

export function mountMonitorRoutes(
  app: Application,
  adapter: DbAdapter,
  deps: MonitorRouteDeps = {},
): void {

  // GET /monitor/fleet — per-agent up/down, port, pid, last-seen.
  app.get('/monitor/fleet', async (_req: Request, res: Response) => {
    try {
      const now = Date.now();
      const teamId = await getDefaultTeamId(adapter);
      const agents = await queryFleetAgents(adapter, teamId, now);
      const managerRow = buildManagerRow(now);

      const response: MonitorFleetResponse = {
        generated_at: now,
        agents: [managerRow, ...agents],
        recovery_backfill: deps.recoveryBackfillMetrics?.() ?? {
          recovery_backfill_runs_total: 0,
          recovery_backfill_rows_reclassified_total: 0,
        },
        build: deps.buildStatus?.() ?? null,
      };
      res.json(response);
    } catch (err) {
      res.status(500).json({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  // GET /monitor/completions?recent_limit=50 — in-flight + recent completions.
  app.get('/monitor/completions', async (req: Request, res: Response) => {
    try {
      const now = Date.now();
      const teamId = await getDefaultTeamId(adapter);
      const limit = parsePositiveInt(req.query.recent_limit, DEFAULT_RECENT_LIMIT);
      const lookbackMs = parsePositiveInt(req.query.lookback_ms, DEFAULT_LOOKBACK_MS);
      const since = now - lookbackMs;

      // Fetch news events for completions projection.
      const events = await queryRecentNews(adapter, teamId, since, limit * 10);

      // Also fetch promotion outcomes from dispatch queue.
      const promotionOutcomes = await queryPromotionOutcomes(adapter, teamId, since);

      const { in_flight, recent_completions, source_coverage } =
        projectCompletions(events, now);

      // News-based promotion outcomes (supplemental).
      const newsPromotions = projectPromotionOutcomes(events);

      const response: MonitorCompletionsResponse = {
        generated_at: now,
        in_flight,
        recent_completions: recent_completions.slice(0, limit),
        promotion_outcomes: [...promotionOutcomes, ...newsPromotions],
        source_coverage: buildSourceCoverage(source_coverage),
      };
      res.json(response);
    } catch (err) {
      res.status(500).json({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });
}

async function getDefaultTeamId(adapter: DbAdapter): Promise<string> {
  const { rows } = await adapter.query<{ id: string }>(
    `SELECT id FROM teams WHERE name = $1 LIMIT 1`,
    ['default'],
  );
  if (rows.length === 0) throw new Error('default team not found');
  return rows[0].id;
}

async function queryFleetAgents(
  adapter: DbAdapter,
  teamId: string,
  now: number,
): Promise<FleetAgentRow[]> {
  const { rows } = await adapter.query<{
    id: string;
    name: string;
    port: number;
    endpoint: string | null;
    status: string;
    metadata: string | null;
    last_seen: number | null;
    last_probed_at: number | null;
  }>(
    `SELECT id, name, port, endpoint, status, metadata, last_seen, last_probed_at
     FROM agents
     WHERE team_id = $1 AND deleted_at IS NULL
     ORDER BY port ASC`,
    [teamId],
  );

  return rows.map(a => {
    const meta = parseJsonSafe(a.metadata);
    const pid = typeof meta?.pid === 'number' ? meta.pid : null;

    // Determine freshness from last_probed_at or last_seen.
    const lastSeen = a.last_probed_at ?? a.last_seen ?? null;
    let agentStatus: 'up' | 'down' | 'unknown';
    if (lastSeen === null) {
      agentStatus = 'unknown';
    } else if (now - lastSeen < FRESHNESS_THRESHOLD_MS) {
      agentStatus = 'up';
    } else {
      agentStatus = 'down';
    }

    return {
      agent: a.name || a.id,
      port: a.port,
      pid,
      status: agentStatus,
      health: a.status,
      last_seen_ts: lastSeen,
      url: a.endpoint,
      source: 'manager-agents' as const,
    };
  });
}

function buildManagerRow(now: number): FleetAgentRow {
  return {
    agent: 'manager',
    port: parseInt(process.env.AGENT_MANAGER_PORT || '4100', 10),
    pid: process.pid,
    status: 'up',
    health: 'ok',
    last_seen_ts: now,
    url: null,
    source: 'manager-health',
  };
}

async function queryRecentNews(
  adapter: DbAdapter,
  teamId: string,
  since: number,
  limit: number,
): Promise<NewsEvent[]> {
  const { rows } = await adapter.query<{
    id: number;
    agent_id: string | null;
    timestamp: number;
    type: string;
    message: string | null;
    data: string | null;
    query_id: string | null;
    owner_id: string;
  }>(
    `SELECT id, agent_id, timestamp, type, message, data, query_id, owner_id
     FROM news_items
     WHERE team_id = $1
       AND timestamp >= $2
       AND type IN ('query.received', 'schedule.received', 'query.completed', 'reply')
     ORDER BY timestamp DESC
     LIMIT $3`,
    [teamId, since, limit],
  );

  return rows.map(r => ({
    id: r.id,
    agent_id: r.agent_id,
    timestamp: Number(r.timestamp),
    type: r.type,
    message: r.message,
    data: parseJsonSafe(r.data),
    query_id: r.query_id,
    owner_id: r.owner_id,
  }));
}

async function queryPromotionOutcomes(
  adapter: DbAdapter,
  teamId: string,
  since: number,
): Promise<import('./types.js').PromotionOutcomeRow[]> {
  // Read promotion results directly from dispatch_scheduler_queue.
  const sinceIso = new Date(since).toISOString();
  const { rows } = await adapter.query<{
    dispatch_phid: string;
    query_id: string;
    to_agent: string;
    promotion_result_json: string | null;
  }>(
    `SELECT dispatch_phid, query_id, to_agent, promotion_result_json
     FROM dispatch_scheduler_queue
     WHERE team_id = $1
       AND status = 'done'
       AND promote = 1
       AND promotion_result_json IS NOT NULL
       AND completed_at >= $2
     ORDER BY completed_at DESC
     LIMIT 20`,
    [teamId, sinceIso],
  );

  const outcomes: import('./types.js').PromotionOutcomeRow[] = [];
  for (const r of rows) {
    const promo = parseJsonSafe(r.promotion_result_json) as {
      required?: boolean;
      completed?: boolean;
      repos?: Array<{
        source_branch?: string;
        promoted_sha?: string;
        pushed?: boolean;
        verified?: boolean;
        base?: string;
        remote_main_sha?: string;
      }>;
    } | null;
    if (!promo || !Array.isArray(promo.repos)) continue;

    for (const repo of promo.repos) {
      outcomes.push({
        query_id: r.query_id,
        agent: r.to_agent,
        branch: repo.source_branch ?? null,
        commit: repo.promoted_sha ?? null,
        promoted_to_main: promo.completed ?? null,
        pushed: repo.pushed ?? null,
        verified: repo.verified != null
          ? (repo.verified === true && repo.remote_main_sha === repo.promoted_sha)
          : null,
        base: repo.base ?? null,
        remote_main_sha: repo.remote_main_sha ?? null,
        source: 'agent-done-promotion',
      });
    }
  }
  return outcomes;
}

function parseJsonSafe(raw: string | null | undefined): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function parsePositiveInt(raw: unknown, defaultVal: number): number {
  if (typeof raw === 'string') {
    const v = parseInt(raw, 10);
    if (!isNaN(v) && v > 0) return v;
  }
  return defaultVal;
}
