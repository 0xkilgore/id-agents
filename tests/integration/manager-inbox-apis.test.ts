// SPDX-License-Identifier: MIT
/**
 * Step 2 of the manager-collapse migration (docs/design/manager-collapse.md):
 * daemon-owned manager inbox APIs.
 *
 *   - GET  /manager/inbox/pending   — pending queries + scheduled work for the
 *                                     manager-inbox identity in the active team
 *   - POST /manager/inbox/respond   — { query_id, message, session_id? } —
 *                                     marks the query completed, emits the
 *                                     same news/event/waiter wakeup the
 *                                     existing /news reply path emits
 *
 * These tests boot the real AgentManagerDb against an in-memory SQLite DB,
 * post a query via /talk + a scheduled query via /schedule, then exercise
 * read + respond + idempotency + error cases. They additionally verify that
 * a long-poll GET /query/:id?wait= unblocks when /manager/inbox/respond
 * fires the same waiter primitive POST /news uses.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as net from 'net';
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
import { SqliteEventsRepo } from '../../src/db/repos/sqlite/events-repo.js';

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
    async close() { await adapter.close(); },
  };
}

async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      server.close(() => resolve(addr.port));
    });
    server.on('error', reject);
  });
}

function teamHeaders(team: string): Record<string, string> {
  return { 'Content-Type': 'application/json', 'X-Id-Team': team, 'X-Id-Admin': '1' };
}

let port: number;
let baseUrl: string;
let workDir: string;
let manager: AgentManagerDb;
let db: Awaited<ReturnType<typeof createInMemoryDb>>;

beforeAll(async () => {
  port = await findFreePort();
  baseUrl = `http://127.0.0.1:${port}`;
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'manager-inbox-apis-test-'));
  db = await createInMemoryDb();
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

describe('GET /manager/inbox/pending', () => {
  const TEAM = 'inbox-pending-test';

  it('returns pending queries and scheduled work for the manager inbox', async () => {
    await db.teams.getOrCreateTeamId(TEAM);

    // Inbound /talk -> pending manager query.
    const talkRes = await fetch(`${baseUrl}/talk`, {
      method: 'POST',
      headers: teamHeaders(TEAM),
      body: JSON.stringify({ message: 'please review the PR', from: 'tester' }),
    });
    expect(talkRes.status).toBe(202);
    const talkBody = await talkRes.json() as { query_id: string };

    // /schedule -> a second pending manager query that carries schedule meta.
    const schedRes = await fetch(`${baseUrl}/schedule`, {
      method: 'POST',
      headers: teamHeaders(TEAM),
      body: JSON.stringify({
        message: 'autonomous wake-up: refresh news',
        schedule: {
          id: 'sched_1',
          kind: 'cron',
          title: 'refresh news',
          scheduledKey: '0 9 * * *',
        },
        mode: 'internal',
      }),
    });
    expect(schedRes.status).toBe(202);
    const schedBody = await schedRes.json() as { query_id: string };

    const res = await fetch(`${baseUrl}/manager/inbox/pending`, { headers: teamHeaders(TEAM) });
    expect(res.status).toBe(200);
    const body = await res.json() as {
      ok: boolean;
      team: string;
      inbox_id: string;
      count: number;
      pending: Array<{
        query_id: string;
        message: string;
        prompt: string | null;
        timestamp: number;
        status: string;
        from: string | null;
        schedule: Record<string, unknown> | null;
        mode: string | null;
      }>;
    };
    expect(body.ok).toBe(true);
    expect(body.team).toBe(TEAM);
    expect(body.inbox_id).toBe(`manager-${TEAM}`);
    expect(body.count).toBe(2);

    const ids = body.pending.map((p) => p.query_id);
    expect(ids).toContain(talkBody.query_id);
    expect(ids).toContain(schedBody.query_id);

    const talkPending = body.pending.find((p) => p.query_id === talkBody.query_id)!;
    expect(talkPending.status).toBe('pending');
    // /talk persists the prompt with a "[From: <sender>]" prefix and does not
    // copy `from` into the query row's result — mirror that behavior so this
    // surface stays faithful to how InteractiveAgentServer.getPending reads.
    expect(talkPending.message).toContain('please review the PR');
    expect(talkPending.message).toContain('tester');
    expect(talkPending.from).toBeNull();
    expect(talkPending.schedule).toBeNull();

    const schedPending = body.pending.find((p) => p.query_id === schedBody.query_id)!;
    expect(schedPending.schedule).toMatchObject({ id: 'sched_1', kind: 'cron' });
    expect(schedPending.mode).toBe('internal');

    // Manager inbox queries use owner_kind only; agent_id remains NULL.
    const teamId = await db.teams.getOrCreateTeamId(TEAM);
    for (const qid of [talkBody.query_id, schedBody.query_id]) {
      const row = await db.queries.getByQueryIdForTeam(teamId, qid);
      expect(row).not.toBeNull();
      expect(row!.agent_id).toBeNull();
      expect(row!.owner_kind).toBe('manager');
      expect(row!.owner_id).toBe(teamId);
    }

    // The companion news rows (query.received + schedule.received) must also
    // be dual-written.
    const newsRows = await db.news.pollByOwner(teamId, 'manager', teamId, 0, { limit: 50 });
    const types = ['query.received', 'schedule.received'];
    for (const t of types) {
      const row = newsRows.find((r) => r.type === t);
      expect(row, `expected ${t} news row`).toBeTruthy();
      expect(row!.agent_id).toBeNull();
      expect(row!.owner_kind).toBe('manager');
      expect(row!.owner_id).toBe(teamId);
    }
  });

  it('returns an empty list for a freshly-created team without creating a stub', async () => {
    const FRESH = 'inbox-pending-fresh';
    const res = await fetch(`${baseUrl}/manager/inbox/pending`, { headers: teamHeaders(FRESH) });
    expect(res.status).toBe(200);
    const body = await res.json() as { count: number; pending: unknown[]; inbox_id: string };
    expect(body.count).toBe(0);
    expect(body.pending).toEqual([]);
    expect(body.inbox_id).toBe(`manager-${FRESH}`);
    expect(await db.agents.getById(`manager-${FRESH}`)).toBeNull();
  });
});

describe('POST /manager/inbox/respond', () => {
  const TEAM = 'inbox-respond-test';

  async function postQuery(message = 'do the thing'): Promise<string> {
    const res = await fetch(`${baseUrl}/talk`, {
      method: 'POST',
      headers: teamHeaders(TEAM),
      body: JSON.stringify({ message, from: 'tester' }),
    });
    expect(res.status).toBe(202);
    const body = await res.json() as { query_id: string };
    return body.query_id;
  }

  it('preserves IAS query.completed shape and emits query:delivered through the shared lifecycle', async () => {
    const queryId = await postQuery('please review');
    const teamId = await db.teams.getOrCreateTeamId(TEAM);

    const res = await fetch(`${baseUrl}/manager/inbox/respond`, {
      method: 'POST',
      headers: teamHeaders(TEAM),
      body: JSON.stringify({ query_id: queryId, message: 'reviewed; lgtm' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; query_id: string; status: string; timestamp: number };
    expect(body.ok).toBe(true);
    expect(body.status).toBe('completed');

    // Query row uses the existing IAS result shape: { result: <response> }.
    const row = await db.queries.getByQueryIdForTeam(teamId, queryId);
    expect(row?.status).toBe('completed');
    expect(row?.completed).toBe(body.timestamp);
    expect((row?.result as any)?.result).toBe('reviewed; lgtm');

    // News row matches the IAS query.completed shape: type=query.completed,
    // data carries query_id + nested result.result. No top-level `message`,
    // no `from` field, no agent-style `reply` type.
    const newsRes = await fetch(`${baseUrl}/news?limit=20&query_id=${queryId}`, { headers: teamHeaders(TEAM) });
    expect(newsRes.ok).toBe(true);
    const newsBody = await newsRes.json() as { items: Array<{ type: string; data: any }> };
    const completedRow = newsBody.items.find(
      (i) => i.type === 'query.completed' && i.data?.query_id === queryId,
    );
    expect(completedRow).toBeTruthy();
    expect(completedRow!.data.result).toEqual({ result: 'reviewed; lgtm' });
    // No agent-style `reply` row should appear for a manager-side response.
    const replyRows = newsBody.items.filter(
      (i) => i.type === 'reply' && i.data?.in_reply_to === queryId,
    );
    expect(replyRows.length).toBe(0);

    // query:delivered event landed in the wakeup-service event log via the
    // shared completeQueryDelivery helper.
    const events = await db.events.query({ teamId, topics: ['query:delivered'] });
    const matching = events.filter((e: any) => e.subject_id === queryId);
    expect(matching.length).toBe(1);

    // Dual-write window: the query.completed news row written by
    // /manager/inbox/respond carries owner_kind + NULL legacy agent_id.
    const newsRows = await db.news.pollByOwner(teamId, 'manager', teamId, 0, { limit: 100 });
    const completedNews = newsRows.find(
      (r) => r.type === 'query.completed' && r.query_id === queryId,
    );
    expect(completedNews).toBeTruthy();
    expect(completedNews!.agent_id).toBeNull();
    expect(completedNews!.owner_kind).toBe('manager');
    expect(completedNews!.owner_id).toBe(teamId);
  });

  it('threads session_id into both the queries result and the news data when provided', async () => {
    const queryId = await postQuery('continue session?');
    const teamId = await db.teams.getOrCreateTeamId(TEAM);

    const res = await fetch(`${baseUrl}/manager/inbox/respond`, {
      method: 'POST',
      headers: teamHeaders(TEAM),
      body: JSON.stringify({ query_id: queryId, message: 'yes', session_id: 'sess_abc' }),
    });
    expect(res.status).toBe(200);

    const row = await db.queries.getByQueryIdForTeam(teamId, queryId);
    expect((row?.result as any)?.result).toBe('yes');
    expect((row?.result as any)?.session_id).toBe('sess_abc');

    const newsRes = await fetch(`${baseUrl}/news?limit=20&query_id=${queryId}`, { headers: teamHeaders(TEAM) });
    const newsBody = await newsRes.json() as { items: Array<{ type: string; data: any }> };
    const completedRow = newsBody.items.find(
      (i) => i.type === 'query.completed' && i.data?.query_id === queryId,
    );
    expect(completedRow!.data.session_id).toBe('sess_abc');
  });

  it('is idempotent — second respond on the same query returns 409 query_not_pending', async () => {
    const queryId = await postQuery('reply twice?');

    const first = await fetch(`${baseUrl}/manager/inbox/respond`, {
      method: 'POST',
      headers: teamHeaders(TEAM),
      body: JSON.stringify({ query_id: queryId, message: 'first' }),
    });
    expect(first.status).toBe(200);

    const second = await fetch(`${baseUrl}/manager/inbox/respond`, {
      method: 'POST',
      headers: teamHeaders(TEAM),
      body: JSON.stringify({ query_id: queryId, message: 'second' }),
    });
    expect(second.status).toBe(409);
    const body = await second.json() as { error: string; status: string };
    expect(body.error).toBe('query_not_pending');
    expect(body.status).toBe('completed');
  });

  it('returns 400 when query_id or message is missing', async () => {
    const noId = await fetch(`${baseUrl}/manager/inbox/respond`, {
      method: 'POST',
      headers: teamHeaders(TEAM),
      body: JSON.stringify({ message: 'oops' }),
    });
    expect(noId.status).toBe(400);

    const noMsg = await fetch(`${baseUrl}/manager/inbox/respond`, {
      method: 'POST',
      headers: teamHeaders(TEAM),
      body: JSON.stringify({ query_id: 'whatever' }),
    });
    expect(noMsg.status).toBe(400);
  });

  it('returns 404 when the query_id is unknown for this team', async () => {
    const res = await fetch(`${baseUrl}/manager/inbox/respond`, {
      method: 'POST',
      headers: teamHeaders(TEAM),
      body: JSON.stringify({ query_id: 'query_does_not_exist', message: 'hi' }),
    });
    expect(res.status).toBe(404);
  });

  it('unblocks long-poll GET /query/:id?wait= using the same waiter primitive POST /news triggers', async () => {
    const queryId = await postQuery('wait for me');

    const longPoll = fetch(`${baseUrl}/query/${queryId}?wait=10`, { headers: teamHeaders(TEAM) });
    // Yield so the waiter is registered before respond fires.
    await new Promise((r) => setTimeout(r, 50));

    const respondRes = await fetch(`${baseUrl}/manager/inbox/respond`, {
      method: 'POST',
      headers: teamHeaders(TEAM),
      body: JSON.stringify({ query_id: queryId, message: 'unblocked' }),
    });
    expect(respondRes.status).toBe(200);

    const queryRes = await longPoll;
    expect(queryRes.status).toBe(200);
    const body = await queryRes.json() as { status: string; result?: any };
    expect(body.status).toBe('delivered');
    // IAS-style result shape: { result: <response> }.
    expect(body.result?.result).toBe('unblocked');
  });
});
