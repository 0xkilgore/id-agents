// SPDX-License-Identifier: MIT
// P6 Agent Performance Telemetry — rollup computation.
// Reads raw telemetry events and writes agent_performance_snapshot + agent_signal rows.

import type { DbAdapter } from '../db/db-adapter.js';
import { queryEvents, upsertSnapshot, upsertSignal, querySignals } from './storage.js';
import type { WindowKind, PerformanceSnapshot, AgentSignal, Confidence, SourceCoverageEntry, SourceName } from './types.js';

// ---------------------------------------------------------------------------
// Window boundaries — America/Chicago by default
// ---------------------------------------------------------------------------

export function dayBoundary(date: Date, tz = 'America/Chicago'): { start: Date; end: Date } {
  // Get the date string in the target timezone
  const dateStr = date.toLocaleDateString('en-CA', { timeZone: tz }); // YYYY-MM-DD
  // Create start/end at midnight in that timezone
  // Use a helper: compute offset manually for reliability
  const startLocal = new Date(`${dateStr}T00:00:00`);
  const endLocal = new Date(`${dateStr}T23:59:59.999`);

  // Convert to UTC by finding the offset
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });

  // Simpler approach: use the date string and compute UTC offset
  const utcDateStr = date.toISOString().slice(0, 10);
  const tzDate = new Date(date.toLocaleString('en-US', { timeZone: tz }));
  const offsetMs = date.getTime() - tzDate.getTime();

  const dayStart = new Date(`${dateStr}T00:00:00.000Z`);
  dayStart.setTime(dayStart.getTime() + offsetMs);

  const dayEnd = new Date(`${dateStr}T23:59:59.999Z`);
  dayEnd.setTime(dayEnd.getTime() + offsetMs);

  return { start: dayStart, end: dayEnd };
}

export function hourBoundary(date: Date): { start: Date; end: Date } {
  const start = new Date(date);
  start.setMinutes(0, 0, 0);
  const end = new Date(start);
  end.setHours(end.getHours() + 1);
  end.setMilliseconds(-1);
  return { start, end };
}

export function windowBoundary(kind: WindowKind, date: Date, tz?: string): { start: Date; end: Date } {
  if (kind === 'hour') return hourBoundary(date);
  if (kind === 'day') return dayBoundary(date, tz);
  // week: 7 days ending at current day boundary
  const day = dayBoundary(date, tz);
  const weekStart = new Date(day.start);
  weekStart.setDate(weekStart.getDate() - 6);
  return { start: weekStart, end: day.end };
}

// ---------------------------------------------------------------------------
// Source coverage computation
// ---------------------------------------------------------------------------

export function computeSourceCoverage(
  events: Array<{ source: string; confidence: string }>,
): SourceCoverageEntry[] {
  const sources: SourceName[] = ['dispatch_ops', 'usage_meter_v2', 'artifact_ops', 'stuck_detector', 'review_signals', 'schedule_ops'];
  const seen = new Map<string, Set<string>>();

  for (const e of events) {
    if (!seen.has(e.source)) seen.set(e.source, new Set());
    seen.get(e.source)!.add(e.confidence);
  }

  return sources.map(source => {
    const confidences = seen.get(source);
    if (!confidences) return { source, state: 'missing' as const, confidence: 'missing' as Confidence };
    if (confidences.has('missing')) return { source, state: 'missing' as const, confidence: 'missing' as Confidence };
    if (confidences.has('canonical')) return { source, state: 'present' as const, confidence: 'canonical' as Confidence };
    if (confidences.has('derived')) return { source, state: 'present' as const, confidence: 'derived' as Confidence };
    return { source, state: 'partial' as const, confidence: 'partial' as Confidence };
  });
}

// ---------------------------------------------------------------------------
// Per-agent rollup from events
// ---------------------------------------------------------------------------

interface AgentRollupInput {
  agentId: string;
  events: Array<{ kind: string; payload_json: string; source: string; confidence: string }>;
}

