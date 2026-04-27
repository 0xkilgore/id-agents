// SPDX-License-Identifier: MIT
/**
 * Integration tests for the checkin due-service tick (slice C4).
 *
 * Drives `CheckinService.tick(now)` directly against an in-memory SQLite
 * stack (avoids real timers). Covers:
 *
 *   - fire cadence: a single tick increments iteration_count and advances
 *     next_fire_at by interval_seconds; it also writes a news row to the
 *     owner's inbox and emits `checkin:due` into event_log
 *   - max_iterations: a row that hits its cap transitions to `expired` and
 *     emits `checkin:expired` with reason `max_iterations`; no further fires
 *   - ttl_expires_at: a row past TTL is hard-expired without a fire and
 *     emits `checkin:expired` with reason `ttl`
 *   - snooze respect: a snoozed row whose snooze_until is still in the
 *     future is skipped; one whose snooze_until has passed flips back to
 *     active and fires
 *
 * Auth/HTTP is out of scope for this slice.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';

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

async function insertAgent(adapter: SqliteAdapter, teamId: string, name: string): Promise<string> {
  const id = `agent_${crypto.randomUUID()}`;
  await adapter.query(
    `INSERT INTO agents (team_id, id, name, type, model, port, status, created_at, runtime)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [teamId, id, name, 'persistent', 'claude-opus', 24000, 'active', Date.now(), 'claude-code'],
  );
  return id;
}

async function insertTask(
  adapter: SqliteAdapter,
  teamId: string,
  name: string,
  ownerId: string | null = null,
): Promise<string> {
  const id = `task_${crypto.randomUUID()}`;
  const updatedAtSec = Math.floor(Date.now() / 1000);
  await adapter.query(
    `INSERT INTO tasks (id, name, uuid, team_id, title, status, owner, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, name, crypto.randomUUID(), teamId, `Title for ${name}`, 'doing', ownerId, updatedAtSec, updatedAtSec],
  );
  return id;
}

function buildRow(overrides: Partial<CheckinRow> & Pick<CheckinRow, 'id' | 'team_id'>): CheckinRow {
  const now = Date.now();
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
    next_fire_at: now,
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

describe('CheckinService.tick', () => {
  let db: ReturnType<typeof createInMemoryDb>;
  let svc: CheckinService;
  let teamId: string;
  let ownerId: string;
  let taskId: string;

  beforeEach(async () => {
    db = createInMemoryDb();
    svc = new CheckinService(db as any);
    teamId = await db.teams.getOrCreateTeamId('checkin-due');
    ownerId = await insertAgent(db.adapter, teamId, 'manager');
    const assigneeId = await insertAgent(db.adapter, teamId, 'coder');
    taskId = await insertTask(db.adapter, teamId, 'check-agent-work', assigneeId);
  });

  afterEach(async () => {
    svc.stop();
    await db.close();
  });

  it('fires a due row: increments iteration_count, advances next_fire_at, writes news + checkin:due event', async () => {
    const now = 1_777_500_000_000;
    await db.checkins.create(buildRow({
      id: 'chk_fire',
      team_id: teamId,
      owner_agent_id: ownerId,
      linked_task_id: taskId,
      interval_seconds: 600,
      next_fire_at: now - 1, // due
      created_at: now - 10_000,
      updated_at: now - 10_000,
    }));

    const result = await svc.tick(now);
    expect(result).toMatchObject({ scanned: 1, fired: 1, expired: 0, errors: 0 });

    const row = await db.checkins.get('chk_fire', teamId);
    expect(row).not.toBeNull();
    expect(row!.status).toBe('active');
    expect(row!.iteration_count).toBe(1);
    expect(row!.next_fire_at).toBe(now + 600 * 1000);
    expect(row!.last_fire_at).toBe(now);
    expect(row!.last_event_seq).not.toBeNull();

    // checkin:due event was emitted with the documented envelope keys.
    const events = await db.events.query({ teamId, topics: ['checkin:due'] });
    expect(events).toHaveLength(1);
    expect(events[0].subject_id).toBe('chk_fire');
    expect(events[0].data).toMatchObject({
      checkin_id: 'chk_fire',
      iteration_count: 1,
      interval_seconds: 600,
      next_fire_at: now + 600 * 1000,
    });
    expect((events[0].data as any).linked_task).toMatchObject({
      id: taskId,
      name: 'check-agent-work',
      status: 'doing',
      assignee: 'coder',
    });
    expect((events[0].data as any).actions).toMatchObject({
      inspect: '/checkins/chk_fire/inspect',
    });

    // News item landed in the owner's inbox. (poll() doesn't return the
    // kind/reply_expected columns; they live on the row in the DB but
    // aren't projected here. Verify the type + payload instead.)
    const news = await db.news.poll(ownerId, 0);
    expect(news.length).toBe(1);
    expect(news[0].type).toBe('checkin_due');
    const data = news[0].data as Record<string, any>;
    expect(data.checkin_id).toBe('chk_fire');
    expect(data.linked_task.id).toBe(taskId);
    expect(typeof data.linked_task.idle_ms).toBe('number');
  });

  it('expires the row when iteration_count >= max_iterations and emits checkin:expired', async () => {
    const now = 1_777_500_010_000;
    await db.checkins.create(buildRow({
      id: 'chk_max',
      team_id: teamId,
      owner_agent_id: ownerId,
      linked_task_id: taskId,
      interval_seconds: 60,
      max_iterations: 2,
      iteration_count: 1, // one fire away from the cap
      next_fire_at: now - 1,
      created_at: now - 1000,
      updated_at: now - 1000,
    }));

    const result = await svc.tick(now);
    expect(result.fired).toBe(1);
    expect(result.expired).toBe(1);

    const row = await db.checkins.get('chk_max', teamId);
    expect(row!.status).toBe('expired');
    expect(row!.iteration_count).toBe(2);
    expect(row!.next_fire_at).toBeNull();
    expect(row!.closed_reason).toBe('max_iterations');
    expect(row!.closed_at).toBe(now);

    const dueEvents = await db.events.query({ teamId, topics: ['checkin:due'] });
    const expEvents = await db.events.query({ teamId, topics: ['checkin:expired'] });
    expect(dueEvents).toHaveLength(1);
    expect(expEvents).toHaveLength(1);
    expect(expEvents[0].data).toMatchObject({
      checkin_id: 'chk_max',
      reason: 'max_iterations',
      iteration_count: 2,
      max_iterations: 2,
    });

    // A subsequent tick should be a no-op for this row.
    const result2 = await svc.tick(now + 60_000);
    expect(result2.scanned).toBe(0);
  });

  it('hard-expires a TTL-past row without firing', async () => {
    const now = 1_777_500_020_000;
    await db.checkins.create(buildRow({
      id: 'chk_ttl',
      team_id: teamId,
      owner_agent_id: ownerId,
      linked_task_id: taskId,
      interval_seconds: 60,
      iteration_count: 0,
      next_fire_at: now - 1,
      ttl_expires_at: now - 100, // already past TTL
      created_at: now - 5000,
      updated_at: now - 5000,
    }));

    const result = await svc.tick(now);
    expect(result.fired).toBe(0);
    expect(result.expired).toBe(1);

    const row = await db.checkins.get('chk_ttl', teamId);
    expect(row!.status).toBe('expired');
    expect(row!.iteration_count).toBe(0); // no fire, count unchanged
    expect(row!.closed_reason).toBe('ttl');
    expect(row!.next_fire_at).toBeNull();

    const dueEvents = await db.events.query({ teamId, topics: ['checkin:due'] });
    const expEvents = await db.events.query({ teamId, topics: ['checkin:expired'] });
    expect(dueEvents).toHaveLength(0);
    expect(expEvents).toHaveLength(1);
    expect(expEvents[0].data).toMatchObject({ reason: 'ttl' });

    // No news for hard-expired rows.
    const news = await db.news.poll(ownerId, 0);
    expect(news).toHaveLength(0);
  });

  it('respects snooze: skips a row whose snooze_until is still in the future, fires once it has passed', async () => {
    const t0 = 1_777_500_030_000;
    const snoozeUntil = t0 + 5 * 60_000;

    await db.checkins.create(buildRow({
      id: 'chk_snz',
      team_id: teamId,
      owner_agent_id: ownerId,
      linked_task_id: taskId,
      interval_seconds: 600,
      status: 'snoozed',
      next_fire_at: snoozeUntil,
      snooze_until: snoozeUntil,
      created_at: t0 - 1000,
      updated_at: t0 - 1000,
    }));

    // First tick: now < snooze_until → claimDue returns nothing.
    const r1 = await svc.tick(t0);
    expect(r1).toMatchObject({ scanned: 0, fired: 0, expired: 0 });
    const stillSnoozed = await db.checkins.get('chk_snz', teamId);
    expect(stillSnoozed!.status).toBe('snoozed');
    expect(stillSnoozed!.iteration_count).toBe(0);

    // Second tick after snooze elapses: row flips back to active and fires.
    const t1 = snoozeUntil + 1;
    const r2 = await svc.tick(t1);
    expect(r2).toMatchObject({ scanned: 1, fired: 1, expired: 0 });
    const fired = await db.checkins.get('chk_snz', teamId);
    expect(fired!.status).toBe('active');
    expect(fired!.snooze_until).toBeNull();
    expect(fired!.iteration_count).toBe(1);
    expect(fired!.next_fire_at).toBe(t1 + 600 * 1000);
  });

  it('does not write news when owner_agent_id is null', async () => {
    const now = 1_777_500_040_000;
    await db.checkins.create(buildRow({
      id: 'chk_no_owner',
      team_id: teamId,
      owner_agent_id: null,
      linked_task_id: taskId,
      next_fire_at: now - 1,
      created_at: now - 1000,
      updated_at: now - 1000,
    }));

    const result = await svc.tick(now);
    expect(result.fired).toBe(1);

    // News for the original ownerId should be untouched.
    const news = await db.news.poll(ownerId, 0);
    expect(news).toHaveLength(0);

    // The checkin:due event still fires.
    const events = await db.events.query({ teamId, topics: ['checkin:due'] });
    expect(events).toHaveLength(1);
  });
});
