// SPDX-License-Identifier: MIT

import type { SqliteAdapter } from '../sqlite-adapter.js';

export function migrateSqlite(adapter: SqliteAdapter): void {
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
      api_key TEXT
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
      query_id TEXT
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
  `);
}
