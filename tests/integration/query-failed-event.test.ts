// SPDX-License-Identifier: MIT
/**
 * Tests for `query:failed` emission on the manager-side `/news` reply
 * path. Audit finding #9 (output/security-review-wakeup-service.md):
 * `emitQueryFailed` was exported but never called by production code.
 *
 * Production failure path (recap):
 *   - Agent's /talk handler catches the work and calls
 *     `sendReplyToSender(success=false)` which posts a /news reply with
 *     `type: 'reply.error'` and `in_reply_to: <queryId>`. See
 *     `src/claude-agent-server.ts → sendReplyToSender`.
 *   - The manager's /news handler used to unconditionally call
 *     `queries.complete()` and emit `query:delivered`, masking the failure
 *     in the event log.
 *   - The fix routes `reply.error` through `queries.markFailed()` and
 *     `emitQueryFailed`, so the wakeup-service event log carries the real
 *     lifecycle transition.
 *
 * The two pieces under test live in different layers, so we cover them
 * separately:
 *   1. `SqliteQueriesRepo.markFailed` — only flips a 'pending' row, returns
 *      true on transition, false on no-op.
 *   2. The producer + repo combo simulates the manager handler: on a
 *      `reply.error`, mark the row failed and emit `query:failed`.
 *      Asserts the event row shape (topic, subject, agent, reason_preview).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SqliteAdapter } from '../../src/db/sqlite-adapter.js';
import { migrateSqlite } from '../../src/db/migrations/sqlite.js';
import { SqliteTeamsRepo } from '../../src/db/repos/sqlite/teams-repo.js';
import { SqliteAgentsRepo } from '../../src/db/repos/sqlite/agents-repo.js';
import { SqliteQueriesRepo } from '../../src/db/repos/sqlite/queries-repo.js';
import { SqliteEventsRepo } from '../../src/db/repos/sqlite/events-repo.js';
import { emitQueryDelivered, emitQueryFailed } from '../../src/wakeup-service/event-producer.js';

async function freshDb() {
  const adapter = new SqliteAdapter(':memory:');
  await migrateSqlite(adapter);
  const teams = new SqliteTeamsRepo(adapter);
  const agents = new SqliteAgentsRepo(adapter);
  const queries = new SqliteQueriesRepo(adapter);
  const events = new SqliteEventsRepo(adapter);
  return { adapter, teams, agents, queries, events };
}

async function insertAgent(adapter: SqliteAdapter, teamId: string, name: string): Promise<string> {
  const id = `agent_${name}_${Math.random().toString(36).slice(2, 9)}`;
  await adapter.query(
    `INSERT INTO agents (team_id, id, name, type, model, port, status, created_at, runtime, metadata)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [teamId, id, name, 'persistent', 'claude-opus', 0, 'active', Date.now(), 'claude-code', '{}'],
  );
  return id;
}

describe('SqliteQueriesRepo.markFailed', () => {
  let db: Awaited<ReturnType<typeof freshDb>>;
  let teamId: string;
  let agentId: string;

  beforeEach(async () => {
    db = await freshDb();
    teamId = await db.teams.getOrCreateTeamId('mark-failed-test');
    agentId = await insertAgent(db.adapter, teamId, 'coder');
  });

  afterEach(async () => {
    await db.adapter.close();
  });

  it('flips a pending row to failed with the error string and timestamp', async () => {
    const queryId = 'query-pending';
    await db.queries.create(teamId, queryId, agentId, 'do the thing', 1000);

    const transitioned = await db.queries.markFailed(teamId, queryId, 2000, 'API quota exceeded');
    expect(transitioned).toBe(true);

    const row = await db.queries.getById(agentId, queryId);
    expect(row?.status).toBe('failed');
    expect(row?.error).toBe('API quota exceeded');
    expect(row?.completed).toBe(2000);
  });

  it('returns false (no-op) when the row has already left pending', async () => {
    const queryId = 'query-already-done';
    await db.queries.create(teamId, queryId, agentId, 'p', 0);
    await db.queries.complete(teamId, queryId, 1000, { reply: 'ok' });

    const transitioned = await db.queries.markFailed(teamId, queryId, 2000, 'late error');
    expect(transitioned).toBe(false);

    const row = await db.queries.getById(agentId, queryId);
    expect(row?.status).toBe('completed'); // not flipped
    expect(row?.error).toBe(null);
  });

  it('returns false when the query is unknown (no row created at all)', async () => {
    const transitioned = await db.queries.markFailed(teamId, 'never-seen', 1000, 'x');
    expect(transitioned).toBe(false);
  });

  it('respects team scoping — markFailed in the wrong team is a no-op', async () => {
    const queryId = 'query-team-scoped';
    await db.queries.create(teamId, queryId, agentId, 'p', 0);
    const otherTeam = await db.teams.getOrCreateTeamId('other-team');

    const transitioned = await db.queries.markFailed(otherTeam, queryId, 1000, 'wrong team');
    expect(transitioned).toBe(false);

    const row = await db.queries.getById(agentId, queryId);
    expect(row?.status).toBe('pending'); // untouched
  });
});

describe('manager /news → query:failed wiring (markFailed + emitQueryFailed)', () => {
  // Mirrors the post-fix branch in `agent-manager-db.ts` /news handler:
  //   when `type === 'reply.error'`:
  //     transitioned = await queries.markFailed(...)
  //     if (transitioned) await emitQueryFailed(events, { ... })
  //   else:
  //     await queries.complete(...)
  //     ... emitQueryDelivered(events, { ... }) ...
  // The test drives the same calls in the same order so the wakeup-service
  // event log carries `query:failed` with the agent + reason preview.

  let db: Awaited<ReturnType<typeof freshDb>>;
  let teamId: string;
  let agentId: string;

  beforeEach(async () => {
    db = await freshDb();
    teamId = await db.teams.getOrCreateTeamId('news-failed-test');
    agentId = await insertAgent(db.adapter, teamId, 'coder');
  });

  afterEach(async () => {
    await db.adapter.close();
  });

  it('emits exactly one query:failed (and no query:delivered) for a reply.error path', async () => {
    const queryId = 'qid-fail-1';
    await db.queries.create(teamId, queryId, agentId, 'do the thing', 1_000);

    const errorMsg = 'API quota exceeded — please retry later';
    const ts = 2_000;

    // Manager handler logic (failure branch):
    const transitioned = await db.queries.markFailed(teamId, queryId, ts, errorMsg);
    expect(transitioned).toBe(true);

    const row = await db.queries.getByQueryIdForTeam(teamId, queryId);
    await emitQueryFailed(db.events, {
      teamId,
      queryId,
      agentId: row!.agent_id,
      occurredAt: ts,
      reason: errorMsg,
    });

    // Event_log carries query:failed with the right shape, and not query:delivered.
    const failed = await db.events.query({ teamId, topics: ['query:failed'] });
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({
      team_id: teamId,
      topic: 'query:failed',
      subject_kind: 'query',
      subject_id: queryId,
      actor_agent_id: agentId,
      occurred_at: ts,
    });
    expect(failed[0].data).toMatchObject({
      query_id: queryId,
      status: 'failed',
      agent: agentId,
      reason_preview: errorMsg,
    });

    const delivered = await db.events.query({ teamId, topics: ['query:delivered'] });
    expect(delivered).toHaveLength(0);
  });

  it('emits query:delivered (and no query:failed) on a normal reply', async () => {
    const queryId = 'qid-ok-1';
    await db.queries.create(teamId, queryId, agentId, 'do the thing', 1_000);

    const ts = 2_000;
    await db.queries.complete(teamId, queryId, ts, { reply: 'all done' });
    const row = await db.queries.getByQueryIdForTeam(teamId, queryId);
    expect(row?.status).toBe('completed');

    await emitQueryDelivered(db.events, {
      teamId,
      queryId,
      agentId: row!.agent_id,
      occurredAt: ts,
      messagePreview: 'all done',
    });

    const failed = await db.events.query({ teamId, topics: ['query:failed'] });
    expect(failed).toHaveLength(0);
    const delivered = await db.events.query({ teamId, topics: ['query:delivered'] });
    expect(delivered).toHaveLength(1);
  });

  it('a late reply.error after a successful completion is suppressed (no event)', async () => {
    const queryId = 'qid-late-1';
    await db.queries.create(teamId, queryId, agentId, 'do the thing', 1_000);

    // Success arrives first — manager would call complete + emitQueryDelivered.
    await db.queries.complete(teamId, queryId, 2_000, { reply: 'ok' });
    const okRow = await db.queries.getByQueryIdForTeam(teamId, queryId);
    await emitQueryDelivered(db.events, {
      teamId, queryId, agentId: okRow!.agent_id, occurredAt: 2_000, messagePreview: 'ok',
    });

    // Then a stray reply.error from a retry path. The manager guards by
    // checking the markFailed return value before emitting.
    const transitioned = await db.queries.markFailed(teamId, queryId, 3_000, 'stale error');
    expect(transitioned).toBe(false);
    if (transitioned) {
      // never executes; this branch is here so the test doc matches the handler.
      await emitQueryFailed(db.events, {
        teamId, queryId, agentId: okRow!.agent_id, occurredAt: 3_000, reason: 'stale error',
      });
    }

    // Row still completed; only the delivered event is in the log.
    const row = await db.queries.getByQueryIdForTeam(teamId, queryId);
    expect(row?.status).toBe('completed');

    const failed = await db.events.query({ teamId, topics: ['query:failed'] });
    expect(failed).toHaveLength(0);
    const delivered = await db.events.query({ teamId, topics: ['query:delivered'] });
    expect(delivered).toHaveLength(1);
  });
});
