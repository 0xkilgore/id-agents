// P1 Dependency-Graph Orchestrator — tests for storage, evaluator, and runner.

import { describe, it, expect, beforeEach } from 'vitest';
import { SqliteAdapter } from '../../src/db/sqlite-adapter.js';
import {
  migrateGraphTables,
  createGraph, getGraph, listGraphs, updateGraphStatus,
  addNode, getNode, getNodes, getNodeByDispatchId, updateNodeState,
  addEdge, getEdges, getIncomingEdges, getOutgoingEdges,
  appendDecision, getDecisions, getRecentDecisions,
  isDispatchGraphBlocked,
} from '../../src/graph/storage.js';
import { evaluateNodeReadiness } from '../../src/graph/evaluator.js';
import { evaluateGraph } from '../../src/graph/runner.js';
import type { NodeRow, EdgeRow, DependencyPredicate } from '../../src/graph/types.js';

function makeAdapter(): SqliteAdapter {
  const adapter = new SqliteAdapter(':memory:');
  migrateGraphTables(adapter);

  // Create dispatch_scheduler_queue table for runner tests.
  (adapter as any).exec(`
    CREATE TABLE IF NOT EXISTS dispatch_scheduler_queue (
      dispatch_phid TEXT PRIMARY KEY,
      team_id TEXT NOT NULL DEFAULT 'default',
      query_id TEXT NOT NULL DEFAULT '',
      to_agent TEXT NOT NULL DEFAULT '',
      from_actor TEXT NOT NULL DEFAULT '',
      channel TEXT NOT NULL DEFAULT '',
      subject TEXT NOT NULL DEFAULT '',
      body_markdown TEXT NOT NULL DEFAULT '',
      provider TEXT NOT NULL DEFAULT 'anthropic',
      runtime TEXT NOT NULL DEFAULT 'claude-code-cli',
      priority INTEGER NOT NULL DEFAULT 5,
      status TEXT NOT NULL DEFAULT 'queued',
      not_before_at TEXT NOT NULL DEFAULT '2020-01-01T00:00:00.000Z',
      attempt_count INTEGER NOT NULL DEFAULT 0,
      bounce_count INTEGER NOT NULL DEFAULT 0,
      last_bounce_json TEXT,
      bounce_history_json TEXT NOT NULL DEFAULT '[]',
      started_at TEXT,
      completed_at TEXT,
      updated_at TEXT NOT NULL DEFAULT '2020-01-01T00:00:00.000Z',
      agent_query_id TEXT,
      usage_policy_snapshot_json TEXT,
      failure_kind TEXT,
      failure_detail TEXT,
      target_url TEXT,
      result_json TEXT,
      clarification_id TEXT,
      active_clarification_json TEXT,
      clarification_history_json TEXT NOT NULL DEFAULT '[]',
      resume_delivery_status TEXT NOT NULL DEFAULT 'none',
      promote INTEGER NOT NULL DEFAULT 1,
      promotion_strategy TEXT NOT NULL DEFAULT 'auto',
      promotion_required_reason TEXT,
      promotion_result_json TEXT,
      promotion_input_json TEXT
    )
  `);
  return adapter;
}

async function seedDispatch(adapter: SqliteAdapter, phid: string, status: string, clarificationJson?: string): Promise<void> {
  await adapter.query(
    `INSERT INTO dispatch_scheduler_queue (dispatch_phid, status, active_clarification_json, updated_at)
     VALUES ($1, $2, $3, $4)`,
    [phid, status, clarificationJson ?? null, new Date().toISOString()],
  );
}

async function updateDispatchStatus(adapter: SqliteAdapter, phid: string, status: string, clarificationJson?: string): Promise<void> {
  await adapter.query(
    'UPDATE dispatch_scheduler_queue SET status = $1, active_clarification_json = $2, updated_at = $3 WHERE dispatch_phid = $4',
    [status, clarificationJson ?? null, new Date().toISOString(), phid],
  );
}

