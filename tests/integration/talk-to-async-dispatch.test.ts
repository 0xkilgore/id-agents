// SPDX-License-Identifier: MIT

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as http from 'http';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import crypto from 'node:crypto';

import { AgentManagerDb } from '../../src/agent-manager-db.js';
import { migrateSqlite } from '../../src/db/migrations/sqlite.js';
import { SqliteAdapter } from '../../src/db/sqlite-adapter.js';
import { SqliteAgentsRepo } from '../../src/db/repos/sqlite/agents-repo.js';
import { SqliteCheckinsRepo } from '../../src/db/repos/sqlite/checkins-repo.js';
import { SqliteEventsRepo } from '../../src/db/repos/sqlite/events-repo.js';
import { SqliteNewsRepo } from '../../src/db/repos/sqlite/news-repo.js';
import { SqliteQueriesRepo } from '../../src/db/repos/sqlite/queries-repo.js';
import { SqliteSchedulesRepo } from '../../src/db/repos/sqlite/schedules-repo.js';
import { SqliteSubscriptionsRepo } from '../../src/db/repos/sqlite/subscriptions-repo.js';
import { SqliteTasksRepo } from '../../src/db/repos/sqlite/tasks-repo.js';
import { SqliteTeamsRepo } from '../../src/db/repos/sqlite/teams-repo.js';

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

async function listen(server: http.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      resolve(addr.port);
    });
    server.on('error', reject);
  });
}

async function closeServer(server: http.Server): Promise<void> {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections?.();
    setTimeout(resolve, 500);
  });
}

