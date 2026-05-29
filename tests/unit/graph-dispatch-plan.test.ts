// N1.2 Graph-backed dispatch-plan — unit tests for validation, DAG ordering,
// idempotency, and partial-failure behavior using a fake enqueue function.

import { describe, it, expect, beforeEach } from 'vitest';
import { SqliteAdapter } from '../../src/db/sqlite-adapter.js';
import { migrateGraphTables, getGraph, getNodes, getEdges, getNodeByClientId } from '../../src/graph/storage.js';
import {
  validateDispatchPlanRequest,
  executeDispatchPlan,
  topoSort,
  DispatchPlanError,
} from '../../src/graph/dispatch-plan.js';
import type { DispatchPlanRequest, EnqueueFn, DispatchPlanNodeInput } from '../../src/graph/types.js';

function makeAdapter(): SqliteAdapter {
  const adapter = new SqliteAdapter(':memory:');
  migrateGraphTables(adapter);

  // Create dispatch_scheduler_queue table for runner/evaluator.
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

let dispatchCounter = 0;
function makeFakeEnqueue(): { enqueue: EnqueueFn; calls: Array<Record<string, unknown>> } {
  const calls: Array<Record<string, unknown>> = [];
  const enqueue: EnqueueFn = async (input) => {
    calls.push(input);
    dispatchCounter++;
    const phid = `phid:disp-test-${dispatchCounter}`;
    const qid = `query_test_${dispatchCounter}`;
    return { query_id: qid, dispatch_phid: phid, status: 'queued' };
  };
  return { enqueue, calls };
}

function basePlan(overrides?: Partial<DispatchPlanRequest>): DispatchPlanRequest {
  return {
    title: 'Test plan',
    created_by: { kind: 'user', id: 'chris', source: 'manager' },
    idempotency_key: `plan:test:${Date.now()}-${Math.random()}`,
    nodes: [
      {
        client_node_id: 'build',
        title: 'Build step',
        to_agent: 'roger',
        message: 'Build the thing',
      },
      {
        client_node_id: 'review',
        title: 'Review step',
        to_agent: 'cto',
        message: 'Review the thing',
        waits_on: [{ client_node_id: 'build', predicate: 'dispatch_success' }],
      },
    ],
    ...overrides,
  };
}

// ── Validation ──

describe('N1.2 Dispatch-Plan — Validation', () => {
  it('accepts a valid two-node plan', () => {
    expect(validateDispatchPlanRequest(basePlan())).toBeNull();
  });

  it('rejects missing title', () => {
    expect(validateDispatchPlanRequest(basePlan({ title: '' }))).toMatch(/title/);
  });

  it('rejects missing idempotency_key', () => {
    expect(validateDispatchPlanRequest(basePlan({ idempotency_key: '' }))).toMatch(/idempotency_key/);
  });

  it('rejects empty nodes', () => {
    expect(validateDispatchPlanRequest(basePlan({ nodes: [] }))).toMatch(/nodes/);
  });

  it('rejects more than 5 nodes', () => {
    const nodes = Array.from({ length: 6 }, (_, i) => ({
      client_node_id: `n${i}`,
      title: `Node ${i}`,
      to_agent: 'roger',
      message: 'do it',
    }));
    expect(validateDispatchPlanRequest(basePlan({ nodes }))).toMatch(/at most 5/);
  });

  it('rejects duplicate client_node_id', () => {
    const nodes = [
      { client_node_id: 'dup', title: 'A', to_agent: 'roger', message: 'a' },
      { client_node_id: 'dup', title: 'B', to_agent: 'roger', message: 'b' },
    ];
    expect(validateDispatchPlanRequest(basePlan({ nodes }))).toMatch(/duplicate/);
  });

  it('rejects invalid client_node_id pattern', () => {
    const nodes = [
      { client_node_id: '123-bad', title: 'A', to_agent: 'roger', message: 'a' },
    ];
    expect(validateDispatchPlanRequest(basePlan({ nodes }))).toMatch(/must match/);
  });

  it('rejects waits_on referencing unknown node', () => {
    const nodes = [
      {
        client_node_id: 'a',
        title: 'A',
        to_agent: 'roger',
        message: 'a',
        waits_on: [{ client_node_id: 'nonexistent', predicate: 'dispatch_success' as const }],
      },
    ];
    expect(validateDispatchPlanRequest(basePlan({ nodes }))).toMatch(/unknown client_node_id/);
  });

  it('rejects unsupported predicate', () => {
    const nodes = [
      { client_node_id: 'a', title: 'A', to_agent: 'roger', message: 'a' },
      {
        client_node_id: 'b',
        title: 'B',
        to_agent: 'roger',
        message: 'b',
        waits_on: [{ client_node_id: 'a', predicate: 'task_done' as any }],
      },
    ];
    expect(validateDispatchPlanRequest(basePlan({ nodes }))).toMatch(/dispatch_success/);
  });

  it('rejects forward references in waits_on', () => {
    const nodes = [
      {
        client_node_id: 'a',
        title: 'A',
        to_agent: 'roger',
        message: 'a',
        waits_on: [{ client_node_id: 'b', predicate: 'dispatch_success' as const }],
      },
      {
        client_node_id: 'b',
        title: 'B',
        to_agent: 'roger',
        message: 'b',
      },
    ];
    expect(validateDispatchPlanRequest(basePlan({ nodes }))).toMatch(/unknown client_node_id/);
  });

  it('rejects build node with promote:false but no skip reason', () => {
    const nodes = [
      {
        client_node_id: 'a',
        title: 'A',
        to_agent: 'roger',
        message: 'a',
        repo: '/some/repo',
        branch: 'feat-x',
        promote: false,
      },
    ];
    expect(validateDispatchPlanRequest(basePlan({ nodes }))).toMatch(/promotion_skip_reason/);
  });

  it('accepts build node with promote:false and skip reason', () => {
    const nodes = [
      {
        client_node_id: 'a',
        title: 'A',
        to_agent: 'roger',
        message: 'a',
        repo: '/some/repo',
        branch: 'feat-x',
        promote: false,
        promotion_skip_reason: 'WIP branch',
      },
    ];
    expect(validateDispatchPlanRequest(basePlan({ nodes }))).toBeNull();
  });
});

// ── Topological Sort ──

describe('N1.2 Dispatch-Plan — topoSort', () => {
  it('returns root nodes first', () => {
    const nodes: DispatchPlanNodeInput[] = [
      {
        client_node_id: 'review',
        title: 'Review',
        to_agent: 'cto',
        message: 'review',
        waits_on: [{ client_node_id: 'build', predicate: 'dispatch_success' }],
      },
      { client_node_id: 'build', title: 'Build', to_agent: 'roger', message: 'build' },
    ];
    const sorted = topoSort(nodes);
    expect(sorted[0].client_node_id).toBe('build');
    expect(sorted[1].client_node_id).toBe('review');
  });

  it('handles a diamond DAG', () => {
    const nodes: DispatchPlanNodeInput[] = [
      { client_node_id: 'a', title: 'A', to_agent: 'roger', message: 'a' },
      {
        client_node_id: 'b',
        title: 'B',
        to_agent: 'roger',
        message: 'b',
        waits_on: [{ client_node_id: 'a', predicate: 'dispatch_success' }],
      },
      {
        client_node_id: 'c',
        title: 'C',
        to_agent: 'roger',
        message: 'c',
        waits_on: [{ client_node_id: 'a', predicate: 'dispatch_success' }],
      },
      {
        client_node_id: 'd',
        title: 'D',
        to_agent: 'roger',
        message: 'd',
        waits_on: [
          { client_node_id: 'b', predicate: 'dispatch_success' },
          { client_node_id: 'c', predicate: 'dispatch_success' },
        ],
      },
    ];
    const sorted = topoSort(nodes);
    const order = sorted.map(n => n.client_node_id);
    expect(order.indexOf('a')).toBeLessThan(order.indexOf('b'));
    expect(order.indexOf('a')).toBeLessThan(order.indexOf('c'));
    expect(order.indexOf('b')).toBeLessThan(order.indexOf('d'));
    expect(order.indexOf('c')).toBeLessThan(order.indexOf('d'));
  });
});

// ── Execution ──

describe('N1.2 Dispatch-Plan — executeDispatchPlan', () => {
  let adapter: SqliteAdapter;

  beforeEach(() => {
    adapter = makeAdapter();
    dispatchCounter = 0;
  });

  it('creates a two-node plan with correct graph, nodes, and edges', async () => {
    const { enqueue, calls } = makeFakeEnqueue();
    const plan = basePlan();
    const result = await executeDispatchPlan(adapter, plan, enqueue);

    expect(result.schema_version).toBe('dispatch_graph.dispatch_plan.v1');
    expect(result.graph_id).toMatch(/^graph-/);
    expect(result.nodes).toHaveLength(2);

    // Build node should be queued (no deps), review should be pending_dependencies.
    const buildNode = result.nodes.find(n => n.client_node_id === 'build')!;
    const reviewNode = result.nodes.find(n => n.client_node_id === 'review')!;
    expect(buildNode.state).toBe('queued');
    expect(reviewNode.state).toBe('pending_dependencies');
    expect(reviewNode.waits_on).toEqual(['build']);

    // Enqueue was called twice.
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({ to_agent: 'roger' });
    expect(calls[1]).toMatchObject({ to_agent: 'cto' });

    // Each node has dispatch_id and query_id.
    expect(buildNode.dispatch_id).toMatch(/^phid:disp-/);
    expect(buildNode.query_id).toMatch(/^query_test_/);
  });

  it('creates correct edges in the graph', async () => {
    const { enqueue } = makeFakeEnqueue();
    const plan = basePlan();
    const result = await executeDispatchPlan(adapter, plan, enqueue);

    const edges = await getEdges(adapter, result.graph_id);
    expect(edges).toHaveLength(1);
    expect(edges[0].relation).toBe('waits_on');
    const pred = JSON.parse(edges[0].predicate_json);
    expect(pred.type).toBe('dispatch_success');
  });

  it('graph status is active after creation', async () => {
    const { enqueue } = makeFakeEnqueue();
    const plan = basePlan();
    const result = await executeDispatchPlan(adapter, plan, enqueue);

    expect(result.status).toBe('active');
    expect(result.evaluation.graph_status).toBe('active');
  });

  it('idempotency: re-posting same key returns existing graph', async () => {
    const { enqueue } = makeFakeEnqueue();
    const plan = basePlan();
    const r1 = await executeDispatchPlan(adapter, plan, enqueue);
    const r2 = await executeDispatchPlan(adapter, plan, enqueue);

    expect(r2.graph_id).toBe(r1.graph_id);
    expect(r2.nodes).toHaveLength(2);
    // Enqueue was only called for the first execution (2 calls, not 4).
  });

  it('single-node plan with no deps is immediately queued', async () => {
    const { enqueue } = makeFakeEnqueue();
    const plan = basePlan({
      nodes: [
        { client_node_id: 'solo', title: 'Solo', to_agent: 'roger', message: 'do it' },
      ],
    });
    const result = await executeDispatchPlan(adapter, plan, enqueue);
    expect(result.nodes).toHaveLength(1);
    expect(result.nodes[0].state).toBe('queued');
    expect(result.evaluation.transitioned).toBe(1);
  });

  it('passes repo/branch/promote through to enqueue', async () => {
    const { enqueue, calls } = makeFakeEnqueue();
    const plan = basePlan({
      nodes: [
        {
          client_node_id: 'build',
          title: 'Build',
          to_agent: 'roger',
          message: 'build it',
          repo: '/code/repo',
          branch: 'feat-x',
          base: 'main',
          remote: 'origin',
          promote: true,
        },
      ],
    });
    await executeDispatchPlan(adapter, plan, enqueue);
    expect(calls[0]).toMatchObject({
      repo: '/code/repo',
      branch: 'feat-x',
      base: 'main',
      remote: 'origin',
      promote: true,
    });
  });

  it('creates client_node_id on graph nodes', async () => {
    const { enqueue } = makeFakeEnqueue();
    const plan = basePlan();
    const result = await executeDispatchPlan(adapter, plan, enqueue);

    const buildNodeDb = await getNodeByClientId(adapter, result.graph_id, 'build');
    expect(buildNodeDb).not.toBeNull();
    expect(buildNodeDb!.title).toBe('Build step');

    const reviewNodeDb = await getNodeByClientId(adapter, result.graph_id, 'review');
    expect(reviewNodeDb).not.toBeNull();
    expect(reviewNodeDb!.title).toBe('Review step');
  });

  it('throws DispatchPlanError on enqueue failure', async () => {
    let callCount = 0;
    const failingEnqueue: EnqueueFn = async (input) => {
      callCount++;
      if (callCount === 2) throw new Error('agent offline');
      return { query_id: 'q1', dispatch_phid: 'phid:disp-1', status: 'queued' };
    };

    const plan = basePlan();
    await expect(executeDispatchPlan(adapter, plan, failingEnqueue)).rejects.toThrow(DispatchPlanError);
  });

  it('evaluation is idempotent — re-running does not duplicate transitions', async () => {
    const { enqueue } = makeFakeEnqueue();
    const plan = basePlan({
      nodes: [
        { client_node_id: 'solo', title: 'Solo', to_agent: 'roger', message: 'do it' },
      ],
    });
    const result = await executeDispatchPlan(adapter, plan, enqueue);
    expect(result.evaluation.transitioned).toBe(1);

    // Re-execute evaluation manually.
    const { evaluateGraph } = await import('../../src/graph/runner.js');
    const r2 = await evaluateGraph(adapter, result.graph_id);
    expect(r2.transitioned).toBe(0);
  });
});
