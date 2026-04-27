// SPDX-License-Identifier: MIT
/**
 * Integration tests for the `/checkins` HTTP API (slice C3 / checkin-api).
 *
 * Boots the real AgentManagerDb against an in-memory SQLite DB with the
 * checkin schema migrated, then exercises:
 *
 *   - POST /checkins         create with defaults + custom fields
 *   - GET  /checkins         filters (owner, status, linked_task) and team scope
 *   - POST /checkins/:id/close   normal close + idempotent close
 *   - POST /checkins/:id/snooze  status flips to snoozed, next_fire_at set
 *   - DELETE /checkins/:id   admin-only (403 for non-admin, 200 for admin)
 *
 * Auth: matches /remote and /events — `X-Id-Team` for routing,
 * `X-Id-Admin: 1` (loopback) for admin elevation.
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

const TEAM = 'checkins-api-test';

function createInMemoryDb() {
  const adapter = new SqliteAdapter(':memory:');
  migrateSqlite(adapter);
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

function adminHeaders(team: string): Record<string, string> {
  return { 'Content-Type': 'application/json', 'X-Id-Team': team, 'X-Id-Admin': '1' };
}

function nonAdminHeaders(team: string): Record<string, string> {
  return { 'Content-Type': 'application/json', 'X-Id-Team': team };
}

async function insertAgentDirect(
  db: ReturnType<typeof createInMemoryDb>,
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
  db: ReturnType<typeof createInMemoryDb>,
  teamId: string,
  name: string,
  ownerId: string | null = null,
): Promise<{ id: string; uuid: string }> {
  const id = `task_${crypto.randomUUID()}`;
  const uuid = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  await db.adapter.query(
    `INSERT INTO tasks (id, name, uuid, team_id, title, status, owner, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, name, uuid, teamId, `Title for ${name}`, 'todo', ownerId, now, now],
  );
  return { id, uuid };
}

interface CheckinEnvelope {
  id: string;
  ownerAgentId: string | null;
  linkedTaskId: string | null;
  intervalSeconds: number;
  priority: 'low' | 'normal' | 'high';
  status: 'active' | 'snoozed' | 'closed' | 'expired';
  closeWhen: Record<string, unknown>;
  maxIterations: number | null;
  iterationCount: number;
  nextFireAt: number | null;
  snoozeUntil: number | null;
  ttlExpiresAt: number | null;
  closedAt: number | null;
  closedReason: string | null;
  note: string | null;
  linkedTask?: Record<string, unknown> | null;
}

describe('Checkins API', () => {
  let manager: AgentManagerDb;
  let db: ReturnType<typeof createInMemoryDb>;
  let baseUrl: string;
  let workDir: string;
  let teamId: string;
  let managerAgentId: string;
  let coderAgentId: string;
  let taskId: string;

  beforeAll(async () => {
    const port = await findFreePort();
    baseUrl = `http://127.0.0.1:${port}`;
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'checkins-api-test-'));
    db = createInMemoryDb();
    manager = new AgentManagerDb(workDir, db as any);
    await manager.start(port);
    teamId = await db.teams.getOrCreateTeamId(TEAM);
    managerAgentId = await insertAgentDirect(db, teamId, 'manager');
    coderAgentId = await insertAgentDirect(db, teamId, 'coder');
    const t = await insertTaskDirect(db, teamId, 'check-agent-work', coderAgentId);
    taskId = t.id;
  }, 30000);

  afterAll(async () => {
    if (manager) await stopManager(manager);
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  beforeEach(async () => {
    // Each describe-block test starts from a clean checkins table so list
    // assertions stay deterministic. Reuse the agents/tasks created above.
    await db.adapter.query(`DELETE FROM checkins`);
  });

  // -------------------------------------------------------------------------
  // POST /checkins
  // -------------------------------------------------------------------------

  it('POST /checkins creates a checkin with documented defaults', async () => {
    const res = await fetch(`${baseUrl}/checkins`, {
      method: 'POST',
      headers: adminHeaders(TEAM),
      body: JSON.stringify({
        owner: 'manager',
        linked_task: 'check-agent-work',
        note: 'Follow up on delegated implementation.',
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { ok: boolean; checkin: CheckinEnvelope };
    expect(body.ok).toBe(true);
    expect(body.checkin.id).toMatch(/^chk_/);
    expect(body.checkin.intervalSeconds).toBe(900); // default 15m
    expect(body.checkin.priority).toBe('normal');
    expect(body.checkin.status).toBe('active');
    expect(body.checkin.closeWhen).toEqual({ task_status: ['done'] });
    expect(body.checkin.iterationCount).toBe(0);
    expect(body.checkin.linkedTaskId).toBe(taskId);
    expect(body.checkin.ownerAgentId).toBe(managerAgentId);
    expect(body.checkin.nextFireAt).toBeGreaterThan(0);
    expect(body.checkin.linkedTask).toMatchObject({ name: 'check-agent-work' });
  });

  it('POST /checkins parses interval as a duration string', async () => {
    const res = await fetch(`${baseUrl}/checkins`, {
      method: 'POST',
      headers: adminHeaders(TEAM),
      body: JSON.stringify({
        owner: 'manager',
        linked_task: 'check-agent-work',
        interval: '10m',
        priority: 'high',
        max_iterations: 4,
        ttl: '2h',
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { checkin: CheckinEnvelope };
    expect(body.checkin.intervalSeconds).toBe(600);
    expect(body.checkin.priority).toBe('high');
    expect(body.checkin.maxIterations).toBe(4);
    // ttl_expires_at is now + 2h; just check it's in the near future.
    expect(body.checkin.ttlExpiresAt).toBeGreaterThan(Date.now());
  });

  it('POST /checkins rejects invalid interval and priority', async () => {
    const r1 = await fetch(`${baseUrl}/checkins`, {
      method: 'POST',
      headers: adminHeaders(TEAM),
      body: JSON.stringify({ interval: 'not-a-duration' }),
    });
    expect(r1.status).toBe(400);
    expect((await r1.json() as { error: string }).error).toBe('invalid_interval');

    const r2 = await fetch(`${baseUrl}/checkins`, {
      method: 'POST',
      headers: adminHeaders(TEAM),
      body: JSON.stringify({ priority: 'urgent' }),
    });
    expect(r2.status).toBe(400);
    expect((await r2.json() as { error: string }).error).toBe('invalid_priority');
  });

  // -------------------------------------------------------------------------
  // GET /checkins
  // -------------------------------------------------------------------------

  it('GET /checkins lists team-scoped rows and respects owner/status filters', async () => {
    // Seed a few rows with varied owners and statuses.
    const created = await Promise.all([
      fetch(`${baseUrl}/checkins`, {
        method: 'POST', headers: adminHeaders(TEAM),
        body: JSON.stringify({ owner: 'manager', linked_task: 'check-agent-work', priority: 'high' }),
      }).then((r) => r.json() as Promise<{ checkin: CheckinEnvelope }>),
      fetch(`${baseUrl}/checkins`, {
        method: 'POST', headers: adminHeaders(TEAM),
        body: JSON.stringify({ owner: 'coder', priority: 'low' }),
      }).then((r) => r.json() as Promise<{ checkin: CheckinEnvelope }>),
    ]);
    // Manually close one row so we can assert status filtering.
    await fetch(`${baseUrl}/checkins/${created[1].checkin.id}/close`, {
      method: 'POST', headers: adminHeaders(TEAM),
      body: JSON.stringify({ reason: 'seed-close' }),
    });

    // Default: returns all 2 in this team.
    const listAll = await fetch(`${baseUrl}/checkins`, { headers: adminHeaders(TEAM) });
    expect(listAll.status).toBe(200);
    const allBody = (await listAll.json()) as { ok: boolean; checkins: CheckinEnvelope[] };
    expect(allBody.checkins).toHaveLength(2);

    // Filter by owner=manager → only the first row.
    const byOwner = await fetch(`${baseUrl}/checkins?owner=manager`, { headers: adminHeaders(TEAM) });
    const byOwnerBody = (await byOwner.json()) as { checkins: CheckinEnvelope[] };
    expect(byOwnerBody.checkins).toHaveLength(1);
    expect(byOwnerBody.checkins[0].priority).toBe('high');

    // Filter by status=active → drops the closed seed row.
    const active = await fetch(`${baseUrl}/checkins?status=active`, { headers: adminHeaders(TEAM) });
    const activeBody = (await active.json()) as { checkins: CheckinEnvelope[] };
    expect(activeBody.checkins).toHaveLength(1);
    expect(activeBody.checkins[0].status).toBe('active');

    // Bad status surfaces a 400.
    const bad = await fetch(`${baseUrl}/checkins?status=neon`, { headers: adminHeaders(TEAM) });
    expect(bad.status).toBe(400);
  });

  // -------------------------------------------------------------------------
  // POST /checkins/:id/close
  // -------------------------------------------------------------------------

  it('POST /checkins/:id/close closes the row and is idempotent', async () => {
    const create = await fetch(`${baseUrl}/checkins`, {
      method: 'POST', headers: adminHeaders(TEAM),
      body: JSON.stringify({ owner: 'manager', linked_task: 'check-agent-work' }),
    });
    const { checkin } = (await create.json()) as { checkin: CheckinEnvelope };

    const close1 = await fetch(`${baseUrl}/checkins/${checkin.id}/close`, {
      method: 'POST', headers: adminHeaders(TEAM),
      body: JSON.stringify({ reason: 'resolved manually' }),
    });
    expect(close1.status).toBe(200);
    const close1Body = (await close1.json()) as {
      ok: boolean;
      alreadyClosed: boolean;
      checkin: CheckinEnvelope;
    };
    expect(close1Body.alreadyClosed).toBe(false);
    expect(close1Body.checkin.status).toBe('closed');
    expect(close1Body.checkin.closedReason).toBe('resolved manually');
    expect(close1Body.checkin.nextFireAt).toBeNull();

    // Repeat: idempotent, alreadyClosed=true, the original closed_reason is preserved.
    const close2 = await fetch(`${baseUrl}/checkins/${checkin.id}/close`, {
      method: 'POST', headers: adminHeaders(TEAM),
      body: JSON.stringify({ reason: 'second-attempt' }),
    });
    expect(close2.status).toBe(200);
    const close2Body = (await close2.json()) as {
      alreadyClosed: boolean;
      checkin: CheckinEnvelope;
    };
    expect(close2Body.alreadyClosed).toBe(true);
    expect(close2Body.checkin.closedReason).toBe('resolved manually');
  });

  it('POST /checkins/:id/close returns 404 for an unknown id', async () => {
    const res = await fetch(`${baseUrl}/checkins/chk_nope/close`, {
      method: 'POST', headers: adminHeaders(TEAM), body: '{}',
    });
    expect(res.status).toBe(404);
  });

  // -------------------------------------------------------------------------
  // POST /checkins/:id/snooze
  // -------------------------------------------------------------------------

  it('POST /checkins/:id/snooze flips status to snoozed and sets next_fire_at', async () => {
    const create = await fetch(`${baseUrl}/checkins`, {
      method: 'POST', headers: adminHeaders(TEAM),
      body: JSON.stringify({ owner: 'manager', linked_task: 'check-agent-work' }),
    });
    const { checkin } = (await create.json()) as { checkin: CheckinEnvelope };
    expect(checkin.status).toBe('active');

    const before = Date.now();
    const snooze = await fetch(`${baseUrl}/checkins/${checkin.id}/snooze`, {
      method: 'POST', headers: adminHeaders(TEAM),
      body: JSON.stringify({ duration: '30m' }),
    });
    expect(snooze.status).toBe(200);
    const body = (await snooze.json()) as { checkin: CheckinEnvelope };
    expect(body.checkin.status).toBe('snoozed');
    expect(body.checkin.snoozeUntil).not.toBeNull();
    // 30m = 1_800_000 ms; allow 5s slack.
    expect(body.checkin.snoozeUntil!).toBeGreaterThanOrEqual(before + 1_800_000 - 5_000);
    expect(body.checkin.nextFireAt).toBe(body.checkin.snoozeUntil);
  });

  it('POST /checkins/:id/snooze rejects a missing duration', async () => {
    const create = await fetch(`${baseUrl}/checkins`, {
      method: 'POST', headers: adminHeaders(TEAM),
      body: JSON.stringify({ owner: 'manager', linked_task: 'check-agent-work' }),
    });
    const { checkin } = (await create.json()) as { checkin: CheckinEnvelope };

    const r = await fetch(`${baseUrl}/checkins/${checkin.id}/snooze`, {
      method: 'POST', headers: adminHeaders(TEAM), body: '{}',
    });
    expect(r.status).toBe(400);
    expect((await r.json() as { error: string }).error).toBe('missing_duration');
  });

  // -------------------------------------------------------------------------
  // DELETE /checkins/:id  (admin-only)
  // -------------------------------------------------------------------------

  it('DELETE /checkins/:id requires admin (403 for non-admin, 200 for admin)', async () => {
    const create = await fetch(`${baseUrl}/checkins`, {
      method: 'POST', headers: adminHeaders(TEAM),
      body: JSON.stringify({ owner: 'manager', linked_task: 'check-agent-work' }),
    });
    const { checkin } = (await create.json()) as { checkin: CheckinEnvelope };

    // Non-admin caller (no X-Id-Admin header) → 403.
    const denied = await fetch(`${baseUrl}/checkins/${checkin.id}`, {
      method: 'DELETE', headers: nonAdminHeaders(TEAM),
    });
    expect(denied.status).toBe(403);
    expect((await denied.json() as { error: string }).error).toBe('admin_required');

    // Row is still present.
    const stillThere = await db.checkins.get(checkin.id, teamId);
    expect(stillThere).not.toBeNull();

    // Admin caller succeeds.
    const ok = await fetch(`${baseUrl}/checkins/${checkin.id}`, {
      method: 'DELETE', headers: adminHeaders(TEAM),
    });
    expect(ok.status).toBe(200);
    const okBody = (await ok.json()) as { ok: boolean; removed: string };
    expect(okBody.removed).toBe(checkin.id);

    // Row gone.
    const gone = await db.checkins.get(checkin.id, teamId);
    expect(gone).toBeNull();

    // Repeat: 404.
    const second = await fetch(`${baseUrl}/checkins/${checkin.id}`, {
      method: 'DELETE', headers: adminHeaders(TEAM),
    });
    expect(second.status).toBe(404);
  });
});
