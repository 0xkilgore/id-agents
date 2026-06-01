// N1.5 Operator-Approval — Express + SQLite integration tests for
// POST /graphs/:graph_id/approvals/:approval_id/approve.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import http from 'http';
import { SqliteAdapter } from '../../src/db/sqlite-adapter.js';
import { migrateSqlite } from '../../src/db/migrations/sqlite.js';
import { mountGraphRoutes } from '../../src/graph/routes.js';
import {
  createGraph, addNode, addEdge, updateGraphStatus, getNode,
} from '../../src/graph/storage.js';
import { evaluateGraph } from '../../src/graph/runner.js';

let adapter: SqliteAdapter;
let server: http.Server;
let baseUrl: string;

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
  adapter = new SqliteAdapter(':memory:');
  await migrateSqlite(adapter);
  // Minimal dispatch row so the evaluator can resolve downstream
  // dispatch_id lookups (real schema is created by migrateSqlite).
  await adapter.query(
    `INSERT INTO dispatch_scheduler_queue (
       dispatch_phid, team_id, query_id, to_agent, from_actor, channel, subject,
       body_markdown, provider, runtime, status, not_before_at, updated_at
     ) VALUES (?, 'default', 'q', 'roger', 'test', 'test', 'subj', 'body',
       'anthropic', 'claude-code-cli', 'queued', '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z')`,
    ['phid:disp-build'],
  );
  const app = express();
  app.use(express.json());
  mountGraphRoutes(app, adapter);

  const port = await findFreePort();
  baseUrl = `http://127.0.0.1:${port}`;
  server = app.listen(port, '127.0.0.1');
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await adapter.close();
});

async function buildApprovalGraph(): Promise<{
  graphId: string;
  approvalNodeId: string;
  downstreamNodeId: string;
}> {
  const graph = await createGraph(adapter, 'approval-gates-build', { kind: 'test' });
  await updateGraphStatus(adapter, graph.graph_id, 'active');
  const approval = await addNode(adapter, graph.graph_id, 'Chris approval: ship N1.5', 'approval', {
    state: 'pending_dependencies',
  });
  const downstream = await addNode(adapter, graph.graph_id, 'build', 'dispatch', {
    dispatch_id: 'phid:disp-build',
    state: 'pending_dependencies',
  });
  await addEdge(adapter, graph.graph_id, approval.node_id, downstream.node_id, 'waits_on', {
    type: 'operator_approval',
    approval_id: approval.node_id,
  });
  // First evaluate so downstream gets its blocker_summary set.
  await evaluateGraph(adapter, graph.graph_id);
  return {
    graphId: graph.graph_id,
    approvalNodeId: approval.node_id,
    downstreamNodeId: downstream.node_id,
  };
}

// ─────────────────────────────────────────────────────────────────────
// 4xx guards
// ─────────────────────────────────────────────────────────────────────

