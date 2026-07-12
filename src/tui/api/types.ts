export interface AgentMetadata {
  runtime?: string;
  runtimeUsageTruth?: {
    actualRuntime: string;
    actualModel: string;
    catalogDesiredModel?: string;
    catalogModelStale: boolean;
    usageTelemetry: {
      provider: 'anthropic' | 'openai' | 'cursor' | 'other';
      source: string;
      authoritativeFields: ['runtime', 'model'];
    };
  };
  description?: string;
  heartbeat?: boolean;
  pid?: number;
  [key: string]: unknown;
}

export interface Agent {
  id: string;
  name: string;
  alias?: string;
  port: number;
  status: string;
  health: string;
  model?: string;
  runtime?: string;
  type?: string;
  url?: string;
  workingDirectory?: string;
  createdAt: number;
  lastHealthCheck?: number;
  metadata?: AgentMetadata;
  teamName?: string;
  // Remote-endpoint fields (public-agent-remote runtime)
  deploymentShape?: 'local-process' | 'remote-endpoint';
  pid?: number | null;
  customer_domain?: string | null;
  public_endpoint_url?: string | null;
  ows_wallet?: string | null;
  idchain_domain?: string | null;
  ssh_target?: string | null;
  last_seen?: number | null;
  last_probed_at?: number | null;
  last_error?: string | null;
  consecutive_failures?: number;
}

export interface Team {
  id: string;
  name: string;
  agentCount: number;
  createdAt?: string;
}

export interface AgentsResponse {
  agents: Agent[];
}

export interface TeamsResponse {
  teams: Team[];
}

export interface NewsItem {
  type: string;
  timestamp: number;
  message?: string;
  data?: unknown;
}

export interface RemoteNewsResponse {
  ok: boolean;
  result?: { items?: NewsItem[] };
  error?: string;
}

export interface Task {
  name: string;
  uuid?: string;
  shortId?: string;
  title: string;
  description?: string | null;
  status: string;
  ownerName?: string | null;
  teamName?: string;
  linkedEvents?: string[];
  createdAt: number;
  updatedAt?: number;
  completedAt?: number | null;
  operationTimeline?: {
    schema_version: 'task.operation_timeline.v1';
    count: number;
    counts: Record<'recorded' | 'pending' | 'routed' | 'failed', number>;
    items: Array<{
      id: string;
      kind: 'comment' | 'route_attempt';
      state: 'recorded' | 'pending' | 'routed' | 'failed';
      actor: string;
      created_at: string;
      comment_id: string;
      comment_text: string;
      source_ref: string;
      target_agent: string | null;
      target_agent_raw: string | null;
      dispatch_phid: string | null;
      query_id: string | null;
      error: string | null;
      retry: {
        available: boolean;
        reason: string;
        source_ref: string;
        target_agent: string | null;
      };
      links: {
        task: { kind: 'task'; ref: string; route: string; href: string };
        artifact: null;
      };
    }>;
  };
}

export interface RemoteTasksResponse {
  ok: boolean;
  result?: { tasks?: Task[] };
  error?: string;
}

export interface Schedule {
  id: string;
  title: string;
  kind: 'heartbeat' | 'calendar' | string;
  active: boolean;
  deliveryMode?: string;
  sourceType?: string;
  targets: string[];
  intervalSeconds: number | null;
  timezone: string | null;
  localTimeSeconds: number | null;
  localDate: string | null;
  daysOfWeek: string | null;
  createdAt: number;
  teamName?: string;
}

export interface RemoteSchedulesResponse {
  ok: boolean;
  result?: { schedules?: Schedule[] };
  error?: string;
}

export type ArtifactDeskStatus =
  | 'unread'
  | 'in_review'
  | 'commented'
  | 'approved'
  | 'rejected'
  | 'shipped'
  | 'missing'
  | string;

export interface ArtifactDeskRow {
  id: string;
  title: string;
  subtitle?: string | null;
  status: ArtifactDeskStatus;
  relevance_reason?: string | null;
  needs?: string | null;
  artifact_ref?: string | null;
  dispatch_ref?: string | null;
  task_ref?: string | null;
  agent_name?: string | null;
  updated_at?: string | null;
  source_kind?: string | null;
  source_path?: string | null;
  visibility_proof?: {
    discovered_by?: string;
    artifact_path_present?: boolean;
    body_renderable?: boolean;
  };
  delivery?: {
    stable_url?: string | null;
    copy_text_url?: string | null;
    download_url?: string | null;
    media_type?: string | null;
    freshness?: string | null;
    body_available?: boolean;
    body_source?: string | null;
    body_preview?: string | null;
    open_url?: string | null;
  };
}

export interface ArtifactDeskResponse {
  ok: boolean;
  schema_version: 'surfaced-artifacts.v1';
  rows: ArtifactDeskRow[];
  count: number;
  health?: {
    ok: boolean;
    event_count: number;
    events?: Array<{
      topic: string;
      severity?: string;
      subject_id?: string;
    }>;
  };
  recent_flood?: {
    total_raw_count: number;
    grouped_count: number;
    suppressed_from_primary_count: number;
  };
}

export interface ArtifactReviewState {
  artifact_id: string;
  viewed_at?: string | null;
  viewed_by?: string | null;
  approved_at?: string | null;
  approved_by?: string | null;
  rejected_at?: string | null;
  rejected_by?: string | null;
  shipped_at?: string | null;
  shipped_by?: string | null;
}

export interface ArtifactReviewResponse {
  ok?: boolean;
  artifact_id?: string;
  state?: ArtifactReviewState | null;
  operations_count?: number;
  comments_count?: number;
  latest_comment?: ArtifactComment | null;
  [key: string]: unknown;
}

