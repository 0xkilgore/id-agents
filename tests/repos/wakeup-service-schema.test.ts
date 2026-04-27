// SPDX-License-Identifier: MIT
/**
 * Tests for the wakeup-service schema slice:
 *   - event_log insert + query (filters: since, topics, limit, team)
 *   - subscriptions listByOwner (team-scoped, owner-scoped, status filter)
 *
 * Backed by SQLite in-memory; the same SQL shape is shared with the
 * Postgres adapter via the EventsRepository / SubscriptionsRepository
 * contracts.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import crypto from 'node:crypto';
import { SqliteAdapter } from '../../src/db/sqlite-adapter.js';
import { migrateSqlite } from '../../src/db/migrations/sqlite.js';
import { SqliteTeamsRepo } from '../../src/db/repos/sqlite/teams-repo.js';
import { SqliteEventsRepo } from '../../src/db/repos/sqlite/events-repo.js';
import { SqliteSubscriptionsRepo } from '../../src/db/repos/sqlite/subscriptions-repo.js';

async function freshDb() {
  const adapter = new SqliteAdapter(':memory:');
  await migrateSqlite(adapter);
  return adapter;
}

async function insertSubscription(
  adapter: SqliteAdapter,
  fields: {
    id: string;
    team_id: string;
    owner_agent_id: string;
    mode?: 'sse' | 'webhook';
    status?: 'active' | 'paused' | 'unhealthy' | 'deleted';
    filter?: Record<string, unknown>;
    target?: Record<string, unknown>;
    created_at?: number;
    updated_at?: number;
    last_acked_seq?: number | null;
  },
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  await adapter.query(
    `INSERT INTO subscriptions
       (id, team_id, owner_agent_id, mode, status, filter_json, target_json,
        created_at, updated_at, last_acked_seq, last_error, consecutive_failures)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 0)`,
    [
      fields.id,
      fields.team_id,
      fields.owner_agent_id,
      fields.mode ?? 'sse',
      fields.status ?? 'active',
      JSON.stringify(fields.filter ?? {}),
      JSON.stringify(fields.target ?? { kind: 'session' }),
      fields.created_at ?? now,
      fields.updated_at ?? now,
      fields.last_acked_seq ?? null,
    ],
  );
}

describe('EventsRepository.insert', () => {
  let adapter: SqliteAdapter;
  let teams: SqliteTeamsRepo;
  let events: SqliteEventsRepo;
  let teamId: string;

  beforeEach(async () => {
    adapter = await freshDb();
    teams = new SqliteTeamsRepo(adapter);
    events = new SqliteEventsRepo(adapter);
    teamId = await teams.getOrCreateTeamId('default');
  });

  it('returns a monotonically increasing seq and round-trips the payload', async () => {
    const first = await events.insert({
      team_id: teamId,
      topic: 'query:delivered',
      actor_agent_id: 'coder',
      subject_kind: 'query',
      subject_id: 'query_abc',
      occurred_at: 1_777_000_000_000,
      data: { status: 'delivered', message_preview: 'Build finished' },
    });
    const second = await events.insert({
      team_id: teamId,
      topic: 'task:completed',
      occurred_at: 1_777_000_000_500,
      data: { task: 'wakeup-service-schema' },
    });

    expect(first.seq).toBeGreaterThan(0);
    expect(second.seq).toBe(first.seq + 1);

    const all = await events.query({ teamId });
    expect(all).toHaveLength(2);
    expect(all[0]).toMatchObject({
      seq: first.seq,
      team_id: teamId,
      topic: 'query:delivered',
      actor_agent_id: 'coder',
      subject_kind: 'query',
      subject_id: 'query_abc',
      occurred_at: 1_777_000_000_000,
      data: { status: 'delivered', message_preview: 'Build finished' },
    });
    expect(all[1].actor_agent_id).toBeNull();
    expect(all[1].subject_kind).toBeNull();
  });
});

describe('EventsRepository.query — filters', () => {
  let adapter: SqliteAdapter;
  let teams: SqliteTeamsRepo;
  let events: SqliteEventsRepo;
  let teamA: string;
  let teamB: string;

  beforeEach(async () => {
    adapter = await freshDb();
    teams = new SqliteTeamsRepo(adapter);
    events = new SqliteEventsRepo(adapter);
    teamA = await teams.getOrCreateTeamId('team-a');
    teamB = await teams.getOrCreateTeamId('team-b');

    // teamA: 4 events across two topics
    await events.insert({ team_id: teamA, topic: 'query:delivered', occurred_at: 1, data: { n: 1 } });
    await events.insert({ team_id: teamA, topic: 'task:completed', occurred_at: 2, data: { n: 2 } });
    await events.insert({ team_id: teamA, topic: 'query:delivered', occurred_at: 3, data: { n: 3 } });
    await events.insert({ team_id: teamA, topic: 'agent:started', occurred_at: 4, data: { n: 4 } });
    // teamB: 1 event that must never leak into teamA reads
    await events.insert({ team_id: teamB, topic: 'query:delivered', occurred_at: 99, data: { tenant: 'b' } });
  });

  it('scopes results to the requested team', async () => {
    const a = await events.query({ teamId: teamA });
    const b = await events.query({ teamId: teamB });
    expect(a).toHaveLength(4);
    expect(b).toHaveLength(1);
    expect(b[0].data).toEqual({ tenant: 'b' });
    for (const row of a) expect(row.team_id).toBe(teamA);
  });

  it('filters by sinceSeq exclusively and orders ascending', async () => {
    const all = await events.query({ teamId: teamA });
    const cursor = all[1].seq; // skip first two

    const after = await events.query({ teamId: teamA, sinceSeq: cursor });
    expect(after).toHaveLength(2);
    expect(after.map((r) => r.seq)).toEqual([all[2].seq, all[3].seq]);
    expect(after.every((r) => r.seq > cursor)).toBe(true);
  });

  it('filters by topics list', async () => {
    const filtered = await events.query({
      teamId: teamA,
      topics: ['query:delivered', 'agent:started'],
    });
    expect(filtered).toHaveLength(3);
    expect(filtered.map((r) => r.topic)).toEqual([
      'query:delivered',
      'query:delivered',
      'agent:started',
    ]);
  });

  it('honors limit and clamps to a hard ceiling', async () => {
    const limited = await events.query({ teamId: teamA, limit: 2 });
    expect(limited).toHaveLength(2);

    const clamped = await events.query({ teamId: teamA, limit: 10_000 });
    expect(clamped.length).toBeLessThanOrEqual(1000);
    expect(clamped).toHaveLength(4);
  });

  it('earliestSeq returns the lowest retained seq for the team', async () => {
    const all = await events.query({ teamId: teamA });
    const earliest = await events.earliestSeq(teamA);
    expect(earliest).toBe(all[0].seq);

    const empty = await events.earliestSeq(
      await teams.getOrCreateTeamId('team-empty'),
    );
    expect(empty).toBeNull();
  });
});

describe('SubscriptionsRepository.listByOwner', () => {
  let adapter: SqliteAdapter;
  let teams: SqliteTeamsRepo;
  let subs: SqliteSubscriptionsRepo;
  let teamA: string;
  let teamB: string;

  beforeEach(async () => {
    adapter = await freshDb();
    teams = new SqliteTeamsRepo(adapter);
    subs = new SqliteSubscriptionsRepo(adapter);
    teamA = await teams.getOrCreateTeamId('team-a');
    teamB = await teams.getOrCreateTeamId('team-b');
  });

  it('returns active + paused + unhealthy rows for the owner, newest first, scoped to team', async () => {
    await insertSubscription(adapter, {
      id: 'sub_old',
      team_id: teamA,
      owner_agent_id: 'manager',
      mode: 'sse',
      target: { kind: 'session' },
      filter: { events: ['query:terminal'] },
      created_at: 100,
    });
    await insertSubscription(adapter, {
      id: 'sub_new',
      team_id: teamA,
      owner_agent_id: 'manager',
      mode: 'webhook',
      status: 'paused',
      target: { kind: 'webhook', url: 'http://127.0.0.1:4050/news' },
      filter: { events: ['task:status'] },
      created_at: 200,
    });
    // Different owner in same team — must be excluded
    await insertSubscription(adapter, {
      id: 'sub_other_owner',
      team_id: teamA,
      owner_agent_id: 'dashboard',
      created_at: 150,
    });
    // Same owner name in a different team — must be excluded
    await insertSubscription(adapter, {
      id: 'sub_other_team',
      team_id: teamB,
      owner_agent_id: 'manager',
      created_at: 250,
    });

    const rows = await subs.listByOwner(teamA, 'manager');
    expect(rows.map((r) => r.id)).toEqual(['sub_new', 'sub_old']);
    expect(rows[0]).toMatchObject({
      id: 'sub_new',
      team_id: teamA,
      owner_agent_id: 'manager',
      mode: 'webhook',
      status: 'paused',
      filter: { events: ['task:status'] },
      target: { kind: 'webhook', url: 'http://127.0.0.1:4050/news' },
      consecutive_failures: 0,
      last_acked_seq: null,
      last_error: null,
    });
    expect(rows[1].mode).toBe('sse');
  });

  it('excludes rows with status="deleted"', async () => {
    await insertSubscription(adapter, {
      id: 'sub_alive',
      team_id: teamA,
      owner_agent_id: 'manager',
      created_at: 100,
    });
    await insertSubscription(adapter, {
      id: 'sub_tombstoned',
      team_id: teamA,
      owner_agent_id: 'manager',
      status: 'deleted',
      created_at: 200,
    });

    const rows = await subs.listByOwner(teamA, 'manager');
    expect(rows.map((r) => r.id)).toEqual(['sub_alive']);
  });

  it('returns an empty array when the owner has no subscriptions', async () => {
    await insertSubscription(adapter, {
      id: `sub_${crypto.randomBytes(4).toString('hex')}`,
      team_id: teamA,
      owner_agent_id: 'someone-else',
    });

    const rows = await subs.listByOwner(teamA, 'manager');
    expect(rows).toEqual([]);
  });
});
