// SPDX-License-Identifier: MIT
/**
 * Manager route GET /dashboard/agents/current-tasks — Phase 3 / Task 4.
 *
 * This is an integration-style test for the route's handler logic. It
 * uses a real in-memory SQLite-backed Db (so the SQLite read model
 * exercises real SQL), a fake fetch for the Vetra side, and the
 * extracted helpers from src/dispatches/current-task-route.ts. We avoid
 * booting the full manager Express app — the route file itself is a
 * thin Express adapter over these helpers and is exercised separately
 * via tsc.
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

import {
  buildCurrentTasksHandler,
  getUseVetraDispatchesFlag,
} from '../../src/dispatches/current-task-route.js';
import { SqliteCurrentTaskReadModel } from '../../src/dispatches/sqlite-current-task-read-model.js';
import { VetraCurrentTaskReadModel } from '../../src/dispatches/vetra-current-task-read-model.js';
import { SwitchboardClient } from '../../src/vetra/switchboard-client.js';
import type { Db } from '../../src/db/db-service.js';

async function freshDb() {
  const adapter = new SqliteAdapter(':memory:');
  await migrateSqlite(adapter);
  const db: Db = {
    adapter,
    teams: new SqliteTeamsRepo(adapter),
    agents: new SqliteAgentsRepo(adapter),
    queries: new SqliteQueriesRepo(adapter),
    news: new SqliteNewsRepo(adapter),
    schedules: new SqliteSchedulesRepo(adapter),
    tasks: new SqliteTasksRepo(adapter),
    dispatches: new SqliteDispatchesRepo(adapter),
    events: new SqliteEventsRepo(adapter),
    subscriptions: new SqliteSubscriptionsRepo(adapter),
    checkins: new SqliteCheckinsRepo(adapter),
    close: async () => {},
  } as unknown as Db;
  return db;
}

async function seed(db: Db, agent: string, message: string, ts: number, status: 'queued' | 'in_flight' = 'queued') {
  const id = await db.dispatches.create({
    team_id: null, dispatched_at: ts, from_actor: 'manager', to_agent: agent,
    channel: 'talk', message, query_id: null,
    verify_signal_json: null, parent_dispatch_id: null,
  });
  if (status !== 'queued') await db.dispatches.setStatus(id, status);
  return id;
}

function fakeFetchOk(body: unknown): typeof fetch {
  return (async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch;
}

function fakeFetchFail(): typeof fetch {
  return (async () => { throw new Error('network down'); }) as unknown as typeof fetch;
}

describe('getUseVetraDispatchesFlag', () => {
  it('is false by default', () => {
    expect(getUseVetraDispatchesFlag({})).toBe(false);
  });
  it('is true only when set to literal "true"', () => {
    expect(getUseVetraDispatchesFlag({ USE_VETRA_DISPATCHES: 'true' })).toBe(true);
    expect(getUseVetraDispatchesFlag({ USE_VETRA_DISPATCHES: 'TRUE' })).toBe(false);
    expect(getUseVetraDispatchesFlag({ USE_VETRA_DISPATCHES: '1' })).toBe(false);
    expect(getUseVetraDispatchesFlag({ USE_VETRA_DISPATCHES: '' })).toBe(false);
  });
});

describe('buildCurrentTasksHandler', () => {
  it('USE_VETRA_DISPATCHES=false returns SQLite snapshots with degraded_source=false', async () => {
    const db = await freshDb();
    await seed(db, 'roger', '# work it', 1000);
    const handler = buildCurrentTasksHandler({
      sqliteModel: new SqliteCurrentTaskReadModel(db),
      vetraModel: null,
      log: () => {},
    });
    const out = await handler({ agents: ['roger'] });
    expect(out.ok).toBe(true);
    expect(out.agents).toHaveLength(1);
    expect(out.agents[0].current_task!.source).toBe('sqlite');
    expect(out.agents[0].degraded_source).toBe(false);
  });

  it('USE_VETRA_DISPATCHES=true returns Vetra snapshots when adapter succeeds', async () => {
    const db = await freshDb();
    await seed(db, 'roger', 'sqlite version', 1000);
    const client = new SwitchboardClient({
      graphqlUrl: 'http://test/graphql',
      accessToken: null,
      fetchImpl: fakeFetchOk({ data: { openDispatches: [
        { dispatch_id: 'v-1', to_agent: 'roger', dispatched_at: '2026-05-08T10:00:00.000Z',
          status: 'IN_FLIGHT', body_markdown: 'vetra version', query_id: 'q-1',
          verify_status: null, artifacts: [] },
      ] } }),
    });
    const vetraModel = new VetraCurrentTaskReadModel(client);
    const handler = buildCurrentTasksHandler({
      sqliteModel: new SqliteCurrentTaskReadModel(db),
      vetraModel,
      log: () => {},
    });
    const out = await handler({ agents: ['roger'] });
    expect(out.agents[0].current_task!.source).toBe('vetra');
    expect(out.agents[0].current_task!.title).toBe('vetra version');
    expect(out.agents[0].degraded_source).toBe(false);
  });

  it('falls back to SQLite silently and sets degraded_source=true on Vetra failure', async () => {
    const db = await freshDb();
    await seed(db, 'roger', 'sqlite version', 1000);
    const logs: string[] = [];
    const client = new SwitchboardClient({
      graphqlUrl: 'http://test/graphql',
      accessToken: null,
      fetchImpl: fakeFetchFail(),
    });
    const vetraModel = new VetraCurrentTaskReadModel(client);
    const handler = buildCurrentTasksHandler({
      sqliteModel: new SqliteCurrentTaskReadModel(db),
      vetraModel,
      log: (m) => logs.push(m),
    });
    const out = await handler({ agents: ['roger'] });
    expect(out.ok).toBe(true);
    expect(out.agents[0].current_task!.source).toBe('sqlite');
    expect(out.agents[0].current_task!.title).toBe('sqlite version');
    expect(out.agents[0].degraded_source).toBe(true);
    // Internal log line, not a user-facing surface
    expect(logs.some((l) => l.includes('Vetra read failed') && l.includes('sqlite_succeeded=true'))).toBe(true);
  });

  it('falls back to SQLite when Vetra returns malformed payload', async () => {
    const db = await freshDb();
    await seed(db, 'roger', 'sqlite version', 1000);
    const client = new SwitchboardClient({
      graphqlUrl: 'http://test/graphql',
      accessToken: null,
      fetchImpl: fakeFetchOk({ errors: [{ message: 'kaboom' }] }),
    });
    const vetraModel = new VetraCurrentTaskReadModel(client);
    const handler = buildCurrentTasksHandler({
      sqliteModel: new SqliteCurrentTaskReadModel(db),
      vetraModel,
      log: () => {},
    });
    const out = await handler({ agents: ['roger'] });
    expect(out.agents[0].current_task!.source).toBe('sqlite');
    expect(out.agents[0].degraded_source).toBe(true);
  });

  it('preserves response shape when some agents have no open dispatch', async () => {
    const db = await freshDb();
    await seed(db, 'roger', 'has work', 1000);
    const handler = buildCurrentTasksHandler({
      sqliteModel: new SqliteCurrentTaskReadModel(db),
      vetraModel: null,
      log: () => {},
    });
    const out = await handler({ agents: ['roger', 'cto', 'sentinel'] });
    expect(out.agents).toHaveLength(3);
    const byAgent = Object.fromEntries(out.agents.map((s) => [s.agent_id, s]));
    expect(byAgent.roger.current_task).not.toBeNull();
    expect(byAgent.cto.current_task).toBeNull();
    expect(byAgent.sentinel.current_task).toBeNull();
    expect(byAgent.cto.degraded_source).toBe(false);
  });

  it('does not leak GraphQL/raw Vetra internals on fallback', async () => {
    const db = await freshDb();
    await seed(db, 'roger', 'sqlite', 1000);
    const client = new SwitchboardClient({
      graphqlUrl: 'http://test/graphql',
      accessToken: null,
      fetchImpl: fakeFetchOk({ errors: [{ message: 'sensitive internal trace' }] }),
    });
    const handler = buildCurrentTasksHandler({
      sqliteModel: new SqliteCurrentTaskReadModel(db),
      vetraModel: new VetraCurrentTaskReadModel(client),
      log: () => {},
    });
    const out = await handler({ agents: ['roger'] });
    const stringified = JSON.stringify(out);
    expect(stringified).not.toContain('sensitive internal trace');
    expect(stringified).not.toContain('GraphQL');
    expect(stringified).not.toContain('Switchboard');
  });

  it('logs include agent ids, reason, and sqlite_succeeded flag (operator visibility)', async () => {
    const db = await freshDb();
    await seed(db, 'roger', 'r', 1000);
    const logs: string[] = [];
    const handler = buildCurrentTasksHandler({
      sqliteModel: new SqliteCurrentTaskReadModel(db),
      vetraModel: new VetraCurrentTaskReadModel(new SwitchboardClient({
        graphqlUrl: 'http://t/graphql', accessToken: null, fetchImpl: fakeFetchFail(),
      })),
      log: (m) => logs.push(m),
    });
    await handler({ agents: ['roger', 'cto'] });
    const line = logs.find((l) => l.includes('Vetra read failed'));
    expect(line).toBeDefined();
    expect(line).toMatch(/agents=roger,cto/);
    expect(line).toMatch(/sqlite_succeeded=true/);
  });
});