export interface ArtifactComment {
  op_id: number;
  artifact_id: string;
  actor: string;
  body: string;
  ts: string;
  route_status?: {
    visible_state?: string;
    feedback_status?: string;
    retryable?: boolean;
    failure_reason?: string | null;
  } | null;
}

export interface ArtifactCommentsResponse {
  ok: boolean;
  schema_version: 'artifact.comments.v1';
  artifact_id: string;
  comments: ArtifactComment[];
  count: number;
  version?: number;
}

export interface ArtifactMutationReceipt {
  ok?: boolean;
  status?: string;
  code?: string;
  error?: string;
  visible_state?: string;
  compat_status?: string;
  feedback_status?: string;
  op_id?: number;
  recorded_op_id?: number;
  version?: number;
  comment?: ArtifactComment | null;
  dispatch_error?: unknown;
  dispatch_skipped?: string;
  blockers?: string[];
  state?: ArtifactReviewState;
}

// Agent detail v2 (T-CKPT.agent-v2) — the GET /agents/:name/detail contract.
export interface AgentDetailTokenSeriesPoint {
  date: string;
  weighted: number;
}

export interface AgentDetailArtifact {
  artifact_id: string;
  basename: string;
  title: string | null;
  tag: string | null;
  abs_path: string;
  produced_at: string;
}

export interface AgentDetailDispatch {
  dispatch_id: string;
  query_id: string | null;
  time: string;
  subject: string;
  dispatch_status: string;
  verification_status: string;
  verified: boolean;
  artifact_path: string | null;
  artifact_exists: boolean | null;
  artifact_mtime: string | null;
  tl_dr: string | null;
  kind: string;
  attributed_agent: string;
}

export interface AgentDetailCommentReceipt {
  receipt_id: string;
  artifact_id: string;
  artifact_title: string | null;
  artifact_basename: string | null;
  actor: string;
  time: string;
  timestamp: string;
  route_status: string;
  visible_state:
    | 'recorded+routed'
    | 'recorded-but-route-failed-with-retry'
    | 'recorded-route-failed-retryable'
    | 'disabled/not-recorded'
    | 'terminal-failure'
    | 'not-recorded';
  retryable: boolean;
  route_kind: 'acknowledgement' | 'approval_signal' | 'substantive_follow_up' | 'question';
  target_agent: string | null;
  target_agent_raw: string | null;
  dispatch_id: string | null;
  query_id: string | null;
  failure_reason: string | null;
  retry_metadata: {
    retryable: boolean;
    skipped: string | null;
    error: { message: string } | null;
    updated_at: string | null;
  };
}

export interface AgentDetailObligation {
  obligation_id: string;
  source_kind: 'report' | 'handoff' | 'comment' | 'closeout';
  obligation_type: 'report' | 'handoff' | 'comment' | 'closeout';
  source_record: string;
  source_ref: string;
  agent: string;
  owner: string;
  status: 'expected' | 'done' | 'late' | 'failed';
  stale_after: string | null;
  due_at: string | null;
  last_event_at: string | null;
  is_stale: boolean;
  stale_seconds: number;
  escalation_level: 'none' | 'stale' | 'critical';
  escalates_at: string | null;
  dashboard_reason: string;
}

export interface AgentDetailLoop {
  slug: string;
  name: string;
  kind: string;
  enabled: boolean;
  health_state: string;
  schedule_label: string;
}

export type AgentDetailContributionMetric = 'activity' | 'artifacts' | 'failure_rate';

export interface AgentDetailContributionGridCell {
  date: string;
  value: number;
  intensity: 0 | 1 | 2 | 3 | 4;
}

export interface AgentDetailContributionGridVariant {
  metric: AgentDetailContributionMetric;
  label: string;
  unit: string;
  total: number;
  max: number;
  cells: AgentDetailContributionGridCell[];
}

export interface AgentDetailContributionGrid {
  days: number;
  variants: AgentDetailContributionGridVariant[];
}

export interface AgentDetailResponse {
  name: string;
  charts: {
    tasks: { total: number; by_status: Record<string, number> };
    tokens: { today: number; series: AgentDetailTokenSeriesPoint[] };
    failures: { consecutive: number; failed_dispatches: number; last_error: string | null };
  };
  contribution_grid?: AgentDetailContributionGrid;
  recent_outputs: AgentDetailArtifact[];
  recent_dispatches?: AgentDetailDispatch[];
  recent_comment_receipts?: AgentDetailCommentReceipt[];
  pending_obligations?: AgentDetailObligation[];
  verified_landings?: AgentDetailDispatch[];
  skills: string[];
  loops: AgentDetailLoop[];
  scripts: string[];
}

export interface DispatchAttemptLedgerRow {
  id: string;
  team_id: string;
  correlation_key: string;
  to_agent: string | null;
  from_actor: string | null;
  original_query_id: string | null;
  original_dispatch_id: string | null;
  subject: string | null;
  talk_to_attempted: boolean;
  talk_to_ok: boolean | null;
  talk_to_status_code: number | null;
  talk_to_error: string | null;
  talk_to_at: string | null;
  news_to_attempted: boolean;
  news_to_ok: boolean | null;
  news_to_status_code: number | null;
  news_to_error: string | null;
  news_to_at: string | null;
  fallback_used: boolean;
  fallback_ok: boolean | null;
  attempts_json: unknown[];
  created_at: string;
  updated_at: string;
}

export interface DispatchAttemptLedgerResponse {
  ok: boolean;
  schema_version: 'dispatch-attempt-ledger.v1';
  team_id: string;
  limit: number;
  attempts: DispatchAttemptLedgerRow[];
}
