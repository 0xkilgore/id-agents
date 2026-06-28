export interface AgentMetadata {
  runtime?: string;
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

export interface AgentDetailLoop {
  slug: string;
  name: string;
  kind: string;
  enabled: boolean;
  health_state: string;
  schedule_label: string;
}

export interface AgentDetailResponse {
  name: string;
  charts: {
    tasks: { total: number; by_status: Record<string, number> };
    tokens: { today: number; series: AgentDetailTokenSeriesPoint[] };
    failures: { consecutive: number; failed_dispatches: number; last_error: string | null };
  };
  recent_outputs: AgentDetailArtifact[];
  recent_dispatches?: AgentDetailDispatch[];
  verified_landings?: AgentDetailDispatch[];
  skills: string[];
  loops: AgentDetailLoop[];
  scripts: string[];
}
