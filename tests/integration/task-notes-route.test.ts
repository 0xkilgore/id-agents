// SPDX-License-Identifier: MIT

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';

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

const TEAM = 'default';

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

describe('POST /task-notes', () => {
  let manager: AgentManagerDb;
  let db: Awaited<ReturnType<typeof createInMemoryDb>>;
  let baseUrl: string;
  let workDir: string;

  beforeAll(async () => {
    const port = await findFreePort();
    baseUrl = `http://127.0.0.1:${port}`;
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-notes-route-test-'));
    db = await createInMemoryDb();
    manager = new AgentManagerDb(workDir, db as any);
    await manager.start(port);
    await db.teams.getOrCreateTeamId(TEAM);
  }, 30000);

  afterAll(async () => {
    if (manager) await stopManager(manager);
    await db?.close();
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  beforeEach(async () => {
    await db.adapter.query(`DELETE FROM event_log`);
    await db.adapter.query(`DELETE FROM tasks`);
  });

  it('records a durable task note, appends it to the task, and emits a routeable event', async () => {
    const create = await fetch(`${baseUrl}/tasks?team_id=${encodeURIComponent(TEAM)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'Fix task note route',
        name: 'fix-task-note-route',
        description: 'Existing context',
      }),
    });
    expect(create.status).toBe(201);

    const note = await fetch(`${baseUrl}/task-notes?team_id=${encodeURIComponent(TEAM)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        task_ref: 'fix-task-note-route',
        task_name: 'Fix task note route',
        actor_ref: 'user:chris',
        note_body: 'Chris says this should route through Cane.',
        source_path: '[local-path:to-do.md]',
        source_project: 'kapelle',
        line_number: 42,
        source_surface: 'ops/tasks/append-note',
      }),
    });

    expect(note.status).toBe(201);
    expect(note.headers.get('content-type')).toContain('application/json');
    const body = await note.json();
    expect(body).toMatchObject({
      ok: true,
      schema_version: 'task.note.v1',
      team_name: TEAM,
      task_note: {
        task_ref: 'fix-task-note-route',
        actor_ref: 'user:chris',
        note_body: 'Chris says this should route through Cane.',
        source_project: 'kapelle',
        line_number: 42,
        status: 'queued',
        event_topic: 'task:commented',
        resolved: true,
      },
      idempotent: false,
    });

    const task = await fetch(`${baseUrl}/tasks/fix-task-note-route`, {
      headers: { 'X-Id-Team': TEAM },
    }).then((r) => r.json());
    expect(task.task.description).toContain('Existing context');
    expect(task.task.description).toContain('Chris says this should route through Cane.');

    const events = await db.adapter.query<{ topic: string; subject_kind: string; data: string }>(
      `SELECT topic, subject_kind, data FROM event_log ORDER BY seq ASC`,
    );
    const commented = events.rows.find((row) => row.topic === 'task:commented');
    expect(commented).toMatchObject({ topic: 'task:commented', subject_kind: 'task' });
    const payload = JSON.parse(commented!.data);
    expect(payload).toMatchObject({
      task_ref: 'fix-task-note-route',
      actor_ref: 'user:chris',
      note_body: 'Chris says this should route through Cane.',
      status: 'queued',
    });
  });

  it('returns JSON validation errors for missing note body', async () => {
    const response = await fetch(`${baseUrl}/task-notes?team_id=${encodeURIComponent(TEAM)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ task_ref: 'anything' }),
    });

    expect(response.status).toBe(400);
    expect(response.headers.get('content-type')).toContain('application/json');
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      code: 'missing_note_body',
    });
  });
});
