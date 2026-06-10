// SPDX-License-Identifier: MIT
/**
 * Tasks read-model immediate-reflect integration tests.
 *
 * The bug being fixed: GET /tasks (the list/projection used by the
 * operator console + kapelle-site `/ops`) was reporting `status: doing`
 * for tasks that had already been closed via `POST /tasks/:ref/done`.
 *
 * After POST /tasks/:ref/done returns 200, GET /tasks MUST return the
 * row with `status: "done"` (and `completedAt`/`updatedAt` populated)
 * with no further round-trips required. There is no caching/projection
 * lag between the write and the next read.
 *
 * The same invariant holds for every close path the manager exposes:
 *   - POST /tasks/:ref/done           (REST close)
 *   - direct row update via the CLI `/task done <ref>` command
 *
 * Boots a real AgentManagerDb against an in-memory SQLite so the
 * Express handler + repo + read path all run end-to-end.
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

const TEAM = 'tasks-readmodel-test';

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

async function insertAgentDirect(
  db: Awaited<ReturnType<typeof createInMemoryDb>>,
  teamId: string,
  name: string,
): Promise<string> {
  const id = `agent_${crypto.randomUUID()}`;
  await db.adapter.query(
    `INSERT INTO agents (team_id, id, name, type, model, port, status, created_at, runtime)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [teamId, id, name, 'persistent', 'claude-opus', 24000, 'active', Date.now(), 'claude-code'],
  );
  return id;
}

async function insertTaskDirect(
  db: Awaited<ReturnType<typeof createInMemoryDb>>,
  teamId: string,
  name: string,
  ownerId: string | null = null,
  initialStatus: 'todo' | 'doing' | 'done' = 'doing',
): Promise<{ id: string; uuid: string }> {
  const id = `task_${crypto.randomUUID()}`;
  const uuid = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  await db.adapter.query(
    `INSERT INTO tasks (id, name, uuid, team_id, title, status, owner, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, name, uuid, teamId, `Title for ${name}`, initialStatus, ownerId, now, now],
  );
  return { id, uuid };
}

describe('GET /tasks read-model immediate reflect', () => {
  let manager: AgentManagerDb;
  let db: Awaited<ReturnType<typeof createInMemoryDb>>;
  let baseUrl: string;
  let workDir: string;
  let teamId: string;
  let coderAgentId: string;

  beforeAll(async () => {
    const port = await findFreePort();
    baseUrl = `http://127.0.0.1:${port}`;
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tasks-readmodel-test-'));
    db = await createInMemoryDb();
    manager = new AgentManagerDb(workDir, db as any);
    await manager.start(port);
    teamId = await db.teams.getOrCreateTeamId(TEAM);
    coderAgentId = await insertAgentDirect(db, teamId, 'coder');
  }, 30000);

  afterAll(async () => {
    if (manager) await stopManager(manager);
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  beforeEach(async () => {
    await db.adapter.query(`DELETE FROM tasks`);
    await db.adapter.query(`DELETE FROM event_log`);
  });

  it('after POST /tasks/:ref/done, GET /tasks shows status:done immediately with completedAt populated', async () => {
    const taskName = 'a-task-to-finish';
    await insertTaskDirect(db, teamId, taskName, coderAgentId, 'doing');

    // Sanity: list before close shows doing.
    const before = await fetch(`${baseUrl}/tasks`, {
      headers: { 'X-Id-Team': TEAM },
    }).then((r) => r.json());
    const beforeRow = (before.tasks as Array<Record<string, unknown>>).find(
      (t) => t.name === taskName,
    );
    expect(beforeRow).toBeDefined();
    expect(beforeRow?.status).toBe('doing');
    expect(beforeRow?.completedAt).toBeNull();

    // Close the task.
    const doneRes = await fetch(`${baseUrl}/tasks/${taskName}/done`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Id-Team': TEAM },
      body: JSON.stringify({ agent_id: 'coder' }),
    });
    expect(doneRes.status).toBe(200);
    const doneBody = await doneRes.json();
    expect(doneBody.task.status).toBe('done');

    // GET /tasks immediately afterwards: the row MUST already be done.
    const after = await fetch(`${baseUrl}/tasks`, {
      headers: { 'X-Id-Team': TEAM },
    }).then((r) => r.json());
    const afterRow = (after.tasks as Array<Record<string, unknown>>).find(
      (t) => t.name === taskName,
    );
    expect(afterRow).toBeDefined();
    expect(afterRow?.status).toBe('done');
    expect(afterRow?.completedAt).not.toBeNull();
    expect(typeof afterRow?.updatedAt).toBe('number');
  });

  it('GET /tasks?status=done lists the just-closed task; ?status=doing does NOT list it', async () => {
    const taskName = 'transition-immediately-visible';
    await insertTaskDirect(db, teamId, taskName, coderAgentId, 'doing');

    await fetch(`${baseUrl}/tasks/${taskName}/done`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Id-Team': TEAM },
      body: JSON.stringify({ agent_id: 'coder' }),
    });

    // Filter doing — must NOT contain the closed task.
    const doingList = await fetch(`${baseUrl}/tasks?status=doing`, {
      headers: { 'X-Id-Team': TEAM },
    }).then((r) => r.json());
    expect(
      (doingList.tasks as Array<Record<string, unknown>>).find((t) => t.name === taskName),
    ).toBeUndefined();

    // Filter done — must contain it.
    const doneList = await fetch(`${baseUrl}/tasks?status=done`, {
      headers: { 'X-Id-Team': TEAM },
    }).then((r) => r.json());
    expect(
      (doneList.tasks as Array<Record<string, unknown>>).find((t) => t.name === taskName),
    ).toBeDefined();
  });

  it('GET /tasks/:ref returns the just-closed status (single-row read parity with the list read)', async () => {
    const taskName = 'singleton-reflect';
    await insertTaskDirect(db, teamId, taskName, coderAgentId, 'doing');

    await fetch(`${baseUrl}/tasks/${taskName}/done`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Id-Team': TEAM },
      body: JSON.stringify({ agent_id: 'coder' }),
    });

    const single = await fetch(`${baseUrl}/tasks/${taskName}`, {
      headers: { 'X-Id-Team': TEAM },
    }).then((r) => r.json());
    expect(single.task.status).toBe('done');
    expect(single.task.completedAt).not.toBeNull();
  });

  it('multiple closes in rapid succession do not produce a stale GET /tasks read', async () => {
    // Two tasks closed back-to-back; the list must reflect both
    // immediately without needing to re-poll.
    const a = 'task-rapid-a';
    const b = 'task-rapid-b';
    await insertTaskDirect(db, teamId, a, coderAgentId, 'doing');
    await insertTaskDirect(db, teamId, b, coderAgentId, 'doing');

    await fetch(`${baseUrl}/tasks/${a}/done`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Id-Team': TEAM },
      body: JSON.stringify({ agent_id: 'coder' }),
    });
    await fetch(`${baseUrl}/tasks/${b}/done`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Id-Team': TEAM },
      body: JSON.stringify({ agent_id: 'coder' }),
    });

    const list = await fetch(`${baseUrl}/tasks`, {
      headers: { 'X-Id-Team': TEAM },
    }).then((r) => r.json());
    const rows = list.tasks as Array<Record<string, unknown>>;
    const rowA = rows.find((t) => t.name === a);
    const rowB = rows.find((t) => t.name === b);
    expect(rowA?.status).toBe('done');
    expect(rowB?.status).toBe('done');
    expect(rowA?.completedAt).not.toBeNull();
    expect(rowB?.completedAt).not.toBeNull();
  });

  it('REGRESSION — CLI /task done (via POST /remote) cascades the same as POST /tasks/:ref/done — emits task:completed', async () => {
    // The "any other close path" rule from the dispatch: closing a
    // task via the CLI /task done command (which is what the TUI hits
    // via POST /remote {command:'/task done <name>'}) MUST run the
    // same cascade as POST /tasks/:ref/done so downstream projections
    // (checkin auto-close, news fan-out, graph re-eval) flip on the
    // same tick. Before this fix the CLI path silently skipped event
    // emission, producing the "task closed but downstream projection
    // still says doing" failure mode.
    const taskName = 'cli-close-emits-event';
    const { uuid: taskUuid } = await insertTaskDirect(db, teamId, taskName, coderAgentId, 'doing');

    // Snapshot baseline event count BEFORE close.
    const baseline = await db.adapter.query<{ c: number }>(
      `SELECT COUNT(*) AS c FROM event_log WHERE topic = 'task:completed' AND subject_id = ?`,
      [taskUuid],
    );
    expect(baseline.rows[0]?.c).toBe(0);

    // Close via /remote /task done — the CLI path.
    const remoteRes = await fetch(`${baseUrl}/remote`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Id-Team': TEAM },
      body: JSON.stringify({ command: `/task done ${taskName}` }),
    });
    expect(remoteRes.status).toBe(200);
    const remoteBody = await remoteRes.json();
    expect(remoteBody.ok).toBe(true);
    expect(remoteBody.result.task.status).toBe('done');

    // The task:completed event must have been emitted as part of the
    // CLI close cascade.
    const after = await db.adapter.query<{ c: number }>(
      `SELECT COUNT(*) AS c FROM event_log WHERE topic = 'task:completed' AND subject_id = ?`,
      [taskUuid],
    );
    expect(after.rows[0]?.c).toBe(1);

    // GET /tasks immediately reflects the close (regression for the
    // read-model staleness symptom).
    const list = await fetch(`${baseUrl}/tasks`, {
      headers: { 'X-Id-Team': TEAM },
    }).then((r) => r.json());
    const row = (list.tasks as Array<Record<string, unknown>>).find(
      (t) => t.name === taskName,
    );
    expect(row?.status).toBe('done');
  });

  it('re-closing an already-done task (idempotent /tasks/:ref/done) keeps status:done in GET /tasks', async () => {
    // Operator-handoff regression: a task that was closed hours earlier
    // and re-closed by a different actor MUST still surface as done in
    // the list view, with the fresh completedAt timestamp from the
    // most-recent close (we re-stamp on every successful done call).
    const taskName = 'reclose-idem';
    await insertTaskDirect(db, teamId, taskName, coderAgentId, 'doing');

    await fetch(`${baseUrl}/tasks/${taskName}/done`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Id-Team': TEAM },
      body: JSON.stringify({ agent_id: 'coder' }),
    });
    const firstList = await fetch(`${baseUrl}/tasks`, {
      headers: { 'X-Id-Team': TEAM },
    }).then((r) => r.json());
    const firstCompletedAt = (firstList.tasks as Array<Record<string, unknown>>)
      .find((t) => t.name === taskName)?.completedAt as number;

    // Sleep at least 1 second so the integer-second clock advances.
    await new Promise((r) => setTimeout(r, 1100));

    // Re-close.
    await fetch(`${baseUrl}/tasks/${taskName}/done`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Id-Team': TEAM },
      body: JSON.stringify({ agent_id: 'coder' }),
    });

    const secondList = await fetch(`${baseUrl}/tasks`, {
      headers: { 'X-Id-Team': TEAM },
    }).then((r) => r.json());
    const secondRow = (secondList.tasks as Array<Record<string, unknown>>)
      .find((t) => t.name === taskName);
    expect(secondRow?.status).toBe('done');
    expect(typeof secondRow?.completedAt).toBe('number');
    expect(secondRow?.completedAt as number).toBeGreaterThanOrEqual(firstCompletedAt);
  });
});
