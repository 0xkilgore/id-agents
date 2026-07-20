// SPDX-License-Identifier: MIT
/**
 * End-to-end checkin flow (slice C8 / checkin-end-to-end-verification).
 *
 * Walks through every primitive in one test:
 *
 *   1. CTO dispatches a /talk-to with a task spec → manager auto-attaches an
 *      active checkin (owner = dispatcher, interval 600s).
 *   2. Time advances past the first `next_fire_at`. The due-service tick
 *      fires the checkin: iteration_count → 1, news item lands in the
 *      dispatcher's inbox, `checkin:due` event recorded.
 *   3. A second tick (after another 600s) advances iteration_count → 2.
 *   4. The assignee marks the linked task `done`. The task `done` route
 *      emits `task:completed` and invokes the auto-close hook, which
 *      closes the checkin (`closed_reason='linked_task_terminal'`) and
 *      emits `checkin:closed`.
 *
 * The test drives `CheckinService.tickTeam(teamId, now)` directly so the
 * suite stays fast (no real 30s timer); production uses the same code path
 * via `start()`.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import * as http from 'http';
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
import { CheckinService } from '../../src/checkins/checkin-service.js';

const TEAM = 'checkin-e2e';
const DEFAULT_INTERVAL_MS = 600 * 1000; // matches /talk-to auto-attach default
const DEFAULT_MAX_ITERATIONS = 12; // two hours at the default cadence

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
    setTimeout(resolve, 200);
  });
}

function startStubAgent(port: number): Promise<http.Server> {
  return new Promise((resolve) => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ query_id: `query_${crypto.randomUUID()}`, status: 'queued' }));
    });
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

async function insertAgent(
  db: Awaited<ReturnType<typeof createInMemoryDb>>,
  teamId: string,
  name: string,
  endpoint: string | null,
): Promise<string> {
  const id = `agent_${crypto.randomUUID()}`;
  const metadata = JSON.stringify({ local: true, mesh_member: true });
  await db.adapter.query(
    `INSERT INTO agents (team_id, id, name, type, model, port, endpoint, status, created_at, runtime, metadata)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [teamId, id, name, 'persistent', 'claude-opus', 0, endpoint, 'active', Date.now(), 'claude-code', metadata],
  );
  return id;
}

function adminHeaders(team: string): Record<string, string> {
  return { 'Content-Type': 'application/json', 'X-Id-Team': team, 'X-Id-Admin': '1' };
}

describe('Checkin end-to-end: /talk-to → fire → auto-close', () => {
  let manager: AgentManagerDb;
  let db: Awaited<ReturnType<typeof createInMemoryDb>>;
  let baseUrl: string;
  let workDir: string;
  let teamId: string;
  let ctoId: string;
  let coderId: string;
  let stubAgent: http.Server;
  let svc: CheckinService;

  beforeAll(async () => {
    const managerPort = await findFreePort();
    const stubPort = await findFreePort();
    baseUrl = `http://127.0.0.1:${managerPort}`;
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'checkin-e2e-'));
    db = await createInMemoryDb();
    manager = new AgentManagerDb(workDir, db as any);
    await manager.start(managerPort);

    teamId = await db.teams.getOrCreateTeamId(TEAM);
    ctoId = await insertAgent(db, teamId, 'cto', null);
    coderId = await insertAgent(db, teamId, 'coder', `http://127.0.0.1:${stubPort}`);
    stubAgent = await startStubAgent(stubPort);

    svc = new CheckinService(db as any);
  }, 120000);

  afterAll(async () => {
    if (svc) svc.stop();
    if (manager) await stopManager(manager);
    if (stubAgent) await new Promise<void>((r) => stubAgent.close(() => r()));
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('walks the full /talk-to → fire → fire → done → auto-close flow', async () => {
    // -----------------------------------------------------------------------
    // 1. CTO dispatches a /talk-to that creates a task. Manager auto-attaches.
    // -----------------------------------------------------------------------
    const dispatchRes = await fetch(`${baseUrl}/talk-to`, {
      method: 'POST',
      headers: adminHeaders(TEAM),
      body: JSON.stringify({
        to: 'coder',
        from: 'cto',
        message: 'please implement the foo widget',
        wait: false,
        task: { title: 'Build foo widget', name: 'build-foo' },
      }),
    });
    expect(dispatchRes.status).toBe(200);

    const tasks = await db.tasks.list({ teamId });
    expect(tasks).toHaveLength(1);
    const task = tasks[0];
    expect(task).toMatchObject({
      name: 'build-foo',
      status: 'doing',
      owner: coderId,
      created_by: ctoId,
    });

    const checkinsAfterDispatch = await db.checkins.list({ teamId });
    expect(checkinsAfterDispatch).toHaveLength(1);
    const checkin = checkinsAfterDispatch[0];
    expect(checkin).toMatchObject({
      owner_agent_id: ctoId,
      linked_task_id: task.id,
      interval_seconds: 600,
      max_iterations: DEFAULT_MAX_ITERATIONS,
      status: 'active',
      iteration_count: 0,
    });
    expect(checkin.next_fire_at).not.toBeNull();
    const initialNextFireAt = checkin.next_fire_at!;

    // checkin:created event present
    expect(await db.events.query({ teamId, topics: ['checkin:created'] })).toHaveLength(1);

    // -----------------------------------------------------------------------
    // 2. Advance simulated time past next_fire_at and run a single tick.
    //    Verify owner inbox got the due news + iteration_count = 1.
    // -----------------------------------------------------------------------
    const t1 = initialNextFireAt + 30_000;
    const tick1 = await svc.tickTeam(teamId, t1);
    expect(tick1).toMatchObject({ scanned: 1, fired: 1, expired: 0, errors: 0 });

    const afterFire1 = await db.checkins.get(checkin.id, teamId);
    expect(afterFire1!.iteration_count).toBe(1);
    expect(afterFire1!.last_fire_at).toBe(t1);
    expect(afterFire1!.next_fire_at).toBe(t1 + DEFAULT_INTERVAL_MS);
    expect(afterFire1!.status).toBe('active');

    const ctoNews1 = await db.news.poll(ctoId, 0);
    expect(ctoNews1.length).toBe(1);
    expect(ctoNews1[0].type).toBe('checkin_due');
    const news1Data = ctoNews1[0].data as Record<string, any>;
    expect(news1Data.checkin_id).toBe(checkin.id);
    expect(news1Data.iteration_count).toBe(1);
    expect(news1Data.linked_task).toMatchObject({
      id: task.id,
      name: 'build-foo',
      status: 'doing',
      assignee: 'coder',
    });

    // checkin:due event present (one)
    expect(await db.events.query({ teamId, topics: ['checkin:due'] })).toHaveLength(1);

    // -----------------------------------------------------------------------
    // 3. Second fire: tick again past the new next_fire_at.
    // -----------------------------------------------------------------------
    const t2 = afterFire1!.next_fire_at! + 5_000;
    const tick2 = await svc.tickTeam(teamId, t2);
    expect(tick2).toMatchObject({ scanned: 1, fired: 1, expired: 0 });

    const afterFire2 = await db.checkins.get(checkin.id, teamId);
    expect(afterFire2!.iteration_count).toBe(2);
    expect(afterFire2!.last_fire_at).toBe(t2);
    expect(afterFire2!.next_fire_at).toBe(t2 + DEFAULT_INTERVAL_MS);

    const ctoNews2 = await db.news.poll(ctoId, 0);
    expect(ctoNews2.length).toBe(2);
    expect((ctoNews2[0].data as Record<string, any>).iteration_count).toBeGreaterThanOrEqual(1);

    // Two checkin:due events now in the log.
    expect(await db.events.query({ teamId, topics: ['checkin:due'] })).toHaveLength(2);

    // -----------------------------------------------------------------------
    // 4. Coder completes the task. The done handler emits task:completed
    //    and calls the auto-close hook → checkin closes + checkin:closed.
    // -----------------------------------------------------------------------
    const doneRes = await fetch(`${baseUrl}/tasks/${task.name}/done`, {
      method: 'POST',
      headers: adminHeaders(TEAM),
      body: JSON.stringify({ agent_id: 'coder' }),
    });
    expect(doneRes.status).toBe(200);

    const doneTask = await db.tasks.getByNameForTeam(task.name, teamId);
    expect(doneTask?.status).toBe('done');

    const finalCheckin = await db.checkins.get(checkin.id, teamId);
    expect(finalCheckin!.status).toBe('closed');
    expect(finalCheckin!.closed_reason).toBe('linked_task_terminal');
    expect(finalCheckin!.next_fire_at).toBeNull();
    expect(finalCheckin!.snooze_until).toBeNull();

    // task:completed and checkin:closed events both landed.
    expect(await db.events.query({ teamId, topics: ['task:completed'] })).toHaveLength(1);
    const closedEvents = await db.events.query({ teamId, topics: ['checkin:closed'] });
    expect(closedEvents).toHaveLength(1);
    expect(closedEvents[0].subject_id).toBe(checkin.id);
    expect(closedEvents[0].data).toMatchObject({
      reason: 'linked_task_terminal',
      task_status: 'done',
    });

    // A subsequent tick is a no-op — the row is closed and not eligible.
    const tickAfterClose = await svc.tickTeam(teamId, t2 + 10 * DEFAULT_INTERVAL_MS);
    expect(tickAfterClose).toMatchObject({ scanned: 0, fired: 0, expired: 0 });
  }, 30000);

  it('preserves an explicit iteration cap and expires without another due receipt', async () => {
    const dispatchRes = await fetch(`${baseUrl}/talk-to`, {
      method: 'POST',
      headers: adminHeaders(TEAM),
      body: JSON.stringify({
        to: 'coder',
        from: 'cto',
        message: 'bounded delegation',
        wait: false,
        task: { title: 'Bounded task', name: 'bounded-task' },
        checkin_iters: 2,
      }),
    });
    expect(dispatchRes.status).toBe(200);

    const [checkin] = await db.checkins.list({ teamId, status: ['active'] });
    expect(checkin.max_iterations).toBe(2);

    const tick1 = await svc.tickTeam(teamId, checkin.next_fire_at!);
    expect(tick1).toMatchObject({ fired: 1, expired: 0 });
    const afterFirst = await db.checkins.get(checkin.id, teamId);
    const tick2 = await svc.tickTeam(teamId, afterFirst!.next_fire_at!);
    expect(tick2).toMatchObject({ fired: 1, expired: 1 });

    const expired = await db.checkins.get(checkin.id, teamId);
    expect(expired).toMatchObject({
      status: 'expired',
      closed_reason: 'max_iterations',
      iteration_count: 2,
      next_fire_at: null,
    });
    const dueForCheckin = (await db.events.query({ teamId, topics: ['checkin:due'] }))
      .filter((event) => event.subject_id === checkin.id);
    expect(dueForCheckin).toHaveLength(2);
    const newsForCheckin = (await db.news.poll(ctoId, 0))
      .filter((item) => (item.data as Record<string, unknown>)?.checkin_id === checkin.id);
    expect(newsForCheckin).toHaveLength(2);

    const afterCap = await svc.tickTeam(teamId, afterFirst!.next_fire_at! + DEFAULT_INTERVAL_MS);
    expect(afterCap).toMatchObject({ scanned: 0, fired: 0, expired: 0 });
    expect((await db.events.query({ teamId, topics: ['checkin:due'] }))
      .filter((event) => event.subject_id === checkin.id)).toHaveLength(2);
    expect((await db.news.poll(ctoId, 0))
      .filter((item) => (item.data as Record<string, unknown>)?.checkin_id === checkin.id)).toHaveLength(2);
  }, 30000);
});
