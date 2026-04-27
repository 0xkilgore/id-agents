// SPDX-License-Identifier: MIT

/**
 * Integration test for event_log retention sweep
 * (output/security-review-wakeup-service.md audit #6).
 *
 * Boots an in-memory sqlite DB with the wakeup-service tables migrated and
 * exercises `sweepEventLogRetention` against the real `SqliteEventsRepo`.
 *
 *   - 7-day age cap: a row with `occurred_at` strictly older than `now - 7d`
 *     is deleted; a fresher row survives.
 *   - 100k-per-team count cap: when a team holds more than the cap, only the
 *     newest cap rows are retained. Uses a small cap override to avoid
 *     inserting 100k rows in CI.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { SqliteAdapter } from '../../src/db/sqlite-adapter.js';
import { migrateSqlite } from '../../src/db/migrations/sqlite.js';
import { SqliteTeamsRepo } from '../../src/db/repos/sqlite/teams-repo.js';
import { SqliteEventsRepo } from '../../src/db/repos/sqlite/events-repo.js';
import {
  DEFAULT_RETENTION_COUNT,
  sweepEventLogRetention,
} from '../../src/wakeup-service/retention.js';

const DAY_MS = 24 * 60 * 60 * 1000;

describe('event_log retention sweep', () => {
  let adapter: SqliteAdapter;
  let teams: SqliteTeamsRepo;
  let events: SqliteEventsRepo;
  let teamId: string;
  let otherTeamId: string;

  beforeAll(async () => {
    adapter = new SqliteAdapter(':memory:');
    migrateSqlite(adapter);
    teams = new SqliteTeamsRepo(adapter);
    events = new SqliteEventsRepo(adapter);
    teamId = await teams.getOrCreateTeamId('retention-team');
    otherTeamId = await teams.getOrCreateTeamId('other-team');
  });

  afterAll(async () => {
    await adapter.close();
  });

  it('age sweep: deletes rows older than 7 days, keeps fresh rows, scoped per team', async () => {
    const now = 1_777_300_000_000;
    const old = await events.insert({
      team_id: teamId,
      topic: 'task:claimed',
      actor_agent_id: null,
      subject_kind: 'task',
      subject_id: 'old',
      occurred_at: now - 7 * DAY_MS - 1, // 7d + 1ms older than now
      data: { mark: 'old' },
    });
    const fresh = await events.insert({
      team_id: teamId,
      topic: 'task:claimed',
      actor_agent_id: null,
      subject_kind: 'task',
      subject_id: 'fresh',
      occurred_at: now - 1 * DAY_MS,
      data: { mark: 'fresh' },
    });
    // A peer team's old row must not be touched while sweeping the test team
    // (the loop scans all teams, but each call is team-scoped).
    const peerOld = await events.insert({
      team_id: otherTeamId,
      topic: 'task:claimed',
      actor_agent_id: null,
      subject_kind: 'task',
      subject_id: 'peer-old',
      occurred_at: now - 30 * DAY_MS,
      data: { mark: 'peer-old' },
    });

    const teamsStub = {
      async listTeams() {
        return [
          { id: teamId, name: 'retention-team', config: {}, port_start: 0, port_end: 0, created_at: '2026-01-01' },
        ];
      },
    } as any;

    const result = await sweepEventLogRetention({
      events,
      teams: teamsStub,
      now,
      config: { retentionDays: 7, retentionCount: DEFAULT_RETENTION_COUNT },
    });

    expect(result.agedDeleted).toBe(1);
    expect(result.countDeleted).toBe(0);

    const remaining = await events.query({ teamId, sinceSeq: 0, limit: 100 });
    const remainingSeqs = remaining.map((r) => r.seq).sort((a, b) => a - b);
    expect(remainingSeqs).not.toContain(old.seq);
    expect(remainingSeqs).toContain(fresh.seq);

    // Other team untouched because we only listed the test team.
    const peerRows = await events.query({ teamId: otherTeamId, sinceSeq: 0, limit: 100 });
    expect(peerRows.map((r) => r.seq)).toContain(peerOld.seq);
  });

  it('count sweep: keeps newest N rows when count exceeds cap', async () => {
    const swiftTeamId = await teams.getOrCreateTeamId('count-cap-team');
    const now = 1_777_400_000_000;

    // Insert 7 fresh rows (none age out at this `now`).
    const inserted: number[] = [];
    for (let i = 0; i < 7; i++) {
      const r = await events.insert({
        team_id: swiftTeamId,
        topic: 'task:claimed',
        actor_agent_id: null,
        subject_kind: 'task',
        subject_id: `s-${i}`,
        occurred_at: now - (7 - i) * 1000, // ascending occurred_at
        data: { i },
      });
      inserted.push(r.seq);
    }

    const teamsStub = {
      async listTeams() {
        return [
          { id: swiftTeamId, name: 'count-cap-team', config: {}, port_start: 0, port_end: 0, created_at: '2026-01-01' },
        ];
      },
    } as any;

    // Cap at 5 → expect oldest 2 deleted, newest 5 retained.
    const result = await sweepEventLogRetention({
      events,
      teams: teamsStub,
      now,
      config: { retentionDays: 365, retentionCount: 5 },
    });

    expect(result.agedDeleted).toBe(0);
    expect(result.countDeleted).toBe(2);

    const remaining = await events.query({ teamId: swiftTeamId, sinceSeq: 0, limit: 100 });
    const remainingSeqs = remaining.map((r) => r.seq).sort((a, b) => a - b);
    expect(remainingSeqs).toEqual(inserted.slice(2));
  });

  it('count sweep with 100_001 rows prunes exactly one to land at the 100k cap', async () => {
    const stressTeamId = await teams.getOrCreateTeamId('count-cap-stress');
    const now = 1_777_550_000_000;
    for (let i = 0; i < DEFAULT_RETENTION_COUNT + 1; i++) {
      await events.insert({
        team_id: stressTeamId,
        topic: 'task:claimed',
        actor_agent_id: null,
        subject_kind: 'task',
        subject_id: `s-${i}`,
        occurred_at: now,
        data: {},
      });
    }
    expect(await events.countForTeam(stressTeamId)).toBe(DEFAULT_RETENTION_COUNT + 1);

    const teamsStub = {
      async listTeams() {
        return [
          { id: stressTeamId, name: 'count-cap-stress', config: {}, port_start: 0, port_end: 0, created_at: '2026-01-01' },
        ];
      },
    } as any;

    const result = await sweepEventLogRetention({ events, teams: teamsStub, now });
    expect(result.countDeleted).toBe(1);
    expect(await events.countForTeam(stressTeamId)).toBe(DEFAULT_RETENTION_COUNT);
  }, 60_000);

  it('count sweep with N+1 rows over the cap deletes exactly one oldest row', async () => {
    const tinyCapTeamId = await teams.getOrCreateTeamId('boundary-cap-team');
    const now = 1_777_500_000_000;

    const inserted: number[] = [];
    const cap = 3;
    for (let i = 0; i < cap + 1; i++) {
      const r = await events.insert({
        team_id: tinyCapTeamId,
        topic: 'task:claimed',
        actor_agent_id: null,
        subject_kind: 'task',
        subject_id: `b-${i}`,
        occurred_at: now - (cap + 1 - i) * 1000,
        data: { i },
      });
      inserted.push(r.seq);
    }

    const teamsStub = {
      async listTeams() {
        return [
          { id: tinyCapTeamId, name: 'boundary-cap-team', config: {}, port_start: 0, port_end: 0, created_at: '2026-01-01' },
        ];
      },
    } as any;

    const result = await sweepEventLogRetention({
      events,
      teams: teamsStub,
      now,
      config: { retentionDays: 365, retentionCount: cap },
    });

    expect(result.countDeleted).toBe(1);
    const remaining = await events.query({ teamId: tinyCapTeamId, sinceSeq: 0, limit: 100 });
    const remainingSeqs = remaining.map((r) => r.seq).sort((a, b) => a - b);
    expect(remainingSeqs).toEqual(inserted.slice(1));
  });
});
