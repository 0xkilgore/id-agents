// N1.2 Dispatch-Plan — integration test with Express + SQLite.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import http from 'http';
import { SqliteAdapter } from '../../src/db/sqlite-adapter.js';
import { migrateSqlite } from '../../src/db/migrations/sqlite.js';
import { mountGraphRoutes } from '../../src/graph/routes.js';
import type { EnqueueFn } from '../../src/graph/types.js';

let adapter: SqliteAdapter;
let server: http.Server;
let baseUrl: string;
let dispatchCounter = 0;
let enqueueCalls: Array<Record<string, unknown>> = [];

const fakeEnqueue: EnqueueFn = async (input) => {
  enqueueCalls.push(input);
  dispatchCounter++;
  return {
    query_id: `query_int_${dispatchCounter}`,
    dispatch_phid: `phid:disp-int-${dispatchCounter}`,
    status: 'queued',
  };
};

async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = http.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address() as { port: number };
      srv.close(() => resolve(addr.port));
    });
    srv.on('error', reject);
  });
}

beforeEach(async () => {
  dispatchCounter = 0;
  enqueueCalls = [];
  adapter = new SqliteAdapter(':memory:');
  await migrateSqlite(adapter);

  const app = express();
  app.use(express.json());
  mountGraphRoutes(app, adapter, { enqueueDispatch: fakeEnqueue });

  const port = await findFreePort();
  baseUrl = `http://127.0.0.1:${port}`;
  server = app.listen(port, '127.0.0.1');
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await adapter.close();
});

describe('POST /graphs/dispatch-plan — integration', () => {
  it('creates a two-node plan and returns correct shape', async () => {
    const res = await fetch(`${baseUrl}/graphs/dispatch-plan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'Build and review',
        created_by: { kind: 'user', id: 'chris', source: 'manager' },
        idempotency_key: 'plan:int-test:1',
        nodes: [
          {
            client_node_id: 'build',
            title: 'Build fixes',
            to_agent: 'roger',
            message: 'Implement fixes',
            repo: '/code/repo',
            branch: 'roger/fixes',
            promote: true,
          },
          {
            client_node_id: 'review',
            title: 'Review fixes',
            to_agent: 'cto',
            message: 'Review build output',
            promote: false,
            waits_on: [{ client_node_id: 'build', predicate: 'dispatch_success' }],
          },
        ],
      }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.schema_version).toBe('dispatch_graph.dispatch_plan.v1');
    expect(body.graph_id).toMatch(/^graph-/);
    expect(body.nodes).toHaveLength(2);

    const buildNode = body.nodes.find((n: any) => n.client_node_id === 'build');
    const reviewNode = body.nodes.find((n: any) => n.client_node_id === 'review');
    expect(buildNode.state).toBe('queued');
    expect(buildNode.dispatch_id).toMatch(/^phid:disp-/);
    expect(reviewNode.state).toBe('pending_dependencies');
    expect(reviewNode.waits_on).toEqual(['build']);
  });

  it('returns 400 for invalid request', async () => {
    const res = await fetch(`${baseUrl}/graphs/dispatch-plan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: '', nodes: [] }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBeTruthy();
  });

  it('idempotency: re-posting same key returns the same graph', async () => {
    const payload = {
      title: 'Idempotent plan',
      created_by: { kind: 'user', id: 'chris' },
      idempotency_key: 'plan:idemp-test:1',
      nodes: [
        { client_node_id: 'solo', title: 'Solo', to_agent: 'roger', message: 'do it' },
      ],
    };

    const res1 = await fetch(`${baseUrl}/graphs/dispatch-plan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    expect(res1.status).toBe(201);
    const body1 = await res1.json();

    const res2 = await fetch(`${baseUrl}/graphs/dispatch-plan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    expect(res2.status).toBe(201);
    const body2 = await res2.json();

    expect(body2.graph_id).toBe(body1.graph_id);
    // Enqueue called only once (1 node), not twice.
    expect(enqueueCalls).toHaveLength(1);
  });

  it('GET /graphs/:graph_id returns the plan graph detail', async () => {
    const createRes = await fetch(`${baseUrl}/graphs/dispatch-plan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'Detail test',
        created_by: { kind: 'user', id: 'chris' },
        idempotency_key: 'plan:detail-test:1',
        nodes: [
          { client_node_id: 'build', title: 'Build', to_agent: 'roger', message: 'build' },
          {
            client_node_id: 'review',
            title: 'Review',
            to_agent: 'cto',
            message: 'review',
            waits_on: [{ client_node_id: 'build', predicate: 'dispatch_success' }],
          },
        ],
      }),
    });
    const plan = await createRes.json();

    const detailRes = await fetch(`${baseUrl}/graphs/${plan.graph_id}`);
    expect(detailRes.status).toBe(200);
    const detail = await detailRes.json();

    expect(detail.graph.status).toBe('active');
    expect(detail.nodes).toHaveLength(2);
    expect(detail.edges).toHaveLength(1);

    const buildNode = detail.nodes.find((n: any) => n.dispatch_id?.includes('disp-'));
    expect(buildNode).toBeTruthy();
  });
});

describe('POST /graphs/dispatch-plan — 503 without scheduler', () => {
  it('returns 503 when enqueueDispatch is not configured', async () => {
    // Mount a separate app without enqueue.
    const noSchedAdapter = new SqliteAdapter(':memory:');
    await migrateSqlite(noSchedAdapter);
    const app = express();
    app.use(express.json());
    mountGraphRoutes(app, noSchedAdapter);

    const port = await findFreePort();
    const srv = app.listen(port, '127.0.0.1');

    try {
      const res = await fetch(`http://127.0.0.1:${port}/graphs/dispatch-plan`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: 'No scheduler',
          created_by: { kind: 'user', id: 'chris' },
          idempotency_key: 'plan:nosched:1',
          nodes: [
            { client_node_id: 'a', title: 'A', to_agent: 'roger', message: 'a' },
          ],
        }),
      });
      expect(res.status).toBe(503);
      const body = await res.json();
      expect(body.error).toMatch(/[Ss]cheduler/);
    } finally {
      await new Promise<void>((resolve) => srv.close(() => resolve()));
      await noSchedAdapter.close();
    }
  });
});
