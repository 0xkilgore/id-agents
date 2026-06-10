// SPDX-License-Identifier: MIT
/**
 * Integration tests for Task 11 of the dispatch-canonical plan:
 *   GET /dispatches/reconcile — diagnostic read surface listing dispatches
 *   whose canonical lifecycle drifted from the agent-side queries projection.
 *
 * Two diagnostics:
 *   1. stuck_queued: dispatch_scheduler_queue.status='queued' AND there is a
 *      queries row joined via queries.manager_dispatch_id whose status is
 *      'processing' or 'completed'. The scheduler never observed the start,
 *      yet the agent already advanced — drift the operator should see.
 *
 * Empty arrays for a healthy fleet; consistent JSON shape regardless.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import crypto from 'node:crypto';

import { AgentManagerDb } from '../../src/agent-manager-db.js';
import { SqliteAdapter } from '../../src/db/sqlite-adapter.js';
import { migrateSqlite } from '../../src/db/migrations/sqlite.js';
import { SqliteTeamsRepo } from '../../src/db/repos/sqlite/teams-repo.js';
import { SqliteAgentsRepo } from '../../src/db/repos/sqlite/agents-repo.js';
import { SqliteQueriesRepo } from '../../src/db/repos/sqlite/queries-repo.js';
import { SqliteNewsRepo } from '../../src/db/repos/sqlite/news-repo.js';
import { SqliteSchedulesRepo } from '../../src/db/repos/sqlite/schedules-repo.js';
import { SqliteTasksRepo } from '../../src/db/repos/sqlite/tasks-repo.js';
import { SqliteEventsRepo } from '../../src/db/repos/sqlite/events-repo.js';
import { SqliteSubscriptionsRepo } from '../../src/db/repos/sqlite/subscriptions-repo.js';
import { SqliteCheckinsRepo } from '../../src/db/repos/sqlite/checkins-repo.js';

// /dispatch/enqueue hard-codes the 'default' team and the agent-side
// queries.upsert in this suite writes against that same team id, so the
// reconcile read (gated by teamContextMiddleware) must resolve to the
// same team. Admin-bypassing the middleware would silently target a
// different team and the join would always be empty.
const TEAM = 'default';

async function createInMemoryDb() {
  const adapter = new SqliteAdapter(':memory:');
  await migrateSqlite(adapter);
  return {
    adapter,
    teams: new SqliteTeamsRepo(adapter),
    agents: new SqliteAgentsRepo(adapter),
    queries: new SqliteQueriesRepo(adapter),
    news: new SqliteNewsRepo(adapter),
    schedules: new SqliteSchedulesRepo(adapter),
    tasks: new SqliteTasksRepo(adapter),
    events: new SqliteEventsRepo(adapter),
    subscriptions: new SqliteSubscriptionsRepo(adapter),
    checkins: new SqliteCheckinsRepo(adapter),
    async close() { await adapter.close(); },
  };
}

async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      server.close(() => resolve(addr.port));
    });
    server.on('error', reject);
  });
}

async function stopManager(manager: AgentManagerDb): Promise<void> {
  await new Promise<void>((resolve) => {
    (manager as any).httpServer?.close(() => resolve());
    setTimeout(resolve, 500);
  });
}

async function insertAgentDirect(
  db: Awaited<ReturnType<typeof createInMemoryDb>>,
  teamId: string,
  name: string,
  endpoint?: string,
): Promise<string> {
  const id = `agent_${crypto.randomUUID()}`;
  await db.adapter.query(
    `INSERT INTO agents (team_id, id, name, type, model, port, endpoint, status, created_at, runtime)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [teamId, id, name, 'persistent', 'claude-opus', 24000, endpoint ?? null, 'active', Date.now(), 'claude-code'],
  );
  return id;
}

describe('GET /dispatches/reconcile', () => {
  let manager: AgentManagerDb;
  let db: Awaited<ReturnType<typeof createInMemoryDb>>;
  let baseUrl: string;
  let workDir: string;
  let defaultTeamId: string;
  let coderAgentId: string;

  async function enqueueDispatch(): Promise<{ ok: boolean; dispatch_phid: string; query_id: string }> {
    const res = await fetch(`${baseUrl}/dispatch/enqueue`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Id-Team': TEAM },
      body: JSON.stringify({ from_actor: 'cane', to_agent: 'coder', message: 'hi' }),
    });
    return res.json() as Promise<{ ok: boolean; dispatch_phid: string; query_id: string }>;
  }

  beforeAll(async () => {
    const port = await findFreePort();
    baseUrl = `http://127.0.0.1:${port}`;
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-reconcile-test-'));
    db = await createInMemoryDb();
    manager = new AgentManagerDb(workDir, db as any);
    await manager.start(port);

    defaultTeamId = await db.teams.getOrCreateTeamId('default');
    coderAgentId = await insertAgentDirect(db, defaultTeamId, 'coder', 'http://127.0.0.1:19999');
  }, 30000);

  afterAll(async () => {
    if (manager) await stopManager(manager);
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  beforeEach(async () => {
    await db.adapter.query(`DELETE FROM dispatch_scheduler_queue`);
    await db.adapter.query(`DELETE FROM queries`);
  });

  it('returns empty stuck_queued array for a healthy fleet', async () => {
    const res = await fetch(`${baseUrl}/dispatches/reconcile`, {
      headers: { 'X-Id-Team': TEAM },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; stuck_queued: unknown[] };
    expect(body.ok).toBe(true);
    expect(body.stuck_queued).toEqual([]);
  });

  it('lists dispatches stuck in queued where an agent query is already completed', async () => {
    const enq = await enqueueDispatch();
    expect(enq.ok).toBe(true);

    // Simulate the drift: agent processed + completed a queries row that
    // points back to the still-queued dispatch.
    const agentLocalQueryId = `agent_q_${Date.now()}_completed`;
    await db.queries.upsert(defaultTeamId, coderAgentId, {
      query_id: agentLocalQueryId,
      status: 'completed',
      prompt: 'hi',
      created: Date.now(),
      completed: Date.now(),
      manager_dispatch_id: enq.dispatch_phid,
      manager_query_id: enq.query_id,
    });

    const res = await fetch(`${baseUrl}/dispatches/reconcile`, {
      headers: { 'X-Id-Team': TEAM },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as {
      ok: boolean;
      stuck_queued: Array<{
        dispatch_id: string;
        agent_query_status: string;
        query_id: string;
      }>;
    };
    expect(body.ok).toBe(true);
    expect(body.stuck_queued).toHaveLength(1);
    expect(body.stuck_queued[0].dispatch_id).toBe(enq.dispatch_phid);
    expect(body.stuck_queued[0].agent_query_status).toBe('completed');
    expect(body.stuck_queued[0].query_id).toBe(agentLocalQueryId);
  });

  it('lists dispatches stuck in queued where an agent query is processing', async () => {
    const enq = await enqueueDispatch();

    const agentLocalQueryId = `agent_q_${Date.now()}_processing`;
    await db.queries.upsert(defaultTeamId, coderAgentId, {
      query_id: agentLocalQueryId,
      status: 'processing',
      prompt: 'hi',
      created: Date.now(),
      manager_dispatch_id: enq.dispatch_phid,
      manager_query_id: enq.query_id,
    });

    const res = await fetch(`${baseUrl}/dispatches/reconcile`, {
      headers: { 'X-Id-Team': TEAM },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as {
      stuck_queued: Array<{ agent_query_status: string }>;
    };
    expect(body.stuck_queued).toHaveLength(1);
    expect(body.stuck_queued[0].agent_query_status).toBe('processing');
  });

  it('does NOT list dispatches that already moved to in_flight (no drift)', async () => {
    const enq = await enqueueDispatch();

    const agentLocalQueryId = `agent_q_${Date.now()}_inflight`;
    await db.queries.upsert(defaultTeamId, coderAgentId, {
      query_id: agentLocalQueryId,
      status: 'processing',
      prompt: 'hi',
      created: Date.now(),
      manager_dispatch_id: enq.dispatch_phid,
      manager_query_id: enq.query_id,
    });
    // flip dispatch via canonical accept route — now lifecycle is in sync.
    const accept = await fetch(`${baseUrl}/dispatches/${enq.dispatch_phid}/accept`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Id-Team': TEAM },
      body: JSON.stringify({ agent_query_id: agentLocalQueryId }),
    });
    expect(accept.status).toBe(200);

    const res = await fetch(`${baseUrl}/dispatches/reconcile`, {
      headers: { 'X-Id-Team': TEAM },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { stuck_queued: unknown[] };
    expect(body.stuck_queued).toEqual([]);
  });

  it('does NOT list queued dispatches whose agent queries are still pending (legitimate queue)', async () => {
    const enq = await enqueueDispatch();

    const agentLocalQueryId = `agent_q_${Date.now()}_pending`;
    await db.queries.upsert(defaultTeamId, coderAgentId, {
      query_id: agentLocalQueryId,
      status: 'pending',
      prompt: 'hi',
      created: Date.now(),
      manager_dispatch_id: enq.dispatch_phid,
      manager_query_id: enq.query_id,
    });

    const res = await fetch(`${baseUrl}/dispatches/reconcile`, {
      headers: { 'X-Id-Team': TEAM },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { stuck_queued: unknown[] };
    expect(body.stuck_queued).toEqual([]);
  });
});
