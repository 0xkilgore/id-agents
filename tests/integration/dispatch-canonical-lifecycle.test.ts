// SPDX-License-Identifier: MIT
/**
 * Integration tests for POST /dispatches/:dispatch_id/accept and /in-flight alias.
 * Task 5 of the dispatch-canonical plan.
 *
 * Boot scaffold mirrors checkin-task-autoclose.test.ts verbatim.
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

const TEAM = 'dispatch-canonical-lifecycle-test';

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

describe('POST /dispatches/:dispatch_id/accept', () => {
  let manager: AgentManagerDb;
  let db: Awaited<ReturnType<typeof createInMemoryDb>>;
  let baseUrl: string;
  let workDir: string;

  // The enqueue route uses getOrCreateTeamId('default') and looks up agents by
  // name in that team, so we insert a 'coder' agent in 'default'.
  async function enqueueDispatch(): Promise<{ ok: boolean; dispatch_phid: string }> {
    const res = await fetch(`${baseUrl}/dispatch/enqueue`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Id-Team': TEAM },
      body: JSON.stringify({ from_actor: 'cane', to_agent: 'coder', message: 'hi' }),
    });
    return res.json() as Promise<{ ok: boolean; dispatch_phid: string }>;
  }

  beforeAll(async () => {
    const port = await findFreePort();
    baseUrl = `http://127.0.0.1:${port}`;
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-canonical-lifecycle-test-'));
    db = await createInMemoryDb();
    manager = new AgentManagerDb(workDir, db as any);
    await manager.start(port);

    // enqueue route uses hardcoded 'default' team + agent lookup by name + endpoint required
    const defaultTeamId = await db.teams.getOrCreateTeamId('default');
    await insertAgentDirect(db, defaultTeamId, 'coder', 'http://127.0.0.1:19999');
  }, 30000);

  afterAll(async () => {
    if (manager) await stopManager(manager);
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  beforeEach(async () => {
    await db.adapter.query(`DELETE FROM dispatch_scheduler_queue`);
  });

  it('flips queued -> in_flight when agent_query_id is supplied', async () => {
    const enq = await enqueueDispatch();
    expect(enq.ok).toBe(true);

    const accept = await fetch(`${baseUrl}/dispatches/${enq.dispatch_phid}/accept`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Id-Team': TEAM },
      body: JSON.stringify({ agent_query_id: 'agent-q-1' }),
    });
    expect(accept.status).toBe(200);
    const body = await accept.json() as { state: string; agent_query_id: string };
    expect(body.state).toBe('in_flight');
    expect(body.agent_query_id).toBe('agent-q-1');
  });

  it('rejects empty agent_query_id with 400', async () => {
    const enq = await enqueueDispatch();
    expect(enq.ok).toBe(true);

    const res = await fetch(`${baseUrl}/dispatches/${enq.dispatch_phid}/accept`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Id-Team': TEAM },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it('returns 409 on different agent_query_id replay', async () => {
    const enq = await enqueueDispatch();
    expect(enq.ok).toBe(true);

    await fetch(`${baseUrl}/dispatches/${enq.dispatch_phid}/accept`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Id-Team': TEAM },
      body: JSON.stringify({ agent_query_id: 'agent-q-1' }),
    });

    const conflict = await fetch(`${baseUrl}/dispatches/${enq.dispatch_phid}/accept`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Id-Team': TEAM },
      body: JSON.stringify({ agent_query_id: 'agent-q-2' }),
    });
    expect(conflict.status).toBe(409);
  });

  it('/in-flight is a strict alias requiring agent_query_id', async () => {
    const enq = await enqueueDispatch();
    expect(enq.ok).toBe(true);

    const inFlight = await fetch(`${baseUrl}/dispatches/${enq.dispatch_phid}/in-flight`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Id-Team': TEAM },
      body: JSON.stringify({ agent_query_id: 'agent-q-1' }),
    });
    expect(inFlight.status).toBe(200);
    const body = await inFlight.json() as { state: string };
    expect(body.state).toBe('in_flight');
  });
});
