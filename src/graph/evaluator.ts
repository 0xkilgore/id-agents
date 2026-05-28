// P1 Dependency-Graph Orchestrator — pure dependency evaluator.
// No side effects. Takes node + upstream states, returns readiness.

import type {
  NodeRow, EdgeRow, DependencyPredicate,
  ReadinessResult, BlockerSummary, NodeState,
} from './types.js';

// Dispatch states considered terminal success.
const SUCCESS_STATES: ReadonlySet<string> = new Set(['done']);

// Dispatch states considered terminal failure.
const FAILURE_STATES: ReadonlySet<string> = new Set(['failed', 'cancelled']);

interface UpstreamInfo {
  node: NodeRow;
  dispatch_status: string | null; // from dispatch_scheduler_queue
  clarification_question: string | null;
}

/**
 * Pure evaluator: given a node and its upstream dependencies,
 * determine whether the node is ready to be queued.
 */
export function evaluateNodeReadiness(
  node: NodeRow,
  incomingEdges: EdgeRow[],
  upstreamMap: Map<string, UpstreamInfo>,
): ReadinessResult {
  // Nodes already past pending_dependencies don't need re-evaluation.
  const terminalForEval: NodeState[] = ['queued', 'in_flight', 'done', 'failed', 'cancelled', 'skipped'];
  if (terminalForEval.includes(node.state)) {
    return { status: 'not_ready', reason: `Node already in state ${node.state}; no transition needed.` };
  }

  // If node has no incoming edges, it's ready.
  if (incomingEdges.length === 0) {
    return { status: 'ready', reason: 'No dependencies; node is ready.' };
  }

  // Evaluate each predicate.
  for (const edge of incomingEdges) {
    const predicate: DependencyPredicate = JSON.parse(edge.predicate_json);
    const result = evaluatePredicate(predicate, upstreamMap);
    if (result.status !== 'ready') return result;
  }

  return { status: 'ready', reason: 'All dependency predicates satisfied.' };
}

function evaluatePredicate(
  predicate: DependencyPredicate,
  upstreamMap: Map<string, UpstreamInfo>,
): ReadinessResult {
  switch (predicate.type) {
    case 'dispatch_success':
      return evaluateDispatchSuccess(predicate.upstream_node_id, upstreamMap);

    case 'dispatch_terminal':
      return evaluateDispatchTerminal(predicate.upstream_node_id, predicate.terminal_states, upstreamMap);

    case 'dispatch_verification_passed':
      // Future slice — type exists, evaluation not implemented.
      return { status: 'not_ready', reason: `Predicate dispatch_verification_passed not yet implemented.` };

    case 'task_done':
      // Future slice — type exists, evaluation not implemented.
      return { status: 'not_ready', reason: `Predicate task_done not yet implemented.` };

    case 'operator_approval':
      // Placeholder — not wired to UI yet.
      return { status: 'not_ready', reason: `Predicate operator_approval not yet implemented (approval_id: ${predicate.approval_id}).` };
  }
}

function evaluateDispatchSuccess(
  upstreamNodeId: string,
  upstreamMap: Map<string, UpstreamInfo>,
): ReadinessResult {
  const upstream = upstreamMap.get(upstreamNodeId);
  if (!upstream) {
    return { status: 'not_ready', reason: `Upstream node ${upstreamNodeId} not found.` };
  }

  const nodeState = upstream.node.state;
  const dispatchStatus = upstream.dispatch_status;

  // Success: upstream node is done.
  if (nodeState === 'done' || dispatchStatus === 'done') {
    return { status: 'ready', reason: `Upstream ${upstreamNodeId} completed successfully.` };
  }

  // Blocked on Chris: upstream needs clarification.
  if (nodeState === 'needs_clarification' || dispatchStatus === 'needs_clarification') {
    const blocker: BlockerSummary = {
      kind: 'blocked_on_chris',
      source_node_id: upstreamNodeId,
      dispatch_id: upstream.node.dispatch_id ?? undefined,
      question: upstream.clarification_question ?? undefined,
    };
    return { status: 'blocked', reason: `Upstream ${upstreamNodeId} needs clarification.`, blocker };
  }

  // Blocked on failure.
  if (FAILURE_STATES.has(nodeState) || (dispatchStatus && FAILURE_STATES.has(dispatchStatus))) {
    const blocker: BlockerSummary = {
      kind: 'blocked_on_failure',
      source_node_id: upstreamNodeId,
      dispatch_id: upstream.node.dispatch_id ?? undefined,
    };
    return { status: 'blocked', reason: `Upstream ${upstreamNodeId} ${nodeState || dispatchStatus} — dependency requires success.`, blocker };
  }

  // Still in progress.
  return { status: 'not_ready', reason: `Upstream ${upstreamNodeId} still in progress (state: ${nodeState}, dispatch: ${dispatchStatus ?? 'n/a'}).` };
}

function evaluateDispatchTerminal(
  upstreamNodeId: string,
  terminalStates: string[],
  upstreamMap: Map<string, UpstreamInfo>,
): ReadinessResult {
  const upstream = upstreamMap.get(upstreamNodeId);
  if (!upstream) {
    return { status: 'not_ready', reason: `Upstream node ${upstreamNodeId} not found.` };
  }

  const nodeState = upstream.node.state;
  const dispatchStatus = upstream.dispatch_status;
  const allowedSet = new Set(terminalStates);

  // Check if the upstream is in one of the allowed terminal states.
  if (allowedSet.has(nodeState) || (dispatchStatus && allowedSet.has(dispatchStatus))) {
    return { status: 'ready', reason: `Upstream ${upstreamNodeId} reached allowed terminal state.` };
  }

  // Blocked on Chris: upstream needs clarification.
  if (nodeState === 'needs_clarification' || dispatchStatus === 'needs_clarification') {
    const blocker: BlockerSummary = {
      kind: 'blocked_on_chris',
      source_node_id: upstreamNodeId,
      dispatch_id: upstream.node.dispatch_id ?? undefined,
      question: upstream.clarification_question ?? undefined,
    };
    return { status: 'blocked', reason: `Upstream ${upstreamNodeId} needs clarification.`, blocker };
  }

  // Check if upstream is terminally failed but not in the allowed list.
  if (FAILURE_STATES.has(nodeState) && !allowedSet.has(nodeState)) {
    const blocker: BlockerSummary = {
      kind: 'blocked_on_failure',
      source_node_id: upstreamNodeId,
      dispatch_id: upstream.node.dispatch_id ?? undefined,
    };
    return { status: 'blocked', reason: `Upstream ${upstreamNodeId} ${nodeState} — not in allowed terminal states [${terminalStates.join(', ')}].`, blocker };
  }

  return { status: 'not_ready', reason: `Upstream ${upstreamNodeId} not yet terminal (state: ${nodeState}, dispatch: ${dispatchStatus ?? 'n/a'}).` };
}
