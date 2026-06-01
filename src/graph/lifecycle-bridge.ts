// N1.3 + N1.4 Graph Lifecycle Bridge — best-effort graph re-evaluation
// when linked dispatches OR tasks change state. Non-blocking: evaluation
// errors are logged but never propagate to the lifecycle endpoint caller.

import type { DbAdapter } from '../db/db-adapter.js';
import { getGraphIdsByDispatchId, getGraphIdsByTaskId } from './storage.js';
import { evaluateGraph, type EvaluateGraphResult } from './runner.js';

export type GraphEvaluationTrigger =
  | 'dispatch_done'
  | 'dispatch_failed'
  | 'dispatch_cancelled'
  | 'dispatch_needs_clarification'
  | 'dispatch_resumed'
  | 'dispatch_resume_delivery_failed';

// N1.4: triggers from the task lifecycle. Today: only task completion.
// Tasks have no failed/cancelled terminal state in this slice.
export type GraphTaskEvaluationTrigger = 'task_done';

export interface GraphEvaluationLogger {
  warn(event: string, data: Record<string, unknown>): void;
  info(event: string, data: Record<string, unknown>): void;
}

export interface GraphEvaluationSummary {
  dispatch_id: string;
  trigger: GraphEvaluationTrigger;
  graph_ids: string[];
  results: Array<{
    graph_id: string;
    evaluated: number;
    transitioned: number;
    graph_status: string;
    error?: string;
  }>;
}

const noopLogger: GraphEvaluationLogger = {
  warn() {},
  info() {},
};

/**
 * Look up graphs linked to a dispatch, evaluate each one.
 * Best-effort: per-graph failures are caught and logged, never thrown.
 */
export async function evaluateGraphsForDispatch(
  adapter: DbAdapter,
  dispatchId: string,
  trigger: GraphEvaluationTrigger,
  opts?: { logger?: GraphEvaluationLogger },
): Promise<GraphEvaluationSummary> {
  const logger = opts?.logger ?? noopLogger;

  let graphIds: string[];
  try {
    graphIds = await getGraphIdsByDispatchId(adapter, dispatchId);
  } catch (err) {
    logger.warn('graph_bridge_lookup_failed', {
      dispatch_id: dispatchId,
      trigger,
      error: err instanceof Error ? err.message : String(err),
    });
    return { dispatch_id: dispatchId, trigger, graph_ids: [], results: [] };
  }

  if (graphIds.length === 0) {
    return { dispatch_id: dispatchId, trigger, graph_ids: [], results: [] };
  }

  const summary: GraphEvaluationSummary = {
    dispatch_id: dispatchId,
    trigger,
    graph_ids: graphIds,
    results: [],
  };

  for (const graphId of graphIds) {
    try {
      const result: EvaluateGraphResult = await evaluateGraph(adapter, graphId);
      summary.results.push({
        graph_id: graphId,
        evaluated: result.evaluated,
        transitioned: result.transitioned,
        graph_status: result.graph_status,
      });
      if (result.transitioned > 0) {
        logger.info('graph_bridge_transitioned', {
          dispatch_id: dispatchId,
          trigger,
          graph_id: graphId,
          transitioned: result.transitioned,
          graph_status: result.graph_status,
        });
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      logger.warn('graph_bridge_evaluate_failed', {
        dispatch_id: dispatchId,
        trigger,
        graph_id: graphId,
        error: errorMsg,
      });
      summary.results.push({
        graph_id: graphId,
        evaluated: 0,
        transitioned: 0,
        graph_status: 'unknown',
        error: errorMsg,
      });
    }
  }

  return summary;
}

// ─────────────────────────────────────────────────────────────────────
// N1.4 — task lifecycle bridge
// ─────────────────────────────────────────────────────────────────────

export interface GraphTaskEvaluationSummary {
  task_id: string;
  trigger: GraphTaskEvaluationTrigger;
  graph_ids: string[];
  results: Array<{
    graph_id: string;
    evaluated: number;
    transitioned: number;
    graph_status: string;
    error?: string;
  }>;
}

/**
 * N1.4 — look up graphs linked to a task by `task_phid`, evaluate each
 * one. Mirrors `evaluateGraphsForDispatch`: best-effort, per-graph
 * failures are caught and logged, never thrown. Reuses `evaluateGraph`;
 * does NOT build a parallel evaluator for the task predicate.
 */
export async function evaluateGraphsForTask(
  adapter: DbAdapter,
  taskId: string,
  trigger: GraphTaskEvaluationTrigger,
  opts?: { logger?: GraphEvaluationLogger },
): Promise<GraphTaskEvaluationSummary> {
  const logger = opts?.logger ?? noopLogger;

  let graphIds: string[];
  try {
    graphIds = await getGraphIdsByTaskId(adapter, taskId);
  } catch (err) {
    logger.warn('graph_bridge_lookup_failed', {
      task_id: taskId,
      trigger,
      error: err instanceof Error ? err.message : String(err),
    });
    return { task_id: taskId, trigger, graph_ids: [], results: [] };
  }

  if (graphIds.length === 0) {
    return { task_id: taskId, trigger, graph_ids: [], results: [] };
  }

  const summary: GraphTaskEvaluationSummary = {
    task_id: taskId,
    trigger,
    graph_ids: graphIds,
    results: [],
  };

  for (const graphId of graphIds) {
    try {
      const result: EvaluateGraphResult = await evaluateGraph(adapter, graphId);
      summary.results.push({
        graph_id: graphId,
        evaluated: result.evaluated,
        transitioned: result.transitioned,
        graph_status: result.graph_status,
      });
      if (result.transitioned > 0) {
        logger.info('graph_bridge_transitioned', {
          task_id: taskId,
          trigger,
          graph_id: graphId,
          transitioned: result.transitioned,
          graph_status: result.graph_status,
        });
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      logger.warn('graph_bridge_evaluate_failed', {
        task_id: taskId,
        trigger,
        graph_id: graphId,
        error: errorMsg,
      });
      summary.results.push({
        graph_id: graphId,
        evaluated: 0,
        transitioned: 0,
        graph_status: 'unknown',
        error: errorMsg,
      });
    }
  }

  return summary;
}
