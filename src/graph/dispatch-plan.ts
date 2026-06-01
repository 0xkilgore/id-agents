// N1.2 Graph-backed dispatch-plan enqueue v0.
// Validates a small DAG request, enqueues each node through an injected
// enqueue function, creates graph nodes/edges, activates, and returns
// a compact read model.

import type { DbAdapter } from '../db/db-adapter.js';
import type {
  DispatchPlanRequest, DispatchPlanNodeInput,
  DispatchPlanResponse, DispatchPlanNodeResult,
  EnqueueFn, NodeState,
} from './types.js';
import {
  createGraph, getGraph, getNodes, getEdges,
  addNode, addEdge, updateGraphStatus,
  getGraphByIdempotencyKey, getNodeByClientId,
  getRecentDecisions, getIncomingEdges, getOutgoingEdges,
  setGraphIdempotencyKey,
} from './storage.js';
import { evaluateGraph } from './runner.js';

const CLIENT_NODE_ID_RE = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;

// ── Validation ──

export function validateDispatchPlanRequest(req: DispatchPlanRequest): string | null {
  if (!req.title || typeof req.title !== 'string') return 'title is required';
  if (!req.idempotency_key || typeof req.idempotency_key !== 'string') return 'idempotency_key is required';
  if (!Array.isArray(req.nodes) || req.nodes.length === 0) return 'nodes[] is required and must not be empty';
  if (req.nodes.length > 5) return 'nodes[] must have at most 5 entries for v0';

  const ids = new Set<string>();
  for (const node of req.nodes) {
    if (!node.client_node_id || typeof node.client_node_id !== 'string') {
      return 'each node requires a client_node_id';
    }
    if (!CLIENT_NODE_ID_RE.test(node.client_node_id)) {
      return `client_node_id "${node.client_node_id}" must match ${CLIENT_NODE_ID_RE}`;
    }
    if (ids.has(node.client_node_id)) {
      return `duplicate client_node_id: "${node.client_node_id}"`;
    }
    ids.add(node.client_node_id);

    if (!node.title) return `node "${node.client_node_id}": title is required`;
    if (!node.to_agent) return `node "${node.client_node_id}": to_agent is required`;
    if (!node.message) return `node "${node.client_node_id}": message is required`;

    // Build nodes: promote defaults true when repo+branch are present.
    if (node.repo || node.branch) {
      if (node.promote === false && !node.promotion_skip_reason) {
        return `node "${node.client_node_id}": promote:false requires promotion_skip_reason`;
      }
    }

    if (node.waits_on) {
      for (const dep of node.waits_on) {
        if (!ids.has(dep.client_node_id)) {
          return `node "${node.client_node_id}": waits_on references unknown client_node_id "${dep.client_node_id}"`;
        }
        if (dep.predicate !== 'dispatch_success') {
          return `node "${node.client_node_id}": v0 only supports predicate "dispatch_success"`;
        }
      }
    }
  }

  // Cycle detection (topological sort).
  if (detectCycle(req.nodes)) {
    return 'nodes[] contain a dependency cycle';
  }

  return null;
}

function detectCycle(nodes: DispatchPlanNodeInput[]): boolean {
  const adj = new Map<string, string[]>();
  const indegree = new Map<string, number>();
  for (const n of nodes) {
    adj.set(n.client_node_id, []);
    indegree.set(n.client_node_id, 0);
  }
  for (const n of nodes) {
    if (n.waits_on) {
      for (const dep of n.waits_on) {
        adj.get(dep.client_node_id)!.push(n.client_node_id);
        indegree.set(n.client_node_id, (indegree.get(n.client_node_id) ?? 0) + 1);
      }
    }
  }
  const queue = [...indegree.entries()].filter(([, d]) => d === 0).map(([id]) => id);
  let visited = 0;
  while (queue.length > 0) {
    const cur = queue.shift()!;
    visited++;
    for (const next of adj.get(cur) ?? []) {
      const d = indegree.get(next)! - 1;
      indegree.set(next, d);
      if (d === 0) queue.push(next);
    }
  }
  return visited !== nodes.length;
}

