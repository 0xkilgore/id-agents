// P6 Agent Performance Telemetry — unit tests for rollup computation,
// source coverage, signal generation, and morning rundown.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SqliteAdapter } from '../../src/db/sqlite-adapter.js';
import { migrateTelemetryTables, insertEvent, upsertSnapshot, upsertSignal } from '../../src/telemetry/storage.js';
import {
  computeAgentSnapshot,
  generateSignals,
  computeSourceCoverage,
  dayBoundary,
  hourBoundary,
} from '../../src/telemetry/rollup.js';
import { summarizeForMorning } from '../../src/telemetry/morning-rundown.js';
import type { TelemetryEvent } from '../../src/telemetry/types.js';

let adapter: SqliteAdapter;

function freshAdapter(): SqliteAdapter {
  return new SqliteAdapter(':memory:');
}

beforeEach(() => {
  adapter = freshAdapter();
  migrateTelemetryTables(adapter);
});

afterEach(async () => {
  await adapter.close();
});

// ---------------------------------------------------------------------------
// Window boundary tests
// ---------------------------------------------------------------------------

describe('window boundaries', () => {
  it('hourBoundary returns start and end of the hour', () => {
    const d = new Date('2026-05-27T15:23:45Z');
    const { start, end } = hourBoundary(d);
    expect(start.getMinutes()).toBe(0);
    expect(start.getSeconds()).toBe(0);
    expect(end.getTime() - start.getTime()).toBeLessThanOrEqual(3600_000);
  });

  it('dayBoundary returns a valid range', () => {
    const d = new Date('2026-05-27T15:00:00Z');
    const { start, end } = dayBoundary(d, 'America/Chicago');
    expect(start.getTime()).toBeLessThan(end.getTime());
    // Day range should be ~24h
    const diffMs = end.getTime() - start.getTime();
    expect(diffMs).toBeGreaterThan(23 * 3600_000);
    expect(diffMs).toBeLessThan(25 * 3600_000);
  });
});

// ---------------------------------------------------------------------------
// Source coverage
// ---------------------------------------------------------------------------

describe('computeSourceCoverage', () => {
  it('marks sources with no events as missing', () => {
    const coverage = computeSourceCoverage([]);
    expect(coverage).toHaveLength(6);
    for (const c of coverage) {
      expect(c.state).toBe('missing');
      expect(c.confidence).toBe('missing');
    }
  });

  it('marks canonical sources as present', () => {
    const coverage = computeSourceCoverage([
      { source: 'dispatch_ops', confidence: 'canonical' },
      { source: 'dispatch_ops', confidence: 'canonical' },
    ]);
    const dispatchCov = coverage.find(c => c.source === 'dispatch_ops')!;
    expect(dispatchCov.state).toBe('present');
    expect(dispatchCov.confidence).toBe('canonical');
  });

  it('marks derived sources correctly', () => {
    const coverage = computeSourceCoverage([
      { source: 'stuck_detector', confidence: 'derived' },
    ]);
    const stuckCov = coverage.find(c => c.source === 'stuck_detector')!;
    expect(stuckCov.state).toBe('present');
    expect(stuckCov.confidence).toBe('derived');
  });

  it('marks missing confidence as missing state', () => {
    const coverage = computeSourceCoverage([
      { source: 'usage_meter_v2', confidence: 'missing' },
    ]);
    const usageCov = coverage.find(c => c.source === 'usage_meter_v2')!;
    expect(usageCov.state).toBe('missing');
    expect(usageCov.confidence).toBe('missing');
  });
});

// ---------------------------------------------------------------------------
// computeAgentSnapshot
// ---------------------------------------------------------------------------

