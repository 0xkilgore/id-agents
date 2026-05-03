// SPDX-License-Identifier: MIT
/**
 * Slice 3 (wakeup-service-events-read) integration tests.
 *
 * Boots the real AgentManagerDb against an in-memory sqlite DB with the
 * wakeup-service tables migrated, seeds the event_log directly via the
 * EventsRepository (producers ship in a separate slice), then exercises
 * GET /events over HTTP. Verifies:
 *
 *   - empty result and full read from since=0
 *   - exclusive `since` cursor semantics
 *   - topic CSV filter and alias expansion (query:terminal)
 *   - default limit, explicit limit, and the 1000 hard cap
 *   - response shape for next_seq, replay_truncated, earliest_available_seq
 *   - team scoping via X-Id-Team header
 *
 * Wire format / field semantics: output/wakeup-service-design.md
 * ("`GET /events`").
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
import { SqliteSubscriptionsRepo } from '../../src/db/repos/sqlite/subscriptions-repo.js';

const TEAM = 'wakeup-events-read-test';

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
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      server.close(() => resolve(addr.port));
    });
    server.on('error', reject);
  });
}

async function stopManager(manager: AgentManagerDb): Promise<void> {
  await new Promise<void>((resolve) => {
    (manager as any).httpServer?.close(() => resolve());
    setTimeout(resolve, 500);
  });
}

function teamHeaders(team: string): Record<string, string> {
  // Same auth/team gating as /remote: X-Id-Team for routing,
  // X-Id-Admin: 1 + loopback IP lets the test create teams on the fly.
  return { 'Content-Type': 'application/json', 'X-Id-Team': team, 'X-Id-Admin': '1' };
}

interface EventsResponse {
  events: Array<{
    seq: number;
    team: string;
    topic: string;
    occurred_at: number;
    actor: string | null;
    subject: { kind: string | null; id: string | null } | null;
    data: Record<string, unknown>;
  }>;
  next_seq: number;
  replay_truncated: boolean;
  earliest_available_seq: number | null;
}

async function getEvents(
  baseUrl: string,
  team: string,
  query: Record<string, string | number | undefined> = {},
): Promise<{ status: number; body: EventsResponse }> {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined) params.set(k, String(v));
  }
  const qs = params.toString();
  const url = `${baseUrl}/events${qs ? `?${qs}` : ''}`;
  const res = await fetch(url, { headers: teamHeaders(team) });
  const body = (await res.json()) as EventsResponse;
  return { status: res.status, body };
}

describe('GET /events — wakeup-service catch-up read', () => {
  let manager: AgentManagerDb;
  let db: Awaited<ReturnType<typeof createInMemoryDb>>;
  let baseUrl: string;
  let workDir: string;
  let teamId: string;

  beforeAll(async () => {
    const port = await findFreePort();
    baseUrl = `http://127.0.0.1:${port}`;
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wakeup-events-read-test-'));
    db = await createInMemoryDb();
    manager = new AgentManagerDb(workDir, db as any);
    await manager.start(port);
    teamId = await db.teams.getOrCreateTeamId(TEAM);
  }, 30000);

  afterAll(async () => {
    if (manager) await stopManager(manager);
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('returns an empty batch, next_seq=since, earliest=null when the log is empty', async () => {
    const { status, body } = await getEvents(baseUrl, TEAM, { since: 0 });
    expect(status).toBe(200);
    expect(body.events).toEqual([]);
    expect(body.next_seq).toBe(0);
    expect(body.replay_truncated).toBe(false);
    expect(body.earliest_available_seq).toBeNull();
  });

  it('returns all events in seq order with the documented envelope shape (since=0)', async () => {
    const t0 = 1_777_300_000_000;
    const a = await db.events.insert({
      team_id: teamId,
      topic: 'query:delivered',
      actor_agent_id: 'coder',
      subject_kind: 'query',
      subject_id: 'query_a',
      occurred_at: t0,
      data: { status: 'delivered', query_id: 'query_a', message_preview: 'hi' },
    });
    const b = await db.events.insert({
      team_id: teamId,
      topic: 'task:created',
      actor_agent_id: 'cto',
      subject_kind: 'task',
      subject_id: 'task_b',
      occurred_at: t0 + 1,
      data: { name: 'task-b' },
    });
    const c = await db.events.insert({
      team_id: teamId,
      topic: 'agent:started',
      actor_agent_id: null,
      subject_kind: null,
      subject_id: null,
      occurred_at: t0 + 2,
      data: { reason: 'manual' },
    });

    const { status, body } = await getEvents(baseUrl, TEAM, { since: 0 });
    expect(status).toBe(200);
    expect(body.events.map((e) => e.seq)).toEqual([a.seq, b.seq, c.seq]);
    expect(body.next_seq).toBe(c.seq);
    expect(body.replay_truncated).toBe(false);
    expect(body.earliest_available_seq).toBe(a.seq);

    // Spot-check envelope shape on the first event.
    expect(body.events[0]).toEqual({
      seq: a.seq,
      team: TEAM,
      topic: 'query:delivered',
      occurred_at: t0,
      actor: 'coder',
      subject: { kind: 'query', id: 'query_a' },
      data: { status: 'delivered', query_id: 'query_a', message_preview: 'hi' },
    });

    // Subject collapses to null when both kind and id are null.
    const cEnv = body.events.find((e) => e.seq === c.seq)!;
    expect(cEnv.subject).toBeNull();
    expect(cEnv.actor).toBeNull();
  });

  it('treats `since` as an exclusive cursor (returns events with seq > since only)', async () => {
    // Reading state from the previous test: a, b, c are present.
    const earliest = await db.events.earliestSeq(teamId);
    expect(earliest).not.toBeNull();

    const { status, body } = await getEvents(baseUrl, TEAM, { since: earliest! });
    expect(status).toBe(200);
    // earliest itself is excluded; only the two later events return.
    expect(body.events.map((e) => e.seq)).toEqual([earliest! + 1, earliest! + 2]);
    expect(body.next_seq).toBe(earliest! + 2);
    expect(body.replay_truncated).toBe(false);
  });

  it('next_seq stays equal to the input `since` when the filter yields no events', async () => {
    const { status, body } = await getEvents(baseUrl, TEAM, {
      since: 0,
      topics: 'no:such:topic',
    });
    expect(status).toBe(200);
    expect(body.events).toEqual([]);
    expect(body.next_seq).toBe(0);
  });

  it('filters by an exact topic when the CSV contains a concrete topic', async () => {
    const { status, body } = await getEvents(baseUrl, TEAM, {
      since: 0,
      topics: 'task:created',
    });
    expect(status).toBe(200);
    expect(body.events.map((e) => e.topic)).toEqual(['task:created']);
  });

  it('expands the `query:terminal` alias into delivered/failed/expired server-side', async () => {
    // Add a failed query and an unrelated topic to confirm only terminal
    // query topics survive the filter.
    await db.events.insert({
      team_id: teamId,
      topic: 'query:failed',
      actor_agent_id: 'coder',
      subject_kind: 'query',
      subject_id: 'query_fail',
      occurred_at: 1_777_300_010_000,
      data: { status: 'failed', query_id: 'query_fail' },
    });
    await db.events.insert({
      team_id: teamId,
      topic: 'news:received',
      actor_agent_id: 'cto',
      subject_kind: null,
      subject_id: null,
      occurred_at: 1_777_300_011_000,
      data: { kind: 'notify' },
    });

    const { status, body } = await getEvents(baseUrl, TEAM, {
      since: 0,
      topics: 'query:terminal',
    });
    expect(status).toBe(200);
    const topics = body.events.map((e) => e.topic).sort();
    expect(topics).toEqual(['query:delivered', 'query:failed']);
  });

  it('caps `limit` at 1000 (large explicit limit is silently clamped)', async () => {
    // The repo default is 100 and the cap is 1000. A request with
    // limit=5000 should still succeed (no 400) and return at most 1000.
    const { status, body } = await getEvents(baseUrl, TEAM, {
      since: 0,
      limit: 5000,
    });
    expect(status).toBe(200);
    expect(body.events.length).toBeLessThanOrEqual(1000);
  });

  it('honours an explicit small `limit`', async () => {
    const { status, body } = await getEvents(baseUrl, TEAM, {
      since: 0,
      limit: 2,
    });
    expect(status).toBe(200);
    expect(body.events.length).toBe(2);
    // next_seq tracks the last included seq (not the global max).
    expect(body.next_seq).toBe(body.events[body.events.length - 1].seq);
  });

  it('rejects malformed `since` and `limit` query params with 400', async () => {
    const sinceBad = await fetch(`${baseUrl}/events?since=abc`, { headers: teamHeaders(TEAM) });
    expect(sinceBad.status).toBe(400);
    const sinceBody = (await sinceBad.json()) as { error: string };
    expect(sinceBody.error).toBe('invalid_since');

    const sinceNeg = await fetch(`${baseUrl}/events?since=-1`, { headers: teamHeaders(TEAM) });
    expect(sinceNeg.status).toBe(400);

    const limitZero = await fetch(`${baseUrl}/events?limit=0`, { headers: teamHeaders(TEAM) });
    expect(limitZero.status).toBe(400);
    const limitBody = (await limitZero.json()) as { error: string };
    expect(limitBody.error).toBe('invalid_limit');
  });

  it('isolates events per team — X-Id-Team header scopes the read', async () => {
    const otherTeam = 'wakeup-events-read-other';
    const otherTeamId = await db.teams.getOrCreateTeamId(otherTeam);
    await db.events.insert({
      team_id: otherTeamId,
      topic: 'task:created',
      actor_agent_id: 'cto',
      subject_kind: 'task',
      subject_id: 'task_other',
      occurred_at: 1_777_300_020_000,
      data: { name: 'task-other' },
    });

    // Read against the other team — only that team's single event
    // should come back, not the events seeded under TEAM in earlier
    // tests in this file.
    const { status, body } = await getEvents(baseUrl, otherTeam, { since: 0 });
    expect(status).toBe(200);
    expect(body.events.length).toBe(1);
    expect(body.events[0].subject?.id).toBe('task_other');
    expect(body.events[0].team).toBe(otherTeam);
  });
});

describe('GET /events — replay_truncated semantics', () => {
  let manager: AgentManagerDb;
  let db: Awaited<ReturnType<typeof createInMemoryDb>>;
  let baseUrl: string;
  let workDir: string;
  let teamId: string;
  const truncTeam = 'wakeup-events-trunc';

  beforeAll(async () => {
    const port = await findFreePort();
    baseUrl = `http://127.0.0.1:${port}`;
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wakeup-events-trunc-'));
    db = await createInMemoryDb();
    manager = new AgentManagerDb(workDir, db as any);
    await manager.start(port);
    teamId = await db.teams.getOrCreateTeamId(truncTeam);

    // Insert an initial event then delete it, simulating retention having
    // pruned older history. earliest_available_seq will then be the seq
    // of the next-inserted event, which is > 1.
    const first = await db.events.insert({
      team_id: teamId,
      topic: 'task:created',
      actor_agent_id: 'cto',
      subject_kind: 'task',
      subject_id: 'pruned',
      occurred_at: 1_777_400_000_000,
      data: {},
    });
    await db.adapter.query(`DELETE FROM event_log WHERE seq = ?`, [first.seq]);

    await db.events.insert({
      team_id: teamId,
      topic: 'task:created',
      actor_agent_id: 'cto',
      subject_kind: 'task',
      subject_id: 'kept',
      occurred_at: 1_777_400_001_000,
      data: {},
    });
  }, 30000);

  afterAll(async () => {
    if (manager) await stopManager(manager);
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('flags replay_truncated=true when `since` predates earliest_available_seq', async () => {
    const earliest = await db.events.earliestSeq(teamId);
    expect(earliest).not.toBeNull();
    expect(earliest!).toBeGreaterThan(1);

    // since=0 is strictly less than earliest, so the consumer is missing
    // history that's no longer retained.
    const { status, body } = await getEvents(baseUrl, truncTeam, { since: 0 });
    expect(status).toBe(200);
    expect(body.replay_truncated).toBe(true);
    expect(body.earliest_available_seq).toBe(earliest);
    expect(body.events.length).toBe(1);
    expect(body.next_seq).toBe(earliest);
  });

  it('flags replay_truncated=false when `since` >= earliest_available_seq', async () => {
    const earliest = await db.events.earliestSeq(teamId);
    expect(earliest).not.toBeNull();

    const { status, body } = await getEvents(baseUrl, truncTeam, { since: earliest! });
    expect(status).toBe(200);
    expect(body.replay_truncated).toBe(false);
    // No events with seq > earliest yet, so next_seq holds the cursor.
    expect(body.events).toEqual([]);
    expect(body.next_seq).toBe(earliest);
  });
});
