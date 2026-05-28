// SPDX-License-Identifier: MIT
// P6 Agent Performance Telemetry — Express routes for /metrics/*.
// Mount via `mountMetricsRoutes(app, adapter)` from the manager startup.

import type { Application, Request, Response } from 'express';
import type { DbAdapter } from '../db/db-adapter.js';
import { getSnapshots, querySignals } from './storage.js';
import { windowBoundary, computeSourceCoverage } from './rollup.js';
import type { WindowKind, MetricsSummaryResponse, AgentMetricsRow, SourceName, Confidence, SignalKind, SignalSeverity } from './types.js';

const VALID_WINDOWS: WindowKind[] = ['hour', 'day', 'week'];
const DEFAULT_TZ = 'America/Chicago';

function parseWindow(raw: unknown): WindowKind {
  if (typeof raw === 'string' && VALID_WINDOWS.includes(raw as WindowKind)) return raw as WindowKind;
  return 'day';
}

function parseBool(raw: unknown, def = true): boolean {
  if (raw === 'false' || raw === '0') return false;
  if (raw === 'true' || raw === '1') return true;
  return def;
}

export function mountMetricsRoutes(app: Application, adapter: DbAdapter): void {
  // -------------------------------------------------------------------------
  // GET /metrics/summary
  // -------------------------------------------------------------------------
  app.get('/metrics/summary', async (req: Request, res: Response) => {
    try {
      const windowKind = parseWindow(req.query.window);
      const includeSignals = parseBool(req.query.include_signals);
      const now = new Date();
      const { start, end } = windowBoundary(windowKind, now, DEFAULT_TZ);
      const windowStart = start.toISOString();

      const snapshots = await getSnapshots(adapter, { windowKind, windowStart });

      // Aggregate totals from snapshots
      const totals = {
        agents_seen: snapshots.length,
        dispatches_started: 0,
        dispatches_completed: 0,
        dispatches_failed: 0,
        dispatches_stuck: 0,
        needs_clarification: 0,
        resume_delivery_failed: 0,
        artifacts_created: 0,
        weighted_tokens: 0,
        high_burn_no_output_agents: 0,
      };

      const coverageEvents: Array<{ source: string; confidence: string }> = [];

      for (const snap of snapshots) {
        totals.dispatches_started += snap.dispatches_started;
        totals.dispatches_completed += snap.dispatches_completed;
        totals.dispatches_failed += snap.dispatches_failed;
        totals.dispatches_stuck += snap.dispatches_stuck;
        totals.needs_clarification += snap.needs_clarification_count;
        totals.artifacts_created += snap.artifacts_created;
        totals.weighted_tokens += snap.weighted_tokens;
        if (snap.high_burn_no_output_events > 0) totals.high_burn_no_output_agents++;

        // Collect coverage from snapshots
        try {
          const cov = JSON.parse(snap.source_coverage_json);
          for (const [src, conf] of Object.entries(cov)) {
            coverageEvents.push({ source: src, confidence: conf as string });
          }
        } catch {}
      }

      // Fetch signals
      let signalsArr: MetricsSummaryResponse['signals'] = [];
      if (includeSignals) {
        const raw = await querySignals(adapter, { unresolvedOnly: true, limit: 50 });
        signalsArr = raw.map(s => ({
          id: s.id,
          severity: s.severity as SignalSeverity,
          kind: s.kind as SignalKind,
          agent_id: s.agent_id,
          title: s.title,
          source_refs: (() => { try { return JSON.parse(s.source_refs_json); } catch { return []; } })(),
        }));
      }

      const response: MetricsSummaryResponse = {
        schema_version: 'agent_metrics.summary.v1',
        generated_at: now.toISOString(),
        window: {
          kind: windowKind,
          start: start.toISOString(),
          end: end.toISOString(),
          timezone: DEFAULT_TZ,
        },
        totals,
        signals: signalsArr,
        source_coverage: computeSourceCoverage(coverageEvents),
      };

      res.json(response);
    } catch (err) {
      console.error('/metrics/summary error:', err);
      res.status(500).json({ error: 'internal', detail: String(err) });
    }
  });

  // -------------------------------------------------------------------------
  // GET /metrics/agents
  // -------------------------------------------------------------------------
  app.get('/metrics/agents', async (req: Request, res: Response) => {
    try {
      const windowKind = parseWindow(req.query.window);
      const includeSignals = parseBool(req.query.include_signals);
      const statusFilter = (req.query.status as string) || 'all';
      const now = new Date();
      const { start, end } = windowBoundary(windowKind, now, DEFAULT_TZ);
      const windowStart = start.toISOString();

      // Get all roster agents
      const { rows: agentRows } = await adapter.query<{
        name: string; status: string; last_seen: number | null; runtime: string | null; type: string;
      }>(
        `SELECT name, status, last_seen, runtime, type FROM agents WHERE deleted_at IS NULL`,
      );

      const snapshots = await getSnapshots(adapter, { windowKind, windowStart });
      const snapMap = new Map(snapshots.map(s => [s.agent_id, s]));

      // Get active dispatch counts
      const { rows: activeDispatches } = await adapter.query<{ to_agent: string; cnt: number; status: string }>(
        `SELECT to_agent, COUNT(*) as cnt, status FROM dispatch_scheduler_queue
         WHERE status NOT IN ('completed', 'failed', 'cancelled', 'expired')
         GROUP BY to_agent, status`,
      );
      const activeMap = new Map<string, { active: number; blocked: number; stuck: number }>();
      for (const row of activeDispatches) {
        if (!activeMap.has(row.to_agent)) activeMap.set(row.to_agent, { active: 0, blocked: 0, stuck: 0 });
        const entry = activeMap.get(row.to_agent)!;
        if (row.status === 'needs_clarification') entry.blocked += row.cnt;
        else if (row.status === 'wedged' || row.status === 'stuck') entry.stuck += row.cnt;
        else entry.active += row.cnt;
      }

      const allSignals = includeSignals
        ? await querySignals(adapter, { unresolvedOnly: true, limit: 200 })
        : [];

      const agents: AgentMetricsRow[] = [];

      for (const agent of agentRows) {
        if (agent.type === 'interactive' && agent.name.startsWith('manager')) continue;

        const snap = snapMap.get(agent.name);
        const dispatches = activeMap.get(agent.name) || { active: 0, blocked: 0, stuck: 0 };
        const agentSignals = allSignals.filter(s => s.agent_id === agent.name);

        // Determine state
        let state = 'offline';
        const staleMs = 5 * 60 * 1000;
        if (agent.last_seen && (Date.now() - agent.last_seen) < staleMs) {
          state = dispatches.active > 0 ? 'working' : 'idle';
        } else if (agent.last_seen) {
          state = 'stale';
        }
        if (dispatches.blocked > 0) state = 'blocked';
        if (dispatches.stuck > 0) state = 'stuck';

        // Filter by status
        if (statusFilter !== 'all') {
          if (statusFilter === 'active' && state !== 'working' && state !== 'idle') continue;
          if (statusFilter === 'blocked' && state !== 'blocked') continue;
          if (statusFilter === 'stale' && state !== 'stale') continue;
          if (statusFilter === 'offline' && state !== 'offline') continue;
        }

        const completed = snap?.dispatches_completed ?? 0;
        const started = snap?.dispatches_started ?? 0;
        const wt = snap?.weighted_tokens ?? 0;

        const row: AgentMetricsRow = {
          agent_id: agent.name,
          display_name: agent.name,
          role: agent.type === 'interactive' ? 'agent' : 'builder',
          runtime: agent.runtime || 'claude-code-cli',
          status: {
            state,
            last_seen_at: agent.last_seen ? new Date(agent.last_seen).toISOString() : null,
            active_dispatches: dispatches.active,
            blocked_dispatches: dispatches.blocked,
            stuck_dispatches: dispatches.stuck,
          },
          window: {
            kind: windowKind,
            dispatches_started: started,
            dispatches_completed: completed,
            dispatch_success_rate: started > 0 ? completed / started : 0,
            artifacts_created: snap?.artifacts_created ?? 0,
            needs_clarification_count: snap?.needs_clarification_count ?? 0,
            failed_dispatches: snap?.dispatches_failed ?? 0,
            weighted_tokens: wt,
            tokens_per_completed_dispatch: completed > 0 ? Math.round(wt / completed) : 0,
            high_burn_no_output_events: snap?.high_burn_no_output_events ?? 0,
            stuck_loop_signals: agentSignals.filter(s => s.kind === 'dispatch_stuck').length,
            cto_corrections_count: snap?.cto_corrections_count ?? 0,
            operator_revision_requests: snap?.operator_revision_requests ?? 0,
          },
          top_signals: agentSignals.slice(0, 5).map(s => ({
            id: s.id,
            kind: s.kind,
            severity: s.severity,
            title: s.title,
          })),
          source_coverage: buildCoverageMap(snap?.source_coverage_json),
        };

        agents.push(row);
      }

      // Sort: critical/warning signals first, then blocked/stuck, then active, then token burn
      agents.sort((a, b) => {
        const aPriority = statePriority(a.status.state, a.top_signals.length);
        const bPriority = statePriority(b.status.state, b.top_signals.length);
        if (aPriority !== bPriority) return aPriority - bPriority;
        return b.window.weighted_tokens - a.window.weighted_tokens;
      });

      res.json({
        schema_version: 'agent_metrics.agent_list.v1',
        generated_at: now.toISOString(),
        stale_after_ms: 300000,
        agents,
      });
    } catch (err) {
      console.error('/metrics/agents error:', err);
      res.status(500).json({ error: 'internal', detail: String(err) });
    }
  });

  // -------------------------------------------------------------------------
  // GET /metrics/agents/:agent_id
  // -------------------------------------------------------------------------
  app.get('/metrics/agents/:agent_id', async (req: Request<{ agent_id: string }>, res: Response) => {
    try {
      const agentId = req.params.agent_id;
      const now = new Date();

      // Get snapshots for all three windows
      const windows: Record<WindowKind, any> = { hour: null, day: null, week: null };
      for (const wk of VALID_WINDOWS) {
        const { start } = windowBoundary(wk, now, DEFAULT_TZ);
        const snaps = await getSnapshots(adapter, { agentId, windowKind: wk, windowStart: start.toISOString() });
        windows[wk] = snaps[0] || null;
      }

      // Recent dispatches
      const { rows: recentDispatches } = await adapter.query<{
        dispatch_phid: string; query_id: string; status: string; started_at: string | null; completed_at: string | null;
      }>(
        `SELECT dispatch_phid, query_id, status, started_at, completed_at
         FROM dispatch_scheduler_queue
         WHERE to_agent = $1
         ORDER BY updated_at DESC LIMIT 20`,
        [agentId],
      );

      // Agent signals
      const signals = await querySignals(adapter, { agentId, limit: 50 });

      // Recent events for this agent
      const { rows: recentEvents } = await adapter.query<any>(
        `SELECT event_id, kind, ts, source, confidence, payload_json
         FROM agent_telemetry_event
         WHERE agent_id = $1
         ORDER BY ts DESC LIMIT 50`,
        [agentId],
      );

      res.json({
        schema_version: 'agent_metrics.agent_detail.v1',
        generated_at: now.toISOString(),
        agent_id: agentId,
        windows,
        recent_dispatches: recentDispatches,
        recent_artifacts: recentEvents.filter((e: any) => e.kind === 'artifact.created'),
        clarification_history: recentEvents.filter((e: any) =>
          e.kind === 'dispatch.state_changed' && JSON.parse(e.payload_json || '{}').to_state === 'needs_clarification'),
        stuck_detector_findings: recentEvents.filter((e: any) => e.kind === 'dispatch.stuck_detected'),
        signals,
        source_events: recentEvents,
      });
    } catch (err) {
      console.error('/metrics/agents/:agent_id error:', err);
      res.status(500).json({ error: 'internal', detail: String(err) });
    }
  });

  // -------------------------------------------------------------------------
  // GET /metrics/signals
  // -------------------------------------------------------------------------
  app.get('/metrics/signals', async (req: Request, res: Response) => {
    try {
      const signals = await querySignals(adapter, {
        kind: req.query.kind as SignalKind | undefined,
        severity: req.query.severity as SignalSeverity | undefined,
        agentId: req.query.agent_id as string | undefined,
        since: req.query.since as string | undefined,
        unresolvedOnly: !req.query.include_resolved,
        limit: 200,
      });

      res.json({
        schema_version: 'agent_metrics.signals.v1',
        generated_at: new Date().toISOString(),
        signals: signals.map(s => ({
          ...s,
          source_refs: (() => { try { return JSON.parse(s.source_refs_json); } catch { return []; } })(),
        })),
      });
    } catch (err) {
      console.error('/metrics/signals error:', err);
      res.status(500).json({ error: 'internal', detail: String(err) });
    }
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function statePriority(state: string, signalCount: number): number {
  if (signalCount > 0) return 0;
  switch (state) {
    case 'stuck': return 1;
    case 'blocked': return 2;
    case 'working': return 3;
    case 'idle': return 4;
    case 'stale': return 5;
    case 'offline': return 6;
    default: return 7;
  }
}

function buildCoverageMap(json?: string): Record<SourceName, Confidence> {
  const defaults: Record<SourceName, Confidence> = {
    dispatch_ops: 'missing',
    usage_meter_v2: 'missing',
    artifact_ops: 'missing',
    stuck_detector: 'missing',
    review_signals: 'missing',
    schedule_ops: 'missing',
  };
  if (!json) return defaults;
  try {
    const parsed = JSON.parse(json);
    return { ...defaults, ...parsed };
  } catch {
    return defaults;
  }
}
