// SPDX-License-Identifier: MIT

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { SqliteAdapter } from '../../src/db/sqlite-adapter.js';
import { migrateSqlite } from '../../src/db/migrations/sqlite.js';
import { SqliteTeamsRepo } from '../../src/db/repos/sqlite/teams-repo.js';
import { SqliteAgentsRepo } from '../../src/db/repos/sqlite/agents-repo.js';
import { SqliteQueriesRepo } from '../../src/db/repos/sqlite/queries-repo.js';
import { SqliteNewsRepo } from '../../src/db/repos/sqlite/news-repo.js';

// ---------------------------------------------------------------------------
// Helpers — fresh in-memory database for each test suite
// ---------------------------------------------------------------------------

async function createDb() {
  const adapter = new SqliteAdapter(':memory:');
  await migrateSqlite(adapter);
  return {
    adapter,
    teams: new SqliteTeamsRepo(adapter),
    agents: new SqliteAgentsRepo(adapter),
    queries: new SqliteQueriesRepo(adapter),
    news: new SqliteNewsRepo(adapter),
  };
}

/** Convenience: create a team and return its id */
async function seedTeam(teams: SqliteTeamsRepo, name = 'test-team'): Promise<string> {
  return teams.getOrCreateTeamId(name);
}

/** Convenience: create a team + agent, return { teamId, agentId } */
async function seedAgent(
  db: Awaited<ReturnType<typeof createDb>>,
  overrides: Partial<{
    name: string;
    type: string;
    model: string;
    status: string;
    metadata: Record<string, unknown>;
    token_id: string;
  }> = {},
) {
  const teamId = await seedTeam(db.teams);
  const agentId = randomUUID();
  await db.agents.create({
    team_id: teamId,
    id: agentId,
    name: overrides.name ?? 'test-agent',
    type: overrides.type ?? 'claude',
    model: overrides.model ?? 'claude-sonnet-4-20250514',
    status: overrides.status ?? 'running',
    created_at: Date.now(),
    metadata: overrides.metadata ?? null,
    token_id: overrides.token_id ?? null,
  });
  return { teamId, agentId };
}

// ===========================================================================
// TeamsRepository
// ===========================================================================

