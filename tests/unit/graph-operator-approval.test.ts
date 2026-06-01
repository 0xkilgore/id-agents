// N1.5 Operator-Approval — pure evaluator + runner integration tests.
//
// Spec: cto/output/2026-05-31-n1-5-spec.md
// Approval identity: `approval_id === approval node_id`. Approval state
// is the approval node's `state` column. No new tables.

import { describe, it, expect, beforeEach } from 'vitest';
import { SqliteAdapter } from '../../src/db/sqlite-adapter.js';
import {
  migrateGraphTables, createGraph, addNode, addEdge,
  updateGraphStatus, updateNodeState, getNode, getRecentDecisions,
} from '../../src/graph/storage.js';
import { evaluateGraph } from '../../src/graph/runner.js';
import { evaluateNodeReadiness } from '../../src/graph/evaluator.js';
import type { EdgeRow, NodeRow } from '../../src/graph/types.js';

function makeAdapter(): SqliteAdapter {
  const adapter = new SqliteAdapter(':memory:');
  migrateGraphTables(adapter);
  (adapter as any).exec(`
    CREATE TABLE IF NOT EXISTS dispatch_scheduler_queue (
      dispatch_phid TEXT PRIMARY KEY,
      status TEXT NOT NULL DEFAULT 'queued',
      active_clarification_json TEXT
    )
  `);
  return adapter;
}

function insertDispatch(adapter: SqliteAdapter, phid: string, status: string): void {
  (adapter as any).exec(
    `INSERT INTO dispatch_scheduler_queue (dispatch_phid, status) VALUES ('${phid}', '${status}')`,
  );
}

let adapter: SqliteAdapter;

beforeEach(() => {
  adapter = makeAdapter();
});

// ─────────────────────────────────────────────────────────────────────
// Pure evaluator — direct calls
// ─────────────────────────────────────────────────────────────────────

function downstreamNode(): NodeRow {
  return {
    node_id: 'node-build',
    graph_id: 'g',
    title: 'build feature',
    kind: 'dispatch',
    dispatch_id: 'phid:disp-1',
    task_phid: null,
    state: 'pending_dependencies',
    blocker_summary_json: null,
  };
}

function approvalEdge(approvalId: string): EdgeRow {
  return {
    edge_id: 'edge-1',
    graph_id: 'g',
    from_node_id: approvalId,
    to_node_id: 'node-build',
    relation: 'waits_on',
    predicate_json: JSON.stringify({ type: 'operator_approval', approval_id: approvalId }),
  };
}

function approvalUpstream(state: NodeRow['state'], title = 'Chris approval'): { node: NodeRow; dispatch_status: string | null; clarification_question: string | null } {
  return {
    node: {
      node_id: 'approval-1',
      graph_id: 'g',
      title,
      kind: 'approval',
      dispatch_id: null,
      task_phid: null,
      state,
      blocker_summary_json: null,
    },
    dispatch_status: null,
    clarification_question: null,
  };
}

describe('evaluateNodeReadiness — operator_approval predicate', () => {
  it('approval node done → downstream is ready', () => {
    const upstreamMap = new Map([['approval-1', approvalUpstream('done')]]);
    const r = evaluateNodeReadiness(downstreamNode(), [approvalEdge('approval-1')], upstreamMap);
    expect(r.status).toBe('ready');
  });

  it('approval node pending_dependencies → blocked with blocked_on_chris + approval title in question', () => {
    const upstreamMap = new Map([['approval-1', approvalUpstream('pending_dependencies', 'Chris approval: ship N1.5')]]);
    const r = evaluateNodeReadiness(downstreamNode(), [approvalEdge('approval-1')], upstreamMap);
    expect(r.status).toBe('blocked');
    expect(r.blocker?.kind).toBe('blocked_on_chris');
    expect(r.blocker?.source_node_id).toBe('approval-1');
    expect(r.blocker?.question).toMatch(/Waiting for operator approval/);
    expect(r.blocker?.question).toMatch(/Chris approval: ship N1.5/);
  });

  it('approval node ready (intermediate state) → blocked (still waiting on operator)', () => {
    const upstreamMap = new Map([['approval-1', approvalUpstream('ready')]]);
    const r = evaluateNodeReadiness(downstreamNode(), [approvalEdge('approval-1')], upstreamMap);
    expect(r.status).toBe('blocked');
    expect(r.blocker?.kind).toBe('blocked_on_chris');
  });

  it('approval node failed/cancelled/skipped → blocked (rejection semantics are a later slice)', () => {
    for (const state of ['failed', 'cancelled', 'skipped'] as const) {
      const upstreamMap = new Map([['approval-1', approvalUpstream(state)]]);
      const r = evaluateNodeReadiness(downstreamNode(), [approvalEdge('approval-1')], upstreamMap);
      expect(r.status).toBe('blocked');
      expect(r.blocker?.kind).toBe('blocked_on_chris');
      expect(r.reason).toMatch(state);
    }
  });

  it('approval node missing from upstreamMap → not_ready (reason includes approval_id)', () => {
    const upstreamMap = new Map(); // empty
    const r = evaluateNodeReadiness(downstreamNode(), [approvalEdge('approval-missing')], upstreamMap);
    expect(r.status).toBe('not_ready');
    expect(r.reason).toMatch(/approval-missing/);
  });

  it('downstream with NO incoming edges is still ready (sanity)', () => {
    const r = evaluateNodeReadiness(downstreamNode(), [], new Map());
    expect(r.status).toBe('ready');
  });
});

