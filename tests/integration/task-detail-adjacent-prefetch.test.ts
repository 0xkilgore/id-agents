// SPDX-License-Identifier: MIT
/**
 * GET /tasks/:ref/detail adjacent prefetch.
 *
 * Boots the real manager against in-memory SQLite and counts TasksRepository.list
 * calls. The first detail read scans the current list once and prefetches the
 * adjacent task detail; switching to that adjacent task must be served from the
 * detail cache without another full-list scan.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';

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

const TEAM = 'task-detail-prefetch-test';

async function createInMemoryDb() {
  const adapter = new SqliteAdapter(':memory:');
  await migrateSqlite(adapter);
  const tasks = new SqliteTasksRepo(adapter);
  let listCalls = 0;
  const originalList = tasks.list.bind(tasks);
  tasks.list = async (...args) => {
    listCalls += 1;
    return originalList(...args);
  };
  return {
    adapter,
    teams: new SqliteTeamsRepo(adapter),
    agents: new SqliteAgentsRepo(adapter),
    queries: new SqliteQueriesRepo(adapter),
    news: new SqliteNewsRepo(adapter),
    schedules: new SqliteSchedulesRepo(adapter),
    tasks,
    events: new SqliteEventsRepo(adapter),
    subscriptions: new SqliteSubscriptionsRepo(adapter),
    checkins: new SqliteCheckinsRepo(adapter),
    getListCalls: () => listCalls,
    resetListCalls: () => { listCalls = 0; },
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

async function insertTaskDirect(
  db: Awaited<ReturnType<typeof createInMemoryDb>>,
  teamId: string,
  name: string,
  updatedAt: number,
): Promise<void> {
  const id = `task_${crypto.randomUUID()}`;
  const uuid = crypto.randomUUID();
  await db.adapter.query(
    `INSERT INTO tasks (id, name, uuid, team_id, title, description, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, name, uuid, teamId, `Title for ${name}`, null, 'todo', updatedAt, updatedAt],
  );
}

describe('GET /tasks/:ref/detail adjacent prefetch', () => {
  let manager: AgentManagerDb | null = null;
  let db: Awaited<ReturnType<typeof createInMemoryDb>> | null = null;
  let baseUrl: string;
  let workDir: string | null = null;
  let teamId: string;

  beforeAll(async () => {
    const port = await findFreePort();
    baseUrl = `http://127.0.0.1:${port}`;
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-detail-prefetch-test-'));
    db = await createInMemoryDb();
    manager = new AgentManagerDb(workDir, db as any);
    await manager.start(port);
    teamId = await db.teams.getOrCreateTeamId(TEAM);
  }, 30000);

  afterAll(async () => {
    if (manager) await stopManager(manager);
    if (workDir) {
      try { fs.rmSync(workDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
    if (db) await db.close();
  });

  beforeEach(async () => {
    await db!.adapter.query(`DELETE FROM tasks`);
    db!.resetListCalls();
  });

  it('serves an adjacent task detail from prefetch cache without a fresh list scan', async () => {
    await insertTaskDirect(db!, teamId, 'task-oldest', 100);
    await insertTaskDirect(db!, teamId, 'task-middle', 200);
    await insertTaskDirect(db!, teamId, 'task-newest', 300);

    const first = await fetch(`${baseUrl}/tasks/task-middle/detail?status=todo`, {
      headers: { 'X-Id-Team': TEAM },
    });
    expect(first.status).toBe(200);
    const firstBody = await first.json() as any;
    expect(first.headers.get('x-task-detail-cache')).toBe('miss');
    expect(firstBody.task.name).toBe('task-middle');
    expect(firstBody.adjacent_prefetch.previous.name).toBe('task-newest');
    expect(db!.getListCalls()).toBe(1);

    const second = await fetch(`${baseUrl}/tasks/task-newest/detail?status=todo`, {
      headers: { 'X-Id-Team': TEAM },
    });
    expect(second.status).toBe(200);
    const secondBody = await second.json() as any;
    expect(second.headers.get('x-task-detail-cache')).toBe('hit');
    expect(secondBody.task.name).toBe('task-newest');
    expect(secondBody.adjacent_prefetch.next.name).toBe('task-middle');
    expect(db!.getListCalls()).toBe(1);
  });
});
