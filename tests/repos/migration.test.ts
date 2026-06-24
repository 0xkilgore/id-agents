// SPDX-License-Identifier: MIT
/**
 * Migration tests for Phase 1 team boundary enforcement.
 * Proves that (team_id, name) uniqueness works correctly:
 *   - Same task name in two different teams is allowed
 *   - Duplicate (team_id, name) in same team is rejected
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { SqliteAdapter } from '../../src/db/sqlite-adapter.js';
import { migrateSqlite, migrateDeleteManagerShadowAgentsSqlite, downMigrateRecreateManagerShadowAgentsSqlite, downMigrateInboxOwnershipSqlite } from '../../src/db/migrations/sqlite.js';
import { SqliteTasksRepo } from '../../src/db/repos/sqlite/tasks-repo.js';
import { SqliteTeamsRepo } from '../../src/db/repos/sqlite/teams-repo.js';
import type { TaskRow } from '../../src/db/types.js';

async function freshDb(): Promise<SqliteAdapter> {
  const adapter = new SqliteAdapter(':memory:');
  await migrateSqlite(adapter);
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
    track: '(unassigned)',
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
    adapter = await freshDb();
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
    const adapter = await freshDb();

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
    const adapter = await freshDb();
    const teamsRepo = new SqliteTeamsRepo(adapter);

    const id1 = await teamsRepo.getOrCreateTeamId('idchain');
    const id2 = await teamsRepo.getOrCreateTeamId('idchain');

    // Same name should return the same id on repeated calls
    expect(id1).toEqual(id2);
  });

  it('fresh DB has dispatch queue indexes for scheduler reads and projections', async () => {
    const adapter = await freshDb();
    const { rows } = await adapter.query<{ name: string }>(
      `SELECT name FROM sqlite_master
       WHERE type = 'index'
         AND tbl_name = 'dispatch_scheduler_queue'`,
    );
    const names = new Set(rows.map((r) => r.name));

    expect(names).toContain('dispatch_scheduler_queue_read_idx');
    expect(names).toContain('dispatch_scheduler_in_flight_read_idx');
    expect(names).toContain('dispatch_scheduler_bounced_read_idx');
    expect(names).toContain('dispatch_scheduler_recent_terminal_idx');
    expect(names).toContain('dispatch_scheduler_team_agent_query_idx');

    await adapter.close();
  });
});

// =====================================================================
// Phase 2: remote endpoint column idempotency
// =====================================================================

describe('SQLite migration — remote endpoint columns (Phase 2 idempotency)', () => {
  it('fresh DB has all four remote endpoint columns on agents', async () => {
    const adapter = await freshDb();
    // Use pragma_table_info() table-valued function so it returns rows via SELECT
    const { rows } = await adapter.query<{ name: string }>(
      `SELECT name FROM pragma_table_info('agents')`,
    );
    const colNames = rows.map(r => r.name);
    expect(colNames).toContain('customer_domain');
    expect(colNames).toContain('public_endpoint_url');
    expect(colNames).toContain('internal_endpoint_url');
    expect(colNames).toContain('ssh_target');
  });

  it('running migration twice is idempotent — no error, schema unchanged', async () => {
    const adapter = new SqliteAdapter(':memory:');

    // First run — normal
    await expect(migrateSqlite(adapter)).resolves.toBeUndefined();

    // Second run — must not throw even though the ALTER TABLE columns already exist
    await expect(migrateSqlite(adapter)).resolves.toBeUndefined();

    // Schema should still have all four columns
    const { rows } = await adapter.query<{ name: string }>(
      `SELECT name FROM pragma_table_info('agents')`,
    );
    const colNames = rows.map(r => r.name);
    expect(colNames).toContain('customer_domain');
    expect(colNames).toContain('public_endpoint_url');
    expect(colNames).toContain('internal_endpoint_url');
    expect(colNames).toContain('ssh_target');

    await adapter.close();
  });

  it('existing rows have NULL for all four new columns (backfill-safe)', async () => {
    const adapter = new SqliteAdapter(':memory:');
    await migrateSqlite(adapter);

    const teamsRepo = new SqliteTeamsRepo(adapter);
    const teamId = await teamsRepo.getOrCreateTeamId('test-team');

    // Insert a row without any remote columns (as a pre-Phase-2 agent would)
    await adapter.query(
      `INSERT INTO agents
         (id, team_id, name, type, model, port, status, created_at, runtime)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ['old-agent-1', teamId, 'legacy-agent', 'virtual', 'sonnet', 0, 'running', Date.now(), 'claude-agent-sdk'],
    );

    const { rows } = await adapter.query<any>(
      `SELECT customer_domain, public_endpoint_url, internal_endpoint_url, ssh_target FROM agents WHERE id = 'old-agent-1'`,
    );
    expect(rows[0]).toBeDefined();
    expect(rows[0].customer_domain).toBeNull();
    expect(rows[0].public_endpoint_url).toBeNull();
    expect(rows[0].internal_endpoint_url).toBeNull();
    expect(rows[0].ssh_target).toBeNull();

    await adapter.close();
  });
});

// =====================================================================
// Manager shadow rows — delete + reversible down helper
// =====================================================================

describe('SQLite migration — manager shadow FK cleanup', () => {
  it('fresh migrated DB has no manager-* agent rows', async () => {
    const adapter = await freshDb();
    const { rows } = await adapter.query<{ c: number }>(
      `SELECT COUNT(*) as c FROM agents WHERE id GLOB 'manager-*'`,
    );
    expect(Number(rows[0]?.c)).toBe(0);
    await adapter.close();
  });

  it('downMigrateRecreate restores stubs + legacy agent_id; migrateDelete clears again', async () => {
    const adapter = await freshDb();
    const teamsRepo = new SqliteTeamsRepo(adapter);
    const teamId = await teamsRepo.getOrCreateTeamId('roundtrip-team');
    const now = Date.now();

    await adapter.query(
      `INSERT INTO agents (id, team_id, name, type, model, port, status, created_at, runtime)
       VALUES ('worker-rt', ?, 'worker', 'virtual', 'sonnet', 0, 'running', ?, 'claude-agent-sdk')`,
      [teamId, now],
    );

    await adapter.query(
      `INSERT INTO queries (team_id, agent_id, query_id, status, created, owner_kind, owner_id, prompt)
       VALUES (?, NULL, 'q_rt_1', 'pending', ?, 'manager', ?, NULL)`,
      [teamId, now + 2, teamId],
    );
    await adapter.query(
      `INSERT INTO news_items (team_id, agent_id, timestamp, type, owner_kind, owner_id)
       VALUES (?, NULL, ?, 'test', 'manager', ?)`,
      [teamId, now + 3, teamId],
    );

    await downMigrateRecreateManagerShadowAgentsSqlite(adapter);

    const stub = await adapter.query<{ id: string }>(
      `SELECT id FROM agents WHERE id = 'manager-roundtrip-team'`,
    );
    expect(stub.rows).toHaveLength(1);

    const qAfterDown = await adapter.query<{ agent_id: string | null }>(
      `SELECT agent_id FROM queries WHERE query_id = 'q_rt_1'`,
    );
    expect(qAfterDown.rows[0]?.agent_id).toBe('manager-roundtrip-team');

    await migrateDeleteManagerShadowAgentsSqlite(adapter);

    const noStub = await adapter.query<{ c: number }>(
      `SELECT COUNT(*) as c FROM agents WHERE id GLOB 'manager-*'`,
    );
    expect(Number(noStub.rows[0]?.c)).toBe(0);

    const qClean = await adapter.query<{ agent_id: string | null }>(
      `SELECT agent_id FROM queries WHERE query_id = 'q_rt_1'`,
    );
    expect(qClean.rows[0]?.agent_id).toBeNull();

    await adapter.close();
  });

  it('migrateDelete clears nullable task/checkin shadow refs before deleting manager rows', async () => {
    const adapter = await freshDb();
    const teamsRepo = new SqliteTeamsRepo(adapter);
    const teamId = await teamsRepo.getOrCreateTeamId('shadow-task-team');
    const now = Date.now();

    await adapter.query(
      `INSERT INTO agents (id, team_id, name, type, model, port, status, created_at, runtime)
       VALUES ('manager-shadow-task-team', ?, 'manager', 'interactive', '', 0, 'stub', ?, 'claude-agent-sdk')`,
      [teamId, now],
    );
    await adapter.query(
      `INSERT INTO tasks (id, name, uuid, team_id, title, status, created_by, owner, created_at, updated_at)
       VALUES ('task_shadow_1', 'shadow-task', 'uuid-shadow-task', ?, 'Shadow task', 'todo', 'manager-shadow-task-team', 'manager-shadow-task-team', ?, ?)`,
      [teamId, now + 1, now + 1],
    );
    await adapter.query(
      `INSERT INTO checkins (id, team_id, owner_agent_id, created_by_agent_id, linked_task_id, interval_seconds, priority, status, close_when, iteration_count, created_at, updated_at)
       VALUES ('chk_shadow_1', ?, 'manager-shadow-task-team', 'manager-shadow-task-team', 'task_shadow_1', 60, 'normal', 'active', '{}', 0, ?, ?)`,
      [teamId, now + 2, now + 2],
    );

    await migrateDeleteManagerShadowAgentsSqlite(adapter);

    const taskRows = await adapter.query<{ created_by: string | null; owner: string | null }>(
      `SELECT created_by, owner FROM tasks WHERE id = 'task_shadow_1'`,
    );
    expect(taskRows.rows[0]?.created_by).toBeNull();
    expect(taskRows.rows[0]?.owner).toBeNull();

    const checkinRows = await adapter.query<{ owner_agent_id: string | null; created_by_agent_id: string | null }>(
      `SELECT owner_agent_id, created_by_agent_id FROM checkins WHERE id = 'chk_shadow_1'`,
    );
    expect(checkinRows.rows[0]?.owner_agent_id).toBeNull();
    expect(checkinRows.rows[0]?.created_by_agent_id).toBeNull();

    const shadowRows = await adapter.query<{ c: number }>(
      `SELECT COUNT(*) as c FROM agents WHERE id = 'manager-shadow-task-team'`,
    );
    expect(Number(shadowRows.rows[0]?.c)).toBe(0);

    await adapter.close();
  });

  it('migrateDelete promotes virtual_manager rows to manager ownership and deletes the legacy row', async () => {
    const adapter = await freshDb();
    const teamsRepo = new SqliteTeamsRepo(adapter);
    const teamId = await teamsRepo.getOrCreateTeamId('default');
    const now = Date.now();

    await adapter.query(
      `INSERT INTO agents (id, team_id, name, type, model, port, status, created_at, runtime)
       VALUES ('virtual_manager', ?, 'manager', 'interactive', '', 0, 'offline', ?, 'claude-agent-sdk')`,
      [teamId, now],
    );
    await adapter.query(
      `INSERT INTO queries (team_id, agent_id, query_id, status, created, owner_kind, owner_id, prompt)
       VALUES (?, 'virtual_manager', 'q_vm_1', 'pending', ?, 'agent', 'virtual_manager', NULL)`,
      [teamId, now + 1],
    );
    await adapter.query(
      `INSERT INTO news_items (team_id, agent_id, timestamp, type, owner_kind, owner_id)
       VALUES (?, 'virtual_manager', ?, 'message', 'agent', 'virtual_manager')`,
      [teamId, now + 2],
    );

    await migrateDeleteManagerShadowAgentsSqlite(adapter);

    const qRows = await adapter.query<{ agent_id: string | null; owner_kind: string; owner_id: string }>(
      `SELECT agent_id, owner_kind, owner_id FROM queries WHERE query_id = 'q_vm_1'`,
    );
    expect(qRows.rows[0]?.agent_id).toBeNull();
    expect(qRows.rows[0]?.owner_kind).toBe('manager');
    expect(qRows.rows[0]?.owner_id).toBe(teamId);

    const nRows = await adapter.query<{ agent_id: string | null; owner_kind: string; owner_id: string }>(
      `SELECT agent_id, owner_kind, owner_id FROM news_items WHERE type = 'message' ORDER BY id DESC LIMIT 1`,
    );
    expect(nRows.rows[0]?.agent_id).toBeNull();
    expect(nRows.rows[0]?.owner_kind).toBe('manager');
    expect(nRows.rows[0]?.owner_id).toBe(teamId);

    const shadowRows = await adapter.query<{ c: number }>(
      `SELECT COUNT(*) as c FROM agents WHERE id = 'virtual_manager'`,
    );
    expect(Number(shadowRows.rows[0]?.c)).toBe(0);

    await adapter.close();
  });
});

// =====================================================================
// Inbox ownership (owner_kind / owner_id) + reversible down helper
// =====================================================================

describe('SQLite migration — inbox ownership (manager foundation)', () => {
  it('fresh DB has ownership columns and indexes on queries and news_items', async () => {
    const adapter = await freshDb();
    for (const table of ['queries', 'news_items'] as const) {
      const { rows } = await adapter.query<{ name: string }>(
        `SELECT name FROM pragma_table_info('${table}')`,
      );
      const names = rows.map(r => r.name);
      expect(names).toContain('owner_kind');
      expect(names).toContain('owner_id');
    }
    const { rows: idxRows } = await adapter.query<{ name: string }>(
      `SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name IN ('queries','news_items')`,
    );
    const idxNames = idxRows.map(r => r.name);
    expect(idxNames).toContain('queries_team_owner_idx');
    expect(idxNames).toContain('news_items_team_owner_time_idx');
    expect(idxNames).toContain('news_items_owner_query_idx');
    await adapter.close();
  });

  it('double migrate leaves ownership schema intact (idempotent)', async () => {
    const adapter = new SqliteAdapter(':memory:');
    await migrateSqlite(adapter);
    await migrateSqlite(adapter);
    const { rows } = await adapter.query<{ name: string }>(
      `SELECT name FROM pragma_table_info('queries')`,
    );
    expect(rows.map(r => r.name)).toContain('owner_kind');
    expect(rows.map(r => r.name)).toContain('owner_id');
    await adapter.close();
  });

  it('downMigrateInboxOwnershipSqlite restores manager-<team> agent_id for manager-owned rows', async () => {
    const adapter = await freshDb();
    const teamsRepo = new SqliteTeamsRepo(adapter);
    const teamId = await teamsRepo.getOrCreateTeamId('roundtrip-team');
    const now = Date.now();

    await adapter.query(
      `INSERT INTO agents (id, team_id, name, type, model, port, status, created_at, runtime)
       VALUES ('worker-rt', ?, 'worker', 'virtual', 'sonnet', 0, 'running', ?, 'claude-agent-sdk')`,
      [teamId, now],
    );
    await adapter.query(
      `INSERT INTO agents (id, team_id, name, type, model, port, status, created_at, runtime)
       VALUES ('manager-roundtrip-team', ?, 'interactive', 'interactive', 'sonnet', 0, 'running', ?, 'claude-agent-sdk')`,
      [teamId, now + 1],
    );

    await adapter.query(
      `INSERT INTO queries (team_id, agent_id, query_id, status, created, owner_kind, owner_id, prompt)
       VALUES (?, 'worker-rt', 'q_rt_1', 'pending', ?, 'manager', ?, NULL)`,
      [teamId, now + 2, teamId],
    );
    await adapter.query(
      `INSERT INTO news_items (team_id, agent_id, timestamp, type, owner_kind, owner_id)
       VALUES (?, 'worker-rt', ?, 'test', 'manager', ?)`,
      [teamId, now + 3, teamId],
    );

    await downMigrateInboxOwnershipSqlite(adapter);

    const q = await adapter.query<{ agent_id: string; owner_kind: string }>(
      `SELECT agent_id, owner_kind FROM queries WHERE query_id = 'q_rt_1'`,
    );
    expect(q.rows[0]?.agent_id).toBe('manager-roundtrip-team');
    expect(q.rows[0]?.owner_kind).toBe('manager');

    const n = await adapter.query<{ agent_id: string }>(
      `SELECT agent_id FROM news_items WHERE team_id = ? AND type = 'test'`,
      [teamId],
    );
    expect(n.rows[0]?.agent_id).toBe('manager-roundtrip-team');

    await adapter.close();
  });
});
