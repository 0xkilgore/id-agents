// SPDX-License-Identifier: MIT

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SqliteAdapter } from '../../src/db/sqlite-adapter.js';
import { migrateSqlite } from '../../src/db/migrations/sqlite.js';
import { SqliteCheckinsRepo } from '../../src/db/repos/sqlite/checkins-repo.js';
import type { CheckinRow } from '../../src/db/types.js';

describe('checkin terminal reconciliation at due claim', () => {
  let adapter: SqliteAdapter;
  let repo: SqliteCheckinsRepo;
  const teamId = 'team_reconcile';
  const now = 2_000_000;

  beforeEach(async () => {
    adapter = new SqliteAdapter(':memory:');
    await migrateSqlite(adapter);
    repo = new SqliteCheckinsRepo(adapter);
    await adapter.query(
      `INSERT INTO teams (id, name) VALUES (?, ?)`,
      [teamId, 'reconcile-team'],
    );
  });

  afterEach(async () => {
    await adapter.close();
  });

  async function insertTask(
    id: string,
    status: 'doing' | 'done',
    updatedAt: number,
    description: string | null = null,
  ): Promise<void> {
    await adapter.query(
      `INSERT INTO tasks (id, name, uuid, team_id, title, description, status, created_at, updated_at, track)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, id, `uuid-${id}`, teamId, id, description, status, 1, updatedAt, '(unassigned)'],
    );
  }

  function row(id: string, taskId: string, overrides: Partial<CheckinRow> = {}): CheckinRow {
    return {
      id,
      team_id: teamId,
      owner_agent_id: null,
      created_by_agent_id: null,
      linked_task_id: taskId,
      interval_seconds: 60,
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
      created_at: 1,
      updated_at: 1,
      closed_at: null,
      closed_reason: null,
      ...overrides,
    };
  }

  it('records terminal reconciliation and returns no receipt work', async () => {
    await insertTask('terminal-task', 'done', 1_500);
    await repo.create(row('terminal-checkin', 'terminal-task'));

    await expect(repo.claimDue(teamId, now, 10)).resolves.toEqual([]);
    const reconciled = await repo.get('terminal-checkin', teamId);
    expect(reconciled).toMatchObject({
      status: 'closed',
      closed_reason: 'canonical_task_terminal',
      closed_at: now,
      next_fire_at: null,
    });
  });

  it('exhausts a repeated record-only chain after three unchanged receipts', async () => {
    await insertTask('stale-task', 'doing', 1_000);
    await repo.create(row('stale-checkin', 'stale-task', {
      iteration_count: 3,
      last_fire_at: 1_500_000,
    }));

    await expect(repo.claimDue(teamId, now, 10)).resolves.toEqual([]);
    expect(await repo.get('stale-checkin', teamId)).toMatchObject({
      status: 'closed',
      closed_reason: 'record_only_chain_exhausted',
      next_fire_at: null,
    });
  });

  it('still claims genuine implementation work with fresh task activity', async () => {
    await insertTask('active-task', 'doing', 1_600);
    await repo.create(row('active-checkin', 'active-task', {
      iteration_count: 3,
      last_fire_at: 1_500_000,
    }));

    const claimed = await repo.claimDue(teamId, now, 10);
    expect(claimed.map((checkin) => checkin.id)).toEqual(['active-checkin']);
    expect((await repo.get('active-checkin', teamId))?.status).toBe('active');
  });

  it('suppresses recurring receipts when the source task was superseded or mooted in its task record', async () => {
    await insertTask('superseded-task', 'doing', 1_600, 'Status: superseded upstream after reconciliation.');
    await repo.create(row('superseded-checkin', 'superseded-task'));

    await expect(repo.claimDue(teamId, now, 10)).resolves.toEqual([]);
    expect(await repo.get('superseded-checkin', teamId)).toMatchObject({
      status: 'closed',
      closed_reason: 'canonical_task_terminal',
      next_fire_at: null,
    });
  });

  it('suppresses recurring receipts when the source task already records a replacement implementation commit', async () => {
    await insertTask(
      'replacement-task',
      'doing',
      1_600,
      'Replacement implementation commit: abc1234 landed on the successor path.',
    );
    await repo.create(row('replacement-checkin', 'replacement-task'));

    await expect(repo.claimDue(teamId, now, 10)).resolves.toEqual([]);
    expect(await repo.get('replacement-checkin', teamId)).toMatchObject({
      status: 'closed',
      closed_reason: 'replacement_implementation_commit',
      next_fire_at: null,
    });
  });
});
