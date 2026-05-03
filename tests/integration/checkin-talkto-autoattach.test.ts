// SPDX-License-Identifier: MIT
/**
 * Integration tests for /talk-to auto-attach (slice C5).
 *
 * Boots the real AgentManagerDb against in-memory SQLite, plus a tiny
 * stub HTTP server that pretends to be the target agent's /talk endpoint.
 * Then drives /talk-to with various flag shapes and asserts:
 *
 *   - default auto-attach: task created (owner = target, status = doing) +
 *     checkin (owner = dispatcher, interval 600s, linked_task_id = task.id)
 *     + `checkin:created` event emitted
 *   - --no-checkin (`no_checkin: true`): task is created, no checkin row
 *   - custom duration (`checkin: '30m'`): checkin.interval_seconds = 1800
 *   - custom iterations (`checkin_iters: 5`): checkin.max_iterations = 5
 *   - no `task` body: legacy /talk-to behavior, no rows created
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
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

const TEAM = 'checkin-autoattach-test';

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

/**
 * Tiny stub agent server: every POST returns `{ query_id, status: 'queued' }`
 * — enough for the manager to record a queries row and return 200.
 */
function startStubAgent(port: number): Promise<http.Server> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const queryId = `query_${crypto.randomUUID()}`;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ query_id: queryId, status: 'queued' }));
      });
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