// ─────────────────────────────────────────────────────────────────────
// runner.evaluateGraph — operator_approval integration
// ─────────────────────────────────────────────────────────────────────

async function buildApprovalGraph(): Promise<{ graphId: string; approvalNodeId: string; downstreamNodeId: string }> {
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
  return { graphId: graph.graph_id, approvalNodeId: approval.node_id, downstreamNodeId: downstream.node_id };
}

describe('evaluateGraph — operator_approval transitions', () => {
  it('approval pending → downstream stays pending_dependencies with blocked_on_chris blocker', async () => {
    insertDispatch(adapter, 'phid:disp-build', 'queued');
    const { graphId, approvalNodeId, downstreamNodeId } = await buildApprovalGraph();
    void approvalNodeId;

    await evaluateGraph(adapter, graphId);
    const downstream = await getNode(adapter, downstreamNodeId);
    expect(downstream!.state).toBe('pending_dependencies');
    const blocker = downstream!.blocker_summary_json
      ? JSON.parse(downstream!.blocker_summary_json)
      : null;
    expect(blocker).not.toBeNull();
    expect(blocker.kind).toBe('blocked_on_chris');
  });

  it('approval done → downstream transitions to queued on next evaluate', async () => {
    insertDispatch(adapter, 'phid:disp-build', 'queued');
    const { graphId, approvalNodeId, downstreamNodeId } = await buildApprovalGraph();

    // First evaluate: downstream blocked.
    await evaluateGraph(adapter, graphId);
    expect((await getNode(adapter, downstreamNodeId))!.state).toBe('pending_dependencies');

    // Approve.
    await updateNodeState(adapter, approvalNodeId, 'done');

    // Re-evaluate: downstream is queued.
    const r = await evaluateGraph(adapter, graphId);
    expect((await getNode(adapter, downstreamNodeId))!.state).toBe('queued');
    expect(r.transitioned).toBeGreaterThanOrEqual(1);
  });

  it('runner input revision changes when approval state changes pending → done (new decision recorded)', async () => {
    insertDispatch(adapter, 'phid:disp-build', 'queued');
    const { graphId, approvalNodeId, downstreamNodeId } = await buildApprovalGraph();

    await evaluateGraph(adapter, graphId);
    const beforeDecisions = await getRecentDecisions(adapter, graphId, 50);
    const beforeCount = beforeDecisions.filter((d) => d.node_id === downstreamNodeId).length;

    await updateNodeState(adapter, approvalNodeId, 'done');
    await evaluateGraph(adapter, graphId);

    const afterDecisions = await getRecentDecisions(adapter, graphId, 50);
    const afterCount = afterDecisions.filter((d) => d.node_id === downstreamNodeId).length;
    // New revision → at least one new decision recorded.
    expect(afterCount).toBeGreaterThan(beforeCount);
  });

  it('re-approving an already-done approval is idempotent (no new downstream transition)', async () => {
    insertDispatch(adapter, 'phid:disp-build', 'queued');
    const { graphId, approvalNodeId, downstreamNodeId } = await buildApprovalGraph();

    await updateNodeState(adapter, approvalNodeId, 'done');
    const r1 = await evaluateGraph(adapter, graphId);
    expect(r1.transitioned).toBeGreaterThanOrEqual(1);
    expect((await getNode(adapter, downstreamNodeId))!.state).toBe('queued');

    // Approve again (no-op state write).
    await updateNodeState(adapter, approvalNodeId, 'done');
    const r2 = await evaluateGraph(adapter, graphId);
    // Downstream was already queued; runner should not re-transition.
    expect(r2.transitioned).toBe(0);
    expect((await getNode(adapter, downstreamNodeId))!.state).toBe('queued');
  });
});
