// Usage Meter + Controls — shared types.
// Spec: cto/output/2026-05-31-usage-meter-controls-spec.md
//
// Safety bar (Chris's overnight mandate, 2026-05-31): gating ships in
// WARN-ONLY / OBSERVE mode by default. The meter, budgets, rollups, and
// dashboard data are LIVE; actual HARD-GATING (refusing dispatch starts)
// is gated behind USAGE_GATE_ENFORCEMENT=enforce. When "warn" (default),
// the gate observes, logs, and reports — it NEVER blocks.

// W1-1 (runtime-provider-lanes): `cursor` is a distinct provider lane.
export type Provider = "anthropic" | "openai" | "cursor" | "other";

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
  provider_limits: ProviderLimitSignal[];
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

// ── Daemon-attributed spend (Gap 2) ──────────────────────────────────
//
// A usage event's spend scope is resolved from the dispatch that caused it:
// dispatches the continuous-orchestration daemon enqueued are `daemon_*`;
// everything else is `fleet`. The daemon's cap measures ONLY its own scopes,
// so a busy day from Roger/Pipeline/Cane no longer pauses the daemon.
export type SpendScope =
  | "fleet"
  | "daemon_autonomous"
  | "daemon_fleshing"
  | "manual_operator"
  | "unknown";

export interface DaemonUsageReport {
  schema_version: "daemon-usage.v1";
  generated_at: string;
  daily: {
    autonomous_weighted_tokens: number;
    fleshing_weighted_tokens: number;
    combined_weighted_tokens: number;
    budget: number;
    percent_consumed: number;
  };
  weekly: {
    combined_weighted_tokens: number;
    budget: number;
    percent_consumed: number;
  };
  coverage: {
    attributed_events: number;
    unknown_events: number;
    /** "fresh" when attribution resolved cleanly; "degraded" when it didn't. */
    confidence: "fresh" | "degraded";
  };
  gate: {
    /** True when the daemon must halt: global emergency brake OR over daemon cap. */
    hard_paused: boolean;
    enforcement: UsageGateEnforcement;
    reason: string;
  };
}

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
  by_provider: UsageReportProviderWindow[];
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
    daily_percent: number | null;
    weekly_percent: number | null;
    override_active: boolean;
    enforcement: UsageGateEnforcement;
    agent_overrides: Array<{
      agent: string;
      state: UsageGateState;
      reason: string;
    }>;
    provider_limits: ProviderLimitSignal[];
  };
  calibration: {
    denominator_kind: "usage_with_no_limit" | "calibrated_estimate";
    calibrated_at: string | null;
    notes: string;
  };
  source: "manager-usage-meter";
}

export interface UsageReportWindow {
  weighted_tokens: number;
  raw_tokens: number;
  requests: number;
  budget: number | null;
  percent_consumed: number | null;
  soft_threshold: number | null;
  hard_threshold: number | null;
}

export interface UsageReportAgentWindow {
  weighted_tokens: number;
  raw_tokens: number;
  requests: number;
  budget: number | null;
  percent_of_budget: number | null;
}

export interface UsageReportProviderWindow {
  provider: Provider;
  daily: {
    weighted_tokens: number;
    raw_tokens: number;
    requests: number;
    limit: number | null;
    percent_of_limit: number | null;
  };
  weekly: {
    weighted_tokens: number;
    raw_tokens: number;
    requests: number;
    limit: number | null;
    percent_of_limit: number | null;
  };
  limit_state: "ok" | "limited" | "unknown";
  limit_source: "observed_provider_signal" | "not_available";
  reset_at: string | null;
}

export interface ProviderLimitSignal {
  provider: Provider;
  runtime: string | null;
  agent: string | null;
  dispatch_phid: string | null;
  observed_at: string;
  reset_at: string | null;
  message: string;
  source: "scheduler_bounce";
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
