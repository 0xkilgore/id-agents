// Supervisor v0 — Configuration schema, defaults, and environment parsing.

import type { AlertKind } from './types.js';

export interface SupervisorAgentOverride {
  agent_id: string;
  stuckQuerySeconds?: number;
  agentDownSeconds?: number;
}

export interface SupervisorWatchConfig {
  enabled: boolean;
  pollIntervalSeconds: number;
  watchedAgents: string[] | 'all';
  stuckQuerySeconds: number;
  noProgressSeconds: number;
  agentDownSeconds: number;
  newsErrorWindowSeconds: number;
  newsErrorRepeatCount: number;
  alertFilePath: string;
  localNotificationsEnabled: boolean;
  criticalNotificationKinds: AlertKind[];
  agentOverrides: SupervisorAgentOverride[];
}

export const DEFAULT_CONFIG: SupervisorWatchConfig = {
  enabled: false,
  pollIntervalSeconds: 30,
  watchedAgents: 'all',
  stuckQuerySeconds: 1800,
  noProgressSeconds: 600,
  agentDownSeconds: 300,
  newsErrorWindowSeconds: 900,
  newsErrorRepeatCount: 3,
  alertFilePath: './var/supervisor-alerts.jsonl',
  localNotificationsEnabled: false,
  criticalNotificationKinds: ['agent_down', 'promotion_failure'],
  agentOverrides: [],
};

export function parseSupervisorConfig(env: Record<string, string | undefined> = process.env): SupervisorWatchConfig {
  const cfg = { ...DEFAULT_CONFIG };

  cfg.enabled = env.SUPERVISOR_WATCH_ENABLED === 'true';

  if (env.SUPERVISOR_POLL_INTERVAL_SECONDS) {
    const v = parseInt(env.SUPERVISOR_POLL_INTERVAL_SECONDS, 10);
    if (!isNaN(v) && v > 0) cfg.pollIntervalSeconds = v;
  }

  if (env.SUPERVISOR_WATCHED_AGENTS) {
    const raw = env.SUPERVISOR_WATCHED_AGENTS.trim();
    if (raw === 'all') {
      cfg.watchedAgents = 'all';
    } else {
      cfg.watchedAgents = raw.split(',').map(s => s.trim()).filter(Boolean);
    }
  }

  if (env.SUPERVISOR_STUCK_QUERY_SECONDS) {
    const v = parseInt(env.SUPERVISOR_STUCK_QUERY_SECONDS, 10);
    if (!isNaN(v) && v > 0) cfg.stuckQuerySeconds = v;
  }

  if (env.SUPERVISOR_NO_PROGRESS_SECONDS) {
    const v = parseInt(env.SUPERVISOR_NO_PROGRESS_SECONDS, 10);
    if (!isNaN(v) && v > 0) cfg.noProgressSeconds = v;
  }

  if (env.SUPERVISOR_AGENT_DOWN_SECONDS) {
    const v = parseInt(env.SUPERVISOR_AGENT_DOWN_SECONDS, 10);
    if (!isNaN(v) && v > 0) cfg.agentDownSeconds = v;
  }

  if (env.SUPERVISOR_NEWS_ERROR_WINDOW_SECONDS) {
    const v = parseInt(env.SUPERVISOR_NEWS_ERROR_WINDOW_SECONDS, 10);
    if (!isNaN(v) && v > 0) cfg.newsErrorWindowSeconds = v;
  }

  if (env.SUPERVISOR_NEWS_ERROR_REPEAT_COUNT) {
    const v = parseInt(env.SUPERVISOR_NEWS_ERROR_REPEAT_COUNT, 10);
    if (!isNaN(v) && v > 0) cfg.newsErrorRepeatCount = v;
  }

  if (env.SUPERVISOR_ALERT_FILE_PATH) {
    cfg.alertFilePath = env.SUPERVISOR_ALERT_FILE_PATH;
  }

  if (env.SUPERVISOR_LOCAL_NOTIFICATIONS === 'true') {
    cfg.localNotificationsEnabled = true;
  }

  return cfg;
}

export function getEffectiveStuckQuerySeconds(config: SupervisorWatchConfig, agentId: string): number {
  const override = config.agentOverrides.find(o => o.agent_id === agentId);
  return override?.stuckQuerySeconds ?? config.stuckQuerySeconds;
}

export function getEffectiveAgentDownSeconds(config: SupervisorWatchConfig, agentId: string): number {
  const override = config.agentOverrides.find(o => o.agent_id === agentId);
  return override?.agentDownSeconds ?? config.agentDownSeconds;
}

export function isAgentWatched(config: SupervisorWatchConfig, agentId: string): boolean {
  if (config.watchedAgents === 'all') return true;
  return config.watchedAgents.includes(agentId);
}

export function configToSnapshot(config: SupervisorWatchConfig) {
  return {
    poll_interval_seconds: config.pollIntervalSeconds,
    stuck_query_seconds: config.stuckQuerySeconds,
    no_progress_seconds: config.noProgressSeconds,
    agent_down_seconds: config.agentDownSeconds,
    news_error_window_seconds: config.newsErrorWindowSeconds,
    news_error_repeat_count: config.newsErrorRepeatCount,
  };
}
