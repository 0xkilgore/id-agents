// P1 Dependency-Graph Orchestrator — shared types.

export type GraphStatus = 'draft' | 'active' | 'blocked' | 'complete' | 'failed' | 'cancelled';

export type NodeState =
  | 'pending_dependencies'
  | 'ready'
  | 'queued'
  | 'in_flight'
  | 'needs_clarification'
  | 'done'
  | 'failed'
  | 'cancelled'
  | 'skipped';

export type NodeKind = 'dispatch' | 'task' | 'approval';

export type EdgeRelation = 'waits_on' | 'blocker_of';

export type DependencyPredicate =
  | { type: 'dispatch_success'; upstream_node_id: string }
  | { type: 'dispatch_terminal'; upstream_node_id: string; terminal_states: string[] }
  | { type: 'dispatch_verification_passed'; upstream_node_id: string }
  | { type: 'task_done'; task_phid: string }
  | { type: 'operator_approval'; approval_id: string };

export type BlockerKind = 'blocked_on_chris' | 'blocked_on_agent' | 'blocked_on_failure';

export interface BlockerSummary {
  kind: BlockerKind;
  source_node_id?: string;
  dispatch_id?: string;
  task_phid?: string;
  question?: string;
  age_seconds?: number;
}

export type DecisionResult = 'not_ready' | 'ready' | 'queued' | 'blocked' | 'skipped';

// ── Row types (DB) ──

export interface GraphRow {
  graph_id: string;
  title: string;
  status: GraphStatus;
  version: number;
  created_by_actor_json: string;
  created_at: string;
}

export interface NodeRow {
  node_id: string;
  graph_id: string;
  title: string;
  kind: NodeKind;
  dispatch_id: string | null;
  task_phid: string | null;
  state: NodeState;
  blocker_summary_json: string | null;
}

export interface EdgeRow {
  edge_id: string;
  graph_id: string;
  from_node_id: string;
  to_node_id: string;
  relation: EdgeRelation;
  predicate_json: string;
}

export interface DecisionRow {
  decision_id: string;
  graph_id: string;
  node_id: string;
  idempotency_key: string;
  result: DecisionResult;
  reason: string;
  input_revision: string;
  created_at: string;
}

// ── API response types ──

export interface GraphListItem {
  graph_id: string;
  title: string;
  status: GraphStatus;
  node_count: number;
  blocked_count: number;
  created_at: string;
}

export interface GraphDetail {
  graph: GraphRow;
  nodes: Array<NodeRow & {
    waits_on: DependencyPredicate[];
    blocker_of: string[];
    blocker_summary: BlockerSummary | null;
  }>;
  edges: Array<EdgeRow & { predicate: DependencyPredicate }>;
  decisions: DecisionRow[];
}

// ── Evaluator types ──

export type ReadinessResult =
  | { status: 'not_ready'; reason: string }
  | { status: 'ready'; reason: string }
  | { status: 'blocked'; reason: string; blocker: BlockerSummary };

// ── Dispatch-Plan API types (N1.2) ──

export interface DispatchPlanNodeInput {
  client_node_id: string;
  title: string;
  to_agent: string;
  message: string;
  subject?: string;
  priority?: number;
  repo?: string;
  branch?: string;
  base?: string;
  remote?: string;
  promote?: boolean;
  promotion_skip_reason?: string;
  waits_on?: Array<{ client_node_id: string; predicate: 'dispatch_success' }>;
}

export interface DispatchPlanRequest {
  title: string;
  created_by: { kind: string; id: string; source?: string };
  idempotency_key: string;
  nodes: DispatchPlanNodeInput[];
}

export interface DispatchPlanNodeResult {
  client_node_id: string;
  node_id: string;
  dispatch_id: string;
  query_id: string;
  state: NodeState;
  waits_on?: string[];
}

export interface DispatchPlanResponse {
  schema_version: 'dispatch_graph.dispatch_plan.v1';
  graph_id: string;
  status: GraphStatus;
  nodes: DispatchPlanNodeResult[];
  evaluation: {
    evaluated: number;
    transitioned: number;
    graph_status: string;
  };
  partial?: boolean;
}

export interface EnqueueFn {
  (input: {
    to_agent: string;
    from_actor: string;
    message: string;
    subject?: string;
    priority?: number;
    repo?: string;
    branch?: string;
    base?: string;
    remote?: string;
    promote?: boolean;
    promotion_skip_reason?: string;
  }): Promise<{ query_id: string; dispatch_phid: string; status: 'queued' }>;
}
