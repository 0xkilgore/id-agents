// SPDX-License-Identifier: MIT
/**
 * Migration tests for Phase 1 team boundary enforcement.
 * Proves that (team_id, name) uniqueness works correctly:
 *   - Same task name in two different teams is allowed
 *   - Duplicate (team_id, name) in same team is rejected
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { SqliteAdapter } from '../../src/db/sqlite-adapter.js';
import { migrateSqlite } from '../../src/db/migrations/sqlite.js';
import { SqliteTasksRepo } from '../../src/db/repos/sqlite/tasks-repo.js';
import { SqliteTeamsRepo } from '../../src/db/repos/sqlite/teams-repo.js';
import type { TaskRow } from '../../src/db/types.js';

function freshDb(): SqliteAdapter {
  const adapter = new SqliteAdapter(':memory:');
  migrateSqlite(adapter);
  return adapter;
}

function makeTask(overrides: Partial<TaskRow> & { team_id: string; name: string }): TaskRow {
  const now = Math.floor(Date.now() / 1000);
  return {
    id: `task_${Math.random().toString(36).slice(2)}`,
    name: overrides.name,
    uuid: crypto.randomUUID(),
    team_id: overrides.team_id,
    title: overrides.title ?? `Task: ${overrides.name}`,
    description: null,
    status: 'todo',
    created_by: null,
    owner: null,
    created_at: now,
    updated_at: now,
    completed_at: null,
    ...overrides,
  };
}

describe('Tasks (team_id, name) uniqueness', () => {
  let adapter: SqliteAdapter;
  let teamsRepo: SqliteTeamsRepo;
  let tasksRepo: SqliteTasksRepo;
  let teamAId: string;
  let teamBId: string;

  beforeEach(async () => {
    adapter = freshDb();
    teamsRepo = new SqliteTeamsRepo(adapter);
    tasksRepo = new SqliteTasksRepo(adapter);
    teamAId = await teamsRepo.getOrCreateTeamId('team-a');
    teamBId = await teamsRepo.getOrCreateTeamId('team-b');
  });

  it('allows the same task name in two different teams', async () => {
    const taskA = makeTask({ team_id: teamAId, name: 'shared-task' });
    const taskB = makeTask({ team_id: teamBId, name: 'shared-task' });

    // Both creates should succeed without throwing
    await expect(tasksRepo.create(taskA)).resolves.toBeUndefined();
    await expect(tasksRepo.create(taskB)).resolves.toBeUndefined();

    // Both should be retrievable in their respective teams
    const foundA = await tasksRepo.getByNameForTeam('shared-task', teamAId);
    const foundB = await tasksRepo.getByNameForTeam('shared-task', teamBId);

    expect(foundA).not.toBeNull();
    expect(foundB).not.toBeNull();
    expect(foundA!.id).not.toEqual(foundB!.id);
    expect(foundA!.team_id).toEqual(teamAId);
    expect(foundB!.team_id).toEqual(teamBId);
  });

  it('rejects a duplicate (team_id, name) in the same team', async () => {
    const task1 = makeTask({ team_id: teamAId, name: 'duplicate-task' });
    const task2 = makeTask({ team_id: teamAId, name: 'duplicate-task' });

    await tasksRepo.create(task1);

    // Second insert with same (team_id, name) must throw UNIQUE constraint error
    await expect(tasksRepo.create(task2)).rejects.toThrow();
  });

  it('getByNameForTeam returns null for task in different team', async () => {
    const task = makeTask({ team_id: teamAId, name: 'team-a-only' });
    await tasksRepo.create(task);

    const inTeamA = await tasksRepo.getByNameForTeam('team-a-only', teamAId);
    const inTeamB = await tasksRepo.getByNameForTeam('team-a-only', teamBId);

    expect(inTeamA).not.toBeNull();
    expect(inTeamB).toBeNull();
  });

  it('list with teamId filter returns only that team\'s tasks', async () => {
    const taskA1 = makeTask({ team_id: teamAId, name: 'task-a1' });
    const taskA2 = makeTask({ team_id: teamAId, name: 'task-a2' });
    const taskB1 = makeTask({ team_id: teamBId, name: 'task-b1' });

    await tasksRepo.create(taskA1);
    await tasksRepo.create(taskA2);
    await tasksRepo.create(taskB1);

    const teamATasks = await tasksRepo.list({ teamId: teamAId });
    const teamBTasks = await tasksRepo.list({ teamId: teamBId });

    expect(teamATasks).toHaveLength(2);
    expect(teamBTasks).toHaveLength(1);
    expect(teamATasks.map(t => t.name).sort()).toEqual(['task-a1', 'task-a2']);
    expect(teamBTasks[0].name).toEqual('task-b1');
  });
});

describe('SQLite migration — tasks uniqueness upgrade', () => {
  it('fresh DB has (team_id, name) constraint not global name UNIQUE', async () => {
    const adapter = freshDb();

    // Verify by reading DDL
    const { rows } = await adapter.query<{ sql: string }>(
      `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'tasks'`,
    );
    expect(rows[0]).toBeDefined();
    const ddl = rows[0].sql.toLowerCase();

    // Should NOT have standalone 'name text not null unique'
    expect(ddl).not.toMatch(/name text not null unique/);

    // Should have the composite unique
    expect(ddl).toMatch(/unique\s*\(\s*team_id\s*,\s*name\s*\)/);
  });

  it('well-known teams seeded by getOrCreateTeamId are unique', async () => {
    const adapter = freshDb();
    const teamsRepo = new SqliteTeamsRepo(adapter);

    const id1 = await teamsRepo.getOrCreateTeamId('idchain');
    const id2 = await teamsRepo.getOrCreateTeamId('idchain');

    // Same name should return the same id on repeated calls
    expect(id1).toEqual(id2);
  });
});
