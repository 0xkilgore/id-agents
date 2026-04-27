// SPDX-License-Identifier: MIT
/**
 * Tests for the checkin-schema slice (output/checkin-primitive-design.md C1):
 *
 *   - SqliteCheckinsRepo.create / get / list with all filter combinations
 *   - updateFields patches only the supplied keys (and stamps updated_at)
 *   - close is idempotent and clears next_fire_at / snooze_until
 *   - closeForTerminalTask bulk-closes only same-team active/snoozed rows
 *   - claimDue returns due active/snoozed rows ordered by next_fire_at
 *   - same-team task link is enforced at create and updateFields time
 *
 * Backed by SQLite in-memory; the postgres repo shares the same SQL shape.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import crypto from 'node:crypto';
import { SqliteAdapter } from '../../src/db/sqlite-adapter.js';
import { migrateSqlite } from '../../src/db/migrations/sqlite.js';
import { SqliteTeamsRepo } from '../../src/db/repos/sqlite/teams-repo.js';
import { SqliteCheckinsRepo } from '../../src/db/repos/sqlite/checkins-repo.js';
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

function buildRow(overrides: Partial<CheckinRow> & Pick<CheckinRow, 'id' | 'team_id'>): CheckinRow {
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

describe('CheckinsRepository.create + get', () => {
  let adapter: SqliteAdapter;
  let repo: SqliteCheckinsRepo;
  let teamId: string;
  let ownerId: string;

  beforeEach(async () => {
    adapter = await freshDb();
    repo = new SqliteCheckinsRepo(adapter);
    teamId = await new SqliteTeamsRepo(adapter).getOrCreateTeamId('default');
    ownerId = await insertAgent(adapter, teamId, 'manager');
  });

  it('round-trips all fields including JSON close_when', async () => {
    const taskId = await insertTask(adapter, teamId, 'check-agent-work', ownerId);
    const row = buildRow({
      id: 'chk_1',
      team_id: teamId,
      owner_agent_id: ownerId,
      created_by_agent_id: ownerId,
      linked_task_id: taskId,
      priority: 'high',
      max_iterations: 8,
      ttl_expires_at: 1_777_300_000,
      note: 'Follow up on delegated implementation.',
      close_when: { task_status: ['done', 'cancelled'] },
    });
    await repo.create(row);

    const fetched = await repo.get('chk_1', teamId);
    expect(fetched).not.toBeNull();
    expect(fetched).toMatchObject({
      id: 'chk_1',
      team_id: teamId,
      owner_agent_id: ownerId,
      linked_task_id: taskId,
      interval_seconds: 900,
      priority: 'high',
      status: 'active',
      close_when: { task_status: ['done', 'cancelled'] },
      max_iterations: 8,
      iteration_count: 0,
      ttl_expires_at: 1_777_300_000,
      note: 'Follow up on delegated implementation.',
    });
  });

  it('get is team-scoped (cross-team lookup returns null)', async () => {
    const otherTeamId = await new SqliteTeamsRepo(adapter).getOrCreateTeamId('other');
    await repo.create(buildRow({ id: 'chk_2', team_id: teamId }));
    expect(await repo.get('chk_2', otherTeamId)).toBeNull();
    expect(await repo.get('chk_2', teamId)).not.toBeNull();
  });

  it('rejects creating a checkin whose linked_task belongs to another team', async () => {
    const otherTeamId = await new SqliteTeamsRepo(adapter).getOrCreateTeamId('other');
    const otherTaskId = await insertTask(adapter, otherTeamId, 'other-team-task');
    await expect(
      repo.create(buildRow({ id: 'chk_x', team_id: teamId, linked_task_id: otherTaskId })),
    ).rejects.toThrow(/different team/);
  });
});

describe('CheckinsRepository.list', () => {
  let adapter: SqliteAdapter;
  let repo: SqliteCheckinsRepo;
  let teamId: string;
  let otherTeamId: string;
  let ownerA: string;
  let ownerB: string;
  let taskId: string;

  beforeEach(async () => {
    adapter = await freshDb();
    repo = new SqliteCheckinsRepo(adapter);
    const teams = new SqliteTeamsRepo(adapter);
    teamId = await teams.getOrCreateTeamId('default');
    otherTeamId = await teams.getOrCreateTeamId('other');
    ownerA = await insertAgent(adapter, teamId, 'manager');
    ownerB = await insertAgent(adapter, teamId, 'cto');
    taskId = await insertTask(adapter, teamId, 'task-x');

    const now = 1_777_000_000;
    // active, owner A, due soon
    await repo.create(buildRow({
      id: 'chk_a', team_id: teamId, owner_agent_id: ownerA, linked_task_id: taskId,
      next_fire_at: now + 60, status: 'active', updated_at: now,
    }));
    // active, owner B, due later
    await repo.create(buildRow({
      id: 'chk_b', team_id: teamId, owner_agent_id: ownerB,
      next_fire_at: now + 300, status: 'active', updated_at: now + 5,
    }));
    // closed, owner A
    await repo.create(buildRow({
      id: 'chk_c', team_id: teamId, owner_agent_id: ownerA,
      next_fire_at: null, status: 'closed', updated_at: now + 10,
    }));
    // active, different team
    await repo.create(buildRow({
      id: 'chk_d', team_id: otherTeamId, owner_agent_id: ownerA,
      next_fire_at: now + 30, status: 'active', updated_at: now + 15,
    }));
  });

  it('scopes by team', async () => {
    const ours = await repo.list({ teamId });
    expect(ours.map((r) => r.id).sort()).toEqual(['chk_a', 'chk_b', 'chk_c']);
  });

  it('filters by owner', async () => {
    const ofA = await repo.list({ teamId, owner: ownerA });
    expect(ofA.map((r) => r.id).sort()).toEqual(['chk_a', 'chk_c']);
  });

  it('filters by linked_task', async () => {
    const linked = await repo.list({ teamId, linkedTaskId: taskId });
    expect(linked.map((r) => r.id)).toEqual(['chk_a']);
  });

  it('filters by status (single and multi)', async () => {
    const active = await repo.list({ teamId, status: 'active' });
    expect(active.map((r) => r.id).sort()).toEqual(['chk_a', 'chk_b']);

    const activeOrClosed = await repo.list({ teamId, status: ['active', 'closed'] });
    expect(activeOrClosed.map((r) => r.id).sort()).toEqual(['chk_a', 'chk_b', 'chk_c']);
  });

  it('returns due rows ordered by next_fire_at when dueBefore is set', async () => {
    const due = await repo.list({ teamId, dueBefore: 1_777_000_000 + 200 });
    expect(due.map((r) => r.id)).toEqual(['chk_a']); // chk_b is 300 in the future, excluded
  });

  it('clamps the limit', async () => {
    const all = await repo.list({ teamId, limit: 1 });
    expect(all).toHaveLength(1);
  });
});

describe('CheckinsRepository.updateFields', () => {
  let adapter: SqliteAdapter;
  let repo: SqliteCheckinsRepo;
  let teamId: string;

  beforeEach(async () => {
    adapter = await freshDb();
    repo = new SqliteCheckinsRepo(adapter);
    teamId = await new SqliteTeamsRepo(adapter).getOrCreateTeamId('default');
    await repo.create(buildRow({
      id: 'chk_u', team_id: teamId, priority: 'normal', interval_seconds: 900,
      created_at: 1_777_000_000, updated_at: 1_777_000_000,
    }));
  });

  it('patches only the supplied fields and bumps updated_at', async () => {
    await repo.updateFields('chk_u', teamId, {
      priority: 'high',
      interval_seconds: 600,
      updated_at: 1_777_000_999,
    });
    const row = await repo.get('chk_u', teamId);
    expect(row).toMatchObject({
      priority: 'high',
      interval_seconds: 600,
      updated_at: 1_777_000_999,
      status: 'active', // unchanged
      created_at: 1_777_000_000, // immutable
    });
  });

  it('rejects switching linked_task to a cross-team task', async () => {
    const otherTeamId = await new SqliteTeamsRepo(adapter).getOrCreateTeamId('other');
    const otherTask = await insertTask(adapter, otherTeamId, 'other-task');
    await expect(
      repo.updateFields('chk_u', teamId, {
        linked_task_id: otherTask,
        updated_at: 1_777_001_000,
      }),
    ).rejects.toThrow(/different team/);
  });
});

describe('CheckinsRepository.close', () => {
  let adapter: SqliteAdapter;
  let repo: SqliteCheckinsRepo;
  let teamId: string;

  beforeEach(async () => {
    adapter = await freshDb();
    repo = new SqliteCheckinsRepo(adapter);
    teamId = await new SqliteTeamsRepo(adapter).getOrCreateTeamId('default');
    await repo.create(buildRow({
      id: 'chk_close', team_id: teamId, status: 'active',
      next_fire_at: 1_777_001_000, snooze_until: 1_777_000_500,
    }));
  });

  it('marks the row closed, clears cursors, and is idempotent', async () => {
    const first = await repo.close('chk_close', teamId, 1_777_002_000, 'manual');
    expect(first).toBe(true);
    const row = await repo.get('chk_close', teamId);
    expect(row).toMatchObject({
      status: 'closed',
      closed_at: 1_777_002_000,
      closed_reason: 'manual',
      next_fire_at: null,
      snooze_until: null,
    });

    // Repeated close on a terminal row is a no-op
    const second = await repo.close('chk_close', teamId, 1_777_003_000, 'manual-again');
    expect(second).toBe(false);
    const row2 = await repo.get('chk_close', teamId);
    expect(row2?.closed_reason).toBe('manual'); // unchanged
  });

  it('does not close a row from a different team', async () => {
    const otherTeamId = await new SqliteTeamsRepo(adapter).getOrCreateTeamId('other');
    const closed = await repo.close('chk_close', otherTeamId, 1_777_002_000, 'wrong team');
    expect(closed).toBe(false);
    const row = await repo.get('chk_close', teamId);
    expect(row?.status).toBe('active');
  });
});

describe('CheckinsRepository.closeForTerminalTask', () => {
  let adapter: SqliteAdapter;
  let repo: SqliteCheckinsRepo;
  let teamId: string;
  let otherTeamId: string;

  beforeEach(async () => {
    adapter = await freshDb();
    repo = new SqliteCheckinsRepo(adapter);
    const teams = new SqliteTeamsRepo(adapter);
    teamId = await teams.getOrCreateTeamId('default');
    otherTeamId = await teams.getOrCreateTeamId('other');
  });

  it('closes only same-team active/snoozed rows linked to the task', async () => {
    const task = await insertTask(adapter, teamId, 'shared-task');
    const otherTask = await insertTask(adapter, otherTeamId, 'other-task');

    await repo.create(buildRow({ id: 'chk_t1', team_id: teamId, linked_task_id: task, status: 'active' }));
    await repo.create(buildRow({ id: 'chk_t2', team_id: teamId, linked_task_id: task, status: 'snoozed' }));
    await repo.create(buildRow({ id: 'chk_t3', team_id: teamId, linked_task_id: task, status: 'closed' }));
    // Different team, same task id is impossible because of FK; use another task.
    await repo.create(buildRow({
      id: 'chk_t4', team_id: otherTeamId, linked_task_id: otherTask, status: 'active',
    }));

    const closed = await repo.closeForTerminalTask(task, teamId, 1_777_005_000, 'task_terminal');
    expect(closed).toBe(2); // chk_t1 + chk_t2; chk_t3 already closed; chk_t4 different team

    const t1 = await repo.get('chk_t1', teamId);
    const t2 = await repo.get('chk_t2', teamId);
    const t3 = await repo.get('chk_t3', teamId);
    const t4 = await repo.get('chk_t4', otherTeamId);
    expect(t1?.status).toBe('closed');
    expect(t1?.closed_reason).toBe('task_terminal');
    expect(t2?.status).toBe('closed');
    expect(t2?.next_fire_at).toBeNull();
    expect(t3?.status).toBe('closed');
    expect(t4?.status).toBe('active');
  });
});

describe('CheckinsRepository.claimDue', () => {
  let adapter: SqliteAdapter;
  let repo: SqliteCheckinsRepo;
  let teamId: string;

  beforeEach(async () => {
    adapter = await freshDb();
    repo = new SqliteCheckinsRepo(adapter);
    teamId = await new SqliteTeamsRepo(adapter).getOrCreateTeamId('default');
  });

  it('returns active/snoozed rows whose next_fire_at <= now, ordered ascending', async () => {
    const now = 1_777_010_000;
    await repo.create(buildRow({ id: 'd1', team_id: teamId, status: 'active', next_fire_at: now - 30 }));
    await repo.create(buildRow({ id: 'd2', team_id: teamId, status: 'snoozed', next_fire_at: now - 5 }));
    await repo.create(buildRow({ id: 'd3', team_id: teamId, status: 'active', next_fire_at: now + 10 }));
    await repo.create(buildRow({ id: 'd4', team_id: teamId, status: 'closed', next_fire_at: now - 60 }));
    await repo.create(buildRow({ id: 'd5', team_id: teamId, status: 'active', next_fire_at: null }));

    const due = await repo.claimDue(teamId, now, 100);
    expect(due.map((r) => r.id)).toEqual(['d1', 'd2']);
  });

  it('respects the limit', async () => {
    const now = 1_777_020_000;
    for (let i = 0; i < 5; i++) {
      await repo.create(buildRow({
        id: `c${i}`, team_id: teamId, status: 'active', next_fire_at: now - i,
      }));
    }
    const due = await repo.claimDue(teamId, now, 2);
    expect(due).toHaveLength(2);
  });
});
