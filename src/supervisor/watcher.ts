// Supervisor v0 — Poll loop lifecycle.
// Reads manager sources, runs rules, emits alerts. No intervention.

import { readFileSync } from 'fs';
import type {
  SourceSnapshot,
  ActiveDispatch,
  TerminalDispatch,
  AgentStatus,
  NewsEntry,
} from './types.js';
import type { SupervisorWatchConfig } from './config.js';
import { parseSupervisorConfig, configToSnapshot } from './config.js';
import { evaluateAllRules } from './rules.js';
import { AlertStateManager } from './alerts.js';
import { createDefaultSinks, type AlertSink } from './sinks.js';

export interface SupervisorSourceReader {
  readActiveDispatches(): Promise<ActiveDispatch[]>;
  readTerminalDispatches(since: string): Promise<TerminalDispatch[]>;
  readWatchedAgents(): Promise<AgentStatus[]>;
  readRecentNews(since: string): Promise<NewsEntry[]>;
}

export interface SupervisorWatcherOptions {
  config?: SupervisorWatchConfig;
  sourceReader: SupervisorSourceReader;
  sink?: AlertSink;
  alertStateManager?: AlertStateManager;
  now?: () => number;
}

export type SupervisorFreshnessState = 'disabled' | 'stopped' | 'starting' | 'fresh' | 'stale' | 'error';

export interface SupervisorHealthStatus {
  schema_version: 'supervisor-freshness.v1';
  enabled: boolean;
  running: boolean;
  state: SupervisorFreshnessState;
  poll_interval_seconds: number;
  stale_after_seconds: number;
  last_tick_started_at: string | null;
  last_success_at: string | null;
  last_error_at: string | null;
  last_error: string | null;
  open_alert_count: number;
}

export class SupervisorWatcher {
  private config: SupervisorWatchConfig;
  private sourceReader: SupervisorSourceReader;
  private sink: AlertSink;
  private alertState: AlertStateManager;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private getNow: () => number;
  private lastTerminalCheck: string;
  private lastNewsCheck: string;
  private lastTickStartedAt: string | null = null;
  private lastSuccessAt: string | null = null;
  private lastErrorAt: string | null = null;
  private lastError: string | null = null;

  constructor(options: SupervisorWatcherOptions) {
    this.config = options.config ?? parseSupervisorConfig();
    this.sourceReader = options.sourceReader;
    this.sink = options.sink ?? createDefaultSinks(this.config);
    this.alertState = options.alertStateManager ?? new AlertStateManager();
    this.getNow = options.now ?? (() => Date.now());

    // Default lookback: 1 hour for terminal dispatches and news
    const lookback = new Date(this.getNow() - 3600_000).toISOString();
    this.lastTerminalCheck = lookback;
    this.lastNewsCheck = lookback;
  }

  start(): void {
    if (!this.config.enabled) {
      console.log('[Supervisor] Watcher disabled (SUPERVISOR_WATCH_ENABLED != true)');
      return;
    }

    if (this.running) return;
    this.running = true;

    // Replay existing JSONL if present
    this.replayAlertFile();

    console.log(`[Supervisor] Watcher started (poll every ${this.config.pollIntervalSeconds}s)`);

    // Run first tick immediately
    this.tick().catch(err => {
      console.error('[Supervisor] First tick error:', err instanceof Error ? err.message : String(err));
    });

    this.timer = setInterval(() => {
      this.tick().catch(err => {
        console.error('[Supervisor] Tick error:', err instanceof Error ? err.message : String(err));
      });
    }, this.config.pollIntervalSeconds * 1000);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.running = false;
    console.log('[Supervisor] Watcher stopped');
  }

  isRunning(): boolean {
    return this.running;
  }

  getOpenAlerts() {
    return this.alertState.getOpenAlerts();
  }