export function computeAgentSnapshot(
  input: AgentRollupInput,
  windowKind: WindowKind,
  windowStart: string,
): PerformanceSnapshot {
  let dispatches_started = 0;
  let dispatches_completed = 0;
  let dispatches_failed = 0;
  let dispatches_stuck = 0;
  let needs_clarification_count = 0;
  let artifacts_created = 0;
  let weighted_tokens = 0;
  let high_burn_no_output_events = 0;
  let cto_corrections_count = 0;
  let operator_revision_requests = 0;

  const completedDispatchIds = new Set<string>();

  for (const evt of input.events) {
    let payload: any = {};
    try { payload = JSON.parse(evt.payload_json); } catch {}

    switch (evt.kind) {
      case 'dispatch.state_changed': {
        const state = payload.to_state;
        if (state === 'queued' || state === 'scheduled') dispatches_started++;
        else if (state === 'completed' || state === 'done') {
          dispatches_completed++;
          if (payload.dispatch_phid) completedDispatchIds.add(payload.dispatch_phid);
        }
        else if (state === 'failed' || state === 'error') dispatches_failed++;
        else if (state === 'needs_clarification') needs_clarification_count++;
        break;
      }
      case 'dispatch.stuck_detected':
        dispatches_stuck++;
        break;
      case 'artifact.created':
        artifacts_created++;
        break;
      case 'usage.window_observed':
        weighted_tokens += payload.daily_weighted_tokens || 0;
        break;
    }
  }

  // Detect high burn / no output: significant tokens but no completed dispatches or artifacts
  if (weighted_tokens > 200_000 && dispatches_completed === 0 && artifacts_created === 0) {
    high_burn_no_output_events = 1;
  }

  const coverage = computeSourceCoverage(input.events);

  return {
    agent_id: input.agentId,
    window_kind: windowKind,
    window_start: windowStart,
    dispatches_started,
    dispatches_completed,
    dispatches_failed,
    dispatches_stuck,
    needs_clarification_count,
    artifacts_created,
    weighted_tokens,
    high_burn_no_output_events,
    cto_corrections_count,
    operator_revision_requests,
    source_coverage_json: JSON.stringify(Object.fromEntries(coverage.map(c => [c.source, c.confidence]))),
    computed_at: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Signal generation from events
// ---------------------------------------------------------------------------

export function generateSignals(
  agentId: string,
  events: Array<{ kind: string; query_id: string | null; payload_json: string; confidence: string }>,
  now: Date,
): AgentSignal[] {
  const signals: AgentSignal[] = [];
  const nowIso = now.toISOString();

  for (const evt of events) {
    let payload: any = {};
    try { payload = JSON.parse(evt.payload_json); } catch {}

    if (evt.kind === 'dispatch.stuck_detected') {
      const queryId = evt.query_id || 'unknown';
      signals.push({
        id: `signal:dispatch-stuck:${queryId}`,
        kind: 'dispatch_stuck',
        severity: 'warning',
        agent_id: agentId,
        subject: queryId,
        title: `Dispatch stuck — PID state ${payload.pid_state || '?'}, ${payload.news_count ?? '?'} news events`,
        first_seen_at: nowIso,
        last_seen_at: nowIso,
        source_refs_json: JSON.stringify(payload.report_file ? [payload.report_file] : []),
        confidence: evt.confidence as Confidence,
        resolved_at: null,
      });
    }

    if (evt.kind === 'dispatch.state_changed' && payload.to_state === 'needs_clarification') {
      const queryId = evt.query_id || 'unknown';
      signals.push({
        id: `signal:needs-clarification:${queryId}`,
        kind: 'needs_clarification',
        severity: 'info',
        agent_id: agentId,
        subject: queryId,
        title: `Dispatch awaiting clarification`,
        first_seen_at: nowIso,
        last_seen_at: nowIso,
        source_refs_json: '[]',
        confidence: 'canonical',
        resolved_at: null,
      });
    }
  }

  return signals;
}

// ---------------------------------------------------------------------------
// Full rollup job
// ---------------------------------------------------------------------------

export async function computeRollup(
  adapter: DbAdapter,
  windowKind: WindowKind,
  date: Date,
  tz = 'America/Chicago',
): Promise<{ snapshots: number; signals: number }> {
  const { start, end } = windowBoundary(windowKind, date, tz);
  const windowStart = start.toISOString();

  // Get all events in the window
  const events = await queryEvents(adapter, {
    since: start.getTime(),
    until: end.getTime(),
  });

  // Group by agent
  const byAgent = new Map<string, typeof events>();
  for (const evt of events) {
    const aid = evt.agent_id;
    if (!byAgent.has(aid)) byAgent.set(aid, []);
    byAgent.get(aid)!.push(evt);
  }

  // Also include roster agents that may have no events
  const { rows: agentRows } = await adapter.query<{ name: string }>(
    `SELECT DISTINCT name FROM agents WHERE deleted_at IS NULL`,
  );
  for (const row of agentRows) {
    if (!byAgent.has(row.name)) byAgent.set(row.name, []);
  }

  let snapshotCount = 0;
  let signalCount = 0;

  for (const [agentId, agentEvents] of byAgent) {
    if (agentId === '_system' || agentId === '_unknown') continue;

    const snapshot = computeAgentSnapshot(
      { agentId, events: agentEvents },
      windowKind,
      windowStart,
    );
    await upsertSnapshot(adapter, snapshot);
    snapshotCount++;

    const sigs = generateSignals(agentId, agentEvents, date);
    for (const sig of sigs) {
      await upsertSignal(adapter, sig);
      signalCount++;
    }

    // Detect high burn / no output signal
    if (snapshot.high_burn_no_output_events > 0) {
      await upsertSignal(adapter, {
        id: `signal:high-burn-no-output:${agentId}:${windowStart}`,
        kind: 'high_burn_no_output',
        severity: 'warning',
        agent_id: agentId,
        subject: null,
        title: `High token burn (${snapshot.weighted_tokens} wt) with no completed dispatches or artifacts`,
        first_seen_at: date.toISOString(),
        last_seen_at: date.toISOString(),
        source_refs_json: '[]',
        confidence: 'derived',
        resolved_at: null,
      });
      signalCount++;
    }
  }

  return { snapshots: snapshotCount, signals: signalCount };
}
