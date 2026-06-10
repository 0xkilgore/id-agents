// SPDX-License-Identifier: MIT
/**
 * Integration tests for Task 7: persist manager_dispatch_id + manager_query_id
 * from /talk body (or message header) into the agent-side queries row.
 *
 * Boots a real AgentRestServer against an in-memory SQLite adapter so the
 * full HTTP → dbUpsertQuery → queries table path is exercised.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'net';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import crypto from 'node:crypto';

import { AgentRestServer } from '../../src/claude-agent-server.js';
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

const TEAM = 'query-dispatch-projection-test';

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
      const addr = server.address() as AddressInfo;
      server.close(() => resolve(addr.port));
    });
    server.on('error', reject);
  });
}

async function insertAgentRow(
  db: Awaited<ReturnType<typeof createInMemoryDb>>,
  teamId: string,
  name: string,
): Promise<string> {
  const id = `agent_${crypto.randomUUID()}`;
  await db.adapter.query(
    `INSERT INTO agents (team_id, id, name, type, model, port, status, created_at, runtime, endpoint)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [teamId, id, name, 'persistent', 'claude-opus', 24000, 'active', Date.now(), 'claude-code', null],
  );
  return id;
}

describe('Agent /talk persists manager dispatch metadata', () => {
  let db: Awaited<ReturnType<typeof createInMemoryDb>>;
  let teamId: string;
  let agentId: string;
  let agentServer: AgentRestServer;
  let agentBaseUrl: string;

  beforeAll(async () => {
    db = await createInMemoryDb();
    teamId = await db.teams.getOrCreateTeamId(TEAM);
    agentId = await insertAgentRow(db, teamId, 'dispatch-test-agent');

    agentServer = new AgentRestServer({
      agentName: 'dispatch-test-agent',
      workingDirectory: process.cwd(),
      sharedDirectory: process.cwd(),
      db: { db: db as any, teamId, agentId },
    });
    await agentServer.start(0);
    const port = ((agentServer as any).httpServer.address() as AddressInfo).port;
    agentBaseUrl = `http://127.0.0.1:${port}`;
  }, 30000);

  afterAll(async () => {
    if (agentServer) await agentServer.stop();
    await db.close();
  });

  beforeEach(async () => {
    await db.adapter.query(`DELETE FROM queries`);
  });

  it('body { dispatch_id, query_id } populates queries.manager_dispatch_id + manager_query_id', async () => {
    const res = await fetch(`${agentBaseUrl}/talk`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: 'do the work',
        from: 'scheduler',
        dispatch_id: 'phid:disp-abc123def45678ab',
        query_id: 'query_upstream_1',
      }),
    });

    expect(res.status).toBe(202);
    const data = await res.json() as { query_id: string };
    expect(data.query_id).toBeTruthy();

    // Give the pre-write a moment to land (it's already awaited in the handler,
    // but belt-and-suspenders in case of DB async flush)
    await new Promise(r => setTimeout(r, 50));

    const row = await db.queries.getById(agentId, data.query_id);
    expect(row).toBeTruthy();
    expect(row!.manager_dispatch_id).toBe('phid:disp-abc123def45678ab');
    expect(row!.manager_query_id).toBe('query_upstream_1');
  });

  it('falls back to parsing [dispatch_id: ...] from message when JSON fields are missing', async () => {
    const message = '[dispatch_id: phid:disp-abc123def45678cd]\n[query_id: query_upstream_2]\n\nthe actual body text';

    const res = await fetch(`${agentBaseUrl}/talk`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message,
        from: 'scheduler',
        // no dispatch_id, no query_id fields
      }),
    });

    expect(res.status).toBe(202);
    const data = await res.json() as { query_id: string };
    expect(data.query_id).toBeTruthy();

    await new Promise(r => setTimeout(r, 50));

    const row = await db.queries.getById(agentId, data.query_id);
    expect(row).toBeTruthy();
    expect(row!.manager_dispatch_id).toBe('phid:disp-abc123def45678cd');
    expect(row!.manager_query_id).toBe('query_upstream_2');
  });
});

// ---------------------------------------------------------------------------
// Task 8: GET /query/:id projects dispatch fields when manager_dispatch_id set.
// The manager's /query/:id handler should sidecar-look-up the dispatch reactor
// when the queries row carries a manager_dispatch_id, and merge the dispatch
// status + agent_query_id + manager_query_id into the response payload.
// ---------------------------------------------------------------------------

describe('GET /query/:id projects dispatch fields', () => {
  let db: Awaited<ReturnType<typeof createInMemoryDb>>;
  let manager: AgentManagerDb;
  let managerBaseUrl: string;
  let managerWorkDir: string;
  let defaultTeamId: string;
  let coderAgentId: string;

  async function enqueueDispatch(): Promise<{ ok: boolean; dispatch_phid: string; query_id: string }> {
    const res = await fetch(`${managerBaseUrl}/dispatch/enqueue`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Id-Team': 'default' },
      body: JSON.stringify({ from_actor: 'cane', to_agent: 'coder', message: 'hi' }),
    });
    return res.json() as Promise<{ ok: boolean; dispatch_phid: string; query_id: string }>;
  }

  beforeAll(async () => {
    db = await createInMemoryDb();
    defaultTeamId = await db.teams.getOrCreateTeamId('default');
    coderAgentId = await insertAgentRow(db, defaultTeamId, 'coder');
    // /dispatch/enqueue requires a resolvable endpoint on the target agent.
    await db.adapter.query(
      `UPDATE agents SET endpoint = ? WHERE id = ?`,
      ['http://127.0.0.1:19999', coderAgentId],
    );

    managerWorkDir = fs.mkdtempSync(path.join(os.tmpdir(), 'query-dispatch-projection-mgr-'));
    const managerPort = await findFreePort();
    manager = new AgentManagerDb(managerWorkDir, db as any);
    await manager.start(managerPort);
    managerBaseUrl = `http://127.0.0.1:${managerPort}`;
  }, 30000);

  afterAll(async () => {
    if (manager) {
      await new Promise<void>((resolve) => {
        (manager as any).httpServer?.close(() => resolve());
        setTimeout(resolve, 500);
      });
    }
    try { fs.rmSync(managerWorkDir, { recursive: true, force: true }); } catch { /* ignore */ }
    await db.close();
  });

  beforeEach(async () => {
    await db.adapter.query(`DELETE FROM queries`);
    await db.adapter.query(`DELETE FROM dispatch_scheduler_queue`);
  });

  it('includes dispatch_id, dispatch_status, agent_query_id, manager_query_id when row has manager_dispatch_id', async () => {
    const enq = await enqueueDispatch();
    expect(enq.ok).toBe(true);
    expect(enq.dispatch_phid).toMatch(/^phid:disp-/);

    const agentLocalQueryId = `agent_q_${Date.now()}_test`;
    await db.queries.upsert(defaultTeamId, coderAgentId, {
      query_id: agentLocalQueryId,
      status: 'pending',
      prompt: 'hi',
      created: Date.now(),
      manager_dispatch_id: enq.dispatch_phid,
      manager_query_id: enq.query_id,
    });

    const res = await fetch(`${managerBaseUrl}/query/${agentLocalQueryId}`, {
      headers: { 'X-Id-Team': 'default' },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as {
      query_id: string;
      status: string;
      dispatch_id?: string;
      dispatch_status?: string;
      agent_query_id?: string | null;
      manager_query_id?: string | null;
    };
    expect(body.query_id).toBe(agentLocalQueryId);
    expect(body.dispatch_id).toBe(enq.dispatch_phid);
    expect(body.manager_query_id).toBe(enq.query_id);
    // Just enqueued — not accepted yet — dispatch_status should be 'queued'.
    expect(['queued', 'in_flight']).toContain(body.dispatch_status!);
  });

  it('omits dispatch fields when row has no manager_dispatch_id (direct /talk)', async () => {
    const agentLocalQueryId = `agent_q_${Date.now()}_direct`;
    await db.queries.upsert(defaultTeamId, coderAgentId, {
      query_id: agentLocalQueryId,
      status: 'pending',
      prompt: 'hi',
      created: Date.now(),
      // no manager_dispatch_id, no manager_query_id
    });

    const res = await fetch(`${managerBaseUrl}/query/${agentLocalQueryId}`, {
      headers: { 'X-Id-Team': 'default' },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.query_id).toBe(agentLocalQueryId);
    expect(body.dispatch_id).toBeUndefined();
    expect(body.dispatch_status).toBeUndefined();
    expect(body.agent_query_id).toBeUndefined();
  });

  it('omits dispatch fields when manager_dispatch_id refers to a phid the reactor cannot find', async () => {
    const agentLocalQueryId = `agent_q_${Date.now()}_stale`;
    await db.queries.upsert(defaultTeamId, coderAgentId, {
      query_id: agentLocalQueryId,
      status: 'pending',
      prompt: 'hi',
      created: Date.now(),
      manager_dispatch_id: 'phid:disp-doesnotexist0000',
      manager_query_id: 'query_upstream_orphan',
    });

    const res = await fetch(`${managerBaseUrl}/query/${agentLocalQueryId}`, {
      headers: { 'X-Id-Team': 'default' },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.dispatch_id).toBeUndefined();
    expect(body.dispatch_status).toBeUndefined();
  });

  it('reflects in_flight after acceptDispatchStart flips the dispatch row', async () => {
    const enq = await enqueueDispatch();
    expect(enq.ok).toBe(true);

    const agentLocalQueryId = `agent_q_${Date.now()}_inflight`;
    await db.queries.upsert(defaultTeamId, coderAgentId, {
      query_id: agentLocalQueryId,
      status: 'pending',
      prompt: 'hi',
      created: Date.now(),
      manager_dispatch_id: enq.dispatch_phid,
      manager_query_id: enq.query_id,
    });

    // Flip dispatch to in_flight via the canonical accept route.
    const accept = await fetch(`${managerBaseUrl}/dispatches/${enq.dispatch_phid}/accept`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Id-Team': 'default' },
      body: JSON.stringify({ agent_query_id: agentLocalQueryId }),
    });
    expect(accept.status).toBe(200);

    const res = await fetch(`${managerBaseUrl}/query/${agentLocalQueryId}`, {
      headers: { 'X-Id-Team': 'default' },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { dispatch_status?: string; agent_query_id?: string | null };
    expect(body.dispatch_status).toBe('in_flight');
    expect(body.agent_query_id).toBe(agentLocalQueryId);
  });
});
