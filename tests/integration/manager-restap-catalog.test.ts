// SPDX-License-Identifier: MIT
/**
 * Step 1 of the manager-collapse migration (docs/design/manager-collapse.md):
 * the daemon root must publish a REST-AP catalog so :4100 is discoverable as
 * the manager. Asserts shape, identity, and the four core inbox endpoints.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';

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

function createInMemoryDb() {
  const adapter = new SqliteAdapter(':memory:');
  migrateSqlite(adapter);
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

describe('Daemon-root REST-AP catalog (manager-collapse step 1)', () => {
  let manager: AgentManagerDb;
  let db: ReturnType<typeof createInMemoryDb>;
  let baseUrl: string;
  let workDir: string;

  beforeAll(async () => {
    const port = await findFreePort();
    baseUrl = `http://127.0.0.1:${port}`;
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'manager-restap-test-'));
    db = createInMemoryDb();
    manager = new AgentManagerDb(workDir, db as any);
    await manager.start(port);
  }, 30000);

  afterAll(async () => {
    if (manager) await stopManager(manager);
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('GET /.well-known/restap.json returns the manager catalog', async () => {
    const res = await fetch(`${baseUrl}/.well-known/restap.json`);
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, any>;

    expect(body.restap_version).toBe('1.0');
    expect(body.agent?.name).toBe('manager');
    expect(typeof body.agent?.description).toBe('string');
    expect(body.agent.description.length).toBeGreaterThan(0);

    expect(body.endpoints).toMatchObject({
      talk: '/talk',
      schedule: '/schedule',
      news: '/news',
      news_post: '/news',
    });

    expect(Array.isArray(body.capabilities)).toBe(true);
    const caps = body.capabilities as Array<{ id: string; method: string; endpoint: string }>;
    const sig = (id: string, method: string, endpoint: string) =>
      caps.some((c) => c.id === id && c.method === method && c.endpoint === endpoint);
    expect(sig('talk', 'POST', '/talk')).toBe(true);
    expect(sig('schedule', 'POST', '/schedule')).toBe(true);
    expect(sig('news', 'GET', '/news')).toBe(true);
    expect(sig('news_receive', 'POST', '/news')).toBe(true);

    expect(body.extensions).toMatchObject({
      remote: '/remote',
      tasks: '/tasks',
      agents: '/agents',
      events: '/events',
    });
  });
});
