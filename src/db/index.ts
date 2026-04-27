// SPDX-License-Identifier: MIT
import type { Db } from './db-service.js';
import type { DbAdapter } from './db-adapter.js';
import type { SqliteAdapter } from './sqlite-adapter.js';

export async function createDb(): Promise<Db> {
  const databaseUrl = process.env.DATABASE_URL;

  if (databaseUrl) {
    const { Pool } = await import('pg');
    const { PgAdapter } = await import('./pg-adapter.js');
    const adapter = new PgAdapter(new Pool({ connectionString: databaseUrl }));
    console.log('Database: PostgreSQL');
    return createPostgresDb(adapter);
  }

  // SQLite mode (zero-config default)
  const { SqliteAdapter: SqliteAdapterImpl } = await import('./sqlite-adapter.js');
  const os = await import('node:os');
  const path = await import('node:path');
  const { mkdirSync } = await import('node:fs');
  const dataDir = path.join(os.homedir(), '.id-agents');
  mkdirSync(dataDir, { recursive: true });
  const dbPath = process.env.SQLITE_PATH || path.join(dataDir, 'id-agents.db');
  const adapter = new SqliteAdapterImpl(dbPath);
  console.log(`Database: SQLite (${dbPath})`);
  return createSqliteDb(adapter);
}

async function createPostgresDb(adapter: DbAdapter): Promise<Db> {
  const { PgTeamsRepo } = await import('./repos/postgres/teams-repo.js');
  const { PgAgentsRepo } = await import('./repos/postgres/agents-repo.js');
  const { PgQueriesRepo } = await import('./repos/postgres/queries-repo.js');
  const { PgNewsRepo } = await import('./repos/postgres/news-repo.js');
  const { PgSchedulesRepo } = await import('./repos/postgres/schedules-repo.js');
  const { PgTasksRepo } = await import('./repos/postgres/tasks-repo.js');
  const { PgEventsRepo } = await import('./repos/postgres/events-repo.js');
  const { PgSubscriptionsRepo } = await import('./repos/postgres/subscriptions-repo.js');
  const { PgCheckinsRepo } = await import('./repos/postgres/checkins-repo.js');
  return {
    adapter,
    teams: new PgTeamsRepo(adapter),
    agents: new PgAgentsRepo(adapter),
    queries: new PgQueriesRepo(adapter),
    news: new PgNewsRepo(adapter),
    schedules: new PgSchedulesRepo(adapter),
    tasks: new PgTasksRepo(adapter),
    events: new PgEventsRepo(adapter),
    subscriptions: new PgSubscriptionsRepo(adapter),
    checkins: new PgCheckinsRepo(adapter),
    async close() { await adapter.close(); },
  };
}

async function createSqliteDb(adapter: SqliteAdapter): Promise<Db> {
  const { SqliteTeamsRepo } = await import('./repos/sqlite/teams-repo.js');
  const { SqliteAgentsRepo } = await import('./repos/sqlite/agents-repo.js');
  const { SqliteQueriesRepo } = await import('./repos/sqlite/queries-repo.js');
  const { SqliteNewsRepo } = await import('./repos/sqlite/news-repo.js');
  const { SqliteSchedulesRepo } = await import('./repos/sqlite/schedules-repo.js');
  const { SqliteTasksRepo } = await import('./repos/sqlite/tasks-repo.js');
  const { SqliteEventsRepo } = await import('./repos/sqlite/events-repo.js');
  const { SqliteSubscriptionsRepo } = await import('./repos/sqlite/subscriptions-repo.js');
  const { SqliteCheckinsRepo } = await import('./repos/sqlite/checkins-repo.js');
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

export async function migrateDb(db: Db): Promise<void> {
  if (db.adapter.dialect === 'postgres') {
    const { migratePostgres } = await import('./migrations/postgres.js');
    await migratePostgres(db.adapter);
  } else {
    const { migrateSqlite } = await import('./migrations/sqlite.js');
    await migrateSqlite(db.adapter as SqliteAdapter);
  }
}

// Re-export types for convenience
export type { Db } from './db-service.js';
export type { DbAdapter, QueryResult } from './db-adapter.js';
export type {
  AgentRow,
  TeamRow,
  QueryRow,
  NewsItemRow,
  ScheduleDefinitionRow,
  ScheduleRunRow,
  TaskRow,
  TaskEventLinkRow,
  EventLogRow,
  SubscriptionRow,
  WebhookDeliveryAttemptRow,
  CheckinRow,
  CheckinStatus,
  CheckinPriority,
  MutableCheckinFields,
} from './types.js';
