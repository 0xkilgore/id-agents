// P1 Dependency-Graph Orchestrator — evaluator runner.
// Reads graph state, calls the pure evaluator, writes decisions, transitions nodes.

import { createHash } from 'node:crypto';
import type { DbAdapter } from '../db/db-adapter.js';
import type { GraphStatus, NodeRow, NodeState } from './types.js';
import {
  getGraph, getNodes, getEdges, getIncomingEdges,
  updateNodeState, updateGraphStatus, appendDecision,
} from './storage.js';
import { evaluateNodeReadiness } from './evaluator.js';

interface DispatchState {
  dispatch_phid: string;
  status: string;
  clarification_question: string | null;
}

async function getDispatchState(adapter: DbAdapter, dispatchId: string): Promise<DispatchState | null> {
  const { rows } = await adapter.query<{
    dispatch_phid: string;
    status: string;
    active_clarification_json: string | null;
  }>(
    'SELECT dispatch_phid, status, active_clarification_json FROM dispatch_scheduler_queue WHERE dispatch_phid = $1',
    [dispatchId],
  );
  if (!rows[0]) return null;
  let question: string | null = null;
  if (rows[0].active_clarification_json) {
    try {
      const parsed = JSON.parse(rows[0].active_clarification_json);
      question = parsed.question ?? null;
    } catch {}
  }
  return {
    dispatch_phid: rows[0].dispatch_phid,
    status: rows[0].status,
    clarification_question: question,
  };
}

function computeInputRevision(nodeId: string, upstreamStates: string[]): string {
  const input = `${nodeId}:${upstreamStates.sort().join(',')}`;
  return createHash('sha256').update(input).digest('hex').slice(0, 16);
}

export interface EvaluateGraphResult {
  evaluated: number;
  transitioned: number;
  decisions: Array<{ node_id: string; result: string; reason: string }>;
  graph_status: string;
}

/**
 * Evaluate all nodes in a graph. Idempotent — duplicate evaluations
 * over the same input revision are no-ops.
 */
export async function evaluateGraph(adapter: DbAdapter, graphId: string): Promise<EvaluateGraphResult> {
  const graph = await getGraph(adapter, graphId);
  if (!graph) throw new Error(`Graph not found: ${graphId}`);

  const nodes = await getNodes(adapter, graphId);
  const edges = await getEdges(adapter, graphId);

  // Build upstream info map.
  const upstreamInfoMap = new Map<string, {
    node: NodeRow;
    dispatch_status: string | null;
    clarification_question: string | null;
  }>();

  for (const node of nodes) {
    let dispatchStatus: string | null = null;
    let clarificationQuestion: string | null = null;

    if (node.dispatch_id) {
      const ds = await getDispatchState(adapter, node.dispatch_id);
      if (ds) {
        dispatchStatus = ds.status;
        clarificationQuestion = ds.clarification_question;

        // Sync node state from dispatch state for upstream projection.
        if (ds.status === 'done' && node.state !== 'done') {
          await updateNodeState(adapter, node.node_id, 'done');
          node.state = 'done';
        } else if (ds.status === 'needs_clarification' && node.state !== 'needs_clarification') {
          const blocker = {
            kind: 'blocked_on_chris' as const,
            source_node_id: node.node_id,
            dispatch_id: node.dispatch_id ?? undefined,
            question: clarificationQuestion ?? undefined,
          };
          await updateNodeState(adapter, node.node_id, 'needs_clarification', blocker);
          node.state = 'needs_clarification';
        } else if (ds.status === 'in_flight' && node.state !== 'in_flight' && node.state !== 'needs_clarification') {
          await updateNodeState(adapter, node.node_id, 'in_flight');
          node.state = 'in_flight';
        } else if (ds.status === 'failed' && node.state !== 'failed') {
          await updateNodeState(adapter, node.node_id, 'failed');
          node.state = 'failed';
        } else if (ds.status === 'cancelled' && node.state !== 'cancelled') {
          await updateNodeState(adapter, node.node_id, 'cancelled');
          node.state = 'cancelled';
        } else if (ds.status === 'queued' && node.state === 'ready') {
          await updateNodeState(adapter, node.node_id, 'queued');
          node.state = 'queued';
        }
      }
    }

    upstreamInfoMap.set(node.node_id, {
      node,
      dispatch_status: dispatchStatus,
      clarification_question: clarificationQuestion,
    });
  }

  const result: EvaluateGraphResult = {
    evaluated: 0,
    transitioned: 0,
    decisions: [],
    graph_status: graph.status,
  };

  // Evaluate nodes that are in pending_dependencies or ready state.
  for (const node of nodes) {
    if (node.state !== 'pending_dependencies' && node.state !== 'ready') continue;

    const incoming = await getIncomingEdges(adapter, node.node_id);
    const readiness = evaluateNodeReadiness(node, incoming, upstreamInfoMap);

    // Build input revision from upstream states.
    const upstreamStates = incoming.map(e => {
      const info = upstreamInfoMap.get(e.from_node_id);
      return `${e.from_node_id}:${info?.node.state ?? 'unknown'}:${info?.dispatch_status ?? 'unknown'}`;
    });
    const inputRevision = computeInputRevision(node.node_id, upstreamStates);
    const idempotencyKey = `${graphId}:${node.node_id}:${inputRevision}`;

    let decisionResult: string;
    let reason: string;

    if (readiness.status === 'ready') {
      decisionResult = 'queued';
      reason = readiness.reason;

      // Transition node to queued.
      const { appended } = await appendDecision(
        adapter, graphId, node.node_id, 'queued', reason, inputRevision, idempotencyKey,
      );
      if (appended) {
        await updateNodeState(adapter, node.node_id, 'queued');
        result.transitioned++;
      }
    } else if (readiness.status === 'blocked') {
      decisionResult = 'blocked';
      reason = readiness.reason;

      await appendDecision(
        adapter, graphId, node.node_id, 'blocked', reason, inputRevision, idempotencyKey,
      );
      await updateNodeState(adapter, node.node_id, 'pending_dependencies', readiness.blocker);
    } else {
      decisionResult = 'not_ready';
      reason = readiness.reason;

      await appendDecision(
        adapter, graphId, node.node_id, 'not_ready', reason, inputRevision, idempotencyKey,
      );
    }

    result.evaluated++;
    result.decisions.push({ node_id: node.node_id, result: decisionResult, reason });
  }

  // Update graph-level status.
  const refreshedNodes = await getNodes(adapter, graphId);
  const graphStatus = computeGraphStatus(refreshedNodes);
  if (graphStatus !== graph.status) {
    await updateGraphStatus(adapter, graphId, graphStatus);
    result.graph_status = graphStatus;
  }

  return result;
}

function computeGraphStatus(nodes: NodeRow[]): GraphStatus {
  if (nodes.length === 0) return 'draft';

  const states = nodes.map(n => n.state);
  const allDone = states.every(s => s === 'done' || s === 'skipped');
  const anyFailed = states.some(s => s === 'failed');
  const anyCancelled = states.every(s => s === 'cancelled' || s === 'skipped');
  const anyBlocked = states.some(s => s === 'pending_dependencies' || s === 'needs_clarification');
  const anyRunning = states.some(s => s === 'queued' || s === 'in_flight' || s === 'ready');

  if (allDone) return 'complete';
  if (anyFailed) return 'failed';
  if (anyCancelled) return 'cancelled';
  if (anyBlocked && !anyRunning) return 'blocked';
  return 'active';
}