describe('TeamsRepository', () => {
  let db: Awaited<ReturnType<typeof createDb>>;

  beforeEach(async () => {
    db = await createDb();
  });

  it('getOrCreateTeamId creates team and returns UUID string (36 chars with dashes)', async () => {
    const id = await db.teams.getOrCreateTeamId('my-team');
    assert.equal(typeof id, 'string');
    assert.equal(id.length, 36);
    assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it('calling getOrCreateTeamId again with same name returns same ID', async () => {
    const id1 = await db.teams.getOrCreateTeamId('dup-team');
    const id2 = await db.teams.getOrCreateTeamId('dup-team');
    assert.equal(id1, id2);
  });

  it('getConfig returns a JS object (not string), defaults to {}', async () => {
    const teamId = await db.teams.getOrCreateTeamId('cfg-team');
    const config = await db.teams.getConfig(teamId);
    assert.equal(typeof config, 'object');
    assert.ok(!Array.isArray(config));
    assert.deepStrictEqual(config, {});
  });

  it('setRegistrarAddress updates config.registrar_address correctly', async () => {
    const teamId = await db.teams.getOrCreateTeamId('reg-team');
    await db.teams.setRegistrarAddress(teamId, '0xABC123');
    const config = await db.teams.getConfig(teamId);
    assert.equal(config.registrar_address, '0xABC123');
  });

  it('setDefaultRegistry updates config.default_chain_id and default_registry_address', async () => {
    const teamId = await db.teams.getOrCreateTeamId('reg-team2');
    await db.teams.setDefaultRegistry(teamId, '8453', '0xDEF456');
    const config = await db.teams.getConfig(teamId);
    assert.equal(config.default_chain_id, '8453');
    assert.equal(config.default_registry_address, '0xDEF456');
  });

  it('deleteTeam removes team', async () => {
    const teamId = await db.teams.getOrCreateTeamId('del-team');
    await db.teams.deleteTeam(teamId);
    const team = await db.teams.getTeam(teamId);
    assert.equal(team, null);
  });
});

// ===========================================================================
// AgentsRepository
// ===========================================================================

describe('AgentsRepository', () => {
  let db: Awaited<ReturnType<typeof createDb>>;

  beforeEach(async () => {
    db = await createDb();
  });

  it('create + getById roundtrip', async () => {
    const { teamId, agentId } = await seedAgent(db, {
      name: 'roundtrip-agent',
      type: 'claude',
      model: 'claude-sonnet-4-20250514',
      status: 'running',
    });

    const agent = await db.agents.getById(teamId, agentId);
    assert.ok(agent);
    assert.equal(agent.id, agentId);
    assert.equal(agent.team_id, teamId);
    assert.equal(agent.name, 'roundtrip-agent');
    assert.equal(agent.type, 'claude');
    assert.equal(agent.model, 'claude-sonnet-4-20250514');
    assert.equal(agent.status, 'running');
  });

  it('getByName matches by metadata alias', async () => {
    const { teamId } = await seedAgent(db, {
      name: 'some-internal-name',
      metadata: { alias: 'max' },
    });

    const agent = await db.agents.getByName(teamId, 'max');
    assert.ok(agent);
    assert.equal((agent.metadata as Record<string, unknown>)?.alias, 'max');
  });

  it('updateMetadata persists and can be read back', async () => {
    const { teamId, agentId } = await seedAgent(db);
    await db.agents.updateMetadata(teamId, agentId, { skill: 'coding', level: 5 });

    const agent = await db.agents.getById(teamId, agentId);
    assert.ok(agent);
    assert.equal(typeof agent.metadata, 'object');
    assert.equal((agent.metadata as Record<string, unknown>).skill, 'coding');
    assert.equal((agent.metadata as Record<string, unknown>).level, 5);
  });

  it('updateStatus changes status', async () => {
    const { teamId, agentId } = await seedAgent(db, { status: 'running' });
    await db.agents.updateStatus(teamId, agentId, 'stopped');

    const agent = await db.agents.getById(teamId, agentId);
    assert.ok(agent);
    assert.equal(agent.status, 'stopped');
  });

  it('list returns only non-deleted agents', async () => {
    const teamId = await seedTeam(db.teams, 'list-team');

    // Create two agents
    const id1 = randomUUID();
    const id2 = randomUUID();
    const now = Date.now();
    await db.agents.create({
      team_id: teamId, id: id1, name: 'a1', type: 'claude',
      model: 'sonnet', status: 'running', created_at: now,
    });
    await db.agents.create({
      team_id: teamId, id: id2, name: 'a2', type: 'claude',
      model: 'sonnet', status: 'running', created_at: now + 1,
    });

    // Soft-delete the first by directly updating
    await db.agents.updateStatus(teamId, id1, 'stopped');
    await db.adapter.query(
      'UPDATE agents SET deleted_at = ? WHERE team_id = ? AND id = ?',
      [Date.now(), teamId, id1],
    );

    const agents = await db.agents.list(teamId);
    assert.equal(agents.length, 1);
    assert.equal(agents[0].id, id2);
  });

  it('count returns string number', async () => {
    const { teamId } = await seedAgent(db);
    const count = await db.agents.count(teamId);
    assert.equal(typeof count, 'string');
    assert.equal(count, '1');
  });

  it('softDelete sets deleted_at, agent excluded from list after soft delete', async () => {
    const teamId = await seedTeam(db.teams, 'soft-del-team');
    const id1 = randomUUID();
    const id2 = randomUUID();
    const now = Date.now();

    await db.agents.create({
      team_id: teamId, id: id1, name: 'dup',
      type: 'virtual', model: 'ext', status: 'running', created_at: now,
    });
    await db.agents.create({
      team_id: teamId, id: id2, name: 'dup',
      type: 'virtual', model: 'ext', status: 'running', created_at: now + 1,
    });

    // Soft-delete agents named "dup" except id2
    await db.agents.softDelete(teamId, 'dup', id2, Date.now());

    const agents = await db.agents.list(teamId);
    assert.equal(agents.length, 1);
    assert.equal(agents[0].id, id2);
  });

  it('deleteAgent removes agent completely', async () => {
    const { teamId, agentId } = await seedAgent(db);
    await db.agents.deleteAgent(teamId, agentId);

    const agent = await db.agents.getById(teamId, agentId);
    assert.equal(agent, null);

    // Also should not be in raw table
    const { rows } = await db.adapter.query<{ id: string }>(
      'SELECT id FROM agents WHERE team_id = ? AND id = ?',
      [teamId, agentId],
    );
    assert.equal(rows.length, 0);
  });
});

// ===========================================================================
// QueriesRepository
// ===========================================================================

describe('QueriesRepository', () => {
  let db: Awaited<ReturnType<typeof createDb>>;

  beforeEach(async () => {
    db = await createDb();
  });

  it('create + getPending roundtrip', async () => {
    const { teamId, agentId } = await seedAgent(db);
    const queryId = randomUUID();
    const now = Date.now();

    await db.queries.create(teamId, queryId, agentId, 'Hello?', now);

    const pending = await db.queries.getPending(teamId, agentId);
    assert.ok(pending.length >= 1);
    const q = pending.find((p) => p.query_id === queryId);
    assert.ok(q);
    assert.equal(q.status, 'pending');
    assert.equal(q.prompt, 'Hello?');
  });

  it('upsert creates then updates same record', async () => {
    const { teamId, agentId } = await seedAgent(db);
    const queryId = randomUUID();
    const now = Date.now();

    // Insert via upsert
    await db.queries.upsert(teamId, agentId, {
      query_id: queryId,
      status: 'pending',
      prompt: 'first',
      created: now,
    });

    let row = await db.queries.getById(teamId, agentId, queryId);
    assert.ok(row);
    assert.equal(row.status, 'pending');

    // Update via upsert
    await db.queries.upsert(teamId, agentId, {
      query_id: queryId,
      status: 'processing',
      created: now,
    });

    row = await db.queries.getById(teamId, agentId, queryId);
    assert.ok(row);
    assert.equal(row.status, 'processing');
  });

  it('complete sets status and result', async () => {
    const { teamId, agentId } = await seedAgent(db);
    const queryId = randomUUID();
    const now = Date.now();

    await db.queries.create(teamId, queryId, agentId, 'Work', now);
    await db.queries.complete(teamId, queryId, now + 1000, { answer: 42 });

    const row = await db.queries.getById(teamId, agentId, queryId);
    assert.ok(row);
    assert.equal(row.status, 'completed');
    assert.deepStrictEqual(row.result, { answer: 42 });
    assert.equal(row.completed, now + 1000);
  });

  it('cancel marks pending as cancelled, returns cancelled query_ids', async () => {
    const { teamId, agentId } = await seedAgent(db);
    const qid1 = randomUUID();
    const qid2 = randomUUID();
    const now = Date.now();

    await db.queries.create(teamId, qid1, agentId, 'A', now);
    await db.queries.create(teamId, qid2, agentId, 'B', now + 1);

    const cancelled = await db.queries.cancel(teamId, agentId, now + 5000);

    assert.ok(Array.isArray(cancelled));
    assert.equal(cancelled.length, 2);
    assert.ok(cancelled.includes(qid1));
    assert.ok(cancelled.includes(qid2));

    // Verify they are actually cancelled
    const pending = await db.queries.getPending(teamId, agentId);
    assert.equal(pending.length, 0);
  });
});

// ===========================================================================
// NewsRepository
// ===========================================================================

describe('NewsRepository', () => {
  let db: Awaited<ReturnType<typeof createDb>>;

  beforeEach(async () => {
    db = await createDb();
  });

  it('add + poll roundtrip', async () => {
    const { teamId, agentId } = await seedAgent(db);
    const ts = Date.now();

    await db.news.add(teamId, agentId, {
      timestamp: ts,
      type: 'message',
      message: 'hello world',
      data: { foo: 'bar' },
    });

    const items = await db.news.poll(teamId, agentId, ts - 1);
    assert.ok(items.length >= 1);
    const item = items[0];
    assert.equal(item.type, 'message');
    assert.equal(item.message, 'hello world');
    assert.deepStrictEqual(item.data, { foo: 'bar' });
  });

  it('poll filters by timestamp (only items after since)', async () => {
    const { teamId, agentId } = await seedAgent(db);

    await db.news.add(teamId, agentId, { timestamp: 1000, type: 'old', message: 'old' });
    await db.news.add(teamId, agentId, { timestamp: 2000, type: 'new', message: 'new' });

    const items = await db.news.poll(teamId, agentId, 1500);
    assert.equal(items.length, 1);
    assert.equal(items[0].type, 'new');
  });

  it('poll filters by queryId', async () => {
    const { teamId, agentId } = await seedAgent(db);
    const qid = randomUUID();

    await db.news.add(teamId, agentId, { timestamp: 1000, type: 'a', query_id: qid });
    await db.news.add(teamId, agentId, { timestamp: 1001, type: 'b', query_id: 'other' });

    const items = await db.news.poll(teamId, agentId, 0, { queryId: qid });
    assert.equal(items.length, 1);
    assert.equal(items[0].type, 'a');
  });

  it('deleteArchived removes old items only', async () => {
    const { teamId, agentId } = await seedAgent(db);

    await db.news.add(teamId, agentId, { timestamp: 1000, type: 'old' });
    await db.news.add(teamId, agentId, { timestamp: 3000, type: 'new' });

    await db.news.deleteArchived(teamId, 2000);

    const all = await db.news.poll(teamId, agentId, 0);
    assert.equal(all.length, 1);
    assert.equal(all[0].type, 'new');
  });
});
