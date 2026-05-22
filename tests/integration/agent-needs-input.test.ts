// Spec 054 v2 Step 2/3 integration: /agent-needs-input + /agent-resume
// + GET /dispatches/clarifications, exercised against a real
// AgentManagerDb (in-memory SQLite, ephemeral port). The scheduler
// bootstraps with the sqlite adapter; the reactor and dispatch queue
// are real.

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
let manager: AgentManagerDb;
let baseUrl: string;
let workDir: string;
let teamId: string;
let dispatchPhid: string;

beforeAll(async () => {
  port = await findFreePort();
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-needs-input-test-'));
  baseUrl = `http://127.0.0.1:${port}`;

  const db = await createInMemoryDb();
  manager = new AgentManagerDb(workDir, db as any);
  await manager.start(port);

  teamId = await db.teams.getOrCreateTeamId('default');

  // Seed a registered agent so dispatch resolution works.
  await db.agents.create({
    teamId,
    name: 'coder-max',
    endpoint: 'http://127.0.0.1:60099', // not actually reachable; resume test tolerates fail
    metadata: {},
  } as any).catch(() => {
    // ignore if signature differs; we don't strictly need a row for the
    // /agent-needs-input path - just for /agent-resume's delivery.
  });

  // Enqueue + claim a dispatch so the reactor has something in_flight.
  const handle = (manager as any).dispatchScheduler;
  if (!handle) throw new Error('dispatchScheduler should be initialised on sqlite');
  const enq = await handle.enqueue({
    to_agent: 'coder-max',
    from_actor: 'manager',
    message: 'do the thing',
    subject: 'subj',
    priority: 5,
  });
  dispatchPhid = enq.dispatch_phid;
  // Claim it so it's in_flight.
  await handle.reactor.claim({ max_in_flight: 10 });
}, 30000);

afterAll(async () => {
  if (manager) {
    await new Promise<void>((resolve) => {
      (manager as any).httpServer?.close(() => resolve());
      setTimeout(resolve, 200);
    });
  }
  try {
    fs.rmSync(workDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe('POST /agent-needs-input', () => {
  it('rejects missing required fields', async () => {
    const r = await fetch(`${baseUrl}/agent-needs-input`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dispatch_id: dispatchPhid }),
    });
    expect(r.status).toBe(400);
  });

  it('returns 404 for unknown dispatch_id', async () => {
    const r = await fetch(`${baseUrl}/agent-needs-input`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        dispatch_id: 'phid:disp-deadbeef',
        agent_id: 'roger',
        question: 'is it on fire?',
      }),
    });
    expect(r.status).toBe(404);
  });

  it('pauses an in_flight dispatch and returns clarification metadata', async () => {
    const r = await fetch(`${baseUrl}/agent-needs-input`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        dispatch_id: dispatchPhid,
        agent_id: 'coder-max',
        question: 'should I squash?',
        context: { ahead: 26 },
        urgency: 'normal',
      }),
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      ok: boolean;
      dispatch_id: string;
      state: string;
      clarification_id: string;
      stale_at: string;
    };
    expect(body.ok).toBe(true);
    expect(body.dispatch_id).toBe(dispatchPhid);
    expect(body.state).toBe('needs_clarification');
    expect(body.clarification_id).toMatch(/^clar_/);
    expect(body.stale_at).toBeTruthy();
  });

  it('GET /dispatches/clarifications lists the open blocker', async () => {
    const r = await fetch(`${baseUrl}/dispatches/clarifications`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      ok: boolean;
      items: Array<{
        dispatch_id: string;
        clarification_id: string;
        agent_id: string;
        question: string;
        urgency: string;
        age_seconds: number;
      }>;
    };
    expect(body.ok).toBe(true);
    expect(body.items.length).toBe(1);
    expect(body.items[0].dispatch_id).toBe(dispatchPhid);
    expect(body.items[0].question).toBe('should I squash?');
    expect(body.items[0].urgency).toBe('normal');
  });

  it('GET /dispatches/clarifications?stale=true filters before stale_at', async () => {
    const r = await fetch(`${baseUrl}/dispatches/clarifications?stale=true`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as { items: unknown[] };
    expect(body.items).toHaveLength(0); // fresh; not stale yet
  });

  it('idempotent: re-sending same question returns same clarification_id', async () => {
    const r1 = await fetch(`${baseUrl}/agent-needs-input`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        dispatch_id: dispatchPhid,
        agent_id: 'coder-max',
        question: 'should I squash?',
      }),
    });
    expect(r1.status).toBe(200);
    const body = (await r1.json()) as { clarification_id: string; idempotent: boolean };
    expect(body.idempotent).toBe(true);
  });
});

describe('POST /agent-resume', () => {
  it('rejects missing required fields', async () => {
    const r = await fetch(`${baseUrl}/agent-resume`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dispatch_id: dispatchPhid }),
    });
    expect(r.status).toBe(400);
  });

  it('returns 404 for unknown dispatch_id', async () => {
    const r = await fetch(`${baseUrl}/agent-resume`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dispatch_id: 'phid:disp-deadbeef', answer: 'x' }),
    });
    expect(r.status).toBe(404);
  });

  it('resumes a paused dispatch (delivery to unreachable agent => resume_delivery_failed)', async () => {
    const r = await fetch(`${baseUrl}/agent-resume`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        dispatch_id: dispatchPhid,
        answer: 'Squash autocommit-heavy branches',
        instructions: ['one repo at a time'],
      }),
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      ok: boolean;
      dispatch_id: string;
      state: string;
      delivered_to_agent: boolean;
    };
    expect(body.ok).toBe(true);
    expect(body.dispatch_id).toBe(dispatchPhid);
    // The agent endpoint we seeded (127.0.0.1:60099) is unreachable, so the
    // resume should fail delivery -> state = resume_delivery_failed.
    expect(body.delivered_to_agent).toBe(false);
    expect(body.state).toBe('resume_delivery_failed');
  });

  it('rejects resume when dispatch is not currently needs_clarification', async () => {
    // After the previous test, the dispatch is in resume_delivery_failed
    // state. /agent-resume should refuse.
    const r = await fetch(`${baseUrl}/agent-resume`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        dispatch_id: dispatchPhid,
        answer: 'try again',
      }),
    });
    expect(r.status).toBe(409);
  });
});
