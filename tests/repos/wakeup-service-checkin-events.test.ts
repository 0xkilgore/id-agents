// SPDX-License-Identifier: MIT
/**
 * Tests for the checkin lifecycle event producers
 * (output/checkin-primitive-design.md "Event Topics"):
 *
 *   - emitCheckinCreated / emitCheckinClosed / emitCheckinSnoozed each
 *     append exactly one event_log row with the right topic, subject, and
 *     envelope shape
 *   - recordCheckin* companions also stamp `last_event_seq` on the checkin
 *     row to the assigned seq, so downstream readers can resolve the most
 *     recent status-changing event without a topic scan
 *
 * Backed by SQLite in-memory; the same producer module is used by the
 * postgres-backed manager.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import crypto from 'node:crypto';
import { SqliteAdapter } from '../../src/db/sqlite-adapter.js';
import { migrateSqlite } from '../../src/db/migrations/sqlite.js';
import { SqliteTeamsRepo } from '../../src/db/repos/sqlite/teams-repo.js';
import { SqliteEventsRepo } from '../../src/db/repos/sqlite/events-repo.js';
import { SqliteCheckinsRepo } from '../../src/db/repos/sqlite/checkins-repo.js';
import {
  emitCheckinCreated,
  emitCheckinClosed,
  emitCheckinSnoozed,
  recordCheckinCreated,
  recordCheckinClosed,
  recordCheckinSnoozed,
  CHECKIN_CREATED,
  CHECKIN_CLOSED,
  CHECKIN_SNOOZED,
} from '../../src/wakeup-service/event-producer.js';
import type { CheckinRow } from '../../src/db/types.js';

async function freshDb() {
  const adapter = new SqliteAdapter(':memory:');
  await migrateSqlite(adapter);
  return adapter;
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
  const now = Math.floor(Date.now() / 1000);
  await adapter.query(
    `INSERT INTO tasks (id, name, uuid, team_id, title, status, owner, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, name, crypto.randomUUID(), teamId, `Title for ${name}`, 'todo', ownerId, now, now],
  );
  return id;
}

function buildCheckinRow(overrides: Partial<CheckinRow> & Pick<CheckinRow, 'id' | 'team_id'>): CheckinRow {
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

describe('event-producer: checkin lifecycle', () => {
  let adapter: SqliteAdapter;
  let events: SqliteEventsRepo;
  let checkins: SqliteCheckinsRepo;
  let teamId: string;
  let ownerId: string;
  let taskId: string;

  beforeEach(async () => {
    adapter = await freshDb();
    events = new SqliteEventsRepo(adapter);
    checkins = new SqliteCheckinsRepo(adapter);
    teamId = await new SqliteTeamsRepo(adapter).getOrCreateTeamId('default');
    ownerId = await insertAgent(adapter, teamId, 'manager');
    taskId = await insertTask(adapter, teamId, 'check-agent-work', ownerId);
  });

  // -------------------------------------------------------------------------
  // checkin:created
  // -------------------------------------------------------------------------

  it('emitCheckinCreated writes one checkin:created row with the design envelope', async () => {
    const checkinId = 'chk_create_1';
    const occurredAt = 1_777_100_000;

    const { seq } = await emitCheckinCreated(events, {
      teamId,
      checkinId,
      ownerAgentId: ownerId,
      createdByAgentId: ownerId,
      linkedTaskId: taskId,
      priority: 'high',
      intervalSeconds: 600,
      maxIterations: 8,
      nextFireAt: occurredAt + 600,
      ttlExpiresAt: occurredAt + 24 * 3600,
      occurredAt,
    });

    const rows = await events.query({ teamId, topics: [CHECKIN_CREATED] });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      seq,
      team_id: teamId,
      topic: CHECKIN_CREATED,
      actor_agent_id: ownerId,
      subject_kind: 'checkin',
      subject_id: checkinId,
      occurred_at: occurredAt,
      data: {
        checkin_id: checkinId,
        status: 'active',
        owner: ownerId,
        linked_task_id: taskId,
        priority: 'high',
        interval_seconds: 600,
        max_iterations: 8,
        next_fire_at: occurredAt + 600,
        ttl_expires_at: occurredAt + 24 * 3600,
        created_at: occurredAt,
      },
    });
  });

  it('recordCheckinCreated stamps last_event_seq on the checkin row', async () => {
    const checkinId = 'chk_create_2';
    const occurredAt = 1_777_100_500;

    await checkins.create(buildCheckinRow({
      id: checkinId,
      team_id: teamId,
      owner_agent_id: ownerId,
      created_by_agent_id: ownerId,
      linked_task_id: taskId,
      priority: 'normal',
      interval_seconds: 900,
      next_fire_at: occurredAt + 900,
      ttl_expires_at: occurredAt + 24 * 3600,
      created_at: occurredAt,
      updated_at: occurredAt,
    }));

    const before = await checkins.get(checkinId, teamId);
    expect(before?.last_event_seq).toBeNull();

    const { seq } = await recordCheckinCreated(events, checkins, {
      teamId,
      checkinId,
      ownerAgentId: ownerId,
      createdByAgentId: ownerId,
      linkedTaskId: taskId,
      priority: 'normal',
      intervalSeconds: 900,
      maxIterations: null,
      nextFireAt: occurredAt + 900,
      ttlExpiresAt: occurredAt + 24 * 3600,
      occurredAt,
    });

    const after = await checkins.get(checkinId, teamId);
    expect(after?.last_event_seq).toBe(seq);
    expect(after?.updated_at).toBe(occurredAt);

    const eventRows = await events.query({ teamId, topics: [CHECKIN_CREATED] });
    expect(eventRows).toHaveLength(1);
    expect(eventRows[0].seq).toBe(seq);
  });

  // -------------------------------------------------------------------------
  // checkin:closed
  // -------------------------------------------------------------------------

  it('emitCheckinClosed writes one checkin:closed row carrying reason and closed_at', async () => {
    const checkinId = 'chk_close_1';
    const occurredAt = 1_777_200_000;

    const { seq } = await emitCheckinClosed(events, {
      teamId,
      checkinId,
      ownerAgentId: ownerId,
      linkedTaskId: taskId,
      reason: 'task_terminal',
      terminalTopic: 'task:completed',
      taskStatus: 'done',
      occurredAt,
    });

    const rows = await events.query({ teamId, topics: [CHECKIN_CLOSED] });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      seq,
      team_id: teamId,
      topic: CHECKIN_CLOSED,
      actor_agent_id: ownerId,
      subject_kind: 'checkin',
      subject_id: checkinId,
      occurred_at: occurredAt,
      data: {
        checkin_id: checkinId,
        status: 'closed',
        owner: ownerId,
        linked_task_id: taskId,
        reason: 'task_terminal',
        closed_at: occurredAt,
        terminal_topic: 'task:completed',
        task_status: 'done',
      },
    });
  });

  it('emitCheckinClosed omits optional terminal fields when not provided', async () => {
    const checkinId = 'chk_close_2';
    const occurredAt = 1_777_200_500;

    await emitCheckinClosed(events, {
      teamId,
      checkinId,
      ownerAgentId: ownerId,
      linkedTaskId: null,
      reason: 'manual',
      occurredAt,
    });

    const [row] = await events.query({ teamId, topics: [CHECKIN_CLOSED] });
    const data = row.data as Record<string, unknown>;
    expect(data.reason).toBe('manual');
    expect(data.terminal_topic).toBeUndefined();
    expect(data.task_status).toBeUndefined();
  });

  it('recordCheckinClosed stamps last_event_seq on the checkin row', async () => {
    const checkinId = 'chk_close_3';
    const createdAt = 1_777_201_000;
    const closedAt = 1_777_202_000;

    await checkins.create(buildCheckinRow({
      id: checkinId,
      team_id: teamId,
      owner_agent_id: ownerId,
      linked_task_id: taskId,
      created_at: createdAt,
      updated_at: createdAt,
    }));

    // Simulate the manual-close path: repo.close() flips state, then we record
    // the audit event and stamp last_event_seq.
    const closed = await checkins.close(checkinId, teamId, closedAt, 'manual');
    expect(closed).toBe(true);

    const { seq } = await recordCheckinClosed(events, checkins, {
      teamId,
      checkinId,
      ownerAgentId: ownerId,
      linkedTaskId: taskId,
      actorAgentId: ownerId,
      reason: 'manual',
      occurredAt: closedAt,
    });

    const after = await checkins.get(checkinId, teamId);
    expect(after?.status).toBe('closed');
    expect(after?.closed_reason).toBe('manual');
    expect(after?.closed_at).toBe(closedAt);
    expect(after?.last_event_seq).toBe(seq);
  });

  // -------------------------------------------------------------------------
  // checkin:snoozed
  // -------------------------------------------------------------------------

  it('emitCheckinSnoozed writes one checkin:snoozed row with snooze_until', async () => {
    const checkinId = 'chk_snooze_1';
    const occurredAt = 1_777_300_000;
    const snoozeUntil = occurredAt + 1800;

    const { seq } = await emitCheckinSnoozed(events, {
      teamId,
      checkinId,
      ownerAgentId: ownerId,
      linkedTaskId: taskId,
      actorAgentId: ownerId,
      snoozeUntil,
      nextFireAt: snoozeUntil,
      occurredAt,
    });

    const rows = await events.query({ teamId, topics: [CHECKIN_SNOOZED] });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      seq,
      team_id: teamId,
      topic: CHECKIN_SNOOZED,
      actor_agent_id: ownerId,
      subject_kind: 'checkin',
      subject_id: checkinId,
      occurred_at: occurredAt,
      data: {
        checkin_id: checkinId,
        status: 'snoozed',
        owner: ownerId,
        linked_task_id: taskId,
        snooze_until: snoozeUntil,
        next_fire_at: snoozeUntil,
      },
    });
  });

  it('recordCheckinSnoozed updates last_event_seq alongside the snooze', async () => {
    const checkinId = 'chk_snooze_2';
    const createdAt = 1_777_300_500;
    const snoozedAt = 1_777_300_700;
    const snoozeUntil = snoozedAt + 600;

    await checkins.create(buildCheckinRow({
      id: checkinId,
      team_id: teamId,
      owner_agent_id: ownerId,
      linked_task_id: taskId,
      next_fire_at: createdAt + 900,
      created_at: createdAt,
      updated_at: createdAt,
    }));

    // Simulate the manual-snooze path: caller flips status/snooze_until/
    // next_fire_at, then records the audit event and stamps last_event_seq.
    await checkins.updateFields(checkinId, teamId, {
      status: 'snoozed',
      snooze_until: snoozeUntil,
      next_fire_at: snoozeUntil,
      updated_at: snoozedAt,
    });

    const { seq } = await recordCheckinSnoozed(events, checkins, {
      teamId,
      checkinId,
      ownerAgentId: ownerId,
      linkedTaskId: taskId,
      actorAgentId: ownerId,
      snoozeUntil,
      nextFireAt: snoozeUntil,
      occurredAt: snoozedAt,
    });

    const after = await checkins.get(checkinId, teamId);
    expect(after?.status).toBe('snoozed');
    expect(after?.snooze_until).toBe(snoozeUntil);
    expect(after?.next_fire_at).toBe(snoozeUntil);
    expect(after?.last_event_seq).toBe(seq);
    expect(after?.updated_at).toBe(snoozedAt);
  });

  // -------------------------------------------------------------------------
  // Cross-cutting: monotonic seq across the lifecycle
  // -------------------------------------------------------------------------

  it('lifecycle emits produce monotonically increasing seq values', async () => {
    const checkinId = 'chk_lifecycle';
    const t0 = 1_777_400_000;

    await checkins.create(buildCheckinRow({
      id: checkinId,
      team_id: teamId,
      owner_agent_id: ownerId,
      linked_task_id: taskId,
      next_fire_at: t0 + 900,
      created_at: t0,
      updated_at: t0,
    }));

    const created = await recordCheckinCreated(events, checkins, {
      teamId,
      checkinId,
      ownerAgentId: ownerId,
      createdByAgentId: ownerId,
      linkedTaskId: taskId,
      priority: 'normal',
      intervalSeconds: 900,
      maxIterations: null,
      nextFireAt: t0 + 900,
      ttlExpiresAt: null,
      occurredAt: t0,
    });

    const snoozed = await recordCheckinSnoozed(events, checkins, {
      teamId,
      checkinId,
      ownerAgentId: ownerId,
      linkedTaskId: taskId,
      snoozeUntil: t0 + 1800,
      nextFireAt: t0 + 1800,
      occurredAt: t0 + 60,
    });

    const closed = await recordCheckinClosed(events, checkins, {
      teamId,
      checkinId,
      ownerAgentId: ownerId,
      linkedTaskId: taskId,
      reason: 'manual',
      occurredAt: t0 + 120,
    });

    expect(created.seq).toBeLessThan(snoozed.seq);
    expect(snoozed.seq).toBeLessThan(closed.seq);

    const after = await checkins.get(checkinId, teamId);
    expect(after?.last_event_seq).toBe(closed.seq);

    const all = await events.query({
      teamId,
      topics: [CHECKIN_CREATED, CHECKIN_SNOOZED, CHECKIN_CLOSED],
    });
    expect(all.map((r) => r.topic)).toEqual([
      CHECKIN_CREATED,
      CHECKIN_SNOOZED,
      CHECKIN_CLOSED,
    ]);
  });
});
