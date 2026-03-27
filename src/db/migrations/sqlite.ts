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
      team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
      id TEXT NOT NULL,
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
      PRIMARY KEY (team_id, id)
    );

    CREATE TABLE IF NOT EXISTS wallets (
      team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
      agent_id TEXT NOT NULL,
      address TEXT NOT NULL,
      private_key TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (team_id, agent_id),
      FOREIGN KEY (team_id, agent_id) REFERENCES agents(team_id, id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS news_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
      agent_id TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      type TEXT NOT NULL,
      message TEXT,
      data TEXT,
      query_id TEXT,
      FOREIGN KEY (team_id, agent_id) REFERENCES agents(team_id, id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS queries (
      team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
      agent_id TEXT NOT NULL,
      query_id TEXT NOT NULL,
      status TEXT NOT NULL,
      prompt TEXT,
      created INTEGER NOT NULL,
      completed INTEGER,
      result TEXT,
      error TEXT,
      session_id TEXT,
      FOREIGN KEY (team_id, agent_id) REFERENCES agents(team_id, id) ON DELETE CASCADE,
      PRIMARY KEY (team_id, agent_id, query_id)
    );

    CREATE INDEX IF NOT EXISTS agents_team_name_idx ON agents(team_id, name);
    CREATE INDEX IF NOT EXISTS news_items_agent_time_idx ON news_items(team_id, agent_id, timestamp);
    CREATE INDEX IF NOT EXISTS news_items_query_idx ON news_items(team_id, agent_id, query_id);
    CREATE INDEX IF NOT EXISTS agents_token_idx ON agents(token_id) WHERE token_id IS NOT NULL;
  `);
}
