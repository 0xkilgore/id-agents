// SPDX-License-Identifier: MIT

import crypto from 'crypto';
import type { SqliteAdapter } from '../sqlite-adapter.js';

export async function migrateSqlite(adapter: SqliteAdapter): Promise<void> {
  adapter.exec(`
    CREATE TABLE IF NOT EXISTS teams (
      id TEXT PRIMARY KEY,
      name TEXT UNIQUE NOT NULL,
      config TEXT NOT NULL DEFAULT '{}',
      port_start INTEGER NOT NULL DEFAULT 4101,
      port_end INTEGER NOT NULL DEFAULT 4125,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      model TEXT NOT NULL,
      port INTEGER NOT NULL DEFAULT 0,
      endpoint TEXT,
      working_directory TEXT,
      status TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      registry TEXT,
      metadata TEXT,
      deleted_at INTEGER,
      runtime TEXT DEFAULT 'claude-agent-sdk',
      token_id TEXT,
      domain TEXT,
      api_key TEXT,
      customer_domain TEXT,
      public_endpoint_url TEXT,
      internal_endpoint_url TEXT,
      ssh_target TEXT
    );

    CREATE TABLE IF NOT EXISTS wallets (
      agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
      address TEXT NOT NULL,
      private_key TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (agent_id)
    );

    CREATE TABLE IF NOT EXISTS news_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
      agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      timestamp INTEGER NOT NULL,
      type TEXT NOT NULL,
      message TEXT,
      data TEXT,
      query_id TEXT,
      kind TEXT,
      reply_expected INTEGER
    );

    CREATE TABLE IF NOT EXISTS queries (
      team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
      agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      query_id TEXT NOT NULL,
      status TEXT NOT NULL,
      prompt TEXT,
      created INTEGER NOT NULL,
      completed INTEGER,
      result TEXT,
      error TEXT,
      session_id TEXT,
      PRIMARY KEY (agent_id, query_id)
    );

    CREATE INDEX IF NOT EXISTS agents_team_name_idx ON agents(team_id, name);
    CREATE INDEX IF NOT EXISTS news_items_agent_time_idx ON news_items(team_id, agent_id, timestamp);
    CREATE INDEX IF NOT EXISTS news_items_query_idx ON news_items(team_id, agent_id, query_id);
    CREATE INDEX IF NOT EXISTS agents_token_idx ON agents(token_id) WHERE token_id IS NOT NULL;

    CREATE TABLE IF NOT EXISTS schedule_definitions (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT,
      active INTEGER NOT NULL DEFAULT 1,
      message TEXT NOT NULL,
      sender TEXT NOT NULL DEFAULT 'schedule',
      delivery_mode TEXT NOT NULL DEFAULT 'talk',
      timezone TEXT,
      catch_up_policy TEXT NOT NULL DEFAULT 'skip',
      dedupe_window_seconds INTEGER NOT NULL DEFAULT 90,
      interval_seconds INTEGER,
      anchor_at INTEGER,
      max_runs INTEGER,
      expires_at INTEGER,
      local_time_seconds INTEGER,
      local_date TEXT,
      days_of_week TEXT,
      source_type TEXT NOT NULL DEFAULT 'yaml',
      source_key TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS schedule_targets (
      schedule_id TEXT NOT NULL REFERENCES schedule_definitions(id) ON DELETE CASCADE,
      agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      PRIMARY KEY (schedule_id, agent_id)
    );

    CREATE TABLE IF NOT EXISTS schedule_runs (
      schedule_id TEXT NOT NULL REFERENCES schedule_definitions(id) ON DELETE CASCADE,
      agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      scheduled_key TEXT NOT NULL,
      scheduled_at INTEGER NOT NULL,
      fired_at INTEGER NOT NULL,
      status TEXT NOT NULL,
      error TEXT,
      PRIMARY KEY (schedule_id, agent_id, scheduled_key)
    );

    CREATE INDEX IF NOT EXISTS schedule_runs_schedule_idx ON schedule_runs(schedule_id, fired_at);
    CREATE INDEX IF NOT EXISTS schedule_runs_agent_idx ON schedule_runs(agent_id, fired_at);

    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      uuid TEXT,
      team_id TEXT REFERENCES teams(id) ON DELETE SET NULL,
      title TEXT NOT NULL,
      description TEXT,
      status TEXT NOT NULL,
      created_by TEXT REFERENCES agents(id) ON DELETE SET NULL,
      owner TEXT REFERENCES agents(id) ON DELETE SET NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      completed_at INTEGER,
      UNIQUE(team_id, name)
    );

    CREATE TABLE IF NOT EXISTS task_event_links (
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      schedule_id TEXT NOT NULL REFERENCES schedule_definitions(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (task_id, schedule_id)
    );

    CREATE INDEX IF NOT EXISTS tasks_status_idx ON tasks(status, updated_at);
    CREATE INDEX IF NOT EXISTS tasks_owner_idx ON tasks(owner, status, updated_at);
    CREATE INDEX IF NOT EXISTS tasks_team_idx ON tasks(team_id, status, updated_at);
    CREATE INDEX IF NOT EXISTS task_event_links_schedule_idx ON task_event_links(schedule_id, task_id);

    CREATE TABLE IF NOT EXISTS event_log (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
      topic TEXT NOT NULL,
      actor_agent_id TEXT,
      subject_kind TEXT,
      subject_id TEXT,
      occurred_at INTEGER NOT NULL,
      data TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS event_log_team_seq_idx ON event_log(team_id, seq);
    CREATE INDEX IF NOT EXISTS event_log_team_topic_seq_idx ON event_log(team_id, topic, seq);
    CREATE INDEX IF NOT EXISTS event_log_team_subject_idx ON event_log(team_id, subject_kind, subject_id, seq);

    CREATE TABLE IF NOT EXISTS subscriptions (
      id TEXT PRIMARY KEY,
      team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
      owner_agent_id TEXT NOT NULL,
      mode TEXT NOT NULL,
      status TEXT NOT NULL,
      filter_json TEXT NOT NULL,
      target_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      last_acked_seq INTEGER,
      last_error TEXT,
      consecutive_failures INTEGER NOT NULL DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS subscriptions_team_owner_idx
      ON subscriptions(team_id, owner_agent_id, status);

    CREATE TABLE IF NOT EXISTS webhook_delivery_attempts (
      id TEXT PRIMARY KEY,
      subscription_id TEXT NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
      event_seq INTEGER NOT NULL,
      scheduled_at INTEGER NOT NULL,
      attempted_at INTEGER,
      status TEXT NOT NULL,
      http_status INTEGER,
      error TEXT
    );

    CREATE UNIQUE INDEX IF NOT EXISTS webhook_delivery_once_idx
      ON webhook_delivery_attempts(subscription_id, event_seq);
  `);

  try {
    adapter.exec(`ALTER TABLE schedule_definitions ADD COLUMN delivery_mode TEXT NOT NULL DEFAULT 'talk'`);
  } catch {
    // Column already exists in upgraded databases.
  }

  // Tasks: add uuid column for short-id lookups (#xxxxxxxx)
  try {
    adapter.exec(`ALTER TABLE tasks ADD COLUMN uuid TEXT`);
  } catch {
    // Column already exists in upgraded databases.
  }

  // news_items: layered metadata (talk|notify plus reply_expected) on top of
  // the existing event `type`. Populated on new writes; old rows stay null.
  try {
    adapter.exec(`ALTER TABLE news_items ADD COLUMN kind TEXT`);
  } catch {
    // Column already exists in upgraded databases.
  }
  try {
    adapter.exec(`ALTER TABLE news_items ADD COLUMN reply_expected INTEGER`);
  } catch {
    // Column already exists in upgraded databases.
  }

  // Remote endpoint columns for public-agent-remote registry entries (Phase 2).
  // All four columns are nullable so existing rows stay intact (backfill-safe).
  // Each ALTER is wrapped in try/catch so a repeated migration call is a no-op.
  try {
    adapter.exec(`ALTER TABLE agents ADD COLUMN customer_domain TEXT`);
  } catch {
    // Column already exists in upgraded databases.
  }
  try {
    adapter.exec(`ALTER TABLE agents ADD COLUMN public_endpoint_url TEXT`);
  } catch {
    // Column already exists in upgraded databases.
  }
  try {
    adapter.exec(`ALTER TABLE agents ADD COLUMN internal_endpoint_url TEXT`);
  } catch {
    // Column already exists in upgraded databases.
  }
  try {
    adapter.exec(`ALTER TABLE agents ADD COLUMN ssh_target TEXT`);
  } catch {
    // Column already exists in upgraded databases.
  }

  // Phase 5: remote heartbeat probe columns.
  try {
    adapter.exec(`ALTER TABLE agents ADD COLUMN last_seen INTEGER`);
  } catch {
    // Column already exists in upgraded databases.
  }
  try {
    adapter.exec(`ALTER TABLE agents ADD COLUMN last_probed_at INTEGER`);
  } catch {
    // Column already exists in upgraded databases.
  }
  try {
    adapter.exec(`ALTER TABLE agents ADD COLUMN last_error TEXT`);
  } catch {
    // Column already exists in upgraded databases.
  }
  try {
    adapter.exec(`ALTER TABLE agents ADD COLUMN consecutive_failures INTEGER NOT NULL DEFAULT 0`);
  } catch {
    // Column already exists in upgraded databases.
  }

  // Backfill uuid for any existing rows that lack one
  const missing = await adapter.query<{ id: string }>(`SELECT id FROM tasks WHERE uuid IS NULL OR uuid = ''`);
  for (const row of missing.rows) {
    await adapter.query(`UPDATE tasks SET uuid = ? WHERE id = ?`, [crypto.randomUUID(), row.id]);
  }

  adapter.exec(`CREATE UNIQUE INDEX IF NOT EXISTS tasks_uuid_idx ON tasks(uuid)`);

  // Tasks: migrate from global name UNIQUE to (team_id, name) UNIQUE.
  // SQLite does not support DROP CONSTRAINT, so we use the rename-copy-swap pattern
  // guarded by a PRAGMA check to detect whether the old global uniqueness is still present.
  await migrateTasks_TeamNameUnique(adapter);
}

