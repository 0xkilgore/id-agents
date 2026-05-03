// SPDX-License-Identifier: MIT
/**
 * Manager-inbox resolution regression tests (cli-registry-refresh).
 *
 * Background: the manager inbox must remain daemon-owned even when teams
 * are fresh or stale interactive rows still exist. Reads and writes must
 * converge on the stable `manager-<team>` row instead of depending on CLI
 * registration or newest-interactive lookup.
 *
 * The fix routes all four entry points through `resolveManagerInboxId`,
 * which now uses the stable daemon-owned row id `manager-<team>` and
 * auto-provisions it when missing. This guarantees writes and reads
 * converge on the same DB row and ignore stale interactive manager rows.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { AgentManagerDb } from '../../src/agent-manager-db.js';
import { SqliteAdapter } from '../../src/db/sqlite-adapter.js';
import { migrateSqlite } from '../../src/db/migrations/sqlite.js';
import { SqliteTeamsRepo } from '../../src/db/repos/sqlite/teams-repo.js';
import { SqliteAgentsRepo } from '../../src/db/repos/sqlite/agents-repo.js';
import { SqliteQueriesRepo } from '../../src/db/repos/sqlite/queries-repo.js';
import { SqliteNewsRepo } from '../../src/db/repos/sqlite/news-repo.js';
import { SqliteSchedulesRepo } from '../../src/db/repos/sqlite/schedules-repo.js';
import { SqliteTasksRepo } from '../../src/db/repos/sqlite/tasks-repo.js';

function createInMemoryDb() {
  const adapter = new SqliteAdapter(':memory:');
  migrateSqlite(adapter);
  return {
    adapter,
    teams: new SqliteTeamsRepo(adapter),
    agents: new SqliteAgentsRepo(adapter),
    queries: new SqliteQueriesRepo(adapter),
    news: new SqliteNewsRepo(adapter),
    schedules: new SqliteSchedulesRepo(adapter),
    tasks: new SqliteTasksRepo(adapter),
    async close() { await adapter.close(); },
  };
}

async function findFreePort(): Promise<number> {
  const { createServer } = await import('net');
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      server.close(() => resolve(addr.port));
    });
    server.on('error', reject);
  });
}

let port: number;
let baseUrl: string;
let workDir: string;
let manager: AgentManagerDb;
let db: ReturnType<typeof createInMemoryDb>;

beforeAll(async () => {
  port = await findFreePort();
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'inbox-resolution-test-'));
  baseUrl = `http://127.0.0.1:${port}`;
  db = createInMemoryDb();
  manager = new AgentManagerDb(workDir, db as any);
  await manager.start(port);
}, 30000);

afterAll(async () => {
  if (manager) {
    await new Promise<void>((resolve) => {
      (manager as any).httpServer?.close(() => resolve());
      setTimeout(resolve, 500);
    });
  }
  try { fs.rmSync(workDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

function teamHeaders(team: string): Record<string, string> {
  // Loopback IP + X-Id-Admin lets the test create teams on the fly.
  // This is the same path /sync uses when it provisions a new team.
  return { 'Content-Type': 'application/json', 'X-Id-Team': team, 'X-Id-Admin': '1' };
}

describe('manager-inbox resolution — fresh team with no CLI registered', () => {
  const TEAM = 'inbox-fresh';

  it('POST /talk auto-provisions the manager-inbox stub and persists the query', async () => {
    // Pre-create the team to simulate the "freshly synced, no CLI yet"
    // state. The team exists in the DB but no interactive row references
    // it — the situation that previously silently blackholed replies.
    await db.teams.getOrCreateTeamId(TEAM);

    const res = await fetch(`${baseUrl}/talk`, {
      method: 'POST',
      headers: teamHeaders(TEAM),
      body: JSON.stringify({ message: 'hello fresh team', from: 'tester' }),
    });
    expect(res.status).toBe(202);
    const body = await res.json() as { query_id: string };
    expect(body.query_id).toMatch(/^query_/);

    const teamId = await db.teams.getOrCreateTeamId(TEAM);
    const stub = await db.agents.getById(`manager-${TEAM}`);
    expect(stub).not.toBeNull();
    expect(stub?.team_id).toBe(teamId);
    expect(stub?.type).toBe('interactive');

    // GET /news reads from the same id, so the query.received event must surface here.
    const newsRes = await fetch(`${baseUrl}/news?limit=10`, { headers: teamHeaders(TEAM) });
    expect(newsRes.ok).toBe(true);
    const newsBody = await newsRes.json() as { items: Array<{ type: string; data: any }> };
    const types = newsBody.items.map(i => i.type);
    expect(types).toContain('query.received');

    // Dual-write window: the same row must carry the new ownership columns
    // alongside the legacy agent_id. Read directly from the DB so we see
    // both columns and confirm /talk did not regress to single-write.
    const queryRow = await db.queries.getByQueryIdForTeam(teamId, body.query_id);
    expect(queryRow).not.toBeNull();
    expect(queryRow!.agent_id).toBe(`manager-${TEAM}`);
    expect(queryRow!.owner_kind).toBe('manager');
    expect(queryRow!.owner_id).toBe(teamId);

    const newsRows = await db.news.poll(`manager-${TEAM}`, 0, { limit: 10 });
    const received = newsRows.find((r) => r.type === 'query.received');
    expect(received).toBeTruthy();
    expect(received!.agent_id).toBe(`manager-${TEAM}`);
    expect(received!.owner_kind).toBe('manager');
    expect(received!.owner_id).toBe(teamId);
  });

  it('POST /news with in_reply_to does not blackhole when no inbox row exists', async () => {
    const TEAM2 = 'inbox-fresh-reply';

    // Send the reply first (no prior CLI/manager row in this team).
    const res = await fetch(`${baseUrl}/news`, {
      method: 'POST',
      headers: teamHeaders(TEAM2),
      body: JSON.stringify({
        from: 'agent-x',
        in_reply_to: 'qid-no-such-query',
        message: 'reply to query that never registered an inbox',
      }),
    });
    expect(res.status).toBe(201);

    // The stub interactive row should have been auto-provisioned and the
    // news item must be readable through GET /news.
    const teamId = await db.teams.getOrCreateTeamId(TEAM2);
    const stub = await db.agents.getById(`manager-${TEAM2}`);
    expect(stub).not.toBeNull();
    expect(stub?.team_id).toBe(teamId);

    const newsRes = await fetch(`${baseUrl}/news?limit=10`, { headers: teamHeaders(TEAM2) });
    expect(newsRes.ok).toBe(true);
    const body = await newsRes.json() as { items: Array<{ message: string; data: any }> };
    expect(body.items.length).toBeGreaterThan(0);
    const messages = body.items.map(i => i.message);
    expect(messages.some(m => m && m.includes('reply to query that never registered'))).toBe(true);

    // Dual-write window: the persisted reply row must carry both the
    // legacy agent_id (manager-<team>) and the new ownership columns.
    const newsRows = await db.news.poll(`manager-${TEAM2}`, 0, { limit: 10 });
    expect(newsRows.length).toBeGreaterThan(0);
    for (const row of newsRows) {
      expect(row.agent_id).toBe(`manager-${TEAM2}`);
      expect(row.owner_kind).toBe('manager');
      expect(row.owner_id).toBe(teamId);
    }
  });

  it('POST /schedule lands on the auto-provisioned inbox stub', async () => {
    const TEAM3 = 'inbox-fresh-schedule';

    const res = await fetch(`${baseUrl}/schedule`, {
      method: 'POST',
      headers: teamHeaders(TEAM3),
      body: JSON.stringify({
        message: 'scheduled wake-up',
        schedule: { id: 'sched-1', kind: 'cron', cadence: 'daily' },
        mode: 'internal',
      }),
    });
    expect(res.status).toBe(202);

    const stub = await db.agents.getById(`manager-${TEAM3}`);
    expect(stub).not.toBeNull();
    expect(stub?.type).toBe('interactive');

    const newsRes = await fetch(`${baseUrl}/news?limit=10`, { headers: teamHeaders(TEAM3) });
    const body = await newsRes.json() as { items: Array<{ type: string }> };
    expect(body.items.map(i => i.type)).toContain('schedule.received');

    // Dual-write window: /schedule writes both a query row and a news row.
    // Both must populate owner_kind='manager'/owner_id=<team_id> alongside
    // the legacy agent_id (manager-<team>).
    const teamId = await db.teams.getOrCreateTeamId(TEAM3);
    const newsRows = await db.news.poll(`manager-${TEAM3}`, 0, { limit: 10 });
    const scheduleRow = newsRows.find((r) => r.type === 'schedule.received');
    expect(scheduleRow).toBeTruthy();
    expect(scheduleRow!.agent_id).toBe(`manager-${TEAM3}`);
    expect(scheduleRow!.owner_kind).toBe('manager');
    expect(scheduleRow!.owner_id).toBe(teamId);

    const queryId = (scheduleRow!.data as any)?.query_id as string;
    expect(queryId).toBeTruthy();
    const queryRow = await db.queries.getByQueryIdForTeam(teamId, queryId);
    expect(queryRow).not.toBeNull();
    expect(queryRow!.agent_id).toBe(`manager-${TEAM3}`);
    expect(queryRow!.owner_kind).toBe('manager');
    expect(queryRow!.owner_id).toBe(teamId);
  });
});

describe('manager-inbox resolution — daemon-owned manager row wins', () => {
  const TEAM = 'inbox-multi';

  it('GET /news ignores interactive rows and uses the daemon-owned manager row', async () => {
    const teamId = await db.teams.getOrCreateTeamId(TEAM);

    // Stale interactive rows should no longer participate in manager-id
    // resolution once the daemon-owned manager row becomes authoritative.
    await db.agents.create({
      team_id: teamId,
      id: 'interactive_stale',
      name: 'stale-cli',
      type: 'interactive',
      model: '',
      status: 'running',
      created_at: 1000,
    });
    // Newer CLI registration after a /sync re-targeted this team.
    await db.agents.create({
      team_id: teamId,
      id: 'interactive_fresh',
      name: 'fresh-cli',
      type: 'interactive',
      model: '',
      status: 'running',
      created_at: 9999,
    });

    const postRes = await fetch(`${baseUrl}/news`, {
      method: 'POST',
      headers: teamHeaders(TEAM),
      body: JSON.stringify({ from: 'agent-y', message: 'multi-row probe' }),
    });
    expect(postRes.status).toBe(201);

    const managerRow = await db.agents.getById(`manager-${TEAM}`);
    expect(managerRow).not.toBeNull();
    expect(managerRow?.name).toBe('manager');

    const managerNews = await db.news.poll(`manager-${TEAM}`, 0, { limit: 10 });
    const fresh = await db.news.poll('interactive_fresh', 0, { limit: 10 });
    const stale = await db.news.poll('interactive_stale', 0, { limit: 10 });
    expect(managerNews.length).toBeGreaterThan(0);
    expect(stale.length).toBe(0);
    expect(fresh.length).toBe(0);
  });
});
