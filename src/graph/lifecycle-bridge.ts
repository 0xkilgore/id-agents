// N1.3 Graph Lifecycle Bridge — best-effort graph re-evaluation when
// linked dispatches change state. Non-blocking: evaluation errors are
// logged but never propagate to the lifecycle endpoint caller.

import type { DbAdapter } from '../db/db-adapter.js';
import { getGraphIdsByDispatchId } from './storage.js';
import { evaluateGraph, type EvaluateGraphResult } from './runner.js';

export type GraphEvaluationTrigger =
  | 'dispatch_done'
  | 'dispatch_failed'
  | 'dispatch_cancelled'
  | 'dispatch_needs_clarification'
  | 'dispatch_resumed'
  | 'dispatch_resume_delivery_failed';

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
