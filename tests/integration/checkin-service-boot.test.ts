// SPDX-License-Identifier: MIT
/**
 * Regression test for the manager-boot wiring of CheckinService.
 *
 * Before this fix the due-service tick was implemented in
 * src/checkins/checkin-service.ts but never instantiated by the manager, so
 * rows created via POST /checkins accumulated past their next_fire_at without
 * ever firing. This test boots the real manager, creates a checkin via HTTP,
 * drives one tick through the service the manager owns, and asserts that:
 *
 *   - manager.start() instantiates the CheckinService
 *   - the tick fires the row (iteration_count=1, last_fire_at set)
 *   - a `checkin_due` news item lands in the owner's inbox
 *   - manager.shutdown() stops the service cleanly (idempotent)
 *
 * It also covers the secondary fixes shipped in the same change:
 *
 *   - POST /checkins rejects creation when linked_task is already terminal
 *   - buildCheckinResponse returns the same `owner` shape on POST and GET
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
import { CheckinService } from '../../src/checkins/checkin-service.js';
import type { CheckinRow } from '../../src/db/types.js';

const TEAM = 'checkin-boot-test';

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

function adminHeaders(team: string): Record<string, string> {
  return { 'Content-Type': 'application/json', 'X-Id-Team': team, 'X-Id-Admin': '1' };
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
  ownerId: string | null,
  status: 'todo' | 'doing' | 'done' = 'doing',
): Promise<{ id: string; uuid: string }> {
  const id = `task_${crypto.randomUUID()}`;
  const uuid = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  await db.adapter.query(
    `INSERT INTO tasks (id, name, uuid, team_id, title, status, owner, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, name, uuid, teamId, `Title for ${name}`, status, ownerId, now, now],
  );
  return { id, uuid };
}

describe('Manager boot wires CheckinService', () => {
  let manager: AgentManagerDb;
  let db: Awaited<ReturnType<typeof createInMemoryDb>>;
  let baseUrl: string;
  let workDir: string;
  let teamId: string;
  let ownerId: string;
  let assigneeId: string;
  let taskId: string;

  beforeAll(async () => {
    const port = await findFreePort();
    baseUrl = `http://127.0.0.1:${port}`;
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'checkin-boot-test-'));
    db = await createInMemoryDb();
    manager = new AgentManagerDb(workDir, db as any);
    await manager.start(port);
    teamId = await db.teams.getOrCreateTeamId(TEAM);
    ownerId = await insertAgentDirect(db, teamId, 'manager');
    assigneeId = await insertAgentDirect(db, teamId, 'coder');
    const t = await insertTaskDirect(db, teamId, 'check-agent-work', assigneeId, 'doing');
    taskId = t.id;
  }, 30000);

  afterAll(async () => {
    if (manager) await manager.shutdown();
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  beforeEach(async () => {
    await db.adapter.query(`DELETE FROM checkins`);
    await db.adapter.query(`DELETE FROM news_items`);
    await db.adapter.query(`DELETE FROM event_log`);
  });

  it('start() installs the timer on the manager-owned CheckinService', () => {
    const svc = (manager as any).checkinService as CheckinService | null;
    expect(svc).not.toBeNull();
    // The internal `interval` field is set by setInterval() inside start().
    // Asserting it is non-null proves start() ran the install path — not just
    // that the service was constructed. The timer is unref'd so it does not
    // keep node alive past test teardown.
    expect((svc as any).interval).not.toBeNull();
  });

  it('a started CheckinService fires a due row from its real setInterval loop (no manual tick)', async () => {
    // Stand up a fresh CheckinService against the suite DB with a 50ms tick
    // so we can observe the started loop firing within a normal test budget,
    // instead of waiting 30s for the manager-default cadence. We do NOT call
    // tick() manually — start() must install the interval and the row must
    // advance purely as a side-effect of the timer.
    const svc = new CheckinService(db as any, { intervalMs: 50 });

    const now = Date.now();
    const row: CheckinRow = {
      id: `chk_started_${now}`,
      team_id: teamId,
      owner_agent_id: ownerId,
      created_by_agent_id: ownerId,
      linked_task_id: taskId,
      interval_seconds: 60,
      priority: 'normal',
      status: 'active',
      close_when: { task_status: ['done'] },
      max_iterations: null,
      iteration_count: 0,
      next_fire_at: now - 1, // already due
      snooze_until: null,
      ttl_expires_at: null,
      last_fire_at: null,
      last_event_seq: null,
      note: null,
      created_at: now,
      updated_at: now,
      closed_at: null,
      closed_reason: null,
    };
    await db.checkins.create(row);

    try {
      svc.start();
      // Two pieces of evidence the loop is live:
      //   1. start() installed a non-null interval handle.
      //   2. polling the row converges to iteration_count >= 1 without us
      //      ever calling svc.tick() — only the interval can advance it.
      expect((svc as any).interval).not.toBeNull();

      const deadline = Date.now() + 5_000;
      let fired: CheckinRow | null = null;
      while (Date.now() < deadline) {
        const current = await db.checkins.get(row.id, teamId);
        if (current && current.iteration_count >= 1) {
          fired = current;
          break;
        }
        await new Promise((r) => setTimeout(r, 25));
      }

      expect(fired, 'expected the started interval to fire the row within 5s').not.toBeNull();
      expect(fired!.iteration_count).toBe(1);
      expect(fired!.last_fire_at).toBeGreaterThan(0);
      expect(fired!.next_fire_at).toBe(fired!.last_fire_at! + 60_000);
    } finally {
      svc.stop();
      expect((svc as any).interval).toBeNull();
    }
  }, 10000);

  it('a checkin created via POST /checkins is fired by the manager-owned tick', async () => {
    const res = await fetch(`${baseUrl}/checkins`, {
      method: 'POST',
      headers: adminHeaders(TEAM),
      body: JSON.stringify({
        owner: 'manager',
        linked_task: 'check-agent-work',
        interval: '5s',
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { ok: boolean; checkin: { id: string; nextFireAt: number } };
    expect(body.checkin.nextFireAt).toBeGreaterThan(0);

    const svc = (manager as any).checkinService as CheckinService;
    expect(svc).not.toBeNull();

    // Drive one pass with `now` past next_fire_at so the row is claimed.
    const tickResult = await svc.tick(body.checkin.nextFireAt + 1);
    expect(tickResult.fired).toBe(1);
    expect(tickResult.errors).toBe(0);

    const row = await db.checkins.get(body.checkin.id, teamId);
    expect(row).not.toBeNull();
    expect(row!.iteration_count).toBe(1);
    expect(row!.last_fire_at).toBeGreaterThan(0);
    expect(row!.next_fire_at).toBe(row!.last_fire_at! + 5_000);

    const news = await db.news.poll(ownerId, 0);
    const dueNews = news.filter((n) => n.type === 'checkin_due');
    expect(dueNews.length).toBe(1);
    expect((dueNews[0].data as any).checkin_id).toBe(body.checkin.id);
  });

  it('POST /checkins rejects creation when linked_task is already in a terminal status (done)', async () => {
    const doneTask = await insertTaskDirect(db, teamId, 'already-finished', assigneeId, 'done');

    const res = await fetch(`${baseUrl}/checkins`, {
      method: 'POST',
      headers: adminHeaders(TEAM),
      body: JSON.stringify({ owner: 'manager', linked_task: 'already-finished' }),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; task_status: string };
    expect(body.error).toBe('linked_task_terminal');
    expect(body.task_status).toBe('done');

    // No checkin row was created.
    const rows = await db.checkins.list({ teamId, linkedTaskId: doneTask.id });
    expect(rows).toHaveLength(0);
  });

  it('buildCheckinResponse returns the same owner shape on POST and GET', async () => {
    const post = await fetch(`${baseUrl}/checkins`, {
      method: 'POST',
      headers: adminHeaders(TEAM),
      body: JSON.stringify({ owner: 'manager', linked_task: 'check-agent-work' }),
    });
    expect(post.status).toBe(201);
    const created = (await post.json()) as { checkin: Record<string, any> };
    expect(created.checkin.owner).toBe('manager');
    expect(created.checkin.ownerId).toBe(ownerId);
    expect(created.checkin.ownerAgentId).toBe(ownerId);

    const list = await fetch(`${baseUrl}/checkins`, { headers: adminHeaders(TEAM) });
    const body = (await list.json()) as { checkins: Array<Record<string, any>> };
    const match = body.checkins.find((c) => c.id === created.checkin.id);
    expect(match).toBeDefined();
    expect(match!.owner).toBe('manager');
    expect(match!.ownerId).toBe(ownerId);
    expect(match!.ownerAgentId).toBe(ownerId);
  });

  it('shutdown() stops the CheckinService idempotently', async () => {
    // Use a one-shot manager so we do not tear down the suite-level instance.
    const port = await findFreePort();
    const localDir = fs.mkdtempSync(path.join(os.tmpdir(), 'checkin-boot-shutdown-'));
    const localDb = await createInMemoryDb();
    const localManager = new AgentManagerDb(localDir, localDb as any);
    await localManager.start(port);
    expect((localManager as any).checkinService).not.toBeNull();

    await localManager.shutdown();
    expect((localManager as any).checkinService).toBeNull();
    // Idempotent: a second call must not throw.
    await localManager.shutdown();

    try { fs.rmSync(localDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });
});
