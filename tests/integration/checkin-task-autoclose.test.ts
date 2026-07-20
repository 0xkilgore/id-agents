// SPDX-License-Identifier: MIT
/**
 * Integration tests for the checkin auto-close hook
 * (output/checkin-primitive-design.md → "Auto-Close Logic").
 *
 *   - POST /tasks/:ref/done flips linked active checkins to status='closed'
 *     with closed_reason='linked_task_terminal' and clears scheduling fields
 *   - One `checkin:closed` event is emitted per closed row, with
 *     last_event_seq stamped on the row to the emitted seq
 *   - Snoozed linked checkins are closed too
 *   - Already-closed/expired linked checkins are not re-closed and do not
 *     produce duplicate events
 *   - Checkins linked to other tasks (or in other teams) are unaffected
 *
 * Boots the real AgentManagerDb so the wakeup-service producer + the new
 * autoclose consumer run end-to-end against an in-memory SQLite database.
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
import { CHECKIN_CLOSED, TASK_COMPLETED } from '../../src/wakeup-service/event-producer.js';
import type { CheckinRow } from '../../src/db/types.js';

const TEAM = 'checkin-autoclose-test';

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
  ownerId: string | null = null,
): Promise<{ id: string; uuid: string }> {
  const id = `task_${crypto.randomUUID()}`;
  const uuid = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  await db.adapter.query(
    `INSERT INTO tasks (id, name, uuid, team_id, title, status, owner, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, name, uuid, teamId, `Title for ${name}`, 'doing', ownerId, now, now],
  );
  return { id, uuid };
}

function buildCheckinRow(
  overrides: Partial<CheckinRow> & Pick<CheckinRow, 'id' | 'team_id'>,
): CheckinRow {
  const now = Math.floor(Date.now() / 1000);
  return {
    owner_agent_id: null,
    created_by_agent_id: null,
    linked_task_id: null,
    interval_seconds: 900,
    priority: 'normal',
    status: 'active',
    close_when: { task_status: ['done'] },
    max_iterations: null,
    iteration_count: 0,
    next_fire_at: now + 900,
    snooze_until: null,
    ttl_expires_at: null,
    last_fire_at: null,
    last_event_seq: null,
    note: null,
    created_at: now,
    updated_at: now,
    closed_at: null,
    closed_reason: null,
    ...overrides,
  };
}

describe('Checkin auto-close on terminal task event', () => {
  let manager: AgentManagerDb;
  let db: Awaited<ReturnType<typeof createInMemoryDb>>;
  let baseUrl: string;
  let workDir: string;
  let teamId: string;
  let otherTeamId: string;
  let coderAgentId: string;
  let managerAgentId: string;

  beforeAll(async () => {
    const port = await findFreePort();
    baseUrl = `http://127.0.0.1:${port}`;
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'checkin-autoclose-test-'));
    db = await createInMemoryDb();
    manager = new AgentManagerDb(workDir, db as any);
    await manager.start(port);
    teamId = await db.teams.getOrCreateTeamId(TEAM);
    otherTeamId = await db.teams.getOrCreateTeamId('other-team');
    managerAgentId = await insertAgentDirect(db, teamId, 'manager');
    coderAgentId = await insertAgentDirect(db, teamId, 'coder');
  }, 120000);

  afterAll(async () => {
    if (manager) await stopManager(manager);
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  beforeEach(async () => {
    await db.adapter.query(`DELETE FROM checkins`);
    await db.adapter.query(`DELETE FROM tasks`);
    await db.adapter.query(`DELETE FROM event_log`);
  });

  it('closes a linked active checkin and emits one checkin:closed event', async () => {
    const task = await insertTaskDirect(db, teamId, 'autoclose-active', coderAgentId);
    const checkinId = `chk_${crypto.randomUUID()}`;
    await db.checkins.create(buildCheckinRow({
      id: checkinId,
      team_id: teamId,
      owner_agent_id: managerAgentId,
      linked_task_id: task.id,
      status: 'active',
    }));

    const res = await fetch(`${baseUrl}/tasks/autoclose-active/done`, {
      method: 'POST',
      headers: adminHeaders(TEAM),
      body: JSON.stringify({ agent_id: 'coder' }),
    });
    expect(res.status).toBe(200);

    const closed = await db.checkins.get(checkinId, teamId);
    expect(closed?.status).toBe('closed');
    expect(closed?.closed_reason).toBe('linked_task_terminal');
    expect(closed?.closed_at).toBeGreaterThan(0);
    expect(closed?.next_fire_at).toBeNull();
    expect(closed?.snooze_until).toBeNull();

    const events = await db.events.query({ teamId, topics: [CHECKIN_CLOSED] });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      team_id: teamId,
      topic: CHECKIN_CLOSED,
      subject_kind: 'checkin',
      subject_id: checkinId,
      data: {
        checkin_id: checkinId,
        status: 'closed',
        owner: managerAgentId,
        linked_task_id: task.id,
        reason: 'linked_task_terminal',
        terminal_topic: TASK_COMPLETED,
        task_status: 'done',
      },
    });

    // last_event_seq stamped on the row matches the emitted event seq
    expect(closed?.last_event_seq).toBe(events[0].seq);

    // task:completed was also written (the trigger), so both topics live in the log
    const completed = await db.events.query({ teamId, topics: [TASK_COMPLETED] });
    expect(completed).toHaveLength(1);
  });

  it('closes a linked snoozed checkin and clears snooze_until', async () => {
    const task = await insertTaskDirect(db, teamId, 'autoclose-snoozed', coderAgentId);
    const checkinId = `chk_${crypto.randomUUID()}`;
    const snoozeUntil = Date.now() + 60_000;
    await db.checkins.create(buildCheckinRow({
      id: checkinId,
      team_id: teamId,
      owner_agent_id: managerAgentId,
      linked_task_id: task.id,
      status: 'snoozed',
      snooze_until: snoozeUntil,
      next_fire_at: snoozeUntil,
    }));

    const res = await fetch(`${baseUrl}/tasks/autoclose-snoozed/done`, {
      method: 'POST',
      headers: adminHeaders(TEAM),
      body: JSON.stringify({ agent_id: 'coder' }),
    });
    expect(res.status).toBe(200);

    const closed = await db.checkins.get(checkinId, teamId);
    expect(closed?.status).toBe('closed');
    expect(closed?.snooze_until).toBeNull();
    expect(closed?.next_fire_at).toBeNull();
    expect(closed?.closed_reason).toBe('linked_task_terminal');

    const events = await db.events.query({ teamId, topics: [CHECKIN_CLOSED] });
    expect(events).toHaveLength(1);
  });

  it('closes every linked active/snoozed checkin and emits one event per row', async () => {
    const task = await insertTaskDirect(db, teamId, 'autoclose-multi', coderAgentId);
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const id = `chk_multi_${i}_${crypto.randomUUID()}`;
      ids.push(id);
      await db.checkins.create(buildCheckinRow({
        id,
        team_id: teamId,
        owner_agent_id: managerAgentId,
        linked_task_id: task.id,
        status: i === 1 ? 'snoozed' : 'active',
      }));
    }

    const res = await fetch(`${baseUrl}/tasks/autoclose-multi/done`, {
      method: 'POST',
      headers: adminHeaders(TEAM),
      body: JSON.stringify({ agent_id: 'coder' }),
    });
    expect(res.status).toBe(200);

    for (const id of ids) {
      const row = await db.checkins.get(id, teamId);
      expect(row?.status).toBe('closed');
      expect(row?.closed_reason).toBe('linked_task_terminal');
      expect(row?.last_event_seq).toBeGreaterThan(0);
    }

    const events = await db.events.query({ teamId, topics: [CHECKIN_CLOSED] });
    expect(events).toHaveLength(3);
    expect(events.map((e) => e.subject_id).sort()).toEqual([...ids].sort());

    // Every emitted seq is stamped onto exactly one row's last_event_seq
    const seqs = events.map((e) => e.seq).sort((a, b) => a - b);
    const stamped = await Promise.all(
      ids.map((id) => db.checkins.get(id, teamId).then((r) => r!.last_event_seq!)),
    );
    expect(stamped.sort((a, b) => a - b)).toEqual(seqs);
  });

  it('does not re-close already-terminal checkins or emit duplicate events', async () => {
    const task = await insertTaskDirect(db, teamId, 'autoclose-terminal', coderAgentId);
    const activeId = `chk_active_${crypto.randomUUID()}`;
    const alreadyClosedId = `chk_closed_${crypto.randomUUID()}`;
    const expiredId = `chk_expired_${crypto.randomUUID()}`;

    const preCloseAt = Date.now() - 60_000;
    await db.checkins.create(buildCheckinRow({
      id: activeId,
      team_id: teamId,
      owner_agent_id: managerAgentId,
      linked_task_id: task.id,
      status: 'active',
    }));
    await db.checkins.create(buildCheckinRow({
      id: alreadyClosedId,
      team_id: teamId,
      owner_agent_id: managerAgentId,
      linked_task_id: task.id,
      status: 'closed',
      closed_at: preCloseAt,
      closed_reason: 'manual',
      next_fire_at: null,
    }));
    await db.checkins.create(buildCheckinRow({
      id: expiredId,
      team_id: teamId,
      owner_agent_id: managerAgentId,
      linked_task_id: task.id,
      status: 'expired',
      closed_at: preCloseAt,
      closed_reason: 'ttl',
      next_fire_at: null,
    }));

    const res = await fetch(`${baseUrl}/tasks/autoclose-terminal/done`, {
      method: 'POST',
      headers: adminHeaders(TEAM),
      body: JSON.stringify({ agent_id: 'coder' }),
    });
    expect(res.status).toBe(200);

    // Only the active row transitions; the already-terminal rows are untouched.
    const active = await db.checkins.get(activeId, teamId);
    expect(active?.status).toBe('closed');
    expect(active?.closed_reason).toBe('linked_task_terminal');

    const stillClosed = await db.checkins.get(alreadyClosedId, teamId);
    expect(stillClosed?.closed_reason).toBe('manual');
    expect(stillClosed?.closed_at).toBe(preCloseAt);

    const stillExpired = await db.checkins.get(expiredId, teamId);
    expect(stillExpired?.status).toBe('expired');
    expect(stillExpired?.closed_reason).toBe('ttl');

    // Exactly one checkin:closed event — the previously closed/expired rows
    // do not re-emit.
    const events = await db.events.query({ teamId, topics: [CHECKIN_CLOSED] });
    expect(events).toHaveLength(1);
    expect(events[0].subject_id).toBe(activeId);

    const restartedService = new CheckinService(db as any);
    expect(await restartedService.tickTeam(teamId, Date.now() + 60_000)).toMatchObject({
      scanned: 0, fired: 0, expired: 0, errors: 0,
    });
    expect(await db.events.query({ teamId, topics: [CHECKIN_CLOSED] })).toHaveLength(1);
  });

  it('reconciles a terminal linked task before another due receipt, idempotently', async () => {
    const task = await insertTaskDirect(db, teamId, 'autoclose-before-due', coderAgentId);
    const checkinId = `chk_due_${crypto.randomUUID()}`;
    const dueAt = Date.now() - 1_000;
    await db.checkins.create(buildCheckinRow({
      id: checkinId,
      team_id: teamId,
      owner_agent_id: managerAgentId,
      linked_task_id: task.id,
      next_fire_at: dueAt,
    }));
    await db.adapter.query(
      `UPDATE tasks SET status = 'done', updated_at = ? WHERE id = ? AND team_id = ?`,
      [Math.floor(Date.now() / 1000), task.id, teamId],
    );

    const firstService = new CheckinService(db as any);
    const first = await firstService.tickTeam(teamId, Date.now());
    expect(first).toMatchObject({ scanned: 0, fired: 0, expired: 0, errors: 0 });
    expect(await db.checkins.get(checkinId, teamId)).toMatchObject({
      status: 'closed',
      closed_reason: 'canonical_task_terminal',
      next_fire_at: null,
    });
    expect(await db.events.query({ teamId, topics: ['checkin:due'] })).toHaveLength(0);

    // A fresh service models restart/repeated reconciliation. The already
    // terminal row remains closed and no close/due events are duplicated.
    const restartedService = new CheckinService(db as any);
    const repeated = await restartedService.tickTeam(teamId, Date.now() + 60_000);
    expect(repeated).toMatchObject({ scanned: 0, fired: 0, expired: 0, errors: 0 });
    expect(await db.events.query({ teamId, topics: [CHECKIN_CLOSED] })).toHaveLength(0);
    expect(await db.events.query({ teamId, topics: ['checkin:due'] })).toHaveLength(0);
  });

  it('does not touch checkins linked to other tasks or in other teams', async () => {
    const taskA = await insertTaskDirect(db, teamId, 'autoclose-isolated', coderAgentId);
    const taskB = await insertTaskDirect(db, teamId, 'unrelated-task', coderAgentId);

    const linkedA = `chk_a_${crypto.randomUUID()}`;
    const linkedB = `chk_b_${crypto.randomUUID()}`;
    const unlinked = `chk_u_${crypto.randomUUID()}`;
    const otherTeamSameTaskShape = `chk_o_${crypto.randomUUID()}`;

    await db.checkins.create(buildCheckinRow({
      id: linkedA, team_id: teamId, owner_agent_id: managerAgentId,
      linked_task_id: taskA.id, status: 'active',
    }));
    await db.checkins.create(buildCheckinRow({
      id: linkedB, team_id: teamId, owner_agent_id: managerAgentId,
      linked_task_id: taskB.id, status: 'active',
    }));
    await db.checkins.create(buildCheckinRow({
      id: unlinked, team_id: teamId, owner_agent_id: managerAgentId,
      linked_task_id: null, status: 'active',
    }));
    // A checkin in another team — different team id, different task id.
    const otherTeamTask = await insertTaskDirect(db, otherTeamId, 'isolated-other', null);
    await db.checkins.create(buildCheckinRow({
      id: otherTeamSameTaskShape, team_id: otherTeamId, owner_agent_id: null,
      linked_task_id: otherTeamTask.id, status: 'active',
    }));

    const res = await fetch(`${baseUrl}/tasks/autoclose-isolated/done`, {
      method: 'POST',
      headers: adminHeaders(TEAM),
      body: JSON.stringify({ agent_id: 'coder' }),
    });
    expect(res.status).toBe(200);

    expect((await db.checkins.get(linkedA, teamId))?.status).toBe('closed');
    expect((await db.checkins.get(linkedB, teamId))?.status).toBe('active');
    expect((await db.checkins.get(unlinked, teamId))?.status).toBe('active');
    expect((await db.checkins.get(otherTeamSameTaskShape, otherTeamId))?.status).toBe('active');

    const ourEvents = await db.events.query({ teamId, topics: [CHECKIN_CLOSED] });
    expect(ourEvents).toHaveLength(1);
    expect(ourEvents[0].subject_id).toBe(linkedA);

    const otherEvents = await db.events.query({ teamId: otherTeamId, topics: [CHECKIN_CLOSED] });
    expect(otherEvents).toHaveLength(0);
  });
});