  getHealthStatus(nowMs: number = this.getNow()): SupervisorHealthStatus {
    const staleAfterSeconds = Math.max(this.config.pollIntervalSeconds * 3, this.config.pollIntervalSeconds + 5);
    const successAgeSeconds = this.lastSuccessAt
      ? (nowMs - Date.parse(this.lastSuccessAt)) / 1000
      : null;
    const errorIsCurrent =
      this.lastErrorAt != null &&
      (this.lastSuccessAt == null || Date.parse(this.lastErrorAt) > Date.parse(this.lastSuccessAt));

    let state: SupervisorFreshnessState;
    if (!this.config.enabled) {
      state = 'disabled';
    } else if (errorIsCurrent) {
      state = 'error';
    } else if (!this.running) {
      state = 'stopped';
    } else if (!this.lastSuccessAt) {
      state = 'starting';
    } else if (successAgeSeconds != null && successAgeSeconds > staleAfterSeconds) {
      state = 'stale';
    } else {
      state = 'fresh';
    }

    return {
      schema_version: 'supervisor-freshness.v1',
      enabled: this.config.enabled,
      running: this.running,
      state,
      poll_interval_seconds: this.config.pollIntervalSeconds,
      stale_after_seconds: staleAfterSeconds,
      last_tick_started_at: this.lastTickStartedAt,
      last_success_at: this.lastSuccessAt,
      last_error_at: this.lastErrorAt,
      last_error: this.lastError,
      open_alert_count: this.alertState.getOpenAlerts().length,
    };
  }

  async tick(): Promise<void> {
    if (!this.config.enabled) return;

    const now = this.getNow();
    const nowIso = new Date(now).toISOString();
    this.lastTickStartedAt = nowIso;

    try {
      // Collect sources with per-source error tolerance
      const snapshot = await this.collectSources(nowIso);

      // Evaluate rules
      const findings = evaluateAllRules(snapshot, this.config, now);

      // Process findings through alert state
      const configSnap = configToSnapshot(this.config);
      const records = this.alertState.processTick(findings, configSnap, nowIso);

      // Emit to sinks
      for (const record of records) {
        this.sink.emit(record);
      }

      // Update lookback markers
      this.lastTerminalCheck = nowIso;
      this.lastNewsCheck = nowIso;
      this.lastSuccessAt = nowIso;
      this.lastErrorAt = null;
      this.lastError = null;
    } catch (err) {
      this.lastErrorAt = nowIso;
      this.lastError = err instanceof Error ? err.message : String(err);
      throw err;
    }
  }

  private async collectSources(nowIso: string): Promise<SourceSnapshot> {
    const available: string[] = [];
    const missing: string[] = [];

    let activeDispatches: ActiveDispatch[] = [];
    try {
      activeDispatches = await this.sourceReader.readActiveDispatches();
      available.push('active_dispatches');
    } catch (err) {
      missing.push('active_dispatches');
      console.warn('[Supervisor] Failed to read active dispatches:', err instanceof Error ? err.message : String(err));
    }

    let terminalDispatches: TerminalDispatch[] = [];
    try {
      terminalDispatches = await this.sourceReader.readTerminalDispatches(this.lastTerminalCheck);
      available.push('terminal_dispatches');
    } catch (err) {
      missing.push('terminal_dispatches');
      console.warn('[Supervisor] Failed to read terminal dispatches:', err instanceof Error ? err.message : String(err));
    }

    let watchedAgents: AgentStatus[] = [];
    try {
      watchedAgents = await this.sourceReader.readWatchedAgents();
      available.push('watched_agents');
    } catch (err) {
      missing.push('watched_agents');
      console.warn('[Supervisor] Failed to read watched agents:', err instanceof Error ? err.message : String(err));
    }

    let recentNews: NewsEntry[] = [];
    try {
      recentNews = await this.sourceReader.readRecentNews(this.lastNewsCheck);
      available.push('recent_news');
    } catch (err) {
      missing.push('recent_news');
      console.warn('[Supervisor] Failed to read recent news:', err instanceof Error ? err.message : String(err));
    }

    return {
      collected_at: nowIso,
      active_dispatches: activeDispatches,
      terminal_dispatches: terminalDispatches,
      watched_agents: watchedAgents,
      recent_news: recentNews,
      available_sources: available,
      missing_sources: missing,
    };
  }

  private replayAlertFile(): void {
    try {
      const content = readFileSync(this.config.alertFilePath, 'utf-8');
      const lines = content.split('\n').filter(Boolean);
      const records = [];
      for (const line of lines) {
        try {
          records.push(JSON.parse(line));
        } catch {
          // Skip malformed lines
        }
      }
      if (records.length > 0) {
        this.alertState.replayFromRecords(records);
        console.log(`[Supervisor] Replayed ${records.length} alert records from ${this.config.alertFilePath}`);
      }
    } catch {
      // File doesn't exist or can't be read — start fresh
    }
  }
}
