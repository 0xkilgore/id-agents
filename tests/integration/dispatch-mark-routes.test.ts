// SPDX-License-Identifier: MIT
/**
 * Integration tests for POST /dispatches/:dispatch_id/markFailed and
 * POST /dispatches/:dispatch_id/markBounced.
 *
 * Task 12 of the dispatch-canonical plan: HTTP wrappers around
 * SchedulerHandle.client.markFailed / markBounced so Cane (and any
 * off-process /talk caller) can close the dispatch loop on delivery
 * failure: hard 4xx → markFailed agent_error, transient (ConnErr / 5xx)
 * → markBounced transport.
 *
 * Boot scaffold mirrors dispatch-canonical-lifecycle.test.ts verbatim.
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

const TEAM = 'dispatch-mark-routes-test';

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

describe('POST /dispatches/:dispatch_id/markFailed and /markBounced', () => {
  let manager: AgentManagerDb;
  let db: Awaited<ReturnType<typeof createInMemoryDb>>;
  let baseUrl: string;
  let workDir: string;

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
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-mark-routes-test-'));
    db = await createInMemoryDb();
    manager = new AgentManagerDb(workDir, db as any);
    await manager.start(port);

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

  it('markFailed: transitions queued -> failed with failure_kind + detail set', async () => {
    const enq = await enqueueDispatch();
    expect(enq.ok).toBe(true);

    const res = await fetch(`${baseUrl}/dispatches/${enq.dispatch_phid}/markFailed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Id-Team': TEAM },
      body: JSON.stringify({ failure_kind: 'agent_error', detail: 'agent /talk returned 422' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as {
      ok: boolean;
      dispatch: { status: string; failure_kind: string; failure_detail: string };
    };
    expect(body.ok).toBe(true);
    expect(body.dispatch.status).toBe('failed');
    expect(body.dispatch.failure_kind).toBe('agent_error');
    expect(body.dispatch.failure_detail).toBe('agent /talk returned 422');
  });

  it('markBounced: transitions queued -> bounced and appends to bounce_history', async () => {
    const enq = await enqueueDispatch();
    expect(enq.ok).toBe(true);

    const res = await fetch(`${baseUrl}/dispatches/${enq.dispatch_phid}/markBounced`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Id-Team': TEAM },
      body: JSON.stringify({ kind: 'transport', message: 'talk-to coder failed: ConnectionError' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as {
      ok: boolean;
      dispatch: { status: string; bounce_history: Array<{ kind: string; message: string }> };
    };
    expect(body.ok).toBe(true);
    expect(body.dispatch.status).toBe('bounced');
    expect(body.dispatch.bounce_history).toHaveLength(1);
    expect(body.dispatch.bounce_history[0].kind).toBe('transport');
    expect(body.dispatch.bounce_history[0].message).toBe('talk-to coder failed: ConnectionError');
  });

  it('markFailed: returns 409 on a done dispatch (terminal conflict)', async () => {
    const enq = await enqueueDispatch();
    expect(enq.ok).toBe(true);

    // First mark failed (queued is non-terminal so this succeeds).
    const first = await fetch(`${baseUrl}/dispatches/${enq.dispatch_phid}/markFailed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Id-Team': TEAM },
      body: JSON.stringify({ failure_kind: 'agent_error', detail: 'first' }),
    });
    expect(first.status).toBe(200);

    // The reactor only rejects markFailed from `done` or `cancelled`,
    // so we drive the queue row to `done` directly and then expect 409.
    await db.adapter.query(
      `UPDATE dispatch_scheduler_queue SET status = 'done' WHERE dispatch_phid = ?`,
      [enq.dispatch_phid],
    );
    const conflict = await fetch(`${baseUrl}/dispatches/${enq.dispatch_phid}/markFailed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Id-Team': TEAM },
      body: JSON.stringify({ failure_kind: 'agent_error', detail: 'after done' }),
    });
    expect(conflict.status).toBe(409);
  });

  it('markFailed: returns 404 for unknown phid', async () => {
    const res = await fetch(`${baseUrl}/dispatches/phid:disp-doesnotexist/markFailed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Id-Team': TEAM },
      body: JSON.stringify({ failure_kind: 'agent_error', detail: 'nope' }),
    });
    expect(res.status).toBe(404);
  });

  it('markFailed: returns 400 when failure_kind is missing', async () => {
    const enq = await enqueueDispatch();
    expect(enq.ok).toBe(true);
    const res = await fetch(`${baseUrl}/dispatches/${enq.dispatch_phid}/markFailed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Id-Team': TEAM },
      body: JSON.stringify({ detail: 'missing kind' }),
    });
    expect(res.status).toBe(400);
  });
});