/**
 * Idempotent migration: change tasks uniqueness from `name UNIQUE` to
 * `UNIQUE(team_id, name)`.
 *
 * Approach: check if the tasks table has a column-level UNIQUE on `name`
 * (present when `name TEXT NOT NULL UNIQUE` was used). If it does, rebuild
 * the table with the new composite constraint.
 *
 * This runs on every start but is a no-op if the constraint is already correct.
 */
async function migrateTasks_TeamNameUnique(adapter: SqliteAdapter): Promise<void> {
  // Inspect the existing CREATE TABLE SQL for the tasks table
  const { rows } = await adapter.query<{ sql: string }>(
    `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'tasks'`,
  );
  if (!rows[0]) return; // table doesn't exist yet (first run handled by CREATE TABLE above)

  const ddl = rows[0].sql || '';

  // If the DDL already has UNIQUE(team_id, name), migration is done
  if (ddl.includes('UNIQUE(team_id, name)') || ddl.includes('UNIQUE (team_id, name)')) return;

  // Check whether the old global name UNIQUE is present (column-level UNIQUE on name)
  // Look for 'name TEXT NOT NULL UNIQUE' pattern
  if (!ddl.toLowerCase().includes('name text not null unique')) return;

  // Rename-copy-swap migration
  adapter.exec(`
    ALTER TABLE tasks RENAME TO tasks_old;

    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      uuid TEXT,
      team_id TEXT REFERENCES teams(id) ON DELETE SET NULL,
      title TEXT NOT NULL,
      description TEXT,
      status TEXT NOT NULL,
      created_by TEXT REFERENCES agents(id) ON DELETE SET NULL,
      owner TEXT REFERENCES agents(id) ON DELETE SET NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      completed_at INTEGER,
      UNIQUE(team_id, name)
    );

    INSERT INTO tasks SELECT * FROM tasks_old;

    DROP TABLE tasks_old;

    CREATE INDEX IF NOT EXISTS tasks_status_idx ON tasks(status, updated_at);
    CREATE INDEX IF NOT EXISTS tasks_owner_idx ON tasks(owner, status, updated_at);
    CREATE INDEX IF NOT EXISTS tasks_team_idx ON tasks(team_id, status, updated_at);
    CREATE UNIQUE INDEX IF NOT EXISTS tasks_uuid_idx ON tasks(uuid);
  `);
}
