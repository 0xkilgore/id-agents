// SPDX-License-Identifier: MIT

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
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

const TEAM = 'tasks-field-update-test';

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

async function postTask(baseUrl: string, body: Record<string, unknown>) {
  const response = await fetch(`${baseUrl}/tasks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Id-Team': TEAM },
    body: JSON.stringify(body),
  });
  return response.json() as Promise<{ task: { name: string } }>;
}

async function patchTask(baseUrl: string, name: string, body: Record<string, unknown>) {
  const response = await fetch(`${baseUrl}/tasks/${name}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', 'X-Id-Team': TEAM },
    body: JSON.stringify(body),
  });
  const json = await response.json();
  return { status: response.status, json };
}

describe('PATCH /tasks/:ref field updates', () => {
  let manager: AgentManagerDb;
  let db: Awaited<ReturnType<typeof createInMemoryDb>>;
  let baseUrl: string;
  let workDir: string;

  beforeAll(async () => {
    const port = await findFreePort();
    baseUrl = `http://127.0.0.1:${port}`;
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tasks-field-update-test-'));
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
    await db.adapter.query(`DELETE FROM tasks`);
  });

  it('updates priority, due, and note through the manager task route', async () => {
    const created = await postTask(baseUrl, {
      title: 'Review manager edit flow !low due:2026-07-10',
      description: 'Existing detail',
    });

    const updated = await patchTask(baseUrl, created.task.name, {
      priority: 'high',
      due: '2026-07-12',
      note: 'Chris asked for this to move up.',
    });

    expect(updated.status).toBe(200);
    expect(updated.json.ok).toBe(true);
    expect(updated.json.task.priority).toBe('high');
    expect(updated.json.task.due_iso).toBe('2026-07-12');
    expect(updated.json.task.description).toContain('Existing detail');
    expect(updated.json.task.description).toContain('Chris asked for this to move up.');

    const single = await fetch(`${baseUrl}/tasks/${created.task.name}`, {
      headers: { 'X-Id-Team': TEAM },
    }).then((r) => r.json());
    expect(single.task.priority).toBe('high');
    expect(single.task.due_iso).toBe('2026-07-12');

    const list = await fetch(`${baseUrl}/tasks`, {
      headers: { 'X-Id-Team': TEAM },
    }).then((r) => r.json());
    const row = list.tasks.find((task: { name: string }) => task.name === created.task.name);
    expect(row.priority).toBe('high');
    expect(row.due_iso).toBe('2026-07-12');

    const entries = await fetch(`${baseUrl}/tasks/entries`, {
      headers: { 'X-Id-Team': TEAM },
    }).then((r) => r.json());
    const entry = entries.items.find((item: { display_id: string }) => item.display_id === created.task.name);
    expect(entry.priority).toBe('high');
    expect(entry.due_iso).toBe('2026-07-12');
  });

  it('clears priority and due tokens', async () => {
    const created = await postTask(baseUrl, {
      title: 'Clear manager fields !high due:2026-07-12',
    });

    const updated = await patchTask(baseUrl, created.task.name, {
      priority: '',
      due: '',
    });

    expect(updated.status).toBe(200);
    expect(updated.json.task.priority).toBeNull();
    expect(updated.json.task.due_iso).toBeNull();
    expect(updated.json.task.title).toBe('Clear manager fields');
  });

  it('rejects invalid field values without mutating the task', async () => {
    const created = await postTask(baseUrl, { title: 'Keep unchanged !med' });
    const invalid = await patchTask(baseUrl, created.task.name, { priority: 'urgent' });

    expect(invalid.status).toBe(400);
    const single = await fetch(`${baseUrl}/tasks/${created.task.name}`, {
      headers: { 'X-Id-Team': TEAM },
    }).then((r) => r.json());
    expect(single.task.priority).toBe('med');
  });
});
