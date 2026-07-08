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
      res.statusCode = 404;
      res.end('not found');
    });
    const slowPort = await listen(slowServer);

    db = await createInMemoryDb();
    const defaultTeamId = await db.teams.getOrCreateTeamId('default');
    await insertAgent(db, defaultTeamId, 'slow-agent', `http://127.0.0.1:${slowPort}`);

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
    await sleep(1200);
  });
});