describe('P1 Graph — Storage', () => {
  let adapter: SqliteAdapter;

  beforeEach(() => {
    adapter = makeAdapter();
  });

  it('creates tables without error', async () => {
    const { rows: tables } = await adapter.query<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'dispatch_graph%'",
      [],
    );
    const names = tables.map(t => t.name).sort();
    expect(names).toEqual([
      'dispatch_graph',
      'dispatch_graph_decision',
      'dispatch_graph_edge',
      'dispatch_graph_node',
    ]);
  });

  it('creates and retrieves a graph', async () => {
    const g = await createGraph(adapter, 'Test graph', { id: 'human:chris' });
    expect(g.graph_id).toBeTruthy();
    expect(g.status).toBe('draft');

    const fetched = await getGraph(adapter, g.graph_id);
    expect(fetched).not.toBeNull();
    expect(fetched!.title).toBe('Test graph');
  });

  it('lists graphs with node/blocked counts', async () => {
    const g = await createGraph(adapter, 'List test', {});
    await addNode(adapter, g.graph_id, 'Node A', 'dispatch');
    await addNode(adapter, g.graph_id, 'Node B', 'dispatch');
    const list = await listGraphs(adapter);
    expect(list.length).toBe(1);
    expect(Number(list[0].node_count)).toBe(2);
    expect(Number(list[0].blocked_count)).toBe(2); // both pending_dependencies
  });

  it('adds nodes with dispatch_id', async () => {
    const g = await createGraph(adapter, 'Node test', {});
    const n = await addNode(adapter, g.graph_id, 'A', 'dispatch', { dispatch_id: 'disp-A' });
    const found = await getNodeByDispatchId(adapter, 'disp-A');
    expect(found).not.toBeNull();
    expect(found!.node_id).toBe(n.node_id);
  });

  it('adds edges and retrieves incoming/outgoing', async () => {
    const g = await createGraph(adapter, 'Edge test', {});
    const a = await addNode(adapter, g.graph_id, 'A', 'dispatch');
    const b = await addNode(adapter, g.graph_id, 'B', 'dispatch');
    const pred: DependencyPredicate = { type: 'dispatch_success', upstream_node_id: a.node_id };
    await addEdge(adapter, g.graph_id, a.node_id, b.node_id, 'waits_on', pred);

    const incoming = await getIncomingEdges(adapter, b.node_id);
    expect(incoming.length).toBe(1);
    expect(incoming[0].from_node_id).toBe(a.node_id);

    const outgoing = await getOutgoingEdges(adapter, a.node_id);
    expect(outgoing.length).toBe(1);
    expect(outgoing[0].to_node_id).toBe(b.node_id);
  });

  it('decisions have idempotency on key', async () => {
    const g = await createGraph(adapter, 'Decision test', {});
    const n = await addNode(adapter, g.graph_id, 'A', 'dispatch');
    const r1 = await appendDecision(adapter, g.graph_id, n.node_id, 'not_ready', 'waiting', 'rev1', 'key1');
    expect(r1.appended).toBe(true);
    const r2 = await appendDecision(adapter, g.graph_id, n.node_id, 'not_ready', 'waiting', 'rev1', 'key1');
    expect(r2.appended).toBe(false);
    expect(r2.reason).toBe('idempotent_duplicate');
  });

  it('isDispatchGraphBlocked returns true for pending_dependencies', async () => {
    const g = await createGraph(adapter, 'Block test', {});
    await addNode(adapter, g.graph_id, 'B', 'dispatch', { dispatch_id: 'disp-B', state: 'pending_dependencies' });
    expect(await isDispatchGraphBlocked(adapter, 'disp-B')).toBe(true);
    expect(await isDispatchGraphBlocked(adapter, 'disp-unknown')).toBe(false);
  });
});

