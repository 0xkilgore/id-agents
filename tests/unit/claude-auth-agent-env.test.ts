// SPDX-License-Identifier: MIT
import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
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

describe('Claude auth local agent environment', () => {
  it('injects the team keychain credential into spawned Claude agents', async () => {
    const db = await createInMemoryDb();
    const store = new MemoryClaudeCredentialStore();
    const teamId = await db.teams.getOrCreateTeamId('alpha');
    await store.set(teamId, { kind: 'claude-code-oauth', secret: 'oauth-token-alpha' });

    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-auth-env-'));
    const manager = new AgentManagerDb(workDir, db as any, { claudeCredentialStore: store });

    try {
      const credential = await store.get(teamId);
      const env = (manager as any).buildLocalAgentEnv('alpha', 4101, null, undefined, undefined, credential);
      expect(env.ID_TEAM).toBe('alpha');
      expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('oauth-token-alpha');
      expect(env.ID_CLAUDE_AUTH_SOURCE).toBe('keychain');
    } finally {
      try { fs.rmSync(workDir, { recursive: true, force: true }); } catch { /* ignore */ }
      await db.close();
    }
  });
});
