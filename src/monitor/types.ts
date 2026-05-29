// Monitor endpoints — read-only fleet health and completions types.

export interface FleetAgentRow {
  agent: string;
  port: number;
  pid: number | null;
  status: 'up' | 'down' | 'unknown';
  health: string | null;
  last_seen_ts: number | null;
  url: string | null;
  source: 'manager-health' | 'manager-agents';
}

export interface MonitorFleetResponse {
  generated_at: number;
  agents: FleetAgentRow[];
}

export interface InFlightQueryRow {
  agent: string;
  query_id: string;
  from: string | null;
  received_ts: number;
  elapsed_ms: number;
  event_type: 'query.received' | 'schedule.received';
}

export interface RecentCompletionRow {
  agent: string;
  query_id: string;
  from: string | null;
  received_ts: number;
  completed_ts: number;
  duration_ms: number;
  result_preview: string | null;
}

export interface PromotionOutcomeRow {
  query_id: string | null;
  agent: string | null;
  branch: string | null;
  commit: string | null;
  promoted_to_main: boolean | null;
  pushed: boolean | null;
  verified: boolean | null;
  base: string | null;
  remote_main_sha: string | null;
  source: 'agent-done-promotion' | 'reply-promotion-block';
}

export interface SourceCoverageRow {
  agent: string;
  news_seen: boolean;
  newest_news_ts: number | null;
  error: string | null;
}

export interface MonitorCompletionsResponse {
  generated_at: number;
  in_flight: InFlightQueryRow[];
  recent_completions: RecentCompletionRow[];
  promotion_outcomes: PromotionOutcomeRow[];
  source_coverage: SourceCoverageRow[];
}