describe('P1 Graph — Pure Evaluator', () => {
  it('returns ready when no dependencies', () => {
    const node: NodeRow = {
      node_id: 'n1', graph_id: 'g1', title: 'A', kind: 'dispatch',
      dispatch_id: 'dA', task_phid: null, state: 'pending_dependencies',
      blocker_summary_json: null,
    };
    const result = evaluateNodeReadiness(node, [], new Map());
    expect(result.status).toBe('ready');
  });

  it('returns ready when upstream node is done', () => {
    const node: NodeRow = {
      node_id: 'n2', graph_id: 'g1', title: 'B', kind: 'dispatch',
      dispatch_id: 'dB', task_phid: null, state: 'pending_dependencies',
      blocker_summary_json: null,
    };
    const edge: EdgeRow = {
      edge_id: 'e1', graph_id: 'g1', from_node_id: 'n1', to_node_id: 'n2',
      relation: 'waits_on',
      predicate_json: JSON.stringify({ type: 'dispatch_success', upstream_node_id: 'n1' }),
    };
    const upstreamMap = new Map([['n1', {
      node: { node_id: 'n1', graph_id: 'g1', title: 'A', kind: 'dispatch' as const,
        dispatch_id: 'dA', task_phid: null, state: 'done' as const, blocker_summary_json: null },
      dispatch_status: 'done',
      clarification_question: null,
    }]]);
    const result = evaluateNodeReadiness(node, [edge], upstreamMap);
    expect(result.status).toBe('ready');
  });

  it('returns blocked when upstream needs_clarification', () => {
    const node: NodeRow = {
      node_id: 'n2', graph_id: 'g1', title: 'B', kind: 'dispatch',
      dispatch_id: 'dB', task_phid: null, state: 'pending_dependencies',
      blocker_summary_json: null,
    };
    const edge: EdgeRow = {
      edge_id: 'e1', graph_id: 'g1', from_node_id: 'n1', to_node_id: 'n2',
      relation: 'waits_on',
      predicate_json: JSON.stringify({ type: 'dispatch_success', upstream_node_id: 'n1' }),
    };
    const upstreamMap = new Map([['n1', {
      node: { node_id: 'n1', graph_id: 'g1', title: 'A', kind: 'dispatch' as const,
        dispatch_id: 'dA', task_phid: null, state: 'needs_clarification' as const, blocker_summary_json: null },
      dispatch_status: 'needs_clarification',
      clarification_question: 'Which route shape?',
    }]]);
    const result = evaluateNodeReadiness(node, [edge], upstreamMap);
    expect(result.status).toBe('blocked');
    if (result.status === 'blocked') {
      expect(result.blocker.kind).toBe('blocked_on_chris');
      expect(result.blocker.question).toBe('Which route shape?');
    }
  });

  it('returns blocked on failure when upstream failed', () => {
    const node: NodeRow = {
      node_id: 'n2', graph_id: 'g1', title: 'B', kind: 'dispatch',
      dispatch_id: 'dB', task_phid: null, state: 'pending_dependencies',
      blocker_summary_json: null,
    };
    const edge: EdgeRow = {
      edge_id: 'e1', graph_id: 'g1', from_node_id: 'n1', to_node_id: 'n2',
      relation: 'waits_on',
      predicate_json: JSON.stringify({ type: 'dispatch_success', upstream_node_id: 'n1' }),
    };
    const upstreamMap = new Map([['n1', {
      node: { node_id: 'n1', graph_id: 'g1', title: 'A', kind: 'dispatch' as const,
        dispatch_id: 'dA', task_phid: null, state: 'failed' as const, blocker_summary_json: null },
      dispatch_status: 'failed',
      clarification_question: null,
    }]]);
    const result = evaluateNodeReadiness(node, [edge], upstreamMap);
    expect(result.status).toBe('blocked');
    if (result.status === 'blocked') {
      expect(result.blocker.kind).toBe('blocked_on_failure');
    }
  });

  it('dispatch_terminal allows failure when explicitly listed', () => {
    const node: NodeRow = {
      node_id: 'n2', graph_id: 'g1', title: 'B', kind: 'dispatch',
      dispatch_id: 'dB', task_phid: null, state: 'pending_dependencies',
      blocker_summary_json: null,
    };
    const edge: EdgeRow = {
      edge_id: 'e1', graph_id: 'g1', from_node_id: 'n1', to_node_id: 'n2',
      relation: 'waits_on',
      predicate_json: JSON.stringify({ type: 'dispatch_terminal', upstream_node_id: 'n1', terminal_states: ['done', 'failed'] }),
    };
    const upstreamMap = new Map([['n1', {
      node: { node_id: 'n1', graph_id: 'g1', title: 'A', kind: 'dispatch' as const,
        dispatch_id: 'dA', task_phid: null, state: 'failed' as const, blocker_summary_json: null },
      dispatch_status: 'failed',
      clarification_question: null,
    }]]);
    const result = evaluateNodeReadiness(node, [edge], upstreamMap);
    expect(result.status).toBe('ready');
  });

  it('not_ready when upstream still in_flight', () => {
    const node: NodeRow = {
      node_id: 'n2', graph_id: 'g1', title: 'B', kind: 'dispatch',
      dispatch_id: 'dB', task_phid: null, state: 'pending_dependencies',
      blocker_summary_json: null,
    };
    const edge: EdgeRow = {
      edge_id: 'e1', graph_id: 'g1', from_node_id: 'n1', to_node_id: 'n2',
      relation: 'waits_on',
      predicate_json: JSON.stringify({ type: 'dispatch_success', upstream_node_id: 'n1' }),
    };
    const upstreamMap = new Map([['n1', {
      node: { node_id: 'n1', graph_id: 'g1', title: 'A', kind: 'dispatch' as const,
        dispatch_id: 'dA', task_phid: null, state: 'in_flight' as const, blocker_summary_json: null },
      dispatch_status: 'in_flight',
      clarification_question: null,
    }]]);
    const result = evaluateNodeReadiness(node, [edge], upstreamMap);
    expect(result.status).toBe('not_ready');
  });
});

