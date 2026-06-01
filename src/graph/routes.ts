// P1 Dependency-Graph Orchestrator — Express routes for /graphs/*.

import type { Application, Request, Response } from 'express';
import type { DbAdapter } from '../db/db-adapter.js';
import type { DependencyPredicate, EnqueueFn, GraphDetail } from './types.js';
import {
  createGraph, getGraph, listGraphs,
  addNode, getNodes, getNode, updateNodeState,
  addEdge, getEdges, getIncomingEdges, getOutgoingEdges,
  getRecentDecisions,
  updateGraphStatus,
} from './storage.js';
import { evaluateGraph } from './runner.js';
import { validateDispatchPlanRequest, executeDispatchPlan, DispatchPlanError } from './dispatch-plan.js';

export interface GraphRouteOptions {
  enqueueDispatch?: EnqueueFn;
}

export function mountGraphRoutes(app: Application, adapter: DbAdapter, options?: GraphRouteOptions): void {

  // ── GET /graphs ──

  app.get('/graphs', async (_req: Request, res: Response) => {
    try {
      const graphs = await listGraphs(adapter);
      res.json({ graphs });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ── GET /graphs/:graph_id ──

  app.get('/graphs/:graph_id', async (req: Request<{ graph_id: string }>, res: Response) => {
    try {
      const graph = await getGraph(adapter, req.params.graph_id);
      if (!graph) {
        res.status(404).json({ error: 'Graph not found' });
        return;
      }

      const [nodes, edges, decisions] = await Promise.all([
        getNodes(adapter, graph.graph_id),
        getEdges(adapter, graph.graph_id),
        getRecentDecisions(adapter, graph.graph_id, 5),
      ]);

      // Enrich nodes with waits_on and blocker_of.
      const enrichedNodes = await Promise.all(nodes.map(async (node) => {
        const incoming = await getIncomingEdges(adapter, node.node_id);
        const outgoing = await getOutgoingEdges(adapter, node.node_id);

        const waitsOn: DependencyPredicate[] = incoming.map(e => JSON.parse(e.predicate_json));
        const blockerOf: string[] = outgoing.map(e => e.to_node_id);

        return {
          ...node,
          waits_on: waitsOn,
          blocker_of: blockerOf,
          blocker_summary: node.blocker_summary_json ? JSON.parse(node.blocker_summary_json) : null,
        };
      }));

      const enrichedEdges = edges.map(e => ({
        ...e,
        predicate: JSON.parse(e.predicate_json),
      }));

      const detail: GraphDetail = {
        graph,
        nodes: enrichedNodes,
        edges: enrichedEdges,
        decisions,
      };

      res.json(detail);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ── POST /graphs — create a new graph ──

  app.post('/graphs', async (req: Request, res: Response) => {
    try {
      const { title, created_by } = req.body;
      if (!title) {
        res.status(400).json({ error: 'title is required' });
        return;
      }
      const graph = await createGraph(adapter, title, created_by ?? { id: 'human:chris', kind: 'human' });
      res.status(201).json(graph);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ── POST /graphs/:graph_id/nodes — add a node ──

  app.post('/graphs/:graph_id/nodes', async (req: Request<{ graph_id: string }>, res: Response) => {
    try {
      const graph = await getGraph(adapter, req.params.graph_id);
      if (!graph) {
        res.status(404).json({ error: 'Graph not found' });
        return;
      }
      const { title, kind, dispatch_id, task_phid, state, node_id } = req.body;
      if (!title) {
        res.status(400).json({ error: 'title is required' });
        return;
      }
      const node = await addNode(adapter, graph.graph_id, title, kind ?? 'dispatch', {
        dispatch_id, task_phid, state, node_id,
      });
      res.status(201).json(node);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ── POST /graphs/:graph_id/edges — add an edge ──

  app.post('/graphs/:graph_id/edges', async (req: Request<{ graph_id: string }>, res: Response) => {
    try {
      const graph = await getGraph(adapter, req.params.graph_id);
      if (!graph) {
        res.status(404).json({ error: 'Graph not found' });
        return;
      }
      const { from_node_id, to_node_id, relation, predicate } = req.body;
      if (!from_node_id || !to_node_id || !predicate) {
        res.status(400).json({ error: 'from_node_id, to_node_id, and predicate are required' });
        return;
      }
      const edge = await addEdge(
        adapter, graph.graph_id,
        from_node_id, to_node_id,
        relation ?? 'waits_on',
        predicate,
      );
      res.json(edge);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ── POST /graphs/:graph_id/activate — move from draft to active ──

  app.post('/graphs/:graph_id/activate', async (req: Request<{ graph_id: string }>, res: Response) => {
    try {
      const graph = await getGraph(adapter, req.params.graph_id);
      if (!graph) {
        res.status(404).json({ error: 'Graph not found' });
        return;
      }
      if (graph.status !== 'draft') {
        res.status(400).json({ error: `Cannot activate graph in state ${graph.status}` });
        return;
      }
      await updateGraphStatus(adapter, graph.graph_id, 'active');
      const result = await evaluateGraph(adapter, graph.graph_id);
      res.json({ ok: true, status: 'active', evaluation: result });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ── POST /graphs/:graph_id/evaluate — manual evaluator kick ──

  app.post('/graphs/:graph_id/evaluate', async (req: Request<{ graph_id: string }>, res: Response) => {
    try {
      const graph = await getGraph(adapter, req.params.graph_id);
      if (!graph) {
        res.status(404).json({ error: 'Graph not found' });
        return;
      }
      const result = await evaluateGraph(adapter, graph.graph_id);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ── POST /graphs/:graph_id/approvals/:approval_id/approve ──
  //
  // N1.5 operator_approval gate (Spec 2026-05-31). Marks an approval
  // node `done` and re-evaluates the graph. Best-effort on re-eval:
  // approval write is durable even if evaluation throws.
  app.post(
    '/graphs/:graph_id/approvals/:approval_id/approve',
    async (req: Request<{ graph_id: string; approval_id: string }>, res: Response) => {
      try {
        const graph = await getGraph(adapter, req.params.graph_id);
        if (!graph) {
          res.status(404).json({ error: 'Graph not found' });
          return;
        }
        const node = await getNode(adapter, req.params.approval_id);
        // Cross-graph guard: an approval node from a different graph must NOT
        // be approvable through this graph's route.
        if (!node || node.graph_id !== graph.graph_id) {
          res.status(404).json({ error: 'approval node not found in graph' });
          return;
        }
        if (node.kind !== 'approval') {
          res.status(400).json({
            error: `node ${node.node_id} is not an approval node (kind=${node.kind})`,
          });
          return;
        }

        // Idempotent write: setting state=done when already done is a
        // no-op at the readiness level; the runner skips re-transition
        // because the input revision is unchanged.
        const wasAlreadyDone = node.state === 'done';
        if (!wasAlreadyDone) {
          await updateNodeState(adapter, node.node_id, 'done');
        }

        // Best-effort re-evaluation. The spec requires that an
        // evaluation error MUST NOT roll back the approval write.
        let evaluation: {
          attempted: boolean;
          evaluated?: number;
          transitioned?: number;
          graph_status?: string;
          error?: string;
        };
        try {
          const r = await evaluateGraph(adapter, graph.graph_id);
          evaluation = {
            attempted: true,
            evaluated: r.evaluated,
            transitioned: r.transitioned,
            graph_status: r.graph_status,
          };
        } catch (err) {
          // Log via console.warn so the manager log surfaces it.
          const msg = err instanceof Error ? err.message : String(err);
          console.warn(`[graph-approval] evaluate failed after approving ${node.node_id}: ${msg}`);
          evaluation = { attempted: true, error: msg };
        }

        res.json({
          ok: true,
          approval: { node_id: node.node_id, state: 'done' },
          evaluation,
        });
      } catch (err) {
        res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  );

  // ── POST /graphs/dispatch-plan — N1.2 dispatch-plan enqueue ──

  app.post('/graphs/dispatch-plan', async (req: Request, res: Response) => {
    try {
      const enqueue = options?.enqueueDispatch;
      if (!enqueue) {
        res.status(503).json({ error: 'Scheduler unavailable — dispatch-plan requires an active scheduler.' });
        return;
      }

      const validationError = validateDispatchPlanRequest(req.body);
      if (validationError) {
        res.status(400).json({ error: validationError });
        return;
      }

      const result = await executeDispatchPlan(adapter, req.body, enqueue);
      res.status(201).json(result);
    } catch (err) {
      if (err instanceof DispatchPlanError) {
        res.status(500).json({
          error: err.message,
          partial: true,
          partial_nodes: err.partialNodes,
          errors: err.errors,
        });
        return;
      }
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });
}
