// SPDX-License-Identifier: MIT
// P6 Agent Performance Telemetry — morning-rundown helper.
// Reads /metrics/summary + /metrics/signals and produces an array of
// one-line strings for digest paths. Does NOT modify any cron pipeline.

import type { DbAdapter } from '../db/db-adapter.js';
import { getSnapshots, querySignals } from './storage.js';
import { windowBoundary } from './rollup.js';
import type { WindowKind } from './types.js';

export interface MorningRundownLine {
  category: string;
  line: string;
}

/**
 * Produce a concise morning rundown from the telemetry store.
 * Callable from any digest path without touching /metrics HTTP endpoints.
 */
export async function summarizeForMorning(
  adapter: DbAdapter,
  opts: { windowKind?: WindowKind; tz?: string; date?: Date } = {},
): Promise<MorningRundownLine[]> {
  const windowKind = opts.windowKind || 'day';
  const date = opts.date || new Date();
  const tz = opts.tz || 'America/Chicago';
  const { start } = windowBoundary(windowKind, date, tz);
  const windowStart = start.toISOString();
  const lines: MorningRundownLine[] = [];

  // 1. Get snapshots
  const snapshots = await getSnapshots(adapter, { windowKind, windowStart });

  // 2. Get unresolved signals
  const signals = await querySignals(adapter, { unresolvedOnly: true, limit: 100 });

  // Stuck dispatches
  const stuckSignals = signals.filter(s => s.kind === 'dispatch_stuck');
  if (stuckSignals.length > 0) {
    lines.push({
      category: 'stuck',
      line: `⚠️ ${stuckSignals.length} stuck dispatch${stuckSignals.length > 1 ? 'es' : ''}: ${stuckSignals.map(s => `${s.agent_id} (${s.subject})`).join(', ')}`,
    });
  }

  // Stale clarifications
  const clarSignals = signals.filter(s => s.kind === 'needs_clarification');
  if (clarSignals.length > 0) {
    lines.push({
      category: 'clarification',
      line: `🔄 ${clarSignals.length} stale clarification${clarSignals.length > 1 ? 's' : ''}: ${clarSignals.map(s => s.agent_id).join(', ')}`,
    });
  }

  // High burn / no output
  const burnSignals = signals.filter(s => s.kind === 'high_burn_no_output');
  if (burnSignals.length > 0) {
    lines.push({
      category: 'high_burn',
      line: `🔥 ${burnSignals.length} high-burn/no-output agent${burnSignals.length > 1 ? 's' : ''}: ${burnSignals.map(s => s.agent_id).join(', ')}`,
    });
  }

  // Missed wakes / stale schedules
  const scheduleSignals = signals.filter(s => s.kind === 'stale_schedule');
  if (scheduleSignals.length > 0) {
    lines.push({
      category: 'schedule',
      line: `📅 ${scheduleSignals.length} missed/stale wake${scheduleSignals.length > 1 ? 's' : ''}`,
    });
  }

  // Top completed work
  const completedAgents = snapshots
    .filter(s => s.dispatches_completed > 0)
    .sort((a, b) => b.dispatches_completed - a.dispatches_completed)
    .slice(0, 5);
  if (completedAgents.length > 0) {
    const completedLine = completedAgents
      .map(s => `${s.agent_id}: ${s.dispatches_completed} done, ${s.artifacts_created} artifacts`)
      .join('; ');
    lines.push({
      category: 'completed',
      line: `✅ Top work: ${completedLine}`,
    });
  }

  // Agents with corrections/rework
  const correctedAgents = snapshots
    .filter(s => s.cto_corrections_count > 0 || s.operator_revision_requests > 0)
    .slice(0, 3);
  if (correctedAgents.length > 0) {
    const corrLine = correctedAgents
      .map(s => `${s.agent_id}: ${s.cto_corrections_count} corrections`)
      .join('; ');
    lines.push({
      category: 'corrections',
      line: `📝 Agents with corrections: ${corrLine}`,
    });
  }

  // Summary totals
  const totalCompleted = snapshots.reduce((s, r) => s + r.dispatches_completed, 0);
  const totalStarted = snapshots.reduce((s, r) => s + r.dispatches_started, 0);
  const totalStuck = snapshots.reduce((s, r) => s + r.dispatches_stuck, 0);
  const totalTokens = snapshots.reduce((s, r) => s + r.weighted_tokens, 0);

  if (totalStarted > 0 || totalCompleted > 0) {
    lines.push({
      category: 'summary',
      line: `📊 Day: ${totalCompleted}/${totalStarted} dispatches done, ${totalStuck} stuck, ${Math.round(totalTokens / 1000)}k weighted tokens`,
    });
  }

  if (lines.length === 0) {
    lines.push({
      category: 'quiet',
      line: `No telemetry events recorded for this window.`,
    });
  }

  return lines;
}