describe('computeAgentSnapshot', () => {
  it('counts dispatch state changes correctly', () => {
    const events = [
      { kind: 'dispatch.state_changed', payload_json: '{"to_state":"queued"}', source: 'dispatch_ops', confidence: 'canonical' },
      { kind: 'dispatch.state_changed', payload_json: '{"to_state":"completed"}', source: 'dispatch_ops', confidence: 'canonical' },
      { kind: 'artifact.created', payload_json: '{}', source: 'artifact_ops', confidence: 'canonical' },
    ];
    const snap = computeAgentSnapshot({ agentId: 'roger', events }, 'day', '2026-05-27T05:00:00Z');
    expect(snap.dispatches_started).toBe(1);
    expect(snap.dispatches_completed).toBe(1);
    expect(snap.artifacts_created).toBe(1);
    expect(snap.high_burn_no_output_events).toBe(0);
  });

  it('needs_clarification does not count as failed', () => {
    const events = [
      { kind: 'dispatch.state_changed', payload_json: '{"to_state":"queued"}', source: 'dispatch_ops', confidence: 'canonical' },
      { kind: 'dispatch.state_changed', payload_json: '{"to_state":"needs_clarification"}', source: 'dispatch_ops', confidence: 'canonical' },
    ];
    const snap = computeAgentSnapshot({ agentId: 'roger', events }, 'day', '2026-05-27T05:00:00Z');
    expect(snap.needs_clarification_count).toBe(1);
    expect(snap.dispatches_failed).toBe(0);
  });

  it('detects high burn / no output', () => {
    const events = [
      { kind: 'usage.window_observed', payload_json: '{"daily_weighted_tokens":300000}', source: 'usage_meter_v2', confidence: 'canonical' },
    ];
    const snap = computeAgentSnapshot({ agentId: 'idle-agent', events }, 'day', '2026-05-27T05:00:00Z');
    expect(snap.high_burn_no_output_events).toBe(1);
  });

  it('resumed clarification then completed does not double-count starts', () => {
    // Agent starts (queued), hits clarification, resumes, then completes.
    // Only 1 queued event = 1 start. Completed = 1 completion.
    const events = [
      { kind: 'dispatch.state_changed', payload_json: '{"to_state":"queued"}', source: 'dispatch_ops', confidence: 'canonical' },
      { kind: 'dispatch.state_changed', payload_json: '{"to_state":"needs_clarification"}', source: 'dispatch_ops', confidence: 'canonical' },
      { kind: 'dispatch.state_changed', payload_json: '{"to_state":"completed"}', source: 'dispatch_ops', confidence: 'canonical' },
    ];
    const snap = computeAgentSnapshot({ agentId: 'roger', events }, 'day', '2026-05-27T05:00:00Z');
    expect(snap.dispatches_started).toBe(1);
    expect(snap.dispatches_completed).toBe(1);
    expect(snap.needs_clarification_count).toBe(1);
  });

  it('stuck detector event increments dispatches_stuck', () => {
    const events = [
      { kind: 'dispatch.stuck_detected', payload_json: '{"pid_state":"Ss","news_count":1}', source: 'stuck_detector', confidence: 'derived' },
    ];
    const snap = computeAgentSnapshot({ agentId: 'cto', events }, 'day', '2026-05-27T05:00:00Z');
    expect(snap.dispatches_stuck).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Signal generation
// ---------------------------------------------------------------------------

describe('generateSignals', () => {
  it('generates dispatch_stuck signal from stuck_detected event', () => {
    const events = [
      { kind: 'dispatch.stuck_detected', query_id: 'q_test', payload_json: '{"pid_state":"Ss","news_count":1,"report_file":"report.md"}', confidence: 'derived' },
    ];
    const sigs = generateSignals('cto', events, new Date());
    expect(sigs).toHaveLength(1);
    expect(sigs[0].kind).toBe('dispatch_stuck');
    expect(sigs[0].severity).toBe('warning');
    expect(sigs[0].confidence).toBe('derived');
    expect(sigs[0].title).toContain('Ss');
  });

  it('generates needs_clarification signal', () => {
    const events = [
      { kind: 'dispatch.state_changed', query_id: 'q_1', payload_json: '{"to_state":"needs_clarification"}', confidence: 'canonical' },
    ];
    const sigs = generateSignals('roger', events, new Date());
    expect(sigs).toHaveLength(1);
    expect(sigs[0].kind).toBe('needs_clarification');
    expect(sigs[0].confidence).toBe('canonical');
  });
});

// ---------------------------------------------------------------------------
// Morning rundown
// ---------------------------------------------------------------------------

describe('summarizeForMorning', () => {
  it('returns quiet message when no data', async () => {
    const lines = await summarizeForMorning(adapter);
    expect(lines).toHaveLength(1);
    expect(lines[0].category).toBe('quiet');
  });

  it('includes stuck dispatches in summary', async () => {
    await upsertSignal(adapter, {
      id: 'sig:stuck:1',
      kind: 'dispatch_stuck',
      severity: 'warning',
      agent_id: 'cto',
      subject: 'q_1',
      title: 'Dispatch stuck for 10m',
      first_seen_at: new Date().toISOString(),
      last_seen_at: new Date().toISOString(),
      source_refs_json: '[]',
      confidence: 'derived',
      resolved_at: null,
    });

    const lines = await summarizeForMorning(adapter);
    const stuckLine = lines.find(l => l.category === 'stuck');
    expect(stuckLine).toBeDefined();
    expect(stuckLine!.line).toContain('1 stuck dispatch');
    expect(stuckLine!.line).toContain('cto');
  });

  it('includes high burn agents in summary', async () => {
    await upsertSignal(adapter, {
      id: 'sig:burn:1',
      kind: 'high_burn_no_output',
      severity: 'warning',
      agent_id: 'idle-agent',
      subject: null,
      title: 'High token burn',
      first_seen_at: new Date().toISOString(),
      last_seen_at: new Date().toISOString(),
      source_refs_json: '[]',
      confidence: 'derived',
      resolved_at: null,
    });

    const lines = await summarizeForMorning(adapter);
    const burnLine = lines.find(l => l.category === 'high_burn');
    expect(burnLine).toBeDefined();
    expect(burnLine!.line).toContain('idle-agent');
  });

  it('includes top completed work', async () => {
    const now = new Date();
    const { start } = dayBoundary(now, 'America/Chicago');
    await upsertSnapshot(adapter, {
      agent_id: 'roger',
      window_kind: 'day',
      window_start: start.toISOString(),
      dispatches_started: 5,
      dispatches_completed: 4,
      dispatches_failed: 0,
      dispatches_stuck: 0,
      needs_clarification_count: 0,
      artifacts_created: 3,
      weighted_tokens: 200000,
      high_burn_no_output_events: 0,
      cto_corrections_count: 0,
      operator_revision_requests: 0,
      source_coverage_json: '{}',
      computed_at: now.toISOString(),
    });

    const lines = await summarizeForMorning(adapter);
    const completedLine = lines.find(l => l.category === 'completed');
    expect(completedLine).toBeDefined();
    expect(completedLine!.line).toContain('roger');
    expect(completedLine!.line).toContain('4 done');
  });
});