describe('POST /graphs/:graph_id/approvals/:approval_id/approve — guards', () => {
  it('404 when graph does not exist', async () => {
    const res = await fetch(`${baseUrl}/graphs/graph-missing/approvals/whatever/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toMatch(/Graph not found/i);
  });

  it('404 when approval node does not exist in the graph', async () => {
    const { graphId } = await buildApprovalGraph();
    const res = await fetch(`${baseUrl}/graphs/${graphId}/approvals/node-missing/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toMatch(/approval node not found/i);
  });

  it('400 when the node exists but kind !== "approval"', async () => {
    const { graphId, downstreamNodeId } = await buildApprovalGraph();
    const res = await fetch(`${baseUrl}/graphs/${graphId}/approvals/${downstreamNodeId}/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/not an approval node/i);
  });

  it('404 when the approval node belongs to a DIFFERENT graph (cross-graph leak guard)', async () => {
    const { graphId: graphAId } = await buildApprovalGraph();
    // Build a second independent graph with its own approval node.
    const graphB = await createGraph(adapter, 'other', { kind: 'test' });
    await updateGraphStatus(adapter, graphB.graph_id, 'active');
    const otherApproval = await addNode(adapter, graphB.graph_id, 'Other approval', 'approval', {
      state: 'pending_dependencies',
    });

    const res = await fetch(`${baseUrl}/graphs/${graphAId}/approvals/${otherApproval.node_id}/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(404);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Happy path
// ─────────────────────────────────────────────────────────────────────

describe('POST /graphs/:graph_id/approvals/:approval_id/approve — happy path', () => {
  it('approves the node, re-evaluates the graph, and queues the downstream dispatch', async () => {
    const { graphId, approvalNodeId, downstreamNodeId } = await buildApprovalGraph();

    // Pre-condition: downstream blocked.
    expect((await getNode(adapter, downstreamNodeId))!.state).toBe('pending_dependencies');

    const res = await fetch(`${baseUrl}/graphs/${graphId}/approvals/${approvalNodeId}/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ actor: { kind: 'human', id: 'chris' }, note: 'lgtm' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.approval.node_id).toBe(approvalNodeId);
    expect(body.approval.state).toBe('done');
    expect(body.evaluation.attempted).toBe(true);
    expect(body.evaluation.transitioned).toBeGreaterThanOrEqual(1);

    // Post-condition: downstream is now queued.
    const after = await getNode(adapter, downstreamNodeId);
    expect(after!.state).toBe('queued');
    // And the approval node is done.
    const approvalAfter = await getNode(adapter, approvalNodeId);
    expect(approvalAfter!.state).toBe('done');
  });

  // N1.5 coverage follow-up (2026-06-01 review). The spec required:
  //   "Approval write is durable even if post-write graph evaluation fails;
  //    the failure is reported/logged without a 500 after approval was written."
  // The route wraps evaluateGraph in a nested try/catch — this test pins
  // that contract so a future refactor cannot accidentally move evaluation
  // back into the outer try/catch and turn a successful approval into 500.
  it('evaluation failure AFTER approval write returns 200 + evaluation.error; approval stays done', async () => {
    const { graphId, approvalNodeId } = await buildApprovalGraph();

    // Force evaluateGraph to throw AFTER the approval write by dropping
    // the dispatch_scheduler_queue table. The runner queries it for any
    // node with a dispatch_id (the downstream node has one) and will
    // throw on the SELECT. This isolates the failure to evaluation,
    // not to the approval write itself.
    (adapter as any).exec(`DROP TABLE dispatch_scheduler_queue`);

    const res = await fetch(`${baseUrl}/graphs/${graphId}/approvals/${approvalNodeId}/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ actor: { kind: 'human', id: 'chris' } }),
    });

    // The spec's safety bar: HTTP 200, not 500.
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.approval.node_id).toBe(approvalNodeId);
    expect(body.approval.state).toBe('done');
    expect(body.evaluation.attempted).toBe(true);
    expect(typeof body.evaluation.error).toBe('string');
    expect(body.evaluation.error.length).toBeGreaterThan(0);

    // Approval write is durable — node is `done` in the DB even though
    // evaluation could not complete.
    const approvalAfter = await getNode(adapter, approvalNodeId);
    expect(approvalAfter!.state).toBe('done');
  });

  it('idempotent: re-approving an already-done node returns 200 and does NOT re-transition downstream', async () => {
    const { graphId, approvalNodeId, downstreamNodeId } = await buildApprovalGraph();

    const first = await fetch(`${baseUrl}/graphs/${graphId}/approvals/${approvalNodeId}/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(first.status).toBe(200);
    const firstBody = await first.json();
    expect(firstBody.evaluation.transitioned).toBeGreaterThanOrEqual(1);

    // Second call — already done.
    const second = await fetch(`${baseUrl}/graphs/${graphId}/approvals/${approvalNodeId}/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(second.status).toBe(200);
    const secondBody = await second.json();
    expect(secondBody.ok).toBe(true);
    expect(secondBody.approval.state).toBe('done');
    expect(secondBody.evaluation.transitioned).toBe(0);

    // Downstream still queued.
    expect((await getNode(adapter, downstreamNodeId))!.state).toBe('queued');
  });
});
