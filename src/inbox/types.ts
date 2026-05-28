// Inbox 2.0 — shared type definitions (P2 first-build, read/proposal slice).

// ── Operator-facing state (projection over InboxItem + shadow docs) ──

export type OperatorState =
  | 'new'
  | 'needs_route'
  | 'waiting_on_agent'
  | 'output_ready'
  | 'snoozed'
  | 'checked_off'
  | 'filed'
  | 'errored';

export type SourceKind =
  | 'email'
  | 'telegram'
  | 'voice_note'
  | 'forwarded_instruction'
  | 'manual_capture'
  | 'api';

export type ParityStatus = 'ok' | 'fallback' | 'drift';
export type ProjectionSource = 'index' | 'reactor';

// ── inbox_items row ──

export interface InboxItemRow {
  inbox_phid: string;
  operator_state: OperatorState;
  source_kind: SourceKind;
  source_external_id: string | null;
  source_text: string | null;
  source_excerpt: string | null;
  source_subject: string | null;
  source_from: string | null;
  classification_label: string | null;
  classification_confidence: number | null;
  classification_classifier: string | null;
  classification_rationale: string | null;
  project_hint: string | null;
  agent_hint: string | null;
  origin_ref: string | null;
  received_at: string;
  triaged_at: string | null;
  resolved_at: string | null;
  snoozed_until: string | null;
  checked_off_at: string | null;
  checked_off_reason: string | null;
  source: ProjectionSource;
  parity_status: ParityStatus;
  generated_at: string;
  projection_version: number;
  legacy_inbox_md_line: string | null;
  legacy_shadow_path: string | null;
}

// ── inbox_links row ──

export type LinkKind = 'task' | 'dispatch' | 'artifact' | 'filed' | 'legacy';

export interface InboxLinkRow {
  id: number;
  inbox_phid: string;
  kind: LinkKind;
  target: string;
}

// ── inbox_audit_events row ──

export interface InboxAuditEvent {
  id: number;
  inbox_phid: string;
  op_id: string;
  op_type: string;
  actor_id: string;
  ts: string;
  reason: string | null;
  summary: string;
  input_revision: string | null;
  links_json: string | null; // JSON string of {kind, target}[]
}

// ── inbox_policy_violations row ──

export interface InboxPolicyViolation {
  id: number;
  inbox_phid: string;
  kind: string;
  message: string;
  severity: 'info' | 'warning' | 'error';
  detected_at: string;
  resolved_at: string | null;
  meta_json: string | null;
}

// ── inbox_routing_decisions row ──

export interface InboxRoutingDecision {
  id: number;
  inbox_phid: string;
  rule_id: string | null;
  action_type: string;
  action_target: string | null;
  actor_id: string;
  reason: string;
  input_revision: string;
  is_primary: boolean;
  decided_at: string;
}

// ── Classify op shape (from CTO plan) ──

export interface ClassifyInboxItemOp {
  type: 'CLASSIFY_INBOX_ITEM';
  inbox_phid: string;
  actor: { id: string; kind: 'human' | 'agent' | 'system' };
  ts: string;
  label: ClassificationLabel;
  confidence: number | null;
  classifier: 'rule' | 'llm' | 'human' | 'import';
  rule_id?: string | null;
  rationale: string;
  projected_project?: string | null;
  projected_agent?: string | null;
  projected_action?: string | null;
  source_op_id?: string | null;
  input_revision: string;
  idempotency_key: string;
}

export type ClassificationLabel =
  | 'action'
  | 'reference'
  | 'idea'
  | 'crm_ref'
  | 'dispatch'
  | 'approval_needed'
  | 'duplicate'
  | 'discard';

// ── Routing rule shape (from CTO plan) ──

export interface InboxRoutingRule {
  rule_id: string;
  enabled: boolean;
  priority: number;
  match: {
    source_kind?: SourceKind[];
    from_address_contains?: string[];
    title_contains?: string[];
    body_contains?: string[];
    tags_any?: string[];
    classification?: ClassificationLabel[];
    project_hint?: string[];
    agent_hint?: string[];
  };
  action:
    | { type: 'propose_project'; project_id: string }
    | { type: 'propose_agent'; agent_id: string; project_id?: string }
    | { type: 'propose_file'; filed_ref: { kind: string; label: string; target_phid?: string | null; legacy_path?: string | null } }
    | { type: 'requires_approval'; reason: string }
    | { type: 'propose_discard'; reason: string };
  explanation: string;
}

export interface RouteDecision {
  rule_id: string;
  action: InboxRoutingRule['action'];
  explanation: string;
  is_primary: boolean;
}

// ── Propose route op ──

export interface ProposeRouteOp {
  type: 'PROPOSE_ROUTE';
  inbox_phid: string;
  actor: { id: string; kind: 'human' | 'agent' | 'system' };
  ts: string;
  rule_id: string | null;
  action_type: string;
  action_target: string | null;
  reason: string;
  input_revision: string;
  is_primary: boolean;
  idempotency_key: string;
}

// ── Typed action ops ──

export interface SnoozeOp {
  type: 'SNOOZE';
  inbox_phid: string;
  actor_id: string;
  ts: string;
  until: string;
  reason?: string | null;
}

export interface CheckOffOp {
  type: 'CHECK_OFF';
  inbox_phid: string;
  actor_id: string;
  ts: string;
  reason: string;
}

export interface AuditNoteOp {
  type: 'AUDIT_NOTE';
  inbox_phid: string;
  actor_id: string;
  ts: string;
  note: string;
}

// ── API response shapes ──

export interface InboxSummaryResponse {
  schema_version: 'inbox.summary.v1';
  generated_at: string;
  last_24h_received: number;
  unresolved: number;
  waiting_on_agent: number;
  output_ready: number;
  approval_needed: number;
  snoozed: number;
  errored: number;
  freshness: {
    oldest_unresolved_at: string | null;
    newest_received_at: string | null;
    projection_version: number;
  };
}

export interface InboxItemDetail {
  item: InboxItemRow;
  links: InboxLinkRow[];
  audit_events: InboxAuditEvent[];
  policy_violations: InboxPolicyViolation[];
  routing_decisions: InboxRoutingDecision[];
}
