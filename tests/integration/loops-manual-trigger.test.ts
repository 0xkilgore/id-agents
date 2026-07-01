// B1 (2026-06-22) — loops manual-trigger + run-evidence + recurrence-link HTTP
// routes on the live manager. Mirrors the loops-route registry smoke harness.

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

const ADMIN = { 'content-type': 'application/json', 'x-id-admin': '1' };

describe('B1 loops manual-trigger + evidence + recurrence link', () => {
  let manager: AgentManagerDb;
  let db: Awaited<ReturnType<typeof createInMemoryDb>>;
  let baseUrl: string;
  let workDir: string;

  beforeAll(async () => {
    const port = await findFreePort();
    baseUrl = `http://127.0.0.1:${port}`;
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loops-trigger-test-'));
    db = await createInMemoryDb();
    manager = new AgentManagerDb(workDir, db as any);
    await manager.start(port);
  }, 60000);

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      (manager as any).httpServer?.close(() => resolve());
      setTimeout(resolve, 500);
    });
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  const post = (p: string, body: unknown, headers: Record<string, string> = ADMIN) =>
    fetch(`${baseUrl}${p}`, { method: 'POST', headers, body: JSON.stringify(body) });

  it('manual trigger creates a queued LoopRun + status_url; the run carries admission evidence', async () => {
    const res = await post('/loops/project-load/run', {
      idempotency_key: 'it-run-1', actor: { type: 'human', id: 'chris' }, surface: 'dashboard', reason: 'load up',
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.ok).toBe(true);
    expect(body.status).toBe('queued');
    expect(body.loop_run_phid).toMatch(/^phid:looprun-/);
    expect(body.status_url).toBe(`/loops/runs/${body.loop_run_phid}`);

    const poll = await fetch(`${baseUrl}${body.status_url}`);
    expect(poll.status).toBe(200);
    const run = (await poll.json() as any).run;
    expect(run.loop_phid).toBe('phid:loop:project-load');
    expect(run.step_log[0].phase).toBe('admission');
    expect(run.created_by.id).toBe('chris');
  });

  it('duplicate idempotency key returns the existing run (no second envelope)', async () => {
    const dup = await post('/loops/project-load/run', { idempotency_key: 'it-run-1', actor: { id: 'chris' } });
    const body = await dup.json() as any;
    expect(body.duplicate).toBe(true);
    const hist = await fetch(`${baseUrl}/loops/project-load/runs`);
    const runs = (await hist.json() as any).runs;
    expect(runs.filter((r: any) => r.idempotency_key === 'it-run-1')).toHaveLength(1);
  });

  it('active-run cap: a different key while one is active returns 409 loop_run_already_active', async () => {
    const res = await post('/loops/project-load/run', { idempotency_key: 'it-run-2', actor: { id: 'chris' } });
    expect(res.status).toBe(409);
    const body = await res.json() as any;
    expect(body.code).toBe('loop_run_already_active');
    expect(body.loop_run_phid).toMatch(/^phid:looprun-/);
  });

  it('rejects an unauthenticated (non-admin) trigger with 403', async () => {
    const res = await post('/loops/project-load/run', { idempotency_key: 'x' }, { 'content-type': 'application/json' });
    expect(res.status).toBe(403);
    expect((await res.json() as any).code).toBe('unauthorized');
  });

  it('rejects a disabled loop (409) and a malformed/unknown ref (400/404)', async () => {
    const disabled = await post('/loops/fantasy-baseball/run', { idempotency_key: 'd1', actor: { id: 'chris' } });
    expect(disabled.status).toBe(409);
    expect((await disabled.json() as any).code).toBe('loop_disabled');

    const malformed = await post('/loops/3/run', { idempotency_key: 'm', actor: { id: 'chris' } });
    expect(malformed.status).toBe(400);
    expect((await malformed.json() as any).code).toBe('invalid_loop_identifier');

    const unknown = await post('/loops/no-such-loop/run', { idempotency_key: 'u', actor: { id: 'chris' } });
    expect(unknown.status).toBe(404);
    expect((await unknown.json() as any).code).toBe('loop_not_found');
  });

  it('recurrence link: POST /loops/:ref/schedule binds a recurrence; detail surfaces it', async () => {
    const res = await post('/loops/morning-digest/schedule', { recurrence_phid: 'phid:recurrence-md-1', enabled: true });
    expect(res.status).toBe(200);
    expect((await res.json() as any).schedule.recurrence_phid).toBe('phid:recurrence-md-1');

    const detail = await fetch(`${baseUrl}/loops/morning-digest`);
    const body = await detail.json() as any;
    expect(body.loop.slug).toBe('morning-digest'); // backward-compatible field preserved
    expect(body.schedule.recurrence_phid).toBe('phid:recurrence-md-1');
    expect(body.controls.can_run_manual).toBe(true);
  });

  it('GET /loops returns the loops-list DTO with runs-derived health (backward compatible shape)', async () => {
    const res = await fetch(`${baseUrl}/loops`);
    const body = await res.json() as any;
    expect(body.schema_version).toBe('loops-list-v1');
    // Same DTO shape; health is now substrate-derived so source is `mixed`.
    expect(body.source).toBe('mixed');
    expect(body.loops).toHaveLength(14);
  });
});
