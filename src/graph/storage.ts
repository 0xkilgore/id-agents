// P1 Dependency-Graph Orchestrator — storage layer (DDL + CRUD).

import { randomUUID } from 'node:crypto';
import type { DbAdapter } from '../db/db-adapter.js';
import type {
  GraphRow, NodeRow, EdgeRow, DecisionRow,
  GraphStatus, NodeState, DependencyPredicate,
  BlockerSummary, DecisionResult, GraphListItem,
} from './types.js';

// ── DDL (idempotent) ──

export function migrateGraphTables(adapter: DbAdapter): void {
  const exec = (sql: string) => {
    if (adapter.dialect === 'sqlite') {
      (adapter as any).exec?.(sql) ?? adapter.query(sql);
    } else {
      adapter.query(sql);
    }
  };

  exec(`
    CREATE TABLE IF NOT EXISTS dispatch_graph (
      graph_id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'draft',
      version INTEGER NOT NULL DEFAULT 1,
      created_by_actor_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    )
  `);

  exec(`
    CREATE TABLE IF NOT EXISTS dispatch_graph_node (
      node_id TEXT PRIMARY KEY,
      graph_id TEXT NOT NULL,
      title TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'dispatch',
      dispatch_id TEXT,
      task_phid TEXT,
      state TEXT NOT NULL DEFAULT 'pending_dependencies',
      blocker_summary_json TEXT,
      FOREIGN KEY (graph_id) REFERENCES dispatch_graph(graph_id)
    )
  `);
  exec(`CREATE INDEX IF NOT EXISTS idx_graph_node_graph ON dispatch_graph_node(graph_id)`);
  exec(`CREATE INDEX IF NOT EXISTS idx_graph_node_dispatch ON dispatch_graph_node(dispatch_id)`);

  exec(`
    CREATE TABLE IF NOT EXISTS dispatch_graph_edge (
      edge_id TEXT PRIMARY KEY,
      graph_id TEXT NOT NULL,
      from_node_id TEXT NOT NULL,
      to_node_id TEXT NOT NULL,
      relation TEXT NOT NULL,
      predicate_json TEXT NOT NULL DEFAULT '{}',
      FOREIGN KEY (graph_id) REFERENCES dispatch_graph(graph_id),
      FOREIGN KEY (from_node_id) REFERENCES dispatch_graph_node(node_id),
      FOREIGN KEY (to_node_id) REFERENCES dispatch_graph_node(node_id)
    )
  `);
  exec(`CREATE INDEX IF NOT EXISTS idx_graph_edge_graph ON dispatch_graph_edge(graph_id)`);

  exec(`
    CREATE TABLE IF NOT EXISTS dispatch_graph_decision (
      decision_id TEXT PRIMARY KEY,
      graph_id TEXT NOT NULL,
      node_id TEXT NOT NULL,
      idempotency_key TEXT NOT NULL UNIQUE,
      result TEXT NOT NULL,
      reason TEXT NOT NULL,
      input_revision TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (graph_id) REFERENCES dispatch_graph(graph_id),
      FOREIGN KEY (node_id) REFERENCES dispatch_graph_node(node_id)
    )
  `);
  exec(`CREATE INDEX IF NOT EXISTS idx_graph_decision_node ON dispatch_graph_decision(node_id)`);

  // N1.2 Dispatch-Plan additive columns (idempotent ALTER).
  for (const stmt of [
    `ALTER TABLE dispatch_graph ADD COLUMN plan_idempotency_key TEXT`,
    `ALTER TABLE dispatch_graph ADD COLUMN source_json TEXT`,
    `ALTER TABLE dispatch_graph_node ADD COLUMN client_node_id TEXT`,
  ]) {
    if (adapter.dialect === 'sqlite') {
      try { (adapter as any).exec(stmt); } catch { /* column already exists */ }
    } else {
      adapter.query(stmt.replace('ADD COLUMN', 'ADD COLUMN IF NOT EXISTS')).catch(() => {});
    }
  }
  exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_graph_plan_idempotency ON dispatch_graph(plan_idempotency_key)`);
  exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_graph_node_client ON dispatch_graph_node(graph_id, client_node_id)`);
}

// ── Graph CRUD ──

