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
import { migrateDispatchAttemptLedger } from '../../src/dispatch-attempt-ledger/storage.js';

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
let handle: any;

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
  handle = (manager as any).dispatchScheduler;
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

async function enqueueClarification(input: {
  subject: string;
  question: string;
  context?: unknown;
  agent_id?: string;
}) {
  const enq = await handle.enqueue({
    to_agent: input.agent_id ?? 'coder-max',
    from_actor: 'manager',
    message: input.subject,
    subject: input.subject,
    priority: 5,
  });
  await handle.reactor.claim({ max_in_flight: 10 });
  const r = await fetch(`${baseUrl}/agent-needs-input`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      dispatch_id: enq.dispatch_phid,
      agent_id: input.agent_id ?? 'coder-max',
      question: input.question,
      context: input.context ?? null,
      urgency: 'normal',
    }),
  });
  expect(r.status).toBe(200);
  return enq.dispatch_phid as string;
}

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

  // Spec 054 v2 review fix: the spec example shows `"dispatch_id": 1234`
  // (numeric). Endpoint must NOT 400 on a numeric input - it should
  // coerce to string and resolve through the normal phid/query_id paths.
  // Numeric values that don't match anything resolve to 404 (correct
  // behavior), not 400.
  it('accepts a numeric dispatch_id (per spec example) without 400-ing', async () => {
    const r = await fetch(`${baseUrl}/agent-needs-input`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        dispatch_id: 1234,
        agent_id: 'roger',
        question: 'spec-shaped numeric input',
      }),
    });
    // The numeric value coerces to "1234", which doesn't match any
    // live phid or query_id, so the endpoint correctly responds 404
    // (NOT 400). Either response proves the numeric input was
    // accepted past validation; the test pins the 404 path.
    expect(r.status).toBe(404);
  });

  it('rejects malformed dispatch_id inputs (objects, booleans, null) with 400', async () => {
    for (const bad of [null, false, true, { foo: 'bar' }, ['a']]) {
      const r = await fetch(`${baseUrl}/agent-needs-input`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          dispatch_id: bad,
          agent_id: 'roger',
          question: 'q',
        }),
      });
      expect(r.status).toBe(400);
    }
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

  it('GET /dispatches/:id/clarification reads the exact body from linked query evidence', async () => {
    const target = await enqueueClarification({
      subject: 'Action Center evidence',
      question: 'Which release lane owns this promotion?',
      context: { branch: 'feature/action-center' },
    });
    const list = await fetch(`${baseUrl}/dispatches/clarifications`);
    const listBody = (await list.json()) as { items: Array<{ dispatch_id: string; clarification_id: string }> };
    const clarificationId = listBody.items.find((item) => item.dispatch_id === target)!.clarification_id;
    const queryId = `query_action_center_${Date.now()}`;
    const now = Date.now();
    const adapter = (manager as any).db.adapter;
    await migrateDispatchAttemptLedger(adapter);
    await adapter.query(
      `INSERT INTO queries (team_id, query_id, status, created, completed, result)
       VALUES (?, ?, 'completed', ?, ?, ?)`,
      [teamId, queryId, now, now, JSON.stringify({ result: { dispatch_id: target, clarification_id: clarificationId, agent_id: 'coder-max', question: 'Which release lane owns this promotion?', context: { branch: 'feature/action-center' }, urgency: 'normal' } })],
    );
    await adapter.query(
      `INSERT INTO dispatch_attempt_ledger
       (id, team_id, correlation_key, original_query_id, original_dispatch_id, attempts_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, '[]', ?, ?)`,
      [`attempt_action_${now}`, teamId, `dispatch:${target}`, queryId, target, new Date(now).toISOString(), new Date(now).toISOString()],
    );

    const response = await fetch(`${baseUrl}/dispatches/${target}/clarification`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      schema_version: 'dispatch-clarification-read.v1',
      dispatch_id: target,
      dispatch_state: 'needs_clarification',
      clarification: {
        clarification_id: clarificationId,
        state: 'open',
        question: 'Which release lane owns this promotion?',
        context: { branch: 'feature/action-center' },
      },
      source: { original_query_id: queryId, complete: true },
    });
  });

  it('returns typed validation and unlinked-evidence errors', async () => {
    const invalid = await fetch(`${baseUrl}/dispatches/query_123/clarification`);
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({ error: 'invalid_dispatch_id' });

    const unlinkedDispatch = await enqueueClarification({
      subject: 'Unlinked Action Center evidence',
      question: 'Where is the durable evidence?',
    });
    const unlinked = await fetch(`${baseUrl}/dispatches/${unlinkedDispatch}/clarification`);
    expect(unlinked.status).toBe(409);
    expect(await unlinked.json()).toEqual({
      ok: false,
      error: 'clarification_evidence_unlinked',
      source_state: 'unavailable_unlinked',
    });
  });

  it('GET /dispatches/clarifications groups repeated Spec 054 promotion questions into bounded action classes', async () => {
    const noRemoteIds = [
      await enqueueClarification({
        subject: 'promote no remote 1',
        question: 'Spec 054 promotion blocked: repo has no configured remote.',
        context: { repo: '/repo/kapelle', branch: 'fix/no-remote' },
      }),
      await enqueueClarification({
        subject: 'promote no remote 2',
        question: 'Spec 054 promotion blocked: remote origin not found.',
        context: { repo: '/repo/kapelle', branch: 'fix/no-remote-2' },
      }),
    ];
    const divergentId = await enqueueClarification({
      subject: 'promote divergent',
      question: 'promote-to-main preflight found branch ahead=1 behind=14; divergent ancestry needs operator input.',
      context: { repo: '/repo/kapelle', branch: 'fix/diverged' },
    });
    const focusedId = await enqueueClarification({
      subject: 'promote focused green broad red',
      question: 'Focused tests passed green, but broad test suite is red. Should promotion continue?',
      context: { focused: 'vitest agent-needs-input', broad: 'npm test failed' },
    });
    const ambiguousRepoId = await enqueueClarification({
      subject: 'promote ambiguous repo',
      question: 'Spec 054 promotion blocked: ambiguous repo metadata; which repo should be promoted?',
      context: { repos: ['/repo/a', '/repo/b'] },
    });

    const r = await fetch(`${baseUrl}/dispatches/clarifications`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      batches: {
        schema_version: string;
        dispatch_id_limit: number;
        action_classes: Array<{
          action_class: string;
          count: number;
          oldest_age_seconds: number;
          dispatch_ids: string[];
          recommended_owner: string;
        }>;
      };
    };

    expect(body.batches.schema_version).toBe('dispatch_clarification_batches.v1');
    expect(body.batches.dispatch_id_limit).toBe(10);
    expect(body.batches.action_classes).toHaveLength(4);
    expect(body.batches.action_classes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action_class: 'no_remote',
          count: 2,
          dispatch_ids: expect.arrayContaining(noRemoteIds),
          recommended_owner: 'release-engineering',
        }),
        expect.objectContaining({
          action_class: 'divergent_branch',
          count: 1,
          dispatch_ids: [divergentId],
          recommended_owner: 'release-engineering',
        }),
        expect.objectContaining({
          action_class: 'focused_green_broad_red',
          count: 1,
          dispatch_ids: [focusedId],
          recommended_owner: 'test-owner',
        }),
        expect.objectContaining({
          action_class: 'ambiguous_repo',
          count: 1,
          dispatch_ids: [ambiguousRepoId],
          recommended_owner: 'dispatcher',
        }),
      ]),
    );
    for (const batch of body.batches.action_classes) {
      expect(batch.oldest_age_seconds).toBeGreaterThanOrEqual(0);
    }
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

  // Spec 054 v2 review fix: accept numeric dispatch_id (spec example
  // shape) without 400-ing.
  it('accepts a numeric dispatch_id (per spec example) without 400-ing', async () => {
    const r = await fetch(`${baseUrl}/agent-resume`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dispatch_id: 1234, answer: 'go' }),
    });
    // 1234 coerces to "1234", doesn't resolve to any dispatch, returns 404 (not 400).
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

  it.each(['redeliver', 'follow_up_dispatch', 'cancel', 'moot'] as const)(
    'records inert, structured %s repair decisions with owner and receipt',
    async (action) => {
      const r = await fetch(`${baseUrl}/dispatches/${encodeURIComponent(dispatchPhid)}/resume-delivery-repair`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, owner: 'oncall', receipt: `ops-130-${action}` }),
      });
      expect(r.status).toBe(200);
      const body = await r.json() as any;
      expect(body).toMatchObject({
        ok: true,
        schema_version: 'resume-delivery-repair-ledger.v1',
        dispatch_id: dispatchPhid,
        state: 'resume_delivery_failed',
        executed: false,
        repair: {
          type: 'RESUME_DELIVERY_REPAIR_RECORDED',
          repair_action: action,
          owner: 'oncall',
          receipt: `ops-130-${action}`,
        },
      });
      expect((await handle.reactor.getByPhid(dispatchPhid)).status).toBe('resume_delivery_failed');
    },
  );

  it('rejects unbounded or unrecognized repair ledger input', async () => {
    const invalid = await fetch(`${baseUrl}/dispatches/${encodeURIComponent(dispatchPhid)}/resume-delivery-repair`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'retry', owner: 'oncall', receipt: 'ops-130' }),
    });
    expect(invalid.status).toBe(400);
    const oversized = await fetch(`${baseUrl}/dispatches/${encodeURIComponent(dispatchPhid)}/resume-delivery-repair`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'redeliver', owner: 'oncall', receipt: 'x'.repeat(513) }),
    });
    expect(oversized.status).toBe(400);

    // Four entries were recorded by the table fixture above. Fill the
    // remaining bounded slots, then prove the 21st entry cannot grow history.
    for (let i = 4; i < 20; i += 1) {
      const fill = await fetch(`${baseUrl}/dispatches/${encodeURIComponent(dispatchPhid)}/resume-delivery-repair`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'moot', owner: 'oncall', receipt: `bounded-${i}` }),
      });
      expect(fill.status).toBe(200);
    }
    const full = await fetch(`${baseUrl}/dispatches/${encodeURIComponent(dispatchPhid)}/resume-delivery-repair`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'moot', owner: 'oncall', receipt: 'bounded-20' }),
    });
    expect(full.status).toBe(409);
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
