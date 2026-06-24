// SPDX-License-Identifier: MIT
/**
 * POST /tasks track-field integration tests.
 *
 * The `track` field tags a task with a canonical-track-registry id. Rules:
 *   - conforming track (canonical / deferred / sub-track prefix / legacy alias)
 *     is stored verbatim;
 *   - absent OR non-conforming track is SOFT-handled — stored as
 *     '(unassigned)' with a warning, never a hard-reject (1362 legacy tasks
 *     carry no track).
 *
 * `track` is surfaced in POST /tasks, GET /tasks, GET /tasks/:ref and
 * GET /tasks/entries, and is a real column (so conformance is countable in SQL).
 *
 * Boots a real AgentManagerDb against in-memory SQLite end-to-end.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
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

const TEAM = 'tasks-track-test';

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
  const r = await fetch(`${baseUrl}/tasks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Id-Team': TEAM },
    body: JSON.stringify(body),
  });
  const json = await r.json();
  return { status: r.status, json };
}

describe('POST /tasks track field', () => {
  let manager: AgentManagerDb;
  let db: Awaited<ReturnType<typeof createInMemoryDb>>;
  let baseUrl: string;
  let workDir: string;

  beforeAll(async () => {
    const port = await findFreePort();
    baseUrl = `http://127.0.0.1:${port}`;
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tasks-track-test-'));
    db = await createInMemoryDb();
    manager = new AgentManagerDb(workDir, db as any);
    await manager.start(port);
    await db.teams.getOrCreateTeamId(TEAM);
  }, 60000);

  afterAll(async () => {
    if (manager) await stopManager(manager);
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  beforeEach(async () => {
    await db.adapter.query(`DELETE FROM tasks`);
  });

  it('stores a conforming canonical track verbatim', async () => {
    const { status, json } = await postTask(baseUrl, { title: 'Wire the daemon', track: 'T-ORCH' });
    expect(status).toBe(201);
    expect(json.ok).toBe(true);
    expect(json.task.track).toBe('T-ORCH');
  });

  it('stores a conforming sub-track (prefix rollup) verbatim', async () => {
    const { status, json } = await postTask(baseUrl, { title: 'View switcher', track: 'T-CKPT.view-switcher' });
    expect(status).toBe(201);
    expect(json.task.track).toBe('T-CKPT.view-switcher');
  });

  it('stores a conforming legacy alias verbatim', async () => {
    const { json } = await postTask(baseUrl, { title: 'Legacy', track: 'T15' });
    expect(json.task.track).toBe('T15');
  });

  it('soft-handles a NON-conforming track: stored as (unassigned), no rejection', async () => {
    const { status, json } = await postTask(baseUrl, { title: 'Bad track', track: 'T-NOPE' });
    expect(status).toBe(201); // NOT a 4xx — soft-warn only
    expect(json.ok).toBe(true);
    expect(json.task.track).toBe('(unassigned)');
  });

  it('defaults to (unassigned) when no track is supplied', async () => {
    const { status, json } = await postTask(baseUrl, { title: 'No track' });
    expect(status).toBe(201);
    expect(json.task.track).toBe('(unassigned)');
  });

  it('persists track as a real column (countable via SQL)', async () => {
    await postTask(baseUrl, { title: 'A', track: 'T-ORCH' });
    await postTask(baseUrl, { title: 'B', track: 'T-NOPE' });   // → (unassigned)
    await postTask(baseUrl, { title: 'C' });                    // → (unassigned)
    const { rows } = await db.adapter.query<{ track: string; c: number }>(
      `SELECT track, COUNT(*) AS c FROM tasks GROUP BY track ORDER BY track`,
    );
    const byTrack = Object.fromEntries(rows.map((r) => [r.track, Number(r.c)]));
    expect(byTrack['T-ORCH']).toBe(1);
    expect(byTrack['(unassigned)']).toBe(2);
  });

  it('surfaces track in GET /tasks and GET /tasks/entries', async () => {
    const created = await postTask(baseUrl, { title: 'Surfaced', track: 'T-MODEL' });
    const name = created.json.task.name;

    const list = await fetch(`${baseUrl}/tasks`, { headers: { 'X-Id-Team': TEAM } }).then((r) => r.json());
    const row = (list.tasks as Array<Record<string, unknown>>).find((t) => t.name === name);
    expect(row?.track).toBe('T-MODEL');

    const entries = await fetch(`${baseUrl}/tasks/entries`, { headers: { 'X-Id-Team': TEAM } }).then((r) => r.json());
    const entry = (entries.items as Array<Record<string, unknown>>).find((e) => e.display_id === name);
    expect(entry?.track).toBe('T-MODEL');
  });
});
