// Supervisor v0 — Watch-and-Alert types.
// Read-only observation layer. No intervention authority.

export type AlertStatus = 'open' | 'updated' | 'resolved';

export type AlertKind =
  | 'stuck_query'
  | 'agent_down'
  | 'build_failure'
  | 'promotion_failure'
  | 'worktree_hygiene'
  | 'news_repeated_error'
  | 'protocol_gap'
  | 'disk_warn'
  | 'build_behind_origin'
  // Harness-resilience (Spec: 2026-05-29-harness-resilience-spec.md):
  // raised when a dispatch fails with one of the structured model/API/harness
  // failure kinds — distinguishes infra reliability from semantic build/test
  // failures so it can fire on non-build dispatches too.
  | 'model_api_error';

export type AlertSeverity = 'info' | 'warning' | 'critical';

export type AlertConfidence = 'low' | 'medium' | 'high';

export type EvidenceSource =
  | 'dispatch'
  | 'metrics'
  | 'graphs'
  | 'agent_done'
  | 'agent_needs_input'
  | 'news'
  | 'system_health';

export interface EvidenceEntry {
  source: EvidenceSource;
  ref?: string;
  observed_at: string;
  detail: string;
}

export interface ConfigSnapshot {
  poll_interval_seconds: number;
  stuck_query_seconds: number;
  no_progress_seconds: number;
  agent_down_seconds: number;
  news_error_window_seconds: number;
  news_error_repeat_count: number;
}

export interface SupervisorAlertRecord {
  alert_id: string;
  dedupe_key: string;
  status: AlertStatus;
  kind: AlertKind;
  severity: AlertSeverity;
  confidence: AlertConfidence;
  detected_at: string;
  updated_at: string;
  resolved_at?: string;
  agent_id?: string;
  query_id?: string;
  dispatch_id?: string;
  graph_id?: string;
  task_name?: string;
  title: string;
  summary: string;
  evidence: EvidenceEntry[];
  counters?: Record<string, number>;
  config_snapshot: ConfigSnapshot;
}

export interface SupervisorAlertState {
  alert_id: string;
  dedupe_key: string;
  kind: AlertKind;
  status: 'open' | 'resolved';
  severity: AlertSeverity;
  first_detected_at: string;
  last_seen_at: string;
  resolved_at?: string;
  last_record_json: SupervisorAlertRecord;
  occurrence_count: number;
}

// Source snapshot types — normalized views of manager state per poll tick.

export interface ActiveDispatch {
  dispatch_phid: string;
  query_id: string;
  to_agent: string;
  status: string;
  started_at: string | null;
  updated_at: string;
  subject: string;
  promote: boolean;
  promotion_input: { repo: string; branch: string; base: string; remote: string; promotion_skip_reason?: string | null } | null;
}

export interface TerminalDispatch {
  dispatch_phid: string;
  query_id: string;
  to_agent: string;
  status: string;
  completed_at: string | null;
  subject: string;
  failure_kind: string | null;
  failure_detail: string | null;
  promote: boolean;
  promotion_result: unknown | null;
  promotion_input: { repo: string; branch: string; base: string; remote: string; promotion_skip_reason?: string | null } | null;
}

export interface AgentStatus {
  agent_id: string;
  last_seen_at: string | null;
  active_dispatches: number;
  status_state: string;
}

export interface NewsEntry {
  id: string;
  agent_id: string;
  ts: string;
  message: string;
}

export interface SourceSnapshot {
  collected_at: string;
  active_dispatches: ActiveDispatch[];
  terminal_dispatches: TerminalDispatch[];
  watched_agents: AgentStatus[];
  recent_news: NewsEntry[];
  available_sources: string[];
  missing_sources: string[];
}

// Rule finding — output of a single rule evaluation.
export interface RuleFinding {
  dedupe_key: string;
  kind: AlertKind;
  severity: AlertSeverity;
  confidence: AlertConfidence;
  title: string;
  summary: string;
  evidence: EvidenceEntry[];
  counters?: Record<string, number>;
  agent_id?: string;
  query_id?: string;
  dispatch_id?: string;
  graph_id?: string;
  task_name?: string;
}
