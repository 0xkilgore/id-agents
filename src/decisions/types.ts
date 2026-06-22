// Kapelle decisions queue — types.
//
// Cto scope: 2026-06-09-decision-queue-structured-status-scope.md
// Contract:  2026-06-09-kapelle-op1-p3-manager-contract-spec.md
//
// `status` is the single canonical signal for open/resolved/superseded/
// declined; readers never infer it from prose, headings, tail slices, or
// summary tables. The CHECK constraint on the column enforces this at the
// storage layer.

export type DecisionStatus = "open" | "resolved" | "superseded" | "declined";

export type DecisionPriority = "critical" | "high" | "normal" | "low";

export interface DecisionRow {
  decision_id: string;
  display_id: string | null;
  title: string;
  question: string;
  context_excerpt: string | null;
  recommendation_json: string | null;
  options_json: string | null;
  status: DecisionStatus;
  estimated_seconds: number | null;
  priority: DecisionPriority;
  owner: string;
  requested_by: string | null;
  created_at: string;
  updated_at: string;
  resolved_at: string | null;
  resolved_by: string | null;
  resolution_note: string | null;
  selected_option_id: string | null;
  source_refs_json: string;
  provenance_json: string;
}

export interface DecisionEventRow {
  event_id: string;
  decision_id: string;
  event_type: string;
  actor: string;
  created_at: string;
  payload_json: string;
}

// OP-1 contract DTO shape — exposed by GET /decisions/queue.

export interface DecisionsQueueResponse {
  schema_version: "decisions.queue.v1";
  generated_at: string;
  source: OpsProjectionSource;
  freshness: OpsProjectionFreshness;
  provenance: OpsProjectionProvenance;
  filters: {
    status: DecisionStatus;
    max_estimated_seconds: number;
    limit: number;
  };
  counts: {
    open: number;
    visible: number;
    stale: number;
    blocked: number;
  };
  items: DecisionQueueItem[];
  warnings: OpsProjectionWarning[];
}

export interface OpsProjectionSource {
  system: "manager";
  projection: "decisions_queue" | "decision_acted_upon" | "decision_actions";
  source_type:
    | "manager_decisions_table"
    | "maestra_decisions_markdown"
    | "hybrid_projection"
    | "fixture_fallback";
  source_refs: SourceRef[];
}

export interface OpsProjectionFreshness {
  status: "fresh" | "stale" | "unavailable" | "unknown";
  generated_at: string;
  source_updated_at: string | null;
  projection_updated_at: string | null;
  max_age_seconds: number;
}

export interface OpsProjectionProvenance {
  producer: "maestra" | "manager" | "migration" | "unknown";
  producer_task_name: string | null;
  producer_dispatch_id: string | null;
  parser_version: string;
  source_hash: string | null;
  source_paths: string[];
}

export interface SourceRef {
  kind: "artifact" | "decision_doc" | "task" | "dispatch" | "risk" | "manual";
  stable_id: string;
  display_id: string | null;
  title: string | null;
  href: string | null;
}

export interface OpsProjectionWarning {
  code: string;
  severity: "info" | "warning" | "error";
  message: string;
  source_ref: SourceRef | null;
}

export interface DecisionQueueItem {
  decision_id: string;
  display_id: string;
  title: string;
  question: string;
  context_excerpt: string;
  recommendation: {
    option_id: string;
    label: string;
    rationale: string;
    confidence: "high" | "medium" | "low";
  };
  options: DecisionOption[];
  status: "open" | "blocked";
  estimated_seconds: number;
  priority: DecisionPriority;
  owner: "chris";
  requested_by: string | null;
  created_at: string;
  updated_at: string;
  stale_after: string | null;
  source_refs: SourceRef[];
  provenance: {
    source_path: string | null;
    source_anchor: string | null;
    source_hash: string | null;
    originating_artifact_id: string | null;
    originating_task_name: string | null;
    originating_dispatch_id: string | null;
  };
  decide: {
    method: "POST";
    path: string;
    one_tap_option_id: string;
    idempotency_key_seed: string;
    requires_note: boolean;
    confirmation: "none" | "confirm";
  };
}

export interface DecisionOption {
  option_id: string;
  label: string;
  value: string;
  recommended: boolean;
  effect_summary: string;
}

export interface DecideDecisionInput {
  actor: "human:chris";
  selected_option_id: string;
  note_markdown?: string;
  idempotency_key: string;
  source_panel?: "ops_decisions_queue";
}

export interface DecideDecisionResponse {
  ok: true;
  schema_version: "decisions.decide.v1";
  decision_id: string;
  operation_id: string;
  status: "decided";
  selected_option_id: string;
  decided_at: string;
  idempotent_replay: boolean;
}

// ── P5: acted-upon read model + typed decision actions ─────────────────
// Contract: cto/output/2026-06-19-kapelle-pdf-ux-backend-contracts.md §P5.
// The acted-upon state is DERIVED from the decision row status + the
// append-only decision_events log (never inferred from prose).

export interface ActorRef {
  kind: "human" | "agent" | "system" | "unknown";
  id: string;
  /** Canonical reference string, e.g. "human:chris". */
  ref: string;
  label: string | null;
}

export type DecisionActedUponState =
  | "not_acted"
  | "decided"
  | "task_created"
  | "dispatch_created"
  | "reported_to_manager"
  | "superseded"
  | "blocked";

export type DecisionOperationType =
  | "DECISION_DECIDE"
  | "DECISION_TASK_CREATED"
  | "DECISION_DISPATCH_CREATED"
  | "DECISION_REPORT_TO_MANAGER"
  | "DECISION_SUPERSEDED";

export interface DecisionOperation {
  operation_id: string;
  operation_type: DecisionOperationType;
  created_at: string;
  actor: ActorRef;
  target_refs: SourceRef[];
  idempotency_key: string;
}

export interface DecisionActedUponResponse {
  ok: true;
  schema_version: "decision.acted-upon.v1";
  generated_at: string;
  decision_id: string;
  artifact_id: string | null;
  state: DecisionActedUponState;
  selected_option_id: string | null;
  acted_at: string | null;
  actor: ActorRef | null;
  operations: DecisionOperation[];
  source: OpsProjectionSource;
  freshness: OpsProjectionFreshness;
  provenance: OpsProjectionProvenance;
  warnings: OpsProjectionWarning[];
}

export type DecisionActionType =
  | "create_manager_task"
  | "create_dispatch"
  | "report_to_manager";

export interface DecisionActionInput {
  action: DecisionActionType;
  actor: "human:chris";
  note_markdown?: string;
  idempotency_key: string;
  source_panel?: "pdf_decision_row" | "ops_decisions_queue";
  artifact_id?: string;
}

export interface DecisionActionResponse {
  ok: true;
  schema_version: "decision.action.v1";
  decision_id: string;
  operation: DecisionOperation;
  idempotent_replay: boolean;
}

export interface DecisionActionsListItem extends DecisionOperation {
  decision_id: string;
}

export interface DecisionActionsListResponse {
  ok: true;
  schema_version: "decision.actions.v1";
  generated_at: string;
  artifact_id: string;
  limit: number;
  actions: DecisionActionsListItem[];
  source: OpsProjectionSource;
  freshness: OpsProjectionFreshness;
  provenance: OpsProjectionProvenance;
  warnings: OpsProjectionWarning[];
}