export async function createGraph(
  adapter: DbAdapter,
  title: string,
  createdBy: Record<string, unknown>,
  opts?: { plan_idempotency_key?: string; source_json?: string },
): Promise<GraphRow> {
  const row: GraphRow = {
    graph_id: `graph-${randomUUID().slice(0, 12)}`,
    title,
    status: 'draft',
    version: 1,
    created_by_actor_json: JSON.stringify(createdBy),
    created_at: new Date().toISOString(),
  };
  await adapter.query(
    `INSERT INTO dispatch_graph (graph_id, title, status, version, created_by_actor_json, created_at, plan_idempotency_key, source_json)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [row.graph_id, row.title, row.status, row.version, row.created_by_actor_json, row.created_at,
     opts?.plan_idempotency_key ?? null, opts?.source_json ?? null],
  );
  return row;
}

export async function getGraph(adapter: DbAdapter, graphId: string): Promise<GraphRow | null> {
  const { rows } = await adapter.query<GraphRow>(
    'SELECT * FROM dispatch_graph WHERE graph_id = $1',
    [graphId],
  );
  return rows[0] ?? null;
}

export async function getGraphByIdempotencyKey(adapter: DbAdapter, key: string): Promise<GraphRow | null> {
  const { rows } = await adapter.query<GraphRow>(
    'SELECT * FROM dispatch_graph WHERE plan_idempotency_key = $1',
    [key],
  );
  return rows[0] ?? null;
}

export async function listGraphs(adapter: DbAdapter): Promise<GraphListItem[]> {
  const { rows } = await adapter.query<GraphListItem>(
    `SELECT g.graph_id, g.title, g.status, g.created_at,
       (SELECT COUNT(*) FROM dispatch_graph_node WHERE graph_id = g.graph_id) AS node_count,
       (SELECT COUNT(*) FROM dispatch_graph_node WHERE graph_id = g.graph_id AND state IN ('pending_dependencies', 'needs_clarification')) AS blocked_count
     FROM dispatch_graph g
     ORDER BY g.created_at DESC`,
  );
  return rows;
}

export async function updateGraphStatus(adapter: DbAdapter, graphId: string, status: GraphStatus): Promise<void> {
  await adapter.query(
    'UPDATE dispatch_graph SET status = $1, version = version + 1 WHERE graph_id = $2',
    [status, graphId],
  );
}

// ── Node CRUD ──

export async function addNode(
  adapter: DbAdapter,
  graphId: string,
  title: string,
  kind: NodeRow['kind'],
  opts: { dispatch_id?: string; task_phid?: string; state?: NodeState; node_id?: string; client_node_id?: string } = {},
): Promise<NodeRow> {
  const row: NodeRow = {
    node_id: opts.node_id ?? `node-${randomUUID().slice(0, 12)}`,
    graph_id: graphId,
    title,
    kind,
    dispatch_id: opts.dispatch_id ?? null,
    task_phid: opts.task_phid ?? null,
    state: opts.state ?? 'pending_dependencies',
    blocker_summary_json: null,
  };
  await adapter.query(
    `INSERT INTO dispatch_graph_node (node_id, graph_id, title, kind, dispatch_id, task_phid, state, blocker_summary_json, client_node_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [row.node_id, row.graph_id, row.title, row.kind, row.dispatch_id, row.task_phid, row.state, row.blocker_summary_json, opts.client_node_id ?? null],
  );
  return row;
}

export async function getNode(adapter: DbAdapter, nodeId: string): Promise<NodeRow | null> {
  const { rows } = await adapter.query<NodeRow>(
    'SELECT * FROM dispatch_graph_node WHERE node_id = $1',
    [nodeId],
  );
  return rows[0] ?? null;
}

export async function getNodeByDispatchId(adapter: DbAdapter, dispatchId: string): Promise<NodeRow | null> {
  const { rows } = await adapter.query<NodeRow>(
    'SELECT * FROM dispatch_graph_node WHERE dispatch_id = $1',
    [dispatchId],
  );
  return rows[0] ?? null;
}

export async function getNodes(adapter: DbAdapter, graphId: string): Promise<NodeRow[]> {
  const { rows } = await adapter.query<NodeRow>(
    'SELECT * FROM dispatch_graph_node WHERE graph_id = $1',
    [graphId],
  );
  return rows;
}

export async function updateNodeState(
  adapter: DbAdapter,
  nodeId: string,
  state: NodeState,
  blockerSummary?: BlockerSummary | null,
): Promise<void> {
  await adapter.query(
    'UPDATE dispatch_graph_node SET state = $1, blocker_summary_json = $2 WHERE node_id = $3',
    [state, blockerSummary ? JSON.stringify(blockerSummary) : null, nodeId],
  );
}

// ── Edge CRUD ──

export async function addEdge(
  adapter: DbAdapter,
  graphId: string,
  fromNodeId: string,
  toNodeId: string,
  relation: EdgeRow['relation'],
  predicate: DependencyPredicate,
): Promise<EdgeRow> {
  const row: EdgeRow = {
    edge_id: `edge-${randomUUID().slice(0, 12)}`,
    graph_id: graphId,
    from_node_id: fromNodeId,
    to_node_id: toNodeId,
    relation,
    predicate_json: JSON.stringify(predicate),
  };
  await adapter.query(
    `INSERT INTO dispatch_graph_edge (edge_id, graph_id, from_node_id, to_node_id, relation, predicate_json)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [row.edge_id, row.graph_id, row.from_node_id, row.to_node_id, row.relation, row.predicate_json],
  );
  return row;
}

export async function getEdges(adapter: DbAdapter, graphId: string): Promise<EdgeRow[]> {
  const { rows } = await adapter.query<EdgeRow>(
    'SELECT * FROM dispatch_graph_edge WHERE graph_id = $1',
    [graphId],
  );
  return rows;
}

export async function getIncomingEdges(adapter: DbAdapter, nodeId: string): Promise<EdgeRow[]> {
  const { rows } = await adapter.query<EdgeRow>(
    'SELECT * FROM dispatch_graph_edge WHERE to_node_id = $1',
    [nodeId],
  );
  return rows;
}

export async function getOutgoingEdges(adapter: DbAdapter, nodeId: string): Promise<EdgeRow[]> {
  const { rows } = await adapter.query<EdgeRow>(
    'SELECT * FROM dispatch_graph_edge WHERE from_node_id = $1',
    [nodeId],
  );
  return rows;
}

// ── Decision CRUD ──

export async function appendDecision(
  adapter: DbAdapter,
  graphId: string,
  nodeId: string,
  result: DecisionResult,
  reason: string,
  inputRevision: string,
  idempotencyKey: string,
): Promise<{ appended: boolean; reason?: string }> {
  try {
    await adapter.query(
      `INSERT INTO dispatch_graph_decision (decision_id, graph_id, node_id, idempotency_key, result, reason, input_revision, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [`dec-${randomUUID().slice(0, 12)}`, graphId, nodeId, idempotencyKey, result, reason, inputRevision, new Date().toISOString()],
    );
    return { appended: true };
  } catch (err) {
    if (err instanceof Error && err.message.includes('UNIQUE')) {
      return { appended: false, reason: 'idempotent_duplicate' };
    }
    throw err;
  }
}

export async function getDecisions(adapter: DbAdapter, nodeId: string, limit = 10): Promise<DecisionRow[]> {
  const { rows } = await adapter.query<DecisionRow>(
    'SELECT * FROM dispatch_graph_decision WHERE node_id = $1 ORDER BY created_at DESC LIMIT $2',
    [nodeId, limit],
  );
  return rows;
}

export async function getRecentDecisions(adapter: DbAdapter, graphId: string, limit = 5): Promise<DecisionRow[]> {
  const { rows } = await adapter.query<DecisionRow>(
    'SELECT * FROM dispatch_graph_decision WHERE graph_id = $1 ORDER BY created_at DESC LIMIT $2',
    [graphId, limit],
  );
  return rows;
}

// ── N1.2 Dispatch-Plan lookups ──

export async function getNodeByClientId(adapter: DbAdapter, graphId: string, clientNodeId: string): Promise<NodeRow | null> {
  const { rows } = await adapter.query<NodeRow>(
    'SELECT * FROM dispatch_graph_node WHERE graph_id = $1 AND client_node_id = $2',
    [graphId, clientNodeId],
  );
  return rows[0] ?? null;
}

// ── Scheduler readiness check ──

export async function isDispatchGraphBlocked(adapter: DbAdapter, dispatchId: string): Promise<boolean> {
  const { rows } = await adapter.query<{ state: string }>(
    "SELECT state FROM dispatch_graph_node WHERE dispatch_id = $1 AND state = 'pending_dependencies'",
    [dispatchId],
  );
  return rows.length > 0;
}
