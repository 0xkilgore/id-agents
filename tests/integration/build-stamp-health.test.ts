// T11.1 build-stamp: verify the running build identity actually shows on
// GET /health (and that the behind-origin staleness fields are present).

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
import { migrateOutputsTables } from '../../src/outputs/storage.js';

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

describe('GET /health build-stamp (T11.1)', () => {
  let manager: AgentManagerDb;
  let db: Awaited<ReturnType<typeof createInMemoryDb>>;
  let baseUrl: string;
  let workDir: string;

  beforeAll(async () => {
    const port = await findFreePort();
    baseUrl = `http://127.0.0.1:${port}`;
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'build-stamp-test-'));
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

  it('exposes the running build identity (build_sha + staleness fields)', async () => {
    await migrateOutputsTables(db.adapter);
    await db.adapter.query(
      `INSERT INTO artifact_operations (artifact_id, op_type, actor, ts, payload_json, source_link, idempotency_key)
       VALUES (?, 'comment_recorded', ?, ?, ?, NULL, NULL)`,
      [
        'art-health-feedback',
        'user:chris',
        '2026-07-01T15:01:00.000Z',
        JSON.stringify({
          body: 'please retry route',
          route_status: {
            visible_state: 'recorded-but-route-failed-with-retry',
            route_kind: 'substantive_follow_up',
            routed: false,
            retryable: true,
            recorded_op_id: 1,
            target_agent: 'regina',
            target_agent_raw: 'regina',
            dispatch: null,
            skipped: null,
            error: { message: 'scheduler unavailable' },
            updated_at: '2026-07-01T15:01:00.000Z',
          },
        }),
      ],
    );

    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.status).toBe('ok');
    expect(body.build).toBeTruthy();
    // The SHA the running binary was built from must be present (this is the
    // exact field the operator needs to see on /health).
    expect(typeof body.build.build_sha === 'string' || body.build.build_sha === null).toBe(true);
    if (body.build.build_sha !== null) {
      expect(body.build.build_sha).toMatch(/^[0-9a-f]{7,40}$/);
    }
    // Staleness surface: all four comparison fields exist.
    expect(body.build).toHaveProperty('build_time');
    expect(body.build).toHaveProperty('local_main_sha');
    expect(body.build).toHaveProperty('origin_main_sha');
    expect(body.build).toHaveProperty('behind_origin');
    expect(['build_stamp', 'runtime_fallback', 'unknown']).toContain(body.build.source);
    expect(body.feedback_outbox_retry_drain).toMatchObject({
      pending: 0,
      retryable: 1,
      'retry-succeeded': 0,
      'hard-failed': 0,
      disabled: 0,
      'not-recorded': 0,
    });
  });
});
