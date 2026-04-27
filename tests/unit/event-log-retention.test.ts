// SPDX-License-Identifier: MIT

/**
 * Unit tests for the event_log retention sweep
 * (output/security-review-wakeup-service.md audit #6).
 *
 * Drives `sweepEventLogRetention` against a stubbed events repo so we can
 * assert: the age cutoff is computed from `now - retentionDays`, the count
 * cap is forwarded as `keepCount`, the sweep iterates every team returned
 * by `teams.listTeams()`, and the log line only fires when something was
 * actually deleted.
 */

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_RETENTION_COUNT,
  DEFAULT_RETENTION_DAYS,
  resolveRetentionConfig,
  sweepEventLogRetention,
} from '../../src/wakeup-service/retention.js';

interface StubCall {
  fn: 'pruneByAge' | 'pruneByCount';
  teamId: string;
  arg: number;
}

function makeStubEvents(returns: { aged?: Record<string, number>; count?: Record<string, number> } = {}) {
  const calls: StubCall[] = [];
  return {
    calls,
    repo: {
      async insert() { return { seq: 0 }; },
      async query() { return []; },
      async earliestSeq() { return null; },
      async pruneByAge(teamId: string, beforeOccurredAt: number) {
        calls.push({ fn: 'pruneByAge', teamId, arg: beforeOccurredAt });
        return returns.aged?.[teamId] ?? 0;
      },
      async pruneByCount(teamId: string, keepCount: number) {
        calls.push({ fn: 'pruneByCount', teamId, arg: keepCount });
        return returns.count?.[teamId] ?? 0;
      },
      async countForTeam() { return 0; },
    },
  };
}

function makeStubTeams(teams: Array<{ id: string; name: string }>) {
  return {
    async listTeams() {
      return teams.map((t) => ({
        id: t.id,
        name: t.name,
        config: {},
        port_start: 0,
        port_end: 0,
        created_at: '2026-01-01',
      }));
    },
  } as any;
}

describe('resolveRetentionConfig', () => {
  it('uses defaults when env vars are unset', () => {
    const cfg = resolveRetentionConfig({} as any);
    expect(cfg.retentionDays).toBe(DEFAULT_RETENTION_DAYS);
    expect(cfg.retentionCount).toBe(DEFAULT_RETENTION_COUNT);
  });

  it('reads positive integer overrides from env', () => {
    const cfg = resolveRetentionConfig({
      EVENT_LOG_RETENTION_DAYS: '14',
      EVENT_LOG_RETENTION_COUNT: '50',
    } as any);
    expect(cfg.retentionDays).toBe(14);
    expect(cfg.retentionCount).toBe(50);
  });

  it('falls back to defaults on garbage / non-positive env values', () => {
    const cfg = resolveRetentionConfig({
      EVENT_LOG_RETENTION_DAYS: 'banana',
      EVENT_LOG_RETENTION_COUNT: '-5',
    } as any);
    expect(cfg.retentionDays).toBe(DEFAULT_RETENTION_DAYS);
    expect(cfg.retentionCount).toBe(DEFAULT_RETENTION_COUNT);
  });
});

describe('sweepEventLogRetention', () => {
  it('passes ageCutoff = now - retentionDays and forwards retentionCount per team', async () => {
    const stub = makeStubEvents();
    const teams = makeStubTeams([
      { id: 'team-a', name: 'alpha' },
      { id: 'team-b', name: 'beta' },
    ]);
    const now = 1_777_300_000_000;
    await sweepEventLogRetention({
      events: stub.repo as any,
      teams,
      now,
      config: { retentionDays: 7, retentionCount: 100 },
    });

    const expectedCutoff = now - 7 * 24 * 60 * 60 * 1000;
    expect(stub.calls).toEqual([
      { fn: 'pruneByAge', teamId: 'team-a', arg: expectedCutoff },
      { fn: 'pruneByCount', teamId: 'team-a', arg: 100 },
      { fn: 'pruneByAge', teamId: 'team-b', arg: expectedCutoff },
      { fn: 'pruneByCount', teamId: 'team-b', arg: 100 },
    ]);
  });

  it('aggregates deletion counts across teams', async () => {
    const stub = makeStubEvents({
      aged: { 'team-a': 3, 'team-b': 0 },
      count: { 'team-a': 0, 'team-b': 5 },
    });
    const teams = makeStubTeams([
      { id: 'team-a', name: 'alpha' },
      { id: 'team-b', name: 'beta' },
    ]);
    const result = await sweepEventLogRetention({
      events: stub.repo as any,
      teams,
      now: 1_777_300_000_000,
      config: { retentionDays: 7, retentionCount: 100 },
    });
    expect(result).toEqual({ agedDeleted: 3, countDeleted: 5, teamsScanned: 2 });
  });

  it('logs only when a team actually deleted something', async () => {
    const stub = makeStubEvents({
      aged: { 'team-a': 2, 'team-b': 0 },
      count: { 'team-a': 0, 'team-b': 0 },
    });
    const teams = makeStubTeams([
      { id: 'team-a', name: 'alpha' },
      { id: 'team-b', name: 'beta' },
    ]);
    const lines: string[] = [];
    await sweepEventLogRetention({
      events: stub.repo as any,
      teams,
      now: 1_777_300_000_000,
      config: { retentionDays: 7, retentionCount: 100 },
      log: (line) => lines.push(line),
    });
    expect(lines).toEqual([
      '[wakeup-service] retention swept: aged=2 count=0 team=alpha',
    ]);
  });

  it('is a no-op when no teams exist', async () => {
    const stub = makeStubEvents();
    const result = await sweepEventLogRetention({
      events: stub.repo as any,
      teams: makeStubTeams([]),
      now: Date.now(),
      config: { retentionDays: 7, retentionCount: 100 },
    });
    expect(result).toEqual({ agedDeleted: 0, countDeleted: 0, teamsScanned: 0 });
    expect(stub.calls).toEqual([]);
  });
});
