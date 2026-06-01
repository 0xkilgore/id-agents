// N1.4 Graph Task-Done Bridge — unit tests for automatic graph
// re-evaluation when a linked task transitions to `done`, plus the
// `task_done` predicate evaluation.
//
// Mirrors the N1.3 dispatch-bridge test shape (graph-lifecycle-bridge.test.ts).
// Spec: /Users/kilgore/Dropbox/Code/cto/output/2026-05-31-n1-4-task-done-bridge-spec.md

import { describe, it, expect, beforeEach } from 'vitest';
import { SqliteAdapter } from '../../src/db/sqlite-adapter.js';
import {
  migrateGraphTables, createGraph, addNode, addEdge,
  updateGraphStatus, getNode,
  getGraphIdsByTaskId,
} from '../../src/graph/storage.js';
import { evaluateGraphsForTask } from '../../src/graph/lifecycle-bridge.js';
import type { GraphEvaluationLogger } from '../../src/graph/lifecycle-bridge.js';

function makeAdapter(): SqliteAdapter {
  const adapter = new SqliteAdapter(':memory:');
  migrateGraphTables(adapter);

  // Minimal `tasks` table — the task_done predicate needs `status`.
  (adapter as any).exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      uuid TEXT,
      team_id TEXT,
      title TEXT NOT NULL,
      description TEXT,
      status TEXT NOT NULL,
      created_by TEXT,
      owner TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      completed_at INTEGER
    )
  `);

  // Minimal dispatch queue — the task_done bridge doesn't depend on it,
  // but the dispatch-side evaluator code path is still executed by
  // evaluateGraph(...). Without the table the runner would throw on
  // graphs that happen to have a dispatch node, breaking the
  // "mixed graph" test case.
  (adapter as any).exec(`
    CREATE TABLE IF NOT EXISTS dispatch_scheduler_queue (
      dispatch_phid TEXT PRIMARY KEY,
      status TEXT NOT NULL DEFAULT 'queued',
      active_clarification_json TEXT
    )
  `);
  return adapter;
}

function insertTask(adapter: SqliteAdapter, id: string, status: string, title = 'A task'): void {
  const now = Math.floor(Date.now() / 1000);
  (adapter as any).exec(
    `INSERT INTO tasks (id, name, title, status, created_at, updated_at${status === 'done' ? ', completed_at' : ''})
     VALUES ('${id}', '${id}', '${title.replace(/'/g, "''")}', '${status}', ${now}, ${now}${status === 'done' ? `, ${now}` : ''})`,
  );
}

function updateTaskStatus(adapter: SqliteAdapter, id: string, status: string): void {
  const now = Math.floor(Date.now() / 1000);
  if (status === 'done') {
    (adapter as any).exec(
      `UPDATE tasks SET status = '${status}', completed_at = ${now}, updated_at = ${now} WHERE id = '${id}'`,
    );
  } else {
    (adapter as any).exec(
      `UPDATE tasks SET status = '${status}', updated_at = ${now} WHERE id = '${id}'`,
    );
  }
}

