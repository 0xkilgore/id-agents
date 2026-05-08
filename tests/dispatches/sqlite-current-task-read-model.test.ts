// SPDX-License-Identifier: MIT
/**
 * SqliteCurrentTaskReadModel — Phase 1 / Task 2.
 *
 * Projects the local `dispatches` table into the shared
 * AgentCurrentTaskSnapshot contract used by the dashboard fleet cards.
 * Runs whenever USE_VETRA_DISPATCHES=false (and as the silent fallback
 * when Vetra reads fail).
 */

import { describe, expect, it } from 'vitest';
import { SqliteAdapter } from '../../src/db/sqlite-adapter.js';
import { migrateSqlite } from '../../src/db/migrations/sqlite.js';
import { SqliteDispatchesRepo } from '../../src/db/repos/sqlite/dispatches-repo.js';
import { SqliteTeamsRepo } from '../../src/db/repos/sqlite/teams-repo.js';
import { SqliteAgentsRepo } from '../../src/db/repos/sqlite/agents-repo.js';
import { SqliteQueriesRepo } from '../../src/db/repos/sqlite/queries-repo.js';
import { SqliteNewsRepo } from '../../src/db/repos/sqlite/news-repo.js';
import { SqliteSchedulesRepo } from '../../src/db/repos/sqlite/schedules-repo.js';
import { SqliteTasksRepo } from '../../src/db/repos/sqlite/tasks-repo.js';
import { SqliteEventsRepo } from '../../src/db/repos/sqlite/events-repo.js';
import { SqliteSubscriptionsRepo } from '../../src/db/repos/sqlite/subscriptions-repo.js';
import { SqliteCheckinsRepo } from '../../src/db/repos/sqlite/checkins-repo.js';
import { SqliteCurrentTaskReadModel } from '../../src/dispatches/sqlite-current-task-read-model.js';
import type { Db } from '../../src/db/db-service.js';

async function freshDb(): Promise<{ db: Db; adapter: SqliteAdapter; repo: SqliteDispatchesRepo }> {
  const adapter = new SqliteAdapter(':memory:');
  await migrateSqlite(adapter);
  const dispatches = new SqliteDispatchesRepo(adapter);
  const db: Db = {
    adapter,
    teams: new SqliteTeamsRepo(adapter),
    agents: new SqliteAgentsRepo(adapter),
    queries: new SqliteQueriesRepo(adapter),
    news: new SqliteNewsRepo(adapter),
    schedules: new SqliteSchedulesRepo(adapter),
    tasks: new SqliteTasksRepo(adapter),
    dispatches,
    events: new SqliteEventsRepo(adapter),
    subscriptions: new SqliteSubscriptionsRepo(adapter),
    checkins: new SqliteCheckinsRepo(adapter),
    close: async () => {},
  } as unknown as Db;
  return { db, adapter, repo: dispatches };
}

async function seedDispatch(
  repo: SqliteDispatchesRepo,
  fields: Partial<Parameters<typeof repo.create>[0]> & { to_agent: string; dispatched_at: number },
  overrides?: { status?: 'queued' | 'in_flight' | 'done' | 'failed' | 'timeout' | 'wedged'; artifact_path?: string | null; verify_status?: 'pending' | 'pass' | 'fail' },
): Promise<number> {
  const id = await repo.create({
    team_id: null,
    dispatched_at: fields.dispatched_at,
    from_actor: fields.from_actor ?? 'manager',
    to_agent: fields.to_agent,
    channel: fields.channel ?? 'talk',
    message: fields.message ?? '# default title\n',
    query_id: fields.query_id ?? null,
    verify_signal_json: fields.verify_signal_json ?? null,
    parent_dispatch_id: fields.parent_dispatch_id ?? null,
  });
  if (overrides?.status && overrides.status !== 'queued') {
    if (overrides.status === 'done') {
      await repo.recordDone(id, {
        responded_at: fields.dispatched_at + 1,
        response: null,
        artifact_path: overrides.artifact_path ?? null,
        verify_signal_json: null,
        verify_status: overrides.verify_status ?? 'pass',
        verify_last_checked: fields.dispatched_at + 1,
        verify_failures_json: null,
      });
    } else {
      await repo.setStatus(id, overrides.status);
    }
  }
  return id;
}

