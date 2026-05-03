// SPDX-License-Identifier: MIT

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { SqliteAdapter } from '../../src/db/sqlite-adapter.js';
import { migrateSqlite } from '../../src/db/migrations/sqlite.js';

async function freshDb(): Promise<SqliteAdapter> {
  const adapter = new SqliteAdapter(':memory:');
  await migrateSqlite(adapter);
  return adapter;
}

// ===========================================================================
// Migration — schema structure
// ===========================================================================

describe('SQLite migration', () => {
  it('creates all 5 tables', async () => {
    const adapter = await freshDb();
    const { rows } = await adapter.query<{ name: string }>(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
    );
    const names = rows.map((r) => r.name).sort();
    assert.deepStrictEqual(names, ['agents', 'news_items', 'queries', 'teams', 'wallets']);
  });

  it('creates all 4 indexes', async () => {
    const adapter = await freshDb();
    const { rows } = await adapter.query<{ name: string }>(
      `SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
    );
    const names = rows.map((r) => r.name).sort();
    assert.ok(names.includes('agents_team_name_idx'), `Missing agents_team_name_idx. Found: ${names}`);
    assert.ok(names.includes('agents_token_idx'), `Missing agents_token_idx. Found: ${names}`);
    assert.ok(names.includes('news_items_agent_time_idx'), `Missing news_items_agent_time_idx. Found: ${names}`);
    assert.ok(names.includes('news_items_query_idx'), `Missing news_items_query_idx. Found: ${names}`);
  });

  it('enforces foreign keys (insert agent with fake team_id should throw)', async () => {
    const adapter = await freshDb();
    await assert.rejects(
      async () => {
        await adapter.query(
          `INSERT INTO agents (team_id, id, name, type, model, status, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          ['non-existent-team-id', 'agent-1', 'test', 'claude', 'sonnet', 'running', Date.now()],
        );
      },
      (err: Error) => {
        // SQLite throws FOREIGN KEY constraint error
        assert.ok(
          err.message.includes('FOREIGN KEY') || err.message.includes('foreign key'),
          `Expected FK error, got: ${err.message}`,
        );
        return true;
      },
    );
  });

  it('news_items.id auto-increments', async () => {
    const adapter = await freshDb();

    // Create a team first
    await adapter.query(
      `INSERT INTO teams (id, name) VALUES (?, ?)`,
      ['team-1', 'auto-inc-team'],
    );

    // Create an agent
    await adapter.query(
      `INSERT INTO agents (team_id, id, name, type, model, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ['team-1', 'agent-1', 'test', 'claude', 'sonnet', 'running', Date.now()],
    );

    // Insert two news items without specifying id
    await adapter.query(
      `INSERT INTO news_items (team_id, agent_id, timestamp, type) VALUES (?, ?, ?, ?)`,
      ['team-1', 'agent-1', 1000, 'msg'],
    );
    await adapter.query(
      `INSERT INTO news_items (team_id, agent_id, timestamp, type) VALUES (?, ?, ?, ?)`,
      ['team-1', 'agent-1', 2000, 'msg'],
    );

    const { rows } = await adapter.query<{ id: number }>(
      `SELECT id FROM news_items ORDER BY id ASC`,
    );
    assert.equal(rows.length, 2);
    assert.ok(typeof rows[0].id === 'number');
    assert.ok(typeof rows[1].id === 'number');
    assert.ok(rows[1].id > rows[0].id, `Expected ${rows[1].id} > ${rows[0].id}`);
  });
});