// Return nodes in topological order (upstream before downstream).
export function topoSort(nodes: DispatchPlanNodeInput[]): DispatchPlanNodeInput[] {
  const adj = new Map<string, string[]>();
  const indegree = new Map<string, number>();
  const byId = new Map<string, DispatchPlanNodeInput>();
  for (const n of nodes) {
    byId.set(n.client_node_id, n);
    adj.set(n.client_node_id, []);
    indegree.set(n.client_node_id, 0);
  }
  for (const n of nodes) {
    if (n.waits_on) {
      for (const dep of n.waits_on) {
        adj.get(dep.client_node_id)!.push(n.client_node_id);
        indegree.set(n.client_node_id, (indegree.get(n.client_node_id) ?? 0) + 1);
      }
    }
  }
  const queue = [...indegree.entries()].filter(([, d]) => d === 0).map(([id]) => id);
  const result: DispatchPlanNodeInput[] = [];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    result.push(byId.get(cur)!);
    for (const next of adj.get(cur) ?? []) {
      const d = indegree.get(next)! - 1;
      indegree.set(next, d);
      if (d === 0) queue.push(next);
    }
  }
  return result;
}

// ── Orchestration ──

export async function executeDispatchPlan(
  adapter: DbAdapter,
  req: DispatchPlanRequest,
  enqueue: EnqueueFn,
): Promise<DispatchPlanResponse> {
  // Idempotency check: return existing graph if key matches.
  //
  // Code-review HIGH-2 (2026-05-31): only treat an existing graph as a
  // completed idempotent hit when its status is 'active' (or 'completed').
  // A 'draft' graph means a prior attempt failed mid-enqueue; in that
  // case we MUST NOT return it as success — but with the deferred-key
  // fix below, such an orphan never claims the key in the first place,
  // so this lookup naturally misses on draft orphans. We keep an
  // explicit guard here as belt-and-suspenders.
  const existing = await getGraphByIdempotencyKey(adapter, req.idempotency_key);
  if (existing && existing.status !== 'draft') {
    return buildResponseFromExistingGraph(adapter, existing.graph_id);
  }

  // 1. Create graph in draft WITHOUT the idempotency key. The key is only
  //    persisted after the full plan is enqueued, activated, and evaluated
  //    — so a partial-failure attempt leaves no idempotency claim.
  const graph = await createGraph(adapter, req.title, req.created_by, {
    source_json: JSON.stringify(req),
  });

  // 2. Topologically sort nodes.
  const sorted = topoSort(req.nodes);

  // 3. Enqueue each dispatch and create graph nodes.
  const clientToNodeId = new Map<string, string>();
  const nodeResults: DispatchPlanNodeResult[] = [];
  const enqueueErrors: Array<{ client_node_id: string; error: string }> = [];
  let partial = false;

  for (const nodeInput of sorted) {
    try {
      const fromActor = req.created_by
        ? `${req.created_by.kind}:${req.created_by.id}`
        : 'manager';

      const enqResult = await enqueue({
        to_agent: nodeInput.to_agent,
        from_actor: fromActor,
        message: nodeInput.message,
        subject: nodeInput.subject,
        priority: nodeInput.priority,
        repo: nodeInput.repo,
        branch: nodeInput.branch,
        base: nodeInput.base,
        remote: nodeInput.remote,
        promote: nodeInput.promote,
        promotion_skip_reason: nodeInput.promotion_skip_reason,
      });

      const nodeRow = await addNode(adapter, graph.graph_id, nodeInput.title, 'dispatch', {
        dispatch_id: enqResult.dispatch_phid,
        state: 'pending_dependencies',
        client_node_id: nodeInput.client_node_id,
      });

      clientToNodeId.set(nodeInput.client_node_id, nodeRow.node_id);

      const waitsOnIds = nodeInput.waits_on?.map(w => w.client_node_id);
      nodeResults.push({
        client_node_id: nodeInput.client_node_id,
        node_id: nodeRow.node_id,
        dispatch_id: enqResult.dispatch_phid,
        query_id: enqResult.query_id,
        state: 'pending_dependencies',
        waits_on: waitsOnIds,
      });
    } catch (err) {
      partial = true;
      enqueueErrors.push({
        client_node_id: nodeInput.client_node_id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // If any enqueue failed and we have partial results, fail the whole plan.
  if (partial) {
    const detail = enqueueErrors.map(e => `${e.client_node_id}: ${e.error}`).join('; ');
    throw new DispatchPlanError(
      `Partial enqueue failure — ${enqueueErrors.length} node(s) failed: ${detail}`,
      nodeResults,
      enqueueErrors,
    );
  }

  // 4. Add edges (waits_on: dispatch_success).
  for (const nodeInput of sorted) {
    if (!nodeInput.waits_on) continue;
    const toNodeId = clientToNodeId.get(nodeInput.client_node_id)!;
    for (const dep of nodeInput.waits_on) {
      const fromNodeId = clientToNodeId.get(dep.client_node_id)!;
      await addEdge(adapter, graph.graph_id, fromNodeId, toNodeId, 'waits_on', {
        type: 'dispatch_success',
        upstream_node_id: fromNodeId,
      });
    }
  }

  // 5. Activate graph and evaluate.
  await updateGraphStatus(adapter, graph.graph_id, 'active');
  const evalResult = await evaluateGraph(adapter, graph.graph_id);

  // 5b. Code-review HIGH-2 (2026-05-31): NOW persist the idempotency
  //     key — only after the plan has been fully enqueued, edges added,
  //     activated, and evaluated. A partial-failure path that threw
  //     above leaves no idempotency claim, so a natural client retry
  //     gets a fresh graph rather than a silent broken-partial success.
  await setGraphIdempotencyKey(adapter, graph.graph_id, req.idempotency_key);

  // 6. Build response with refreshed node states.
  const refreshedNodes = await getNodes(adapter, graph.graph_id);
  const refreshedGraph = await getGraph(adapter, graph.graph_id);

  for (const nr of nodeResults) {
    const refreshed = refreshedNodes.find(n => n.node_id === nr.node_id);
    if (refreshed) nr.state = refreshed.state;
  }

  return {
    schema_version: 'dispatch_graph.dispatch_plan.v1',
    graph_id: graph.graph_id,
    status: refreshedGraph?.status ?? 'active',
    nodes: nodeResults,
    evaluation: {
      evaluated: evalResult.evaluated,
      transitioned: evalResult.transitioned,
      graph_status: evalResult.graph_status,
    },
  };
}

async function buildResponseFromExistingGraph(
  adapter: DbAdapter,
  graphId: string,
): Promise<DispatchPlanResponse> {
  const graph = await getGraph(adapter, graphId);
  if (!graph) throw new Error(`Graph not found: ${graphId}`);

  const nodes = await getNodes(adapter, graphId);
  const edges = await getEdges(adapter, graphId);

  const nodeResults: DispatchPlanNodeResult[] = [];
  for (const node of nodes) {
    const incoming = await getIncomingEdges(adapter, node.node_id);
    const waitsOn = incoming.length > 0
      ? incoming.map(e => {
          const upNode = nodes.find(n => n.node_id === e.from_node_id);
          return (upNode as any)?.client_node_id ?? e.from_node_id;
        })
      : undefined;

    nodeResults.push({
      client_node_id: (node as any).client_node_id ?? node.node_id,
      node_id: node.node_id,
      dispatch_id: node.dispatch_id ?? '',
      query_id: '',
      state: node.state,
      waits_on: waitsOn,
    });
  }

  return {
    schema_version: 'dispatch_graph.dispatch_plan.v1',
    graph_id: graphId,
    status: graph.status,
    nodes: nodeResults,
    evaluation: {
      evaluated: 0,
      transitioned: 0,
      graph_status: graph.status,
    },
  };
}

export class DispatchPlanError extends Error {
  constructor(
    message: string,
    public readonly partialNodes: DispatchPlanNodeResult[],
    public readonly errors: Array<{ client_node_id: string; error: string }>,
  ) {
    super(message);
    this.name = 'DispatchPlanError';
  }
}
