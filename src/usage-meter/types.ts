// Usage Meter + Controls — shared types.
// Spec: cto/output/2026-05-31-usage-meter-controls-spec.md
//
// Safety bar (Chris's overnight mandate, 2026-05-31): gating ships in
// WARN-ONLY / OBSERVE mode by default. The meter, budgets, rollups, and
// dashboard data are LIVE; actual HARD-GATING (refusing dispatch starts)
// is gated behind USAGE_GATE_ENFORCEMENT=enforce. When "warn" (default),
// the gate observes, logs, and reports — it NEVER blocks.

export type Provider = "anthropic" | "openai" | "other";

export type UsageGateEnforcement = "warn" | "enforce";

export type UsageGateState =
  | "normal"
  | "soft_warning"
  | "hard_paused"
  | "degraded";

export type UsageGateDecisionLabel =
  | "allow"
  | "warn_allow"
  | "pause_agent"
  | "pause_non_core"
  | "pause_unknown";

export interface UsageGateDecision {
  state: UsageGateState;
  decision: UsageGateDecisionLabel;
  reason: string;
  daily_pct: number | null;
  weekly_pct: number | null;
}

export interface UsageGateSnapshot {
  status: "ok" | "degraded";
  policy_version: string;
  global: UsageGateDecision;
  agents: Record<string, UsageGateDecision>;
  exempt_agents: string[];
  enforcement: UsageGateEnforcement;
  override_active: boolean;
  override_reason?: string;
  override_expires_at?: string;
  degraded_reason?: string;
  generated_at: string;
}

// ── Policy ───────────────────────────────────────────────────────────

export type AgentPriority = "core" | "worker" | "experimental";

export interface AgentBudget {
  daily_weighted_tokens: number;
  weekly_weighted_tokens: number;
  priority?: AgentPriority;
}

export interface GlobalBudget {
  daily_weighted_tokens: number;
  weekly_weighted_tokens: number;
  soft_threshold_pct: number;
  hard_threshold_pct: number;
}

export interface EmergencyOverride {
  enabled: boolean;
  reason: string | null;
  expires_at: string | null;
}

export interface UsageBudgetPolicy {
  schema_version: "usage-budget-policy.v1";
  timezone: string;
  provider: Provider;
  global: GlobalBudget;
  agents: Record<string, AgentBudget>;
  exempt_agents: string[];
  emergency_override: EmergencyOverride;
  /**
   * If true, telemetry stale → pause non-exempt new starts (in enforce mode).
   * Default true to match the spec's recommended safe behavior.
   */
  fail_closed_on_unknown?: boolean;
}

// ── Events / rollups ─────────────────────────────────────────────────

export type AttributionConfidence = "canonical" | "derived" | "partial";

export interface AgentUsageEvent {
  event_id: string;
  provider: Provider;
  agent_id: string;
  dispatch_id: string | null;
  query_id: string | null;
  session_id: string | null;
  model: string | null;
  /** Unix milliseconds. */
  ts: number;
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  raw_tokens: number;
  weighted_tokens: number;
  source: "claude_code_transcripts" | "manual_ingest" | "other";
  confidence: AttributionConfidence;
  idempotency_key: string;
}

export type WindowKind = "day" | "week";

export interface AgentUsageRollup {
  provider: Provider;
  agent_id: string;
  window_kind: WindowKind;
  /** ISO timestamp (with timezone), inclusive. */
  window_start: string;
  /** ISO timestamp (with timezone), exclusive. */
  window_end: string;
  raw_tokens: number;
  weighted_tokens: number;
  requests: number;
  models: string[];
  source_coverage: Record<string, number>;
  computed_at: string;
}

// ── Report contract (GET /usage) ─────────────────────────────────────

export interface UsageReportV2 {
  schema_version: "usage-meter-v2";
  generated_at: string;
  windows: {
    daily: {
      start: string;
      reset_at: string;
      time_until_reset_seconds: number;
    };
    weekly: {
      start: string;
      reset_at: string;
      time_until_reset_seconds: number;
    };
  };
  usage: {
    daily: UsageReportWindow;
    weekly: UsageReportWindow;
  };
  by_agent: Array<{
    agent: string;
    daily: UsageReportAgentWindow;
    weekly: UsageReportAgentWindow;
  }>;
  by_model: Array<{
    model: string;
    daily: { weighted_tokens: number; raw_tokens: number; requests: number };
  }>;
  concurrency: {
    in_flight_claude: number;
    max_safe_concurrency: number;
    slots_available: number;
    queue_depth: number;
    rate_limit_retry: number;
    wedged_count: number;
    oldest_in_flight_age_seconds: number | null;
    oldest_in_flight_agent: string | null;
    source_status: "ok" | "degraded";
  };
  gate: {
    global_state: UsageGateState;
    should_pause_new_dispatches: boolean;
    reason: string;
    daily_percent: number;
    weekly_percent: number;
    override_active: boolean;
    enforcement: UsageGateEnforcement;
    agent_overrides: Array<{
      agent: string;
      state: UsageGateState;
      reason: string;
    }>;
  };
  calibration: {
    denominator_kind: "configured_policy_budget";
    calibrated_at: string | null;
    notes: string;
  };
  source: "manager-usage-meter";
}

export interface UsageReportWindow {
  weighted_tokens: number;
  raw_tokens: number;
  requests: number;
  budget: number;
  percent_consumed: number;
  soft_threshold: number;
  hard_threshold: number;
}

export interface UsageReportAgentWindow {
  weighted_tokens: number;
  raw_tokens: number;
  requests: number;
  budget: number | null;
  percent_of_budget: number | null;
}

// ── Audit (usage_gate_decision row) ──────────────────────────────────

export interface UsageGateDecisionRecord {
  id: string;
  ts: number;
  scope: "global" | "agent";
  agent_id: string | null;
  state: UsageGateState;
  decision: UsageGateDecisionLabel;
  reason: string;
  daily_pct: number | null;
  weekly_pct: number | null;
  policy_version: string;
  metadata: Record<string, unknown>;
}