describe('P1 Graph — Runner (evaluateGraph)', () => {
  let adapter: SqliteAdapter;

  beforeEach(() => {
    adapter = makeAdapter();
  });

  it('two-node graph: B stays pending while A is queued', async () => {
    await seedDispatch(adapter, 'disp-A', 'queued');
    await seedDispatch(adapter, 'disp-B', 'queued');

    const g = await createGraph(adapter, 'Two-node', {});
    const a = await addNode(adapter, g.graph_id, 'A', 'dispatch', { dispatch_id: 'disp-A', state: 'queued' });
    const b = await addNode(adapter, g.graph_id, 'B', 'dispatch', { dispatch_id: 'disp-B' });
    await addEdge(adapter, g.graph_id, a.node_id, b.node_id, 'waits_on',
      { type: 'dispatch_success', upstream_node_id: a.node_id });
    await updateGraphStatus(adapter, g.graph_id, 'active');

    const result = await evaluateGraph(adapter, g.graph_id);
    const nodeB = await getNode(adapter, b.node_id);
    expect(nodeB!.state).toBe('pending_dependencies');
    expect(result.decisions.some(d => d.node_id === b.node_id && d.result === 'not_ready')).toBe(true);
  });

  it('B becomes queued only when A completes', async () => {
    await seedDispatch(adapter, 'disp-A', 'done');
    await seedDispatch(adapter, 'disp-B', 'queued');

    const g = await createGraph(adapter, 'Two-node', {});
    const a = await addNode(adapter, g.graph_id, 'A', 'dispatch', { dispatch_id: 'disp-A' });
    const b = await addNode(adapter, g.graph_id, 'B', 'dispatch', { dispatch_id: 'disp-B' });
    await addEdge(adapter, g.graph_id, a.node_id, b.node_id, 'waits_on',
      { type: 'dispatch_success', upstream_node_id: a.node_id });
    await updateGraphStatus(adapter, g.graph_id, 'active');

    const result = await evaluateGraph(adapter, g.graph_id);
    const nodeB = await getNode(adapter, b.node_id);
    expect(nodeB!.state).toBe('queued');
    expect(result.transitioned).toBe(1);
  });

  it('clarification on A blocks B with blocked_on_chris', async () => {
    await seedDispatch(adapter, 'disp-A', 'needs_clarification',
      JSON.stringify({ question: 'Which shape?' }));
    await seedDispatch(adapter, 'disp-B', 'queued');

    const g = await createGraph(adapter, 'Clarification test', {});
    const a = await addNode(adapter, g.graph_id, 'A', 'dispatch', { dispatch_id: 'disp-A' });
    const b = await addNode(adapter, g.graph_id, 'B', 'dispatch', { dispatch_id: 'disp-B' });
    await addEdge(adapter, g.graph_id, a.node_id, b.node_id, 'waits_on',
      { type: 'dispatch_success', upstream_node_id: a.node_id });
    await updateGraphStatus(adapter, g.graph_id, 'active');

    const result = await evaluateGraph(adapter, g.graph_id);
    const nodeB = await getNode(adapter, b.node_id);
    expect(nodeB!.state).toBe('pending_dependencies');
    const blocker = JSON.parse(nodeB!.blocker_summary_json!);
    expect(blocker.kind).toBe('blocked_on_chris');
    expect(blocker.question).toBe('Which shape?');
  });

  it('resume of A returns B to pending, not queued', async () => {
    // First: A needs clarification, evaluate → B blocked.
    await seedDispatch(adapter, 'disp-A', 'needs_clarification');
    await seedDispatch(adapter, 'disp-B', 'queued');

    const g = await createGraph(adapter, 'Resume test', {});
    const a = await addNode(adapter, g.graph_id, 'A', 'dispatch', { dispatch_id: 'disp-A' });
    const b = await addNode(adapter, g.graph_id, 'B', 'dispatch', { dispatch_id: 'disp-B' });
    await addEdge(adapter, g.graph_id, a.node_id, b.node_id, 'waits_on',
      { type: 'dispatch_success', upstream_node_id: a.node_id });
    await updateGraphStatus(adapter, g.graph_id, 'active');

    await evaluateGraph(adapter, g.graph_id);

    // Now resume A (back to in_flight).
    await updateDispatchStatus(adapter, 'disp-A', 'in_flight');
    await evaluateGraph(adapter, g.graph_id);

    const nodeB = await getNode(adapter, b.node_id);
    expect(nodeB!.state).toBe('pending_dependencies');
    expect(nodeB!.state).not.toBe('queued');
  });

  it('re-running evaluator is idempotent — no duplicate queued', async () => {
    await seedDispatch(adapter, 'disp-A', 'done');
    await seedDispatch(adapter, 'disp-B', 'queued');

    const g = await createGraph(adapter, 'Idempotent test', {});
    const a = await addNode(adapter, g.graph_id, 'A', 'dispatch', { dispatch_id: 'disp-A' });
    const b = await addNode(adapter, g.graph_id, 'B', 'dispatch', { dispatch_id: 'disp-B' });
    await addEdge(adapter, g.graph_id, a.node_id, b.node_id, 'waits_on',
      { type: 'dispatch_success', upstream_node_id: a.node_id });
    await updateGraphStatus(adapter, g.graph_id, 'active');

    const r1 = await evaluateGraph(adapter, g.graph_id);
    expect(r1.transitioned).toBe(1);

    // Re-run: B is already queued, so no new transition.
    const r2 = await evaluateGraph(adapter, g.graph_id);
    expect(r2.transitioned).toBe(0);

    // Only one decision with result=queued.
    const decisions = await getDecisions(adapter, b.node_id, 100);
    expect(decisions.filter(d => d.result === 'queued').length).toBe(1);
  });

  it('failed A blocks B unless dispatch_terminal allows failure', async () => {
    await seedDispatch(adapter, 'disp-A', 'failed');
    await seedDispatch(adapter, 'disp-B', 'queued');

    const g = await createGraph(adapter, 'Failure test', {});
    const a = await addNode(adapter, g.graph_id, 'A', 'dispatch', { dispatch_id: 'disp-A' });
    const b = await addNode(adapter, g.graph_id, 'B', 'dispatch', { dispatch_id: 'disp-B' });

    // First: dispatch_success predicate — B should be blocked.
    await addEdge(adapter, g.graph_id, a.node_id, b.node_id, 'waits_on',
      { type: 'dispatch_success', upstream_node_id: a.node_id });
    await updateGraphStatus(adapter, g.graph_id, 'active');

    await evaluateGraph(adapter, g.graph_id);
    const nodeB = await getNode(adapter, b.node_id);
    expect(nodeB!.state).toBe('pending_dependencies');
    const blocker = JSON.parse(nodeB!.blocker_summary_json!);
    expect(blocker.kind).toBe('blocked_on_failure');
  });

  it('non-graph dispatch is not blocked by isDispatchGraphBlocked', async () => {
    expect(await isDispatchGraphBlocked(adapter, 'disp-not-in-graph')).toBe(false);
  });
});
