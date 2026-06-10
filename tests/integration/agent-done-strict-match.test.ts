// SPDX-License-Identifier: MIT
/**
 * Integration tests for Task 9 of the dispatch-canonical plan:
 *   Strict mismatch handling on POST /agent-done. When the caller supplies
 *   BOTH `dispatch_id` (canonical phid form) AND `query_id` (manager-side
 *   canonical query id), the two must resolve to the same Dispatch doc.
 *   Mismatched pairs return 409 rather than silently picking one.
 *
 * Per open question Q7 in the plan (resolved 2026-06-09): strict matching is
 * the canonical behavior — required so closeout tracking is unambiguous.
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

const TEAM = 'agent-done-strict-match-test';

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

describe('POST /agent-done strict mismatch handling', () => {
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
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-done-strict-match-test-'));
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

  it('returns 409 when supplied dispatch_id and query_id resolve to different docs', async () => {
    const enqA = await enqueueDispatch();
    const enqB = await enqueueDispatch();
    expect(enqA.dispatch_phid).not.toBe(enqB.dispatch_phid);
    expect(enqA.query_id).not.toBe(enqB.query_id);

    const res = await fetch(`${baseUrl}/agent-done`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Id-Team': TEAM },
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
  });

  it('returns 200 when dispatch_id and query_id resolve to the same doc', async () => {
    const enq = await enqueueDispatch();

    const res = await fetch(`${baseUrl}/agent-done`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Id-Team': TEAM },
      body: JSON.stringify({
        dispatch_id: enq.dispatch_phid,
        query_id: enq.query_id, // matching
        success: true,
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; state: string; dispatch_id: string };
    expect(body.ok).toBe(true);
    expect(body.dispatch_id).toBe(enq.dispatch_phid);
  });

  it('returns 200 when only dispatch_id is supplied (no mismatch possible)', async () => {
    const enq = await enqueueDispatch();

    const res = await fetch(`${baseUrl}/agent-done`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Id-Team': TEAM },
      body: JSON.stringify({
        dispatch_id: enq.dispatch_phid,
        success: true,
      }),
    });

    expect(res.status).toBe(200);
  });

  it('returns 200 when only query_id is supplied (no mismatch possible)', async () => {
    const enq = await enqueueDispatch();

    const res = await fetch(`${baseUrl}/agent-done`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Id-Team': TEAM },
      body: JSON.stringify({
        query_id: enq.query_id,
        success: true,
      }),
    });

    expect(res.status).toBe(200);
  });

  it('falls through to dispatch_id-resolved doc when query_id is unknown (one-sided is not a mismatch)', async () => {
    // The plan's strict-matching contract: 409 fires ONLY when BOTH ids
    // resolve and point at different docs. When one side resolves and the
    // other is just unknown (orphaned caller, legacy row), the resolved
    // side wins — the manager remains resilient to stale references.
    const enq = await enqueueDispatch();

    const res = await fetch(`${baseUrl}/agent-done`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Id-Team': TEAM },
      body: JSON.stringify({
        dispatch_id: enq.dispatch_phid,
        query_id: 'query_does_not_exist_anywhere',
        success: true,
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; dispatch_id: string };
    expect(body.dispatch_id).toBe(enq.dispatch_phid);
  });
});
