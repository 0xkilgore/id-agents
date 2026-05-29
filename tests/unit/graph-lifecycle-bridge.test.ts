// N1.3 Graph Lifecycle Bridge — unit tests for automatic graph
// re-evaluation when linked dispatches change state.

import { describe, it, expect, beforeEach } from 'vitest';
import { SqliteAdapter } from '../../src/db/sqlite-adapter.js';
import {
  migrateGraphTables, createGraph, addNode, addEdge,
  updateGraphStatus, getNodes, getNode,
} from '../../src/graph/storage.js';
import { evaluateGraphsForDispatch } from '../../src/graph/lifecycle-bridge.js';
import type { GraphEvaluationLogger, GraphEvaluationSummary } from '../../src/graph/lifecycle-bridge.js';

function makeAdapter(): SqliteAdapter {
  const adapter = new SqliteAdapter(':memory:');
  migrateGraphTables(adapter);

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

function insertDispatch(adapter: SqliteAdapter, phid: string, status: string, opts: {
  active_clarification_json?: string;
} = {}): void {
  (adapter as any).exec(
    `INSERT INTO dispatch_scheduler_queue (dispatch_phid, status, active_clarification_json)
     VALUES ('${phid}', '${status}', ${opts.active_clarification_json ? `'${opts.active_clarification_json}'` : 'NULL'})`,
  );
}

function updateDispatchStatus(adapter: SqliteAdapter, phid: string, status: string, opts: {
  active_clarification_json?: string | null;
} = {}): void {
  if (opts.active_clarification_json !== undefined) {
    (adapter as any).exec(
      `UPDATE dispatch_scheduler_queue SET status = '${status}', active_clarification_json = ${opts.active_clarification_json ? `'${opts.active_clarification_json}'` : 'NULL'} WHERE dispatch_phid = '${phid}'`,
    );
  } else {
    (adapter as any).exec(
      `UPDATE dispatch_scheduler_queue SET status = '${status}' WHERE dispatch_phid = '${phid}'`,
    );
  }
}

function collectLogs(): { logger: GraphEvaluationLogger; warns: Array<{ event: string; data: Record<string, unknown> }>; infos: Array<{ event: string; data: Record<string, unknown> }> } {
  const warns: Array<{ event: string; data: Record<string, unknown> }> = [];
  const infos: Array<{ event: string; data: Record<string, unknown> }> = [];
  return {
    logger: {
      warn: (event, data) => warns.push({ event, data }),
      info: (event, data) => infos.push({ event, data }),
    },
    warns,
    infos,
  };
}

let adapter: SqliteAdapter;

beforeEach(() => {
  adapter = makeAdapter();
});

// ── Helper: set up a two-node graph: build -> review ──

async function setupBuildReviewGraph(buildDispatchId: string, reviewDispatchId: string) {
  const graph = await createGraph(adapter, 'build-review', { kind: 'test' });
  await updateGraphStatus(adapter, graph.graph_id, 'active');
  const buildNode = await addNode(adapter, graph.graph_id, 'build', 'dispatch', {
    dispatch_id: buildDispatchId,
    state: 'queued',
  });
  const reviewNode = await addNode(adapter, graph.graph_id, 'review', 'dispatch', {
    dispatch_id: reviewDispatchId,
    state: 'pending_dependencies',
  });
  await addEdge(
    adapter, graph.graph_id, buildNode.node_id, reviewNode.node_id,
    'waits_on', { type: 'dispatch_success', upstream_node_id: buildNode.node_id },
  );
  return { graph, buildNode, reviewNode };
}

describe('evaluateGraphsForDispatch', () => {
  it('is a no-op when dispatch has no linked graph nodes', async () => {
    insertDispatch(adapter, 'phid:unlinked', 'done');
    const summary = await evaluateGraphsForDispatch(adapter, 'phid:unlinked', 'dispatch_done');
    expect(summary.graph_ids).toHaveLength(0);
    expect(summary.results).toHaveLength(0);
  });

  it('auto-releases downstream node when upstream dispatch completes', async () => {
    insertDispatch(adapter, 'phid:build-1', 'done');
    insertDispatch(adapter, 'phid:review-1', 'queued');
    const { reviewNode } = await setupBuildReviewGraph('phid:build-1', 'phid:review-1');

    const summary = await evaluateGraphsForDispatch(adapter, 'phid:build-1', 'dispatch_done');
    expect(summary.graph_ids).toHaveLength(1);
    expect(summary.results).toHaveLength(1);
    expect(summary.results[0].transitioned).toBeGreaterThanOrEqual(1);

    const updatedReview = await getNode(adapter, reviewNode.node_id);
    expect(updatedReview!.state).toBe('queued');
  });

  it('projects blocked_on_chris when upstream needs clarification', async () => {
    const clarJson = JSON.stringify({ question: 'What branch?' });
    insertDispatch(adapter, 'phid:build-2', 'needs_clarification', {
      active_clarification_json: clarJson,
    });
    insertDispatch(adapter, 'phid:review-2', 'queued');
    const { reviewNode } = await setupBuildReviewGraph('phid:build-2', 'phid:review-2');

    const summary = await evaluateGraphsForDispatch(adapter, 'phid:build-2', 'dispatch_needs_clarification');
    expect(summary.results).toHaveLength(1);

    const updatedReview = await getNode(adapter, reviewNode.node_id);
    expect(updatedReview!.state).toBe('pending_dependencies');
    const blocker = updatedReview!.blocker_summary_json
      ? JSON.parse(updatedReview!.blocker_summary_json)
      : null;
    expect(blocker).not.toBeNull();
    expect(blocker.kind).toBe('blocked_on_chris');
  });

  it('keeps downstream blocked when upstream dispatch fails', async () => {
    insertDispatch(adapter, 'phid:build-3', 'failed');
    insertDispatch(adapter, 'phid:review-3', 'queued');
    const { reviewNode } = await setupBuildReviewGraph('phid:build-3', 'phid:review-3');

    await evaluateGraphsForDispatch(adapter, 'phid:build-3', 'dispatch_failed');

    const updatedReview = await getNode(adapter, reviewNode.node_id);
    expect(updatedReview!.state).toBe('pending_dependencies');
    const blocker = updatedReview!.blocker_summary_json
      ? JSON.parse(updatedReview!.blocker_summary_json)
      : null;
    expect(blocker).not.toBeNull();
    expect(blocker.kind).toBe('blocked_on_failure');
  });

  it('does not prematurely release downstream on resume (upstream back to queued)', async () => {
    // After resume, build is back to queued — not done — so review stays pending.
    insertDispatch(adapter, 'phid:build-4', 'queued');
    insertDispatch(adapter, 'phid:review-4', 'queued');
    const { reviewNode } = await setupBuildReviewGraph('phid:build-4', 'phid:review-4');

    await evaluateGraphsForDispatch(adapter, 'phid:build-4', 'dispatch_resumed');

    const updatedReview = await getNode(adapter, reviewNode.node_id);
    expect(updatedReview!.state).toBe('pending_dependencies');
  });

  it('is idempotent — duplicate evaluations do not re-release already queued nodes', async () => {
    insertDispatch(adapter, 'phid:build-5', 'done');
    insertDispatch(adapter, 'phid:review-5', 'queued');
    const { reviewNode } = await setupBuildReviewGraph('phid:build-5', 'phid:review-5');

    const summary1 = await evaluateGraphsForDispatch(adapter, 'phid:build-5', 'dispatch_done');
    expect(summary1.results[0].transitioned).toBeGreaterThanOrEqual(1);

    // Second evaluation should be a no-op (node already queued).
    const summary2 = await evaluateGraphsForDispatch(adapter, 'phid:build-5', 'dispatch_done');
    expect(summary2.results[0].transitioned).toBe(0);
  });

  it('catches per-graph evaluation errors without propagating', async () => {
    insertDispatch(adapter, 'phid:build-6', 'done');
    insertDispatch(adapter, 'phid:review-6', 'queued');
    await setupBuildReviewGraph('phid:build-6', 'phid:review-6');

    // Create a second graph reference with a broken graph_id to simulate failure.
    // Disable FK checks to insert an orphan node referencing a nonexistent graph.
    (adapter as any).exec(`PRAGMA foreign_keys = OFF`);
    (adapter as any).exec(
      `INSERT INTO dispatch_graph_node (node_id, graph_id, title, kind, dispatch_id, state)
       VALUES ('node-broken', 'graph-nonexistent', 'broken', 'dispatch', 'phid:build-6', 'queued')`,
    );
    (adapter as any).exec(`PRAGMA foreign_keys = ON`);

    const { logger, warns } = collectLogs();
    const summary = await evaluateGraphsForDispatch(adapter, 'phid:build-6', 'dispatch_done', { logger });

    // Should have processed both graphs.
    expect(summary.graph_ids).toHaveLength(2);
    // One succeeded, one failed.
    const errResult = summary.results.find(r => r.error);
    expect(errResult).toBeDefined();
    const okResult = summary.results.find(r => !r.error);
    expect(okResult).toBeDefined();
    expect(warns.length).toBeGreaterThanOrEqual(1);
  });

  it('logs info when transitions occur', async () => {
    insertDispatch(adapter, 'phid:build-7', 'done');
    insertDispatch(adapter, 'phid:review-7', 'queued');
    await setupBuildReviewGraph('phid:build-7', 'phid:review-7');

    const { logger, infos } = collectLogs();
    await evaluateGraphsForDispatch(adapter, 'phid:build-7', 'dispatch_done', { logger });

    expect(infos.length).toBeGreaterThanOrEqual(1);
    expect(infos[0].event).toBe('graph_bridge_transitioned');
  });

  it('handles multiple graphs linked to the same dispatch', async () => {
    insertDispatch(adapter, 'phid:shared', 'done');
    insertDispatch(adapter, 'phid:downstream-a', 'queued');
    insertDispatch(adapter, 'phid:downstream-b', 'queued');

    // Graph A
    const graphA = await createGraph(adapter, 'graph-a', { kind: 'test' });
    await updateGraphStatus(adapter, graphA.graph_id, 'active');
    const nodeA1 = await addNode(adapter, graphA.graph_id, 'shared-step', 'dispatch', {
      dispatch_id: 'phid:shared', state: 'queued',
    });
    const nodeA2 = await addNode(adapter, graphA.graph_id, 'downstream-a', 'dispatch', {
      dispatch_id: 'phid:downstream-a', state: 'pending_dependencies',
    });
    await addEdge(adapter, graphA.graph_id, nodeA1.node_id, nodeA2.node_id,
      'waits_on', { type: 'dispatch_success', upstream_node_id: nodeA1.node_id });

    // Graph B
    const graphB = await createGraph(adapter, 'graph-b', { kind: 'test' });
    await updateGraphStatus(adapter, graphB.graph_id, 'active');
    const nodeB1 = await addNode(adapter, graphB.graph_id, 'shared-step', 'dispatch', {
      dispatch_id: 'phid:shared', state: 'queued',
    });
    const nodeB2 = await addNode(adapter, graphB.graph_id, 'downstream-b', 'dispatch', {
      dispatch_id: 'phid:downstream-b', state: 'pending_dependencies',
    });
    await addEdge(adapter, graphB.graph_id, nodeB1.node_id, nodeB2.node_id,
      'waits_on', { type: 'dispatch_success', upstream_node_id: nodeB1.node_id });

    const summary = await evaluateGraphsForDispatch(adapter, 'phid:shared', 'dispatch_done');
    expect(summary.graph_ids).toHaveLength(2);
    expect(summary.results).toHaveLength(2);

    // Both downstreams should be released.
    const nodeA2Updated = await getNode(adapter, nodeA2.node_id);
    expect(nodeA2Updated!.state).toBe('queued');
    const nodeB2Updated = await getNode(adapter, nodeB2.node_id);
    expect(nodeB2Updated!.state).toBe('queued');
  });

  it('lifecycle re-evaluation clears blocker projection after upstream completes', async () => {
    // Start with upstream in needs_clarification.
    const clarJson = JSON.stringify({ question: 'Which env?' });
    insertDispatch(adapter, 'phid:build-8', 'needs_clarification', {
      active_clarification_json: clarJson,
    });
    insertDispatch(adapter, 'phid:review-8', 'queued');
    const { reviewNode } = await setupBuildReviewGraph('phid:build-8', 'phid:review-8');

    // First evaluation: should project blocked_on_chris.
    await evaluateGraphsForDispatch(adapter, 'phid:build-8', 'dispatch_needs_clarification');
    let updatedReview = await getNode(adapter, reviewNode.node_id);
    expect(updatedReview!.state).toBe('pending_dependencies');
    let blocker = JSON.parse(updatedReview!.blocker_summary_json!);
    expect(blocker.kind).toBe('blocked_on_chris');

    // Upstream resumes then completes.
    updateDispatchStatus(adapter, 'phid:build-8', 'done', { active_clarification_json: null });

    // Second evaluation after done.
    await evaluateGraphsForDispatch(adapter, 'phid:build-8', 'dispatch_done');
    updatedReview = await getNode(adapter, reviewNode.node_id);
    expect(updatedReview!.state).toBe('queued');
    expect(updatedReview!.blocker_summary_json).toBeNull();
  });
});
