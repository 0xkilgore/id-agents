// Loop registry foundation — route smoke: the manager exposes the seed catalog
// read-model at GET /loops, /loops/summary and /loops/:ref for /ops/loops.

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

describe('GET /loops registry routes', () => {
  let manager: AgentManagerDb;
  let db: Awaited<ReturnType<typeof createInMemoryDb>>;
  let baseUrl: string;
  let workDir: string;

  beforeAll(async () => {
    const port = await findFreePort();
    baseUrl = `http://127.0.0.1:${port}`;
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loops-route-test-'));
    db = await createInMemoryDb();
    manager = new AgentManagerDb(workDir, db as any);
    await manager.start(port);
  }, 30000);

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      (manager as any).httpServer?.close(() => resolve());
      setTimeout(resolve, 500);
    });
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('GET /loops returns the seed catalog list envelope (all 9 loops)', async () => {
    const res = await fetch(`${baseUrl}/loops`);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.ok).toBe(true);
    expect(body.schema_version).toBe('loops-list-v1');
    expect(body.source).toBe('seed_catalog');
    expect(body.loops).toHaveLength(12);
    expect(body.filters.owners.length).toBeGreaterThan(0);
    // every row carries the read-model identity + placeholder health
    for (const l of body.loops) {
      expect(l.loop_phid).toMatch(/^phid:loop:/);
      expect(['healthy', 'degraded', 'failed', 'disabled', 'unknown']).toContain(l.health.state);
    }
  });

  it('GET /loops?owner_agent= filters the list', async () => {
    const res = await fetch(`${baseUrl}/loops?owner_agent=sentinel`);
    const body = await res.json() as any;
    expect(body.loops.map((l: any) => l.slug)).toEqual(['sentinel-verification-2h']);
  });

  it('GET /loops/summary returns the dashboard rollup', async () => {
    const res = await fetch(`${baseUrl}/loops/summary`);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.ok).toBe(true);
    expect(body.schema_version).toBe('loops-dashboard-summary-v1');
    expect(body.total_enabled).toBe(7);
  });

  it('GET /loops/:ref resolves by slug and by phid; 404 otherwise', async () => {
    const bySlug = await fetch(`${baseUrl}/loops/morning-digest`);
    expect(bySlug.status).toBe(200);
    expect((await bySlug.json() as any).loop.slug).toBe('morning-digest');

    const byPhid = await fetch(`${baseUrl}/loops/phid:loop:inbox-intake`);
    expect(byPhid.status).toBe(200);
    expect((await byPhid.json() as any).loop.slug).toBe('inbox-intake');

    const missing = await fetch(`${baseUrl}/loops/not-a-loop`);
    expect(missing.status).toBe(404);
    expect((await missing.json() as any).error).toBe('loop_not_found');
  });
});
