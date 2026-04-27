// SPDX-License-Identifier: MIT
/**
 * Tests for the wakeup-service producer slice:
 *   - emitTaskClaimed / emitTaskCompleted append exactly one event_log row
 *     with the correct topic, subject, and envelope shape
 *   - The query sweeper flow (expireStale → emitQueryExpired) appends one
 *     query:expired event per stale row
 *
 * Backed by SQLite in-memory; the same producer module is used by the
 * postgres-backed manager.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import crypto from 'node:crypto';
import { SqliteAdapter } from '../../src/db/sqlite-adapter.js';
import { migrateSqlite } from '../../src/db/migrations/sqlite.js';
import { SqliteTeamsRepo } from '../../src/db/repos/sqlite/teams-repo.js';
import { SqliteEventsRepo } from '../../src/db/repos/sqlite/events-repo.js';
import { SqliteQueriesRepo } from '../../src/db/repos/sqlite/queries-repo.js';
import {
  emitTaskClaimed,
  emitTaskCompleted,
  emitQueryExpired,
  TASK_CLAIMED,
  TASK_COMPLETED,
  QUERY_EXPIRED,
} from '../../src/wakeup-service/event-producer.js';

async function freshDb() {
  const adapter = new SqliteAdapter(':memory:');
  await migrateSqlite(adapter);
  return adapter;
}

async function insertAgent(adapter: SqliteAdapter, teamId: string, name: string): Promise<string> {
  const id = crypto.randomUUID();
  await adapter.query(
    `INSERT INTO agents (team_id, id, name, type, model, port, status, created_at, runtime)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [teamId, id, name, 'persistent', 'claude-opus', 24000, 'active', Date.now(), 'claude-code'],
  );
  return id;
}

describe('event-producer: tasks', () => {
  let adapter: SqliteAdapter;
  let events: SqliteEventsRepo;
  let teamId: string;

  beforeEach(async () => {
    adapter = await freshDb();
    const teams = new SqliteTeamsRepo(adapter);
    events = new SqliteEventsRepo(adapter);
    teamId = await teams.getOrCreateTeamId('default');
  });

  it('emitTaskClaimed writes one task:claimed row with the correct envelope', async () => {
    const taskUuid = crypto.randomUUID();
    const occurredAt = 1_777_000_000_000;

    const { seq } = await emitTaskClaimed(events, {
      teamId,
      taskUuid,
      taskName: 'wakeup-service-producers',
      title: 'Wakeup service producers',
      ownerAgentId: 'agent-coder',
      occurredAt,
    });

    const rows = await events.query({ teamId });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      seq,
      team_id: teamId,
      topic: TASK_CLAIMED,
      actor_agent_id: 'agent-coder',
      subject_kind: 'task',
      subject_id: taskUuid,
      occurred_at: occurredAt,
      data: {
        task_name: 'wakeup-service-producers',
        task_uuid: taskUuid,
        status: 'doing',
        owner: 'agent-coder',
        title_preview: 'Wakeup service producers',
      },
    });
  });

  it('emitTaskCompleted writes one task:completed row with status=done', async () => {
    const taskUuid = crypto.randomUUID();
    const occurredAt = 1_777_000_001_000;

    const { seq } = await emitTaskCompleted(events, {
      teamId,
      taskUuid,
      taskName: 'wakeup-service-producers',
      title: null,
      ownerAgentId: 'agent-coder',
      actorAgentId: 'agent-coder',
      occurredAt,
    });

    const rows = await events.query({ teamId, topics: [TASK_COMPLETED] });
    expect(rows).toHaveLength(1);
    expect(rows[0].seq).toBe(seq);
    expect(rows[0].topic).toBe(TASK_COMPLETED);
    expect(rows[0].subject_kind).toBe('task');
    expect(rows[0].subject_id).toBe(taskUuid);
    expect(rows[0].actor_agent_id).toBe('agent-coder');
    expect(rows[0].data).toMatchObject({
      task_name: 'wakeup-service-producers',
      task_uuid: taskUuid,
      status: 'done',
      owner: 'agent-coder',
      completed_at: occurredAt,
    });
    // No title_preview when title is null
    expect((rows[0].data as Record<string, unknown>).title_preview).toBeUndefined();
  });
});

describe('event-producer: query sweeper', () => {
  let adapter: SqliteAdapter;
  let events: SqliteEventsRepo;
  let queries: SqliteQueriesRepo;
  let teamId: string;
  let agentId: string;

  beforeEach(async () => {
    adapter = await freshDb();
    const teams = new SqliteTeamsRepo(adapter);
    events = new SqliteEventsRepo(adapter);
    queries = new SqliteQueriesRepo(adapter);
    teamId = await teams.getOrCreateTeamId('default');
    agentId = await insertAgent(adapter, teamId, 'coder');
  });

  it('expireStale + emitQueryExpired produces one query:expired event per stale row', async () => {
    const oldQueryId = `query_old_${crypto.randomUUID()}`;
    const freshQueryId = `query_fresh_${crypto.randomUUID()}`;

    // Old, stuck query (will be expired by sweep)
    await queries.create(teamId, oldQueryId, agentId, 'old prompt', Date.now() - 60 * 60 * 1000);
    // Fresh query (not yet expired)
    await queries.create(teamId, freshQueryId, agentId, 'fresh prompt', Date.now());

    const cutoff = Date.now() - 30 * 60 * 1000;
    const expired = await queries.expireStale(cutoff, ['pending', 'processing']);

    expect(expired).toHaveLength(1);
    expect(expired[0].query_id).toBe(oldQueryId);
    expect(expired[0].status).toBe('expired');

    // Mirror the sweeper: emit one event per expired row
    const occurredAt = 1_777_000_002_000;
    for (const row of expired) {
      await emitQueryExpired(events, {
        teamId: row.team_id,
        queryId: row.query_id,
        agentId: row.agent_id,
        occurredAt,
      });
    }

    const eventRows = await events.query({ teamId, topics: [QUERY_EXPIRED] });
    expect(eventRows).toHaveLength(1);
    expect(eventRows[0]).toMatchObject({
      team_id: teamId,
      topic: QUERY_EXPIRED,
      actor_agent_id: agentId,
      subject_kind: 'query',
      subject_id: oldQueryId,
      occurred_at: occurredAt,
      data: {
        query_id: oldQueryId,
        status: 'expired',
        agent: agentId,
        completed_at: occurredAt,
      },
    });

    // Fresh query is unaffected
    const stillPending = await queries.getById(agentId, freshQueryId);
    expect(stillPending?.status).toBe('pending');
  });
});
