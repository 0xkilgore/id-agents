// SPDX-License-Identifier: MIT
/**
 * R.2 integration tests for POST /agent-done authentication.
 *
 * Acceptance:
 *   1. /agent-done requires an auth token / trusted-local mechanism.
 *   2. Valid auth + exact dispatch_id/query_id match succeeds (200).
 *   3. Valid auth + mismatched dispatch_id/query_id returns 409, no mutation.
 *   4. Missing/invalid auth returns 401/403, no mutation.
 *
 * A shared token (DISPATCH_DONE_TOKEN) is configured for this suite so the
 * loopback-only test harness can still exercise the missing/invalid-auth paths
 * (otherwise every fetch from 127.0.0.1 would be trusted-local and pass).
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

const TEAM = 'agent-done-auth-test';
const TOKEN = 'test-dispatch-done-token';

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

describe('POST /agent-done authentication (R.2)', () => {
  let manager: AgentManagerDb;
  let db: Awaited<ReturnType<typeof createInMemoryDb>>;
  let baseUrl: string;
  let workDir: string;
  let prevToken: string | undefined;
  let prevSchedulerEnabled: string | undefined;

  async function enqueueDispatch(): Promise<{ ok: boolean; dispatch_phid: string; query_id: string }> {
    const res = await fetch(`${baseUrl}/dispatch/enqueue`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Id-Team': TEAM },
      body: JSON.stringify({ from_actor: 'cane', to_agent: 'coder', message: 'hi' }),
    });
    return res.json() as Promise<{ ok: boolean; dispatch_phid: string; query_id: string }>;
  }

  async function statusOf(phid: string): Promise<string | null> {
    const doc = await (manager as any).dispatchScheduler.reactor.getByPhid(phid);
    return doc ? doc.status : null;
  }

  beforeAll(async () => {
    prevToken = process.env.DISPATCH_DONE_TOKEN;
    prevSchedulerEnabled = process.env.DISPATCH_SCHEDULER_ENABLED;
    process.env.DISPATCH_DONE_TOKEN = TOKEN;
    process.env.DISPATCH_SCHEDULER_ENABLED = 'false';

    const port = await findFreePort();
    baseUrl = `http://127.0.0.1:${port}`;
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-done-auth-test-'));
    db = await createInMemoryDb();
    manager = new AgentManagerDb(workDir, db as any);
    await manager.start(port);

    const defaultTeamId = await db.teams.getOrCreateTeamId('default');
    await insertAgentDirect(db, defaultTeamId, 'coder', 'http://127.0.0.1:19999');
  }, 30000);

  afterAll(async () => {
    if (manager) await stopManager(manager);
    if (prevToken === undefined) delete process.env.DISPATCH_DONE_TOKEN;
    else process.env.DISPATCH_DONE_TOKEN = prevToken;
    if (prevSchedulerEnabled === undefined) delete process.env.DISPATCH_SCHEDULER_ENABLED;
    else process.env.DISPATCH_SCHEDULER_ENABLED = prevSchedulerEnabled;
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  beforeEach(async () => {
    await db.adapter.query(`DELETE FROM dispatch_scheduler_queue`);
  });

  it('returns 401 and does not mutate the dispatch when the token is missing', async () => {
    const enq = await enqueueDispatch();
    const before = await statusOf(enq.dispatch_phid);

    const res = await fetch(`${baseUrl}/agent-done`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Id-Team': TEAM },
      body: JSON.stringify({ dispatch_id: enq.dispatch_phid, query_id: enq.query_id, success: true }),
    });

    expect(res.status).toBe(401);
    const body = await res.json() as { ok: boolean };
    expect(body.ok).toBe(false);
    expect(await statusOf(enq.dispatch_phid)).toBe(before); // unchanged
  });

  it('returns 403 and does not mutate the dispatch when the token is wrong', async () => {
    const enq = await enqueueDispatch();
    const before = await statusOf(enq.dispatch_phid);

    const res = await fetch(`${baseUrl}/agent-done`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Id-Team': TEAM,
        'x-id-dispatch-token': 'wrong-token',
      },
      body: JSON.stringify({ dispatch_id: enq.dispatch_phid, query_id: enq.query_id, success: true }),
    });

    expect(res.status).toBe(403);
    expect(await statusOf(enq.dispatch_phid)).toBe(before); // unchanged
  });

  it('returns 200 with a valid token and a matching dispatch_id/query_id pair', async () => {
    const enq = await enqueueDispatch();

    const res = await fetch(`${baseUrl}/agent-done`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Id-Team': TEAM,
        'x-id-dispatch-token': TOKEN,
      },
      body: JSON.stringify({ dispatch_id: enq.dispatch_phid, query_id: enq.query_id, success: true }),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; dispatch_id: string };
    expect(body.ok).toBe(true);
    expect(body.dispatch_id).toBe(enq.dispatch_phid);
  });

  it('returns 409 (not 200) with a valid token but a mismatched pair, and does not mutate', async () => {
    const enqA = await enqueueDispatch();
    const enqB = await enqueueDispatch();
    const beforeA = await statusOf(enqA.dispatch_phid);
    const beforeB = await statusOf(enqB.dispatch_phid);

    const res = await fetch(`${baseUrl}/agent-done`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Id-Team': TEAM,
        'x-id-dispatch-token': TOKEN,
      },
      body: JSON.stringify({
        dispatch_id: enqA.dispatch_phid,
        query_id: enqB.query_id, // mismatched on purpose
        success: true,
      }),
    });

    expect(res.status).toBe(409);
    const body = await res.json() as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/mismatch/i);
    expect(await statusOf(enqA.dispatch_phid)).toBe(beforeA); // unchanged
    expect(await statusOf(enqB.dispatch_phid)).toBe(beforeB); // unchanged
  });
});