describe('/talk-to auto-attach', () => {
  let manager: AgentManagerDb;
  let db: Awaited<ReturnType<typeof createInMemoryDb>>;
  let baseUrl: string;
  let workDir: string;
  let teamId: string;
  let dispatcherId: string;
  let targetId: string;
  let stubAgent: http.Server;

  beforeAll(async () => {
    const managerPort = await findFreePort();
    const stubPort = await findFreePort();
    baseUrl = `http://127.0.0.1:${managerPort}`;
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'checkin-autoattach-'));

    db = await createInMemoryDb();
    manager = new AgentManagerDb(workDir, db as any);
    await manager.start(managerPort);

    teamId = await db.teams.getOrCreateTeamId(TEAM);
    dispatcherId = await insertAgent(db, teamId, 'manager', null);
    targetId = await insertAgent(db, teamId, 'coder', `http://127.0.0.1:${stubPort}`);

    stubAgent = await startStubAgent(stubPort);
  }, 30000);

  afterAll(async () => {
    if (manager) await stopManager(manager);
    if (stubAgent) await new Promise<void>((r) => stubAgent.close(() => r()));
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  beforeEach(async () => {
    // Each test starts from a clean checkin/task slate.
    await db.adapter.query(`DELETE FROM checkins`);
    await db.adapter.query(`DELETE FROM tasks`);
    await db.adapter.query(`DELETE FROM event_log`);
    await db.adapter.query(`DELETE FROM queries`);
  });

  it('auto-attaches a checkin with a 600s default interval when /talk-to creates a task', async () => {
    const res = await fetch(`${baseUrl}/talk-to`, {
      method: 'POST',
      headers: adminHeaders(TEAM),
      body: JSON.stringify({
        to: 'coder',
        from: 'manager',
        message: 'build the foo widget',
        wait: false,
        task: { title: 'Build foo widget', name: 'build-foo' },
      }),
    });
    expect(res.status).toBe(200);

    // Task: created with owner = target, status = 'doing'.
    const tasks = await db.tasks.list({ teamId });
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({
      name: 'build-foo',
      title: 'Build foo widget',
      status: 'doing',
      owner: targetId,
      created_by: dispatcherId,
      team_id: teamId,
    });

    // Checkin: owner = dispatcher, linked_task = the new task, default 10m.
    const checkins = await db.checkins.list({ teamId });
    expect(checkins).toHaveLength(1);
    expect(checkins[0]).toMatchObject({
      owner_agent_id: dispatcherId,
      created_by_agent_id: dispatcherId,
      linked_task_id: tasks[0].id,
      interval_seconds: 600,
      priority: 'normal',
      status: 'active',
      max_iterations: null,
    });
    expect(checkins[0].next_fire_at).toBeGreaterThan(Date.now() - 1000);
    expect(checkins[0].last_event_seq).not.toBeNull();

    // Event: checkin:created landed in event_log.
    const events = await db.events.query({ teamId, topics: ['checkin:created'] });
    expect(events).toHaveLength(1);
    expect(events[0].subject_id).toBe(checkins[0].id);
  });

  it('skips the checkin when no_checkin: true (task is still created)', async () => {
    const res = await fetch(`${baseUrl}/talk-to`, {
      method: 'POST',
      headers: adminHeaders(TEAM),
      body: JSON.stringify({
        to: 'coder',
        from: 'manager',
        message: 'no need to watch this one',
        wait: false,
        task: { title: 'Quick fix' },
        no_checkin: true,
      }),
    });
    expect(res.status).toBe(200);

    const tasks = await db.tasks.list({ teamId });
    expect(tasks).toHaveLength(1);
    expect(tasks[0].title).toBe('Quick fix');

    const checkins = await db.checkins.list({ teamId });
    expect(checkins).toHaveLength(0);

    const events = await db.events.query({ teamId, topics: ['checkin:created'] });
    expect(events).toHaveLength(0);
  });

  it('honors --checkin <duration> override', async () => {
    const res = await fetch(`${baseUrl}/talk-to`, {
      method: 'POST',
      headers: adminHeaders(TEAM),
      body: JSON.stringify({
        to: 'coder',
        from: 'manager',
        message: 'longer cadence please',
        wait: false,
        task: { title: 'Long-running migration' },
        checkin: '30m',
      }),
    });
    expect(res.status).toBe(200);

    const checkins = await db.checkins.list({ teamId });
    expect(checkins).toHaveLength(1);
    expect(checkins[0].interval_seconds).toBe(1800);
    expect(checkins[0].max_iterations).toBeNull();
  });

  it('honors --checkin-iters <N> override', async () => {
    const res = await fetch(`${baseUrl}/talk-to`, {
      method: 'POST',
      headers: adminHeaders(TEAM),
      body: JSON.stringify({
        to: 'coder',
        from: 'manager',
        message: 'cap follow-ups',
        wait: false,
        task: { title: 'Bounded check' },
        checkin: '5m',
        checkin_iters: 3,
      }),
    });
    expect(res.status).toBe(200);

    const checkins = await db.checkins.list({ teamId });
    expect(checkins).toHaveLength(1);
    expect(checkins[0].interval_seconds).toBe(300);
    expect(checkins[0].max_iterations).toBe(3);
  });

  it('rejects an invalid checkin duration with 400', async () => {
    const res = await fetch(`${baseUrl}/talk-to`, {
      method: 'POST',
      headers: adminHeaders(TEAM),
      body: JSON.stringify({
        to: 'coder',
        from: 'manager',
        message: 'bad flag',
        wait: false,
        task: { title: 'Will not be created' },
        checkin: 'not-a-duration',
      }),
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('invalid_checkin_duration');

    // Task and checkin both stay un-created on validation failure.
    expect(await db.tasks.list({ teamId })).toHaveLength(0);
    expect(await db.checkins.list({ teamId })).toHaveLength(0);
  });

  it('does not create any rows when /talk-to has no `task` field (legacy path unchanged)', async () => {
    const res = await fetch(`${baseUrl}/talk-to`, {
      method: 'POST',
      headers: adminHeaders(TEAM),
      body: JSON.stringify({
        to: 'coder',
        from: 'manager',
        message: 'just a ping',
        wait: false,
      }),
    });
    expect(res.status).toBe(200);

    expect(await db.tasks.list({ teamId })).toHaveLength(0);
    expect(await db.checkins.list({ teamId })).toHaveLength(0);
  });
});
