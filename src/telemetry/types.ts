// SPDX-License-Identifier: MIT
// P6 Agent Performance Telemetry — shared types.

export type Confidence = 'canonical' | 'derived' | 'partial' | 'missing';
export type SourceName = 'dispatch_ops' | 'usage_meter_v2' | 'artifact_ops' | 'stuck_detector' | 'review_signals' | 'schedule_ops';
export type WindowKind = 'hour' | 'day' | 'week';
export type SignalSeverity = 'info' | 'warning' | 'critical';
export type SignalKind =
  | 'dispatch_stuck'
  | 'silent_failure'
  | 'needs_clarification'
  | 'resume_failed'
  | 'high_burn_no_output'
  | 'rate_limit_bounce'
  | 'missing_agent_done'
  | 'stale_schedule'
  | 'cto_correction';

export interface TelemetryEvent {
  event_id: string;
  kind: string;
  agent_id: string;
  dispatch_id: string | null;
  query_id: string | null;
  ts: number; // epoch ms
  source: SourceName;
  confidence: Confidence;
  payload_json: string;
  idempotency_key: string;
}

export interface PerformanceSnapshot {
  agent_id: string;
  window_kind: WindowKind;
  window_start: string; // ISO
  dispatches_started: number;
  dispatches_completed: number;
  dispatches_failed: number;
  dispatches_stuck: number;
  needs_clarification_count: number;
  artifacts_created: number;
  weighted_tokens: number;
  high_burn_no_output_events: number;
  cto_corrections_count: number;
  operator_revision_requests: number;
  source_coverage_json: string;
  computed_at: string; // ISO
}

export interface AgentSignal {
  id: string;
  kind: SignalKind;
  severity: SignalSeverity;
  agent_id: string;
  subject: string | null;
  title: string;
  first_seen_at: string;
  last_seen_at: string;
  source_refs_json: string;
  confidence: Confidence;
  resolved_at: string | null;
}

export interface SourceCoverageEntry {
  source: SourceName;
  state: 'present' | 'partial' | 'missing';
  confidence: Confidence;
}

export interface MetricsSummaryResponse {
  schema_version: 'agent_metrics.summary.v1';
  generated_at: string;
  window: { kind: WindowKind; start: string; end: string; timezone: string };
  totals: {
    agents_seen: number;
    dispatches_started: number;
    dispatches_completed: number;
    dispatches_failed: number;
    dispatches_stuck: number;
    needs_clarification: number;
    resume_delivery_failed: number;
    artifacts_created: number;
    weighted_tokens: number;
    high_burn_no_output_agents: number;
  };
  signals: Array<{
    id: string;
    severity: SignalSeverity;
    kind: SignalKind;
    agent_id: string;
    title: string;
    source_refs: string[];
  }>;
  source_coverage: SourceCoverageEntry[];
}

export interface AgentMetricsRow {
  agent_id: string;
  display_name: string;
  role: string;
  runtime: string;
  status: {
    state: string;
    last_seen_at: string | null;
    active_dispatches: number;
    blocked_dispatches: number;
    stuck_dispatches: number;
  };
  window: {
    kind: WindowKind;
    dispatches_started: number;
    dispatches_completed: number;
    dispatch_success_rate: number;
    artifacts_created: number;
    needs_clarification_count: number;
    failed_dispatches: number;
    weighted_tokens: number;
    tokens_per_completed_dispatch: number;
    high_burn_no_output_events: number;
    stuck_loop_signals: number;
    cto_corrections_count: number;
    operator_revision_requests: number;
  };
  top_signals: Array<{ id: string; kind: string; severity: string; title: string }>;
  source_coverage: Record<SourceName, Confidence>;
}