async function dispatchLedgerEntries(baseUrl: string): Promise<any[]> {
  const res = await fetch(`${baseUrl}/logs?limit=100`, {
    headers: { 'X-Id-Team': 'default' },
  });
  expect(res.status).toBe(200);
  const body = await res.json() as { logs: Array<{ msg: string }> };
  return body.logs
    .map((entry) => entry.msg)
    .filter((msg) => msg.startsWith('[dispatch-attempt-ledger] '))
    .map((msg) => JSON.parse(msg.slice('[dispatch-attempt-ledger] '.length)));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function insertAgent(
  db: Awaited<ReturnType<typeof createInMemoryDb>>,
  teamId: string,
  name: string,
  endpoint: string,
): Promise<string> {
  const id = `agent_${crypto.randomUUID()}`;
  await db.adapter.query(
    `INSERT INTO agents (team_id, id, name, type, model, port, endpoint, status, created_at, runtime)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [teamId, id, name, 'persistent', 'claude-opus', 24000, endpoint, 'active', Date.now(), 'claude-code'],
  );
  return id;
}

describe('/talk-to async dispatch receipt', () => {
  const savedGatewayMode = process.env.DISPATCH_GATEWAY_MODE;
  const savedTickInterval = process.env.DISPATCH_TICK_INTERVAL_MS;
  let db: Awaited<ReturnType<typeof createInMemoryDb>>;
  let manager: AgentManagerDb;
  let baseUrl: string;
  let workDir: string;
  let slowServer: http.Server;

  beforeAll(async () => {
    process.env.DISPATCH_GATEWAY_MODE = 'enforce';
    process.env.DISPATCH_TICK_INTERVAL_MS = '60000';

    slowServer = http.createServer((req, res) => {
      if (req.method === 'POST' && req.url === '/talk') {
        setTimeout(() => {
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ ok: true, query_id: `agent_q_${Date.now()}` }));
        }, 1500);
        return;
      }
      if (req.method === 'POST' && req.url === '/news') {
        res.statusCode = 202;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ ok: true, query_id: `fallback_q_${Date.now()}`, triggered: true }));
        return;
      }
      res.statusCode = 404;
      res.end('not found');
    });
    const slowPort = await listen(slowServer);

    db = await createInMemoryDb();
    const defaultTeamId = await db.teams.getOrCreateTeamId('default');
    await insertAgent(db, defaultTeamId, 'slow-agent', `http://127.0.0.1:${slowPort}`);
    await insertAgent(db, defaultTeamId, 'dead-agent', `http://127.0.0.1:9`);

    const managerPort = await findFreePort();
    baseUrl = `http://127.0.0.1:${managerPort}`;
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'talk-to-async-dispatch-'));
    manager = new AgentManagerDb(workDir, db as any);
    await manager.start(managerPort);
  }, 30000);

  afterAll(async () => {
    if (manager) {
      await manager.shutdown();
    }
    await closeServer(slowServer);
    try { await db?.close(); } catch { /* ignore */ }
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch { /* ignore */ }
    if (savedGatewayMode === undefined) delete process.env.DISPATCH_GATEWAY_MODE; else process.env.DISPATCH_GATEWAY_MODE = savedGatewayMode;
    if (savedTickInterval === undefined) delete process.env.DISPATCH_TICK_INTERVAL_MS; else process.env.DISPATCH_TICK_INTERVAL_MS = savedTickInterval;
  });

  beforeEach(async () => {
    await db.adapter.query(`DELETE FROM queries`);
    await db.adapter.query(`DELETE FROM dispatch_scheduler_queue`);
  });

  it('returns immediately with a durable receipt for a slow target', async () => {
    const started = Date.now();
    const res = await fetch(`${baseUrl}/talk-to`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Id-Team': 'default' },
      body: JSON.stringify({
        to: 'slow-agent',
        from: 'operator',
        message: 'do slow work',
      }),
    });
    const elapsedMs = Date.now() - started;
    expect(res.status).toBe(200);
    expect(elapsedMs).toBeLessThan(1000);

    const body = await res.json() as {
      success: boolean;
      dispatch_id: string;
      dispatch_phid: string;
      query_id: string;
      status: string;
    };
    expect(body).toMatchObject({
      success: true,
      status: 'queued',
    });
    expect(body.dispatch_id).toMatch(/^phid:disp-/);
    expect(body.dispatch_phid).toBe(body.dispatch_id);
    expect(body.query_id).toMatch(/^query_/);

    const health = await fetch(`${baseUrl}/dispatches/health`, {
      headers: { 'X-Id-Team': 'default' },
    });
    expect(health.status).toBe(200);
    const healthBody = await health.json() as any;
    expect(healthBody.active).toBe(1);
    expect(healthBody.terminal).toBe(0);

    const ledger = await dispatchLedgerEntries(baseUrl);
    expect(ledger).toContainEqual(expect.objectContaining({
      target_agent: 'slow-agent',
      path: 'talk-to',
      status: 'queued',
      query_id: body.query_id,
      dispatch_id: body.dispatch_id,
      http_status: 200,
      original_query_metadata: expect.objectContaining({
        from: 'operator',
      }),
    }));
    await sleep(1700);
  });

  it('wait:true still uses the synchronous wait path and timeout remains pending', async () => {
    const res = await fetch(`${baseUrl}/talk-to`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Id-Team': 'default' },
      body: JSON.stringify({
        to: 'slow-agent',
        from: 'operator',
        message: 'answer slowly',
        wait: true,
        timeout: 1000,
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as {
      success: boolean;
      dispatch_id: string;
      query_id: string;
      status: string;
      message: string;
    };
    expect(body.success).toBe(false);
    expect(body.dispatch_id).toMatch(/^phid:disp-/);
    expect(body.query_id).toMatch(/^query_/);
    expect(body.status).toBe('pending');
    expect(body.message).toMatch(/timed out/i);

    const doc = await (manager as any).dispatchScheduler.reactor.getByPhid(body.dispatch_id);
    expect(doc.status === 'queued' || doc.status === 'in_flight').toBe(true);
    expect(doc.status).not.toBe('failed');

    const ledger = await dispatchLedgerEntries(baseUrl);
    expect(ledger).toContainEqual(expect.objectContaining({
      target_agent: 'slow-agent',
      path: 'talk-to',
      status: 'pending',
      query_id: body.query_id,
      dispatch_id: body.dispatch_id,
      http_status: 200,
      original_query_metadata: expect.objectContaining({
        from: 'operator',
        wait: true,
        timeout: 1000,
      }),
    }));
    await sleep(1200);
  });

  it('logs retryable primary dispatch failures as pending with original query metadata', async () => {
    const res = await fetch(`${baseUrl}/talk-to`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Id-Team': 'default' },
      body: JSON.stringify({
        to: 'dead-agent',
        from: 'operator',
        message: 'this target is down',
        wait: true,
        timeout: 3000,
        original_query_id: 'query_original_primary',
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as {
      dispatch_id: string;
      query_id: string;
      status: string;
    };
    expect(body.dispatch_id).toMatch(/^phid:disp-/);
    expect(body.query_id).toMatch(/^query_/);
    expect(body.status).toBe('pending');

    const ledger = await dispatchLedgerEntries(baseUrl);
    expect(ledger).toContainEqual(expect.objectContaining({
      target_agent: 'dead-agent',
      path: 'talk-to',
      status: 'pending',
      query_id: body.query_id,
      dispatch_id: body.dispatch_id,
      http_status: 200,
      original_query_metadata: expect.objectContaining({
        from: 'operator',
        wait: true,
        timeout: 3000,
        original_query_id: 'query_original_primary',
      }),
    }));
  }, 10000);

  it('logs /news-to as a fallback send preserving original query metadata', async () => {
    const res = await fetch(`${baseUrl}/news-to`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Id-Team': 'default' },
      body: JSON.stringify({
        to: 'slow-agent',
        from: 'operator',
        message: 'fallback notification',
        trigger: true,
        original_query_id: 'query_failed_primary',
        original_dispatch_id: 'phid:disp-primary',
      }),
    });
    expect(res.status).toBe(202);
    const body = await res.json() as {
      query_id: string;
      status: string;
      triggered: boolean;
    };
    expect(body.query_id).toMatch(/^fallback_q_/);
    expect(body.status).toBe('delivered');
    expect(body.triggered).toBe(true);

    const ledger = await dispatchLedgerEntries(baseUrl);
    expect(ledger).toContainEqual(expect.objectContaining({
      target_agent: 'slow-agent',
      path: 'news-to fallback',
      status: 'fallback_sent',
      query_id: body.query_id,
      http_status: 202,
      original_query_metadata: expect.objectContaining({
        from: 'operator',
        trigger: true,
        original_query_id: 'query_failed_primary',
        original_dispatch_id: 'phid:disp-primary',
      }),
    }));
  });
});