function insertDispatch(adapter: SqliteAdapter, phid: string, status: string): void {
  (adapter as any).exec(
    `INSERT INTO dispatch_scheduler_queue (dispatch_phid, status) VALUES ('${phid}', '${status}')`,
  );
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

// ─── Helper: build a graph with a task → dispatch dependency ────────────
async function setupTaskGatedDispatchGraph(taskId: string, downstreamDispatchPhid: string) {
  const graph = await createGraph(adapter, 'task-gates-dispatch', { kind: 'test' });
  await updateGraphStatus(adapter, graph.graph_id, 'active');

  const taskNode = await addNode(adapter, graph.graph_id, 'upstream task', 'task', {
    task_phid: taskId,
    state: 'pending_dependencies',
  });

  const downstreamNode = await addNode(adapter, graph.graph_id, 'downstream dispatch', 'dispatch', {
    dispatch_id: downstreamDispatchPhid,
    state: 'pending_dependencies',
  });

  await addEdge(
    adapter, graph.graph_id, taskNode.node_id, downstreamNode.node_id,
    'waits_on', { type: 'task_done', task_phid: taskId },
  );

  return { graph, taskNode, downstreamNode };
}

// ─────────────────────────────────────────────────────────────────────
// storage.getGraphIdsByTaskId
// ─────────────────────────────────────────────────────────────────────

describe('getGraphIdsByTaskId', () => {
  it('returns empty when no graph nodes link to the task', async () => {
    const ids = await getGraphIdsByTaskId(adapter, 'task-nonexistent');
    expect(ids).toEqual([]);
  });

  it('returns the graph id when a single node links to the task', async () => {
    insertTask(adapter, 'task-1', 'todo');
    const { graph } = await setupTaskGatedDispatchGraph('task-1', 'phid:disp-x');
    insertDispatch(adapter, 'phid:disp-x', 'queued');
    const ids = await getGraphIdsByTaskId(adapter, 'task-1');
    expect(ids).toEqual([graph.graph_id]);
  });

  it('returns DISTINCT graph ids when multiple nodes in the SAME graph reference the same task', async () => {
    insertTask(adapter, 'task-shared', 'todo');
    const graph = await createGraph(adapter, 'two-task-nodes-same-task', { kind: 'test' });
    await updateGraphStatus(adapter, graph.graph_id, 'active');
    await addNode(adapter, graph.graph_id, 'first', 'task', { task_phid: 'task-shared', state: 'pending_dependencies' });
    await addNode(adapter, graph.graph_id, 'second', 'task', { task_phid: 'task-shared', state: 'pending_dependencies' });
    const ids = await getGraphIdsByTaskId(adapter, 'task-shared');
    expect(ids).toEqual([graph.graph_id]); // DISTINCT — single graph id
  });

  it('returns multiple graph ids when nodes in DIFFERENT graphs reference the same task', async () => {
    insertTask(adapter, 'task-fanout', 'todo');
    const gA = await createGraph(adapter, 'A', { kind: 'test' });
    await updateGraphStatus(adapter, gA.graph_id, 'active');
    await addNode(adapter, gA.graph_id, 'task-node-a', 'task', { task_phid: 'task-fanout', state: 'pending_dependencies' });
    const gB = await createGraph(adapter, 'B', { kind: 'test' });
    await updateGraphStatus(adapter, gB.graph_id, 'active');
    await addNode(adapter, gB.graph_id, 'task-node-b', 'task', { task_phid: 'task-fanout', state: 'pending_dependencies' });
    const ids = await getGraphIdsByTaskId(adapter, 'task-fanout');
    expect(ids.sort()).toEqual([gA.graph_id, gB.graph_id].sort());
  });
});

// ─────────────────────────────────────────────────────────────────────
// evaluateGraphsForTask — bridge orchestration
// ─────────────────────────────────────────────────────────────────────

describe('evaluateGraphsForTask', () => {
  it('is a no-op when the task is not linked to any graph node', async () => {
    insertTask(adapter, 'task-orphan', 'done');
    const summary = await evaluateGraphsForTask(adapter, 'task-orphan', 'task_done');
    expect(summary.task_id).toBe('task-orphan');
    expect(summary.trigger).toBe('task_done');
    expect(summary.graph_ids).toHaveLength(0);
    expect(summary.results).toHaveLength(0);
  });

  it('auto-releases a downstream dispatch node when the upstream task is done', async () => {
    insertTask(adapter, 'task-1', 'done');
    insertDispatch(adapter, 'phid:downstream-1', 'queued');
    const { downstreamNode } = await setupTaskGatedDispatchGraph('task-1', 'phid:downstream-1');

    const summary = await evaluateGraphsForTask(adapter, 'task-1', 'task_done');
    expect(summary.graph_ids).toHaveLength(1);
    expect(summary.results).toHaveLength(1);
    expect(summary.results[0].transitioned).toBeGreaterThanOrEqual(1);

    const updated = await getNode(adapter, downstreamNode.node_id);
    expect(updated!.state).toBe('queued');
  });

  it('keeps downstream blocked when the upstream task is still doing', async () => {
    insertTask(adapter, 'task-2', 'doing');
    insertDispatch(adapter, 'phid:downstream-2', 'queued');
    const { downstreamNode } = await setupTaskGatedDispatchGraph('task-2', 'phid:downstream-2');

    await evaluateGraphsForTask(adapter, 'task-2', 'task_done');

    const updated = await getNode(adapter, downstreamNode.node_id);
    expect(updated!.state).toBe('pending_dependencies');
  });

  it('keeps downstream blocked when the upstream task is still todo', async () => {
    insertTask(adapter, 'task-3', 'todo');
    insertDispatch(adapter, 'phid:downstream-3', 'queued');
    const { downstreamNode } = await setupTaskGatedDispatchGraph('task-3', 'phid:downstream-3');

    await evaluateGraphsForTask(adapter, 'task-3', 'task_done');

    const updated = await getNode(adapter, downstreamNode.node_id);
    expect(updated!.state).toBe('pending_dependencies');
  });

  it('keeps downstream blocked when the upstream task is missing entirely', async () => {
    // No tasks.* row inserted. Predicate must not_ready.
    insertDispatch(adapter, 'phid:downstream-missing', 'queued');
    const { downstreamNode } = await setupTaskGatedDispatchGraph('task-missing', 'phid:downstream-missing');

    await evaluateGraphsForTask(adapter, 'task-missing', 'task_done');

    const updated = await getNode(adapter, downstreamNode.node_id);
    expect(updated!.state).toBe('pending_dependencies');
  });

  it('is idempotent — re-invoking after a successful release does not re-transition', async () => {
    insertTask(adapter, 'task-idem', 'done');
    insertDispatch(adapter, 'phid:downstream-idem', 'queued');
    await setupTaskGatedDispatchGraph('task-idem', 'phid:downstream-idem');

    const s1 = await evaluateGraphsForTask(adapter, 'task-idem', 'task_done');
    expect(s1.results[0].transitioned).toBeGreaterThanOrEqual(1);
    const s2 = await evaluateGraphsForTask(adapter, 'task-idem', 'task_done');
    expect(s2.results[0].transitioned).toBe(0);
  });

  it('projects the task node state from the tasks table during evaluation', async () => {
    insertTask(adapter, 'task-proj', 'done');
    insertDispatch(adapter, 'phid:downstream-proj', 'queued');
    const { taskNode } = await setupTaskGatedDispatchGraph('task-proj', 'phid:downstream-proj');

    await evaluateGraphsForTask(adapter, 'task-proj', 'task_done');

    const projectedTaskNode = await getNode(adapter, taskNode.node_id);
    // Spec: task status `done` → node state `done`.
    expect(projectedTaskNode!.state).toBe('done');
  });

  it('catches per-graph evaluation errors without throwing', async () => {
    insertTask(adapter, 'task-err', 'done');
    insertDispatch(adapter, 'phid:downstream-err', 'queued');
    await setupTaskGatedDispatchGraph('task-err', 'phid:downstream-err');

    // Orphan node referencing a missing graph — evaluateGraph will throw.
    (adapter as any).exec(`PRAGMA foreign_keys = OFF`);
    (adapter as any).exec(
      `INSERT INTO dispatch_graph_node (node_id, graph_id, title, kind, task_phid, state)
       VALUES ('node-broken-task', 'graph-nonexistent', 'broken', 'task', 'task-err', 'pending_dependencies')`,
    );
    (adapter as any).exec(`PRAGMA foreign_keys = ON`);

    const { logger, warns } = collectLogs();
    const summary = await evaluateGraphsForTask(adapter, 'task-err', 'task_done', { logger });

    expect(summary.graph_ids).toHaveLength(2);
    const failed = summary.results.find((r) => r.error);
    const ok = summary.results.find((r) => !r.error);
    expect(failed).toBeDefined();
    expect(ok).toBeDefined();
    expect(warns.length).toBeGreaterThanOrEqual(1);
    expect(warns[0].event).toBe('graph_bridge_evaluate_failed');
  });

  it('logs info when a transition occurs', async () => {
    insertTask(adapter, 'task-log', 'done');
    insertDispatch(adapter, 'phid:downstream-log', 'queued');
    await setupTaskGatedDispatchGraph('task-log', 'phid:downstream-log');

    const { logger, infos } = collectLogs();
    await evaluateGraphsForTask(adapter, 'task-log', 'task_done', { logger });

    expect(infos.length).toBeGreaterThanOrEqual(1);
    expect(infos[0].event).toBe('graph_bridge_transitioned');
  });

  it('handles multiple graphs linked to the same task (fan-out)', async () => {
    insertTask(adapter, 'task-shared', 'done');
    insertDispatch(adapter, 'phid:downstream-shared-a', 'queued');
    insertDispatch(adapter, 'phid:downstream-shared-b', 'queued');

    // Graph A
    const gA = await createGraph(adapter, 'graph-a', { kind: 'test' });
    await updateGraphStatus(adapter, gA.graph_id, 'active');
    const aTask = await addNode(adapter, gA.graph_id, 'task', 'task', { task_phid: 'task-shared', state: 'pending_dependencies' });
    const aDown = await addNode(adapter, gA.graph_id, 'down-a', 'dispatch', {
      dispatch_id: 'phid:downstream-shared-a', state: 'pending_dependencies',
    });
    await addEdge(adapter, gA.graph_id, aTask.node_id, aDown.node_id, 'waits_on',
      { type: 'task_done', task_phid: 'task-shared' });

    // Graph B
    const gB = await createGraph(adapter, 'graph-b', { kind: 'test' });
    await updateGraphStatus(adapter, gB.graph_id, 'active');
    const bTask = await addNode(adapter, gB.graph_id, 'task', 'task', { task_phid: 'task-shared', state: 'pending_dependencies' });
    const bDown = await addNode(adapter, gB.graph_id, 'down-b', 'dispatch', {
      dispatch_id: 'phid:downstream-shared-b', state: 'pending_dependencies',
    });
    await addEdge(adapter, gB.graph_id, bTask.node_id, bDown.node_id, 'waits_on',
      { type: 'task_done', task_phid: 'task-shared' });

    const summary = await evaluateGraphsForTask(adapter, 'task-shared', 'task_done');
    expect(summary.graph_ids).toHaveLength(2);

    expect((await getNode(adapter, aDown.node_id))!.state).toBe('queued');
    expect((await getNode(adapter, bDown.node_id))!.state).toBe('queued');
  });

  it('releases downstream once a previously-doing task transitions to done', async () => {
    insertTask(adapter, 'task-flow', 'doing');
    insertDispatch(adapter, 'phid:downstream-flow', 'queued');
    const { downstreamNode } = await setupTaskGatedDispatchGraph('task-flow', 'phid:downstream-flow');

    // First evaluation while doing — downstream blocked.
    await evaluateGraphsForTask(adapter, 'task-flow', 'task_done');
    expect((await getNode(adapter, downstreamNode.node_id))!.state).toBe('pending_dependencies');

    // Task transitions to done.
    updateTaskStatus(adapter, 'task-flow', 'done');

    // Second evaluation releases downstream.
    await evaluateGraphsForTask(adapter, 'task-flow', 'task_done');
    expect((await getNode(adapter, downstreamNode.node_id))!.state).toBe('queued');
  });
});
