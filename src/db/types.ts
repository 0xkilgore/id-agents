// SPDX-License-Identifier: MIT

/**
 * Row types matching the actual database table schemas.
 *
 * JSON columns (config, metadata, registry, data, result) are typed as
 * Record<string, unknown> | null at the APPLICATION boundary.
 * Repository implementations handle parsing/stringifying internally,
 * so callers always receive parsed JS objects (or null).
 */

/** agents table row */
export interface AgentRow {
  team_id: string;
  id: string;
  name: string;
  type: string;
  model: string;
  port: number;
  endpoint: string | null;
  working_directory: string | null;
  status: string;
  created_at: number;
  registry: Record<string, unknown> | null;
  metadata: Record<string, unknown> | null;
  deleted_at: number | null;
  runtime: string;
  token_id: string | null;
  domain: string | null;
  api_key: string | null;
}

/** teams table row */
export interface TeamRow {
  id: string;
  name: string;
  config: Record<string, unknown>;
  port_start: number;
  port_end: number;
  created_at: string;
}

/** queries table row */
export interface QueryRow {
  team_id: string;
  agent_id: string;
  query_id: string;
  status: string;
  prompt: string | null;
  created: number;
  completed: number | null;
  result: Record<string, unknown> | null;
  error: string | null;
  session_id: string | null;
}

/** news_items table row */
export interface NewsItemRow {
  id: number;
  team_id: string;
  agent_id: string;
  timestamp: number;
  type: string;
  message: string | null;
  data: Record<string, unknown> | null;
  query_id: string | null;
}

/** schedule_definitions table row */
export interface ScheduleDefinitionRow {
  id: string;
  kind: 'interval' | 'calendar';
  title: string;
  description: string | null;
  active: boolean;
  message: string;
  delivery_mode: 'talk' | 'internal';
  timezone: string | null;
  catch_up_policy: 'skip' | 'fire_once';
  dedupe_window_seconds: number;
  interval_seconds: number | null;
  anchor_at: number | null;
  max_runs: number | null;
  expires_at: number | null;
  local_time_seconds: number | null;
  local_date: string | null;
  days_of_week: string | null;
  source_type: string;
  source_key: string | null;
  created_at: number;
  updated_at: number;
}

/** schedule_runs table row */
export interface ScheduleRunRow {
  schedule_id: string;
  agent_id: string;
  scheduled_key: string;
  scheduled_at: number;
  fired_at: number;
  status: 'pending' | 'sent' | 'failed' | 'skipped';
  error: string | null;
}
