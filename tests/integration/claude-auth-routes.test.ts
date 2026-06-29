// SPDX-License-Identifier: MIT
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createServer } from 'net';
import { AgentManagerDb } from '../../src/agent-manager-db.js';
import { SqliteAdapter } from '../../src/db/sqlite-adapter.js';
import { migrateSqlite } from '../../src/db/migrations/sqlite.js';
import { SqliteTeamsRepo } from '../../src/db/repos/sqlite/teams-repo.js';
import { SqliteAgentsRepo } from '../../src/db/repos/sqlite/agents-repo.js';
import { SqliteQueriesRepo } from '../../src/db/repos/sqlite/queries-repo.js';
import { SqliteNewsRepo } from '../../src/db/repos/sqlite/news-repo.js';
import { SqliteSchedulesRepo } from '../../src/db/repos/sqlite/schedules-repo.js';
import { SqliteTasksRepo } from '../../src/db/repos/sqlite/tasks-repo.js';
import { SqliteEventsRepo } from '../../src/db/repos/sqlite/events-repo.js';
import { SqliteSubscriptionsRepo } from '../../src/db/repos/sqlite/subscriptions-repo.js';
import { MemoryClaudeCredentialStore } from '../../src/lib/claude-auth-store.js';

async function createInMemoryDb() {
  const adapter = new SqliteAdapter(':memory:');
  await migrateSqlite(adapter);
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
    async close() { await adapter.close(); },
  };
}

async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      server.close(() => resolve(addr.port));
    });
    server.on('error', reject);
  });
}

function headers(team: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'X-Id-Team': team,
  };
}

describe('Claude auth routes', () => {
  let manager: AgentManagerDb;
  let baseUrl: string;
  let workDir: string;
  let db: Awaited<ReturnType<typeof createInMemoryDb>>;

  beforeAll(async () => {
    const port = await findFreePort();
    baseUrl = `http://127.0.0.1:${port}`;
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-auth-routes-'));
    db = await createInMemoryDb();
    await db.teams.getOrCreateTeamId('alpha');
    await db.teams.getOrCreateTeamId('beta');
    manager = new AgentManagerDb(workDir, db as any, {
      claudeCredentialStore: new MemoryClaudeCredentialStore(),
    });
    await manager.start(port);
  }, 30000);

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      (manager as any).httpServer?.close(() => resolve());
      setTimeout(resolve, 1000);
    });
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch { /* ignore */ }
    await db.close();
  });

  it('connects, redacts, and deletes a team-scoped Claude credential', async () => {
    const connect = await fetch(`${baseUrl}/auth/claude/connect`, {
      method: 'POST',
      headers: headers('alpha'),
      body: JSON.stringify({ kind: 'claude-code-oauth', credential: 'oauth-token-alpha' }),
    });
    expect(connect.status).toBe(201);
    const connected = await connect.json() as any;
    expect(connected.connected).toBe(true);
    expect(connected.team).toBe('alpha');
    expect(connected.kind).toBe('claude-code-oauth');
    expect(JSON.stringify(connected)).not.toContain('oauth-token-alpha');

    const alphaStatus = await fetch(`${baseUrl}/auth/claude`, { headers: headers('alpha') });
    const alpha = await alphaStatus.json() as any;
    expect(alpha.connected).toBe(true);
    expect(alpha.team).toBe('alpha');
    expect(JSON.stringify(alpha)).not.toContain('oauth-token-alpha');

    const betaStatus = await fetch(`${baseUrl}/auth/claude`, { headers: headers('beta') });
    const beta = await betaStatus.json() as any;
    expect(beta.connected).toBe(false);
    expect(beta.team).toBe('beta');

    const deleted = await fetch(`${baseUrl}/auth/claude`, {
      method: 'DELETE',
      headers: headers('alpha'),
    });
    expect(deleted.ok).toBe(true);

    const afterDelete = await fetch(`${baseUrl}/auth/claude`, { headers: headers('alpha') });
    const body = await afterDelete.json() as any;
    expect(body.connected).toBe(false);
  });
});
