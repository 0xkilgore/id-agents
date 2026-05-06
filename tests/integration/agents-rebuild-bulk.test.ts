// SPDX-License-Identifier: MIT
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createServer } from 'net';
import { randomUUID } from 'crypto';
import { AgentManagerDb } from '../../src/agent-manager-db.js';
import { SqliteAdapter } from '../../src/db/sqlite-adapter.js';
import { migrateSqlite } from '../../src/db/migrations/sqlite.js';
import { SqliteAgentsRepo } from '../../src/db/repos/sqlite/agents-repo.js';
import { SqliteCheckinsRepo } from '../../src/db/repos/sqlite/checkins-repo.js';
import { SqliteEventsRepo } from '../../src/db/repos/sqlite/events-repo.js';
import { SqliteNewsRepo } from '../../src/db/repos/sqlite/news-repo.js';
import { SqliteQueriesRepo } from '../../src/db/repos/sqlite/queries-repo.js';
import { SqliteSchedulesRepo } from '../../src/db/repos/sqlite/schedules-repo.js';
import { SqliteSubscriptionsRepo } from '../../src/db/repos/sqlite/subscriptions-repo.js';
import { SqliteTasksRepo } from '../../src/db/repos/sqlite/tasks-repo.js';
import { SqliteTeamsRepo } from '../../src/db/repos/sqlite/teams-repo.js';

async function findFreePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      server.close(() => resolve(addr.port));
    });
    server.on('error', reject);
  });
}

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
    checkins: new SqliteCheckinsRepo(adapter),
    async close() { await adapter.close(); },
  };
}

describe('POST /remote agents rebuild bulk command', () => {
  let port: number;
  let baseUrl: string;
  let workDir: string;
  let manager: AgentManagerDb;
  let db: Awaited<ReturnType<typeof createInMemoryDb>>;
  let teamSeq = 0;

  beforeAll(async () => {
    port = await findFreePort();
    baseUrl = `http://127.0.0.1:${port}`;
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-rebuild-bulk-'));
    db = await createInMemoryDb();
    manager = new AgentManagerDb(workDir, db as any);
    await manager.start(port);
  }, 30000);

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    if (manager) {
      await new Promise<void>((resolve) => {
        (manager as any).httpServer?.close(() => resolve());
        setTimeout(resolve, 500);
      });
    }
    await db?.close();
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  async function createTeam() {
    const name = `bulk-rebuild-${++teamSeq}-${Date.now()}`;
    const id = await db.teams.getOrCreateTeamId(name);
    return { id, name };
  }

  async function createAgent(teamId: string, overrides: {
    name: string;
    type?: string;
    runtime?: string | null;
    status?: string;
    port?: number;
  }) {
    const now = Math.floor(Date.now() / 1000);
    await db.agents.create({
      team_id: teamId,
      id: `agent-${randomUUID()}`,
      name: overrides.name,
      type: overrides.type ?? 'claude',
      model: 'sonnet',
      status: overrides.status ?? 'running',
      created_at: now,
      port: overrides.port ?? 4300 + teamSeq,
      runtime: overrides.runtime ?? 'claude-agent-sdk',
    });
  }

  async function sendRemote(teamName: string, command: string) {
    const res = await fetch(`${baseUrl}/remote`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Id-Team': teamName,
        'X-Id-Admin': '1',
      },
      body: JSON.stringify({ command }),
    });
    expect(res.ok).toBe(true);
    return await res.json() as any;
  }

  it('requires --confirm', async () => {
    const team = await createTeam();

    const body = await sendRemote(team.name, 'agents rebuild');

    expect(body).toEqual({ ok: false, error: 'Usage: /agents rebuild --confirm' });
  });

  it('rebuilds one eligible claude agent', async () => {
    const team = await createTeam();
    await createAgent(team.id, { name: 'rebuildable-claude' });
    const rebuild = vi.fn().mockResolvedValue({ success: true, pid: 12345, logFile: '/tmp/rebuildable-claude.log' });
    (manager as any).rebuildLocalClaudeAgent = rebuild;

    const body = await sendRemote(team.name, 'agents rebuild --confirm');

    expect(rebuild).toHaveBeenCalledTimes(1);
    expect(body).toEqual({
      ok: true,
      result: {
        action: 'agents-rebuild',
        rebuilt: 1,
        skipped: 0,
        failed: 0,
        agents: [{ name: 'rebuildable-claude', status: 'rebuilt', reason: 'rebuilt' }],
      },
    });
  });

  it('skips remote-endpoint agents with the lifecycle reason', async () => {
    const team = await createTeam();
    await createAgent(team.id, { name: 'remote-worker', runtime: 'public-agent-remote' });
    const rebuild = vi.fn().mockResolvedValue({ success: true });
    (manager as any).rebuildLocalClaudeAgent = rebuild;

    const body = await sendRemote(team.name, 'agents rebuild --confirm');

    expect(rebuild).not.toHaveBeenCalled();
    expect(body).toEqual({
      ok: true,
      result: {
        action: 'agents-rebuild',
        rebuilt: 0,
        skipped: 1,
        failed: 0,
        agents: [{ name: 'remote-worker', status: 'skipped', reason: 'lifecycle_not_supported_for_remote' }],
      },
    });
  });

  it('surfaces one spawn failure and continues rebuilding other agents', async () => {
    const team = await createTeam();
    await createAgent(team.id, { name: 'first-claude', port: 4401 });
    await createAgent(team.id, { name: 'second-claude', port: 4402 });
    const rebuild = vi
      .fn()
      .mockResolvedValueOnce({ success: false, error: 'spawn exploded' })
      .mockResolvedValueOnce({ success: true, pid: 12346, logFile: '/tmp/second-claude.log' });
    (manager as any).rebuildLocalClaudeAgent = rebuild;

    const body = await sendRemote(team.name, 'agents rebuild --confirm');

    expect(rebuild).toHaveBeenCalledTimes(2);
    expect(body).toEqual({
      ok: true,
      result: {
        action: 'agents-rebuild',
        rebuilt: 1,
        skipped: 0,
        failed: 1,
        agents: [
          { name: 'first-claude', status: 'failed', reason: 'spawn exploded' },
          { name: 'second-claude', status: 'rebuilt', reason: 'rebuilt' },
        ],
      },
    });
  });
});
