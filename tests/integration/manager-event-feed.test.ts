import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';

import { AgentManagerDb } from '../../src/agent-manager-db.js';
import { migrateSqlite } from '../../src/db/migrations/sqlite.js';
import { SqliteAdapter } from '../../src/db/sqlite-adapter.js';
import { SqliteAgentsRepo } from '../../src/db/repos/sqlite/agents-repo.js';
import { SqliteEventsRepo } from '../../src/db/repos/sqlite/events-repo.js';
import { SqliteNewsRepo } from '../../src/db/repos/sqlite/news-repo.js';
import { SqliteQueriesRepo } from '../../src/db/repos/sqlite/queries-repo.js';
import { SqliteSchedulesRepo } from '../../src/db/repos/sqlite/schedules-repo.js';
import { SqliteSubscriptionsRepo } from '../../src/db/repos/sqlite/subscriptions-repo.js';
import { SqliteTasksRepo } from '../../src/db/repos/sqlite/tasks-repo.js';
import { SqliteTeamsRepo } from '../../src/db/repos/sqlite/teams-repo.js';

const TEAM = 'default';

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

function headers(team = TEAM): Record<string, string> {
  return { 'Content-Type': 'application/json', 'X-Id-Team': team, 'X-Id-Admin': '1' };
}

interface EventsResponse {
  events: Array<{
    seq: number;
    topic: string;
    subject: { kind: string | null; id: string | null } | null;
    data: Record<string, unknown>;
  }>;
  next_seq: number;
  replay_truncated: boolean;
  earliest_available_seq: number | null;
}

async function getManagerFeed(baseUrl: string, since: number): Promise<EventsResponse> {
  const res = await fetch(`${baseUrl}/events?since=${since}&topics=manager:feed`, {
    headers: headers(),
  });
  expect(res.status).toBe(200);
  return res.json() as Promise<EventsResponse>;
}

describe('manager event feed v0', () => {
  let manager: AgentManagerDb;
  let db: Awaited<ReturnType<typeof createInMemoryDb>>;
  let baseUrl: string;
  let workDir: string;

  beforeAll(async () => {
    const port = await findFreePort();
    baseUrl = `http://127.0.0.1:${port}`;
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'manager-event-feed-'));
    db = await createInMemoryDb();
    manager = new AgentManagerDb(workDir, db as any);
    await manager.start(port);

    const teamId = await db.teams.getOrCreateTeamId(TEAM);
    await db.agents.create({
      team_id: teamId,
      id: 'agent-coder-feed',
      name: 'coder-feed',
      type: 'persistent',
      model: 'claude-opus',
      port: 25001,
      endpoint: 'http://127.0.0.1:19999',
      status: 'active',
      created_at: Date.now(),
      runtime: 'claude-code',
    });
  }, 30000);

  afterAll(async () => {
    if (manager) {
      await new Promise<void>((resolve) => {
        (manager as any).httpServer?.close(() => resolve());
        setTimeout(resolve, 500);
      });
    }
    try { await db?.close(); } catch { /* ignore */ }
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('replays from cursor 0 and resumes from next_seq without duplicates or gaps', async () => {
    const taskRes = await fetch(`${baseUrl}/tasks`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({
        title: 'Feed smoke task',
        name: 'feed-smoke-task',
        from: 'coder-feed',
      }),
    });
    expect(taskRes.status).toBe(201);

    const enqueueRes = await fetch(`${baseUrl}/dispatch/enqueue`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({
        to_agent: 'coder-feed',
        from_actor: 'operator',
        subject: 'Feed smoke dispatch',
        message: 'Exercise the manager event feed',
      }),
    });
    expect(enqueueRes.status).toBe(200);
    const enqueued = await enqueueRes.json() as { dispatch_phid: string; query_id: string };

    const acceptRes = await fetch(`${baseUrl}/dispatches/${encodeURIComponent(enqueued.dispatch_phid)}/accept`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ agent_query_id: 'agent-query-feed-1' }),
    });
    expect(acceptRes.status).toBe(200);

    const first = await getManagerFeed(baseUrl, 0);
    expect(first.events.map((event) => event.topic)).toEqual([
      'task:created',
      'dispatch:queued',
      'dispatch:in_flight',
    ]);
    expect(first.next_seq).toBe(first.events[first.events.length - 1].seq);
    expect(first.replay_truncated).toBe(false);

    const artifactPath = path.join(workDir, 'output', 'feed-artifact.md');
    fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
    fs.writeFileSync(artifactPath, '# Feed Artifact\n\nFresh output.\n');

    const doneRes = await fetch(`${baseUrl}/agent-done`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({
        dispatch_id: enqueued.dispatch_phid,
        query_id: enqueued.query_id,
        success: true,
        artifact_path: artifactPath,
        result: { artifact_path: artifactPath, tl_dr: 'Feed artifact' },
      }),
    });
    expect(doneRes.status).toBe(200);

    const second = await getManagerFeed(baseUrl, first.next_seq);
    expect(second.events.map((event) => event.topic)).toEqual([
      'dispatch:done',
      'artifact:registered',
    ]);
    expect(second.next_seq).toBe(second.events[second.events.length - 1].seq);

    const allSeqs = [...first.events, ...second.events].map((event) => event.seq);
    expect(new Set(allSeqs).size).toBe(allSeqs.length);
    expect(allSeqs).toEqual([...allSeqs].sort((a, b) => a - b));
    for (let i = 1; i < allSeqs.length; i += 1) {
      expect(allSeqs[i]).toBe(allSeqs[i - 1] + 1);
    }

    const emptyReconnect = await getManagerFeed(baseUrl, second.next_seq);
    expect(emptyReconnect.events).toEqual([]);
    expect(emptyReconnect.next_seq).toBe(second.next_seq);
  });
});
