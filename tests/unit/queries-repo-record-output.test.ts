// SPDX-License-Identifier: MIT
//
// B1 — alive-nonclosing / worker-progress evidence.
//
// Verifies that `QueriesRepository.recordOutput()` stamps `last_output_at`
// onto in-flight queries so the manager can later derive a
// `silence_age_seconds` signal (B4) and distinguish working-but-slow from
// silently-wedged. Spec: cto/2026-06-08-worker-health-roger-reliability-reassessment.md
// §"Minimal Reliability Slice" item (2) "Dispatch Progress Observation".

import { afterEach, describe, expect, it } from 'vitest';

import { SqliteAdapter } from '../../src/db/sqlite-adapter.js';
import { migrateSqlite } from '../../src/db/migrations/sqlite.js';
import { SqliteTeamsRepo } from '../../src/db/repos/sqlite/teams-repo.js';
import { SqliteAgentsRepo } from '../../src/db/repos/sqlite/agents-repo.js';
import { SqliteQueriesRepo } from '../../src/db/repos/sqlite/queries-repo.js';

async function createDb() {
  const adapter = new SqliteAdapter(':memory:');
  await migrateSqlite(adapter);
  const teams = new SqliteTeamsRepo(adapter);
  const agents = new SqliteAgentsRepo(adapter);
  const queries = new SqliteQueriesRepo(adapter);
  const teamId = await teams.getOrCreateTeamId('test-team');
  const agentId = 'agent-under-test';
  await agents.upsert({
    team_id: teamId,
    id: agentId,
    name: 'agent',
    type: 'claude',
    model: 'test',
    port: 0,
    endpoint: 'http://localhost:0',
    working_directory: null,
    status: 'running',
    created_at: Date.now(),
    metadata: {},
  });
  return {
    adapter,
    teams,
    agents,
    queries,
    teamId,
    agentId,
    async close() { await adapter.close(); },
  };
}

type Ctx = Awaited<ReturnType<typeof createDb>>;
const ctxs: Ctx[] = [];

afterEach(async () => {
  while (ctxs.length > 0) {
    await ctxs.pop()!.close();
  }
});

describe('SqliteQueriesRepo.recordOutput', () => {
  it('stamps last_output_at on an in-flight (pending) query', async () => {
    const ctx = await createDb();
    ctxs.push(ctx);
    const { queries, teamId, agentId } = ctx;
    const qid = 'query_pending';
    const created = 1000;
    await queries.create(teamId, qid, agentId, 'p', created);

    const before = await queries.getByQueryIdForTeam(teamId, qid);
    expect(before?.last_output_at).toBeNull();

    await queries.recordOutput(teamId, qid, 1500);

    const after = await queries.getByQueryIdForTeam(teamId, qid);
    expect(after?.last_output_at).toBe(1500);
  });

  it('stamps last_output_at on a processing query', async () => {
    const ctx = await createDb();
    ctxs.push(ctx);
    const { queries, teamId, agentId } = ctx;
    const qid = 'query_processing';
    await queries.create(teamId, qid, agentId, 'p', 1000);
    await queries.upsert(teamId, agentId, { query_id: qid, status: 'processing', created: 1000 });

    await queries.recordOutput(teamId, qid, 2000);

    const row = await queries.getByQueryIdForTeam(teamId, qid);
    expect(row?.status).toBe('processing');
    expect(row?.last_output_at).toBe(2000);
  });

  it('overwrites last_output_at on subsequent calls (latest wins)', async () => {
    const ctx = await createDb();
    ctxs.push(ctx);
    const { queries, teamId, agentId } = ctx;
    const qid = 'query_streaming';
    await queries.create(teamId, qid, agentId, 'p', 1000);

    await queries.recordOutput(teamId, qid, 1100);
    await queries.recordOutput(teamId, qid, 1200);
    await queries.recordOutput(teamId, qid, 1300);

    const row = await queries.getByQueryIdForTeam(teamId, qid);
    expect(row?.last_output_at).toBe(1300);
  });

  it('does not touch a completed query (post-terminal writes ignored)', async () => {
    const ctx = await createDb();
    ctxs.push(ctx);
    const { queries, teamId, agentId } = ctx;
    const qid = 'query_completed';
    await queries.create(teamId, qid, agentId, 'p', 1000);
    await queries.complete(teamId, qid, 1500, { result: 'ok' });

    await queries.recordOutput(teamId, qid, 9999);

    const row = await queries.getByQueryIdForTeam(teamId, qid);
    expect(row?.status).toBe('completed');
    expect(row?.last_output_at).toBeNull();
  });

  it('does not touch a failed query', async () => {
    const ctx = await createDb();
    ctxs.push(ctx);
    const { queries, teamId, agentId } = ctx;
    const qid = 'query_failed';
    await queries.create(teamId, qid, agentId, 'p', 1000);
    await queries.markFailed(teamId, qid, 1500, 'boom');

    await queries.recordOutput(teamId, qid, 9999);

    const row = await queries.getByQueryIdForTeam(teamId, qid);
    expect(row?.status).toBe('failed');
    expect(row?.last_output_at).toBeNull();
  });

  it('does not touch an expired query', async () => {
    const ctx = await createDb();
    ctxs.push(ctx);
    const { queries, teamId, agentId } = ctx;
    const qid = 'query_expired';
    await queries.create(teamId, qid, agentId, 'p', 1000);
    const expired = await queries.expireStale(2000, ['pending', 'processing']);
    expect(expired.length).toBe(1);

    await queries.recordOutput(teamId, qid, 9999);

    const row = await queries.getByQueryIdForTeam(teamId, qid);
    expect(row?.status).toBe('expired');
    expect(row?.last_output_at).toBeNull();
  });

  it('is a silent no-op for a nonexistent query', async () => {
    const ctx = await createDb();
    ctxs.push(ctx);
    const { queries, teamId } = ctx;

    await expect(queries.recordOutput(teamId, 'no-such-query', 1000)).resolves.toBeUndefined();
  });

  it('getById and getByQueryIdForTeam round-trip last_output_at', async () => {
    const ctx = await createDb();
    ctxs.push(ctx);
    const { queries, teamId, agentId } = ctx;
    const qid = 'query_round_trip';
    await queries.create(teamId, qid, agentId, 'p', 1000);
    await queries.recordOutput(teamId, qid, 1234);

    const byId = await queries.getById(agentId, qid);
    expect(byId?.last_output_at).toBe(1234);

    const byTeam = await queries.getByQueryIdForTeam(teamId, qid);
    expect(byTeam?.last_output_at).toBe(1234);
  });
});