describe('SqliteCurrentTaskReadModel', () => {
  it('returns one snapshot per requested agent, even when no dispatches exist', async () => {
    const { db } = await freshDb();
    const model = new SqliteCurrentTaskReadModel(db);
    const snaps = await model.getCurrentTaskByAgent(['roger', 'cto']);
    expect(snaps).toHaveLength(2);
    expect(snaps.map((s) => s.agent_id).sort()).toEqual(['cto', 'roger']);
    expect(snaps.every((s) => s.current_task === null)).toBe(true);
    expect(snaps.every((s) => s.degraded_source === false)).toBe(true);
  });

  it('chooses the most recent queued or in_flight dispatch per agent', async () => {
    const { db, repo } = await freshDb();
    await seedDispatch(repo, { to_agent: 'roger', dispatched_at: 1000, message: 'old roger' });
    await seedDispatch(repo, { to_agent: 'roger', dispatched_at: 5000, message: 'newer roger' });
    await seedDispatch(repo, { to_agent: 'cto', dispatched_at: 3000, message: 'cto job' }, { status: 'in_flight' });
    const model = new SqliteCurrentTaskReadModel(db);
    const snaps = await model.getCurrentTaskByAgent(['roger', 'cto']);
    const byAgent = Object.fromEntries(snaps.map((s) => [s.agent_id, s]));
    expect(byAgent.roger.current_task).not.toBeNull();
    expect(byAgent.roger.current_task!.title).toBe('newer roger');
    expect(byAgent.roger.current_task!.status).toBe('queued');
    expect(byAgent.cto.current_task!.title).toBe('cto job');
    expect(byAgent.cto.current_task!.status).toBe('in_flight');
  });

  it('ignores terminal statuses (done, failed, timeout, wedged)', async () => {
    const { db, repo } = await freshDb();
    await seedDispatch(repo, { to_agent: 'roger', dispatched_at: 9000, message: 'done one' }, { status: 'done' });
    await seedDispatch(repo, { to_agent: 'roger', dispatched_at: 8000, message: 'failed one' }, { status: 'failed' });
    await seedDispatch(repo, { to_agent: 'roger', dispatched_at: 7000, message: 'timeout one' }, { status: 'timeout' });
    await seedDispatch(repo, { to_agent: 'roger', dispatched_at: 6000, message: 'wedged one' }, { status: 'wedged' });
    await seedDispatch(repo, { to_agent: 'roger', dispatched_at: 1000, message: 'open one' });
    const model = new SqliteCurrentTaskReadModel(db);
    const [snap] = await model.getCurrentTaskByAgent(['roger']);
    expect(snap.current_task).not.toBeNull();
    expect(snap.current_task!.title).toBe('open one');
  });

  it('returns current_task: null when the only rows for an agent are terminal', async () => {
    const { db, repo } = await freshDb();
    await seedDispatch(repo, { to_agent: 'roger', dispatched_at: 1000 }, { status: 'done' });
    const model = new SqliteCurrentTaskReadModel(db);
    const [snap] = await model.getCurrentTaskByAgent(['roger']);
    expect(snap.current_task).toBeNull();
    expect(snap.degraded_source).toBe(false);
  });

  it('maps dispatched_at to ISO started_at', async () => {
    const { db, repo } = await freshDb();
    const ts = Date.UTC(2026, 4, 8, 14, 0, 0);  // 2026-05-08T14:00:00Z
    await seedDispatch(repo, { to_agent: 'roger', dispatched_at: ts });
    const model = new SqliteCurrentTaskReadModel(db);
    const [snap] = await model.getCurrentTaskByAgent(['roger']);
    expect(snap.current_task!.started_at).toBe('2026-05-08T14:00:00.000Z');
  });

  it('passes through query_id, verify_status, and artifact_path on the row', async () => {
    const { db, repo } = await freshDb();
    // queued + verify_signal stays pending. We don't set artifact_path on the
    // queued row directly (recordDone is the only writer), so this checks that
    // open rows surface query_id and pass-through nulls correctly.
    await seedDispatch(repo, {
      to_agent: 'roger',
      dispatched_at: 1000,
      query_id: 'q-abc-123',
    });
    const model = new SqliteCurrentTaskReadModel(db);
    const [snap] = await model.getCurrentTaskByAgent(['roger']);
    expect(snap.current_task!.query_id).toBe('q-abc-123');
    expect(snap.current_task!.verify_status).toBeNull();
    expect(snap.current_task!.artifact_path).toBeNull();
  });

  it('sets source = "sqlite" and degraded_source = false on every snapshot', async () => {
    const { db, repo } = await freshDb();
    await seedDispatch(repo, { to_agent: 'roger', dispatched_at: 1000 });
    const model = new SqliteCurrentTaskReadModel(db);
    const snaps = await model.getCurrentTaskByAgent(['roger', 'no_dispatches_yet']);
    expect(snaps.find((s) => s.agent_id === 'roger')!.current_task!.source).toBe('sqlite');
    expect(snaps.every((s) => s.degraded_source === false)).toBe(true);
  });

  it('uses extractCurrentTaskTitle on the message body', async () => {
    const { db, repo } = await freshDb();
    await seedDispatch(repo, {
      to_agent: 'roger',
      dispatched_at: 1000,
      message: '# Build the read-side dashboard\n\nMore notes here.',
    });
    const model = new SqliteCurrentTaskReadModel(db);
    const [snap] = await model.getCurrentTaskByAgent(['roger']);
    expect(snap.current_task!.title).toBe('Build the read-side dashboard');
  });
});
