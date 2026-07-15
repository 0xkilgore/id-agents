import { describe, it, expect } from 'vitest';
import { AlertStateManager } from '../../src/supervisor/alerts.js';
import type { RuleFinding, ConfigSnapshot, SupervisorAlertRecord } from '../../src/supervisor/types.js';

const configSnapshot: ConfigSnapshot = {
  poll_interval_seconds: 30,
  stuck_query_seconds: 1800,
  no_progress_seconds: 600,
  agent_down_seconds: 300,
  news_error_window_seconds: 900,
  news_error_repeat_count: 3,
};

function makeFinding(overrides: Partial<RuleFinding> = {}): RuleFinding {
  return {
    dedupe_key: 'stuck_query:q1',
    kind: 'stuck_query',
    severity: 'warning',
    confidence: 'high',
    title: 'Stuck query q1',
    summary: 'Dispatch stuck for 2000s',
    evidence: [{ source: 'dispatch', observed_at: '2026-05-28T12:00:00Z', detail: 'test' }],
    agent_id: 'roger',
    ...overrides,
  };
}

function makeHealthFinding(
  kind: 'disk_warn' | 'build_behind_origin',
  overrides: Partial<RuleFinding> = {},
): RuleFinding {
  return makeFinding({
    dedupe_key: `${kind}:live-health`,
    kind,
    severity: 'warning',
    confidence: 'high',
    title: `${kind} live health alert`,
    summary: `${kind} degraded from live health source`,
    evidence: [{ source: 'system_health', observed_at: '2026-05-28T12:00:00Z', detail: `${kind}=degraded` }],
    counters: { affected: 1 },
    ...overrides,
  });
}

describe('AlertStateManager', () => {
  it('emits an open record for a new finding', () => {
    const mgr = new AlertStateManager();
    const findings = [makeFinding()];
    const records = mgr.processTick(findings, configSnapshot, '2026-05-28T12:00:00Z');

    expect(records).toHaveLength(1);
    expect(records[0].status).toBe('open');
    expect(records[0].kind).toBe('stuck_query');
    expect(records[0].dedupe_key).toBe('stuck_query:q1');
    expect(records[0].alert_id).toBeTruthy();
    expect(records[0].config_snapshot).toEqual(configSnapshot);
  });

  it('does not emit duplicate on same finding with no change', () => {
    const mgr = new AlertStateManager();
    const findings = [makeFinding()];

    mgr.processTick(findings, configSnapshot, '2026-05-28T12:00:00Z');
    const records2 = mgr.processTick(findings, configSnapshot, '2026-05-28T12:00:30Z');

    expect(records2).toHaveLength(0);
  });

  it('emits updated record when severity changes', () => {
    const mgr = new AlertStateManager();
    mgr.processTick([makeFinding()], configSnapshot, '2026-05-28T12:00:00Z');

    const updated = makeFinding({ severity: 'critical' });
    const records = mgr.processTick([updated], configSnapshot, '2026-05-28T12:00:30Z');

    expect(records).toHaveLength(1);
    expect(records[0].status).toBe('updated');
    expect(records[0].severity).toBe('critical');
  });

  it('emits updated record when summary changes', () => {
    const mgr = new AlertStateManager();
    mgr.processTick([makeFinding()], configSnapshot, '2026-05-28T12:00:00Z');

    const updated = makeFinding({ summary: 'Now stuck for 3000s' });
    const records = mgr.processTick([updated], configSnapshot, '2026-05-28T12:00:30Z');

    expect(records).toHaveLength(1);
    expect(records[0].status).toBe('updated');
  });

  it('resolves alert after 2 consecutive missing ticks', () => {
    const mgr = new AlertStateManager();
    mgr.processTick([makeFinding()], configSnapshot, '2026-05-28T12:00:00Z');

    // First tick without the finding — no resolution yet
    const tick2 = mgr.processTick([], configSnapshot, '2026-05-28T12:00:30Z');
    expect(tick2).toHaveLength(0);
    expect(mgr.getOpenAlerts()).toHaveLength(1);

    // Second tick without — should resolve
    const tick3 = mgr.processTick([], configSnapshot, '2026-05-28T12:01:00Z');
    expect(tick3).toHaveLength(1);
    expect(tick3[0].status).toBe('resolved');
    expect(tick3[0].resolved_at).toBe('2026-05-28T12:01:00Z');
    expect(mgr.getOpenAlerts()).toHaveLength(0);
  });

  it('cancels resolution if finding reappears on second tick', () => {
    const mgr = new AlertStateManager();
    mgr.processTick([makeFinding()], configSnapshot, '2026-05-28T12:00:00Z');

    // First tick without
    mgr.processTick([], configSnapshot, '2026-05-28T12:00:30Z');

    // Finding reappears — should NOT resolve
    const tick3 = mgr.processTick([makeFinding()], configSnapshot, '2026-05-28T12:01:00Z');
    expect(tick3).toHaveLength(0); // No new emission (same state)
    expect(mgr.getOpenAlerts()).toHaveLength(1);
  });

  it('tracks multiple alerts independently', () => {
    const mgr = new AlertStateManager();
    const f1 = makeFinding({ dedupe_key: 'stuck_query:q1' });
    const f2 = makeFinding({ dedupe_key: 'agent_down:roger', kind: 'agent_down' });

    const records = mgr.processTick([f1, f2], configSnapshot, '2026-05-28T12:00:00Z');
    expect(records).toHaveLength(2);
    expect(mgr.getOpenAlerts()).toHaveLength(2);

    // Remove one
    mgr.processTick([f1], configSnapshot, '2026-05-28T12:00:30Z');
    mgr.processTick([f1], configSnapshot, '2026-05-28T12:01:00Z');
    expect(mgr.getOpenAlerts()).toHaveLength(1);
    expect(mgr.getOpenAlerts()[0].dedupe_key).toBe('stuck_query:q1');
  });

  it.each(['disk_warn', 'build_behind_origin'] as const)(
    'keeps %s open until the live health source is green for configured consecutive checks',
    (kind) => {
      const mgr = new AlertStateManager(3);
      const finding = makeHealthFinding(kind);

      const opened = mgr.processTick([finding], configSnapshot, '2026-05-28T12:00:00Z');
      expect(opened).toHaveLength(1);
      expect(opened[0]).toMatchObject({ status: 'open', kind, dedupe_key: `${kind}:live-health` });

      const firstGreen = mgr.processTick([], configSnapshot, '2026-05-28T12:00:30Z');
      const secondGreen = mgr.processTick([], configSnapshot, '2026-05-28T12:01:00Z');
      expect(firstGreen).toEqual([]);
      expect(secondGreen).toEqual([]);
      expect(mgr.getOpenAlerts()).toHaveLength(1);

      const thirdGreen = mgr.processTick([], configSnapshot, '2026-05-28T12:01:30Z');
      expect(thirdGreen).toHaveLength(1);
      expect(thirdGreen[0]).toMatchObject({ status: 'resolved', kind, dedupe_key: `${kind}:live-health` });
      expect(mgr.getOpenAlerts()).toHaveLength(0);
    },
  );

  it.each(['disk_warn', 'build_behind_origin'] as const)(
    'collapses repeated %s degraded checks into one actionable incident',
    (kind) => {
      const mgr = new AlertStateManager(2);
      const finding = makeHealthFinding(kind);

      const opened = mgr.processTick([finding], configSnapshot, '2026-05-28T12:00:00Z');
      const repeated = mgr.processTick([finding], configSnapshot, '2026-05-28T12:00:30Z');
      const repeatedAgain = mgr.processTick([finding], configSnapshot, '2026-05-28T12:01:00Z');

      expect(opened).toHaveLength(1);
      expect(repeated).toEqual([]);
      expect(repeatedAgain).toEqual([]);
      expect(mgr.getOpenAlerts()).toHaveLength(1);
      expect(mgr.getOpenAlerts()[0]).toMatchObject({
        dedupe_key: `${kind}:live-health`,
        occurrence_count: 1,
        status: 'open',
      });
    },
  );

  it('preserves alert_id across updates', () => {
    const mgr = new AlertStateManager();
    const records1 = mgr.processTick([makeFinding()], configSnapshot, '2026-05-28T12:00:00Z');
    const records2 = mgr.processTick(
      [makeFinding({ severity: 'critical' })],
      configSnapshot,
      '2026-05-28T12:00:30Z',
    );

    expect(records1[0].alert_id).toBe(records2[0].alert_id);
  });
});

describe('AlertStateManager — replay', () => {
  it('reconstructs open alerts from JSONL records', () => {
    const mgr = new AlertStateManager();

    const openRecord: SupervisorAlertRecord = {
      alert_id: 'test-id',
      dedupe_key: 'stuck_query:q1',
      status: 'open',
      kind: 'stuck_query',
      severity: 'warning',
      confidence: 'high',
      detected_at: '2026-05-28T11:00:00Z',
      updated_at: '2026-05-28T11:30:00Z',
      title: 'Stuck query',
      summary: 'test',
      evidence: [],
      config_snapshot: configSnapshot,
    };

    mgr.replayFromRecords([openRecord]);
    expect(mgr.getOpenAlerts()).toHaveLength(1);
    expect(mgr.getOpenAlerts()[0].alert_id).toBe('test-id');
  });

  it('removes resolved alerts during replay', () => {
    const mgr = new AlertStateManager();

    const openRecord: SupervisorAlertRecord = {
      alert_id: 'test-id',
      dedupe_key: 'stuck_query:q1',
      status: 'open',
      kind: 'stuck_query',
      severity: 'warning',
      confidence: 'high',
      detected_at: '2026-05-28T11:00:00Z',
      updated_at: '2026-05-28T11:30:00Z',
      title: 'Stuck query',
      summary: 'test',
      evidence: [],
      config_snapshot: configSnapshot,
    };

    const resolvedRecord: SupervisorAlertRecord = {
      ...openRecord,
      status: 'resolved',
      resolved_at: '2026-05-28T11:45:00Z',
      updated_at: '2026-05-28T11:45:00Z',
    };

    mgr.replayFromRecords([openRecord, resolvedRecord]);
    expect(mgr.getOpenAlerts()).toHaveLength(0);
  });
});
