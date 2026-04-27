// SPDX-License-Identifier: MIT

/**
 * event_log retention sweep (security review #6).
 *
 * Two caps, whichever is hit first per team:
 *   - age:   delete rows older than `retentionDays` (default 7d)
 *   - count: keep at most `retentionCount` rows (default 100k); delete the
 *            oldest excess.
 *
 * Defaults can be overridden at process start via env:
 *   EVENT_LOG_RETENTION_DAYS  (positive integer, days)
 *   EVENT_LOG_RETENTION_COUNT (positive integer, rows per team)
 *
 * The sweep loop is wired into the manager daemon at boot
 * (see startEventLogRetentionSweep in agent-manager-db.ts).
 */

import type { EventsRepository, TeamsRepository } from '../db/db-service.js';

export const DEFAULT_RETENTION_DAYS = 7;
export const DEFAULT_RETENTION_COUNT = 100_000;
export const DEFAULT_RETENTION_INTERVAL_MS = 5 * 60 * 1000;

export interface RetentionConfig {
  retentionDays: number;
  retentionCount: number;
}

export interface RetentionSweepResult {
  agedDeleted: number;
  countDeleted: number;
  teamsScanned: number;
}

export interface RetentionTickInput {
  events: EventsRepository;
  teams: TeamsRepository;
  now: number;
  config?: RetentionConfig;
  log?: (line: string) => void;
}

export function resolveRetentionConfig(env: NodeJS.ProcessEnv = process.env): RetentionConfig {
  return {
    retentionDays: parsePositiveInt(env.EVENT_LOG_RETENTION_DAYS, DEFAULT_RETENTION_DAYS),
    retentionCount: parsePositiveInt(env.EVENT_LOG_RETENTION_COUNT, DEFAULT_RETENTION_COUNT),
  };
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return n;
}

/**
 * One pass over every team. For each team:
 *   1. Age sweep — delete rows with occurred_at < now - retentionDays.
 *   2. Count sweep — if rows remain over the cap, delete the oldest excess.
 * Logs only when something was deleted.
 */
export async function sweepEventLogRetention(
  input: RetentionTickInput,
): Promise<RetentionSweepResult> {
  const cfg = input.config ?? resolveRetentionConfig();
  const ageCutoff = input.now - cfg.retentionDays * 24 * 60 * 60 * 1000;
  const log = input.log ?? ((line: string) => console.log(line));

  const result: RetentionSweepResult = { agedDeleted: 0, countDeleted: 0, teamsScanned: 0 };

  const teams = await input.teams.listTeams();
  for (const team of teams) {
    result.teamsScanned += 1;
    const aged = await input.events.pruneByAge(team.id, ageCutoff);
    const count = await input.events.pruneByCount(team.id, cfg.retentionCount);
    result.agedDeleted += aged;
    result.countDeleted += count;
    if (aged > 0 || count > 0) {
      log(`[wakeup-service] retention swept: aged=${aged} count=${count} team=${team.name}`);
    }
  }
  return result;
}

/**
 * Daemon-side wrapper. `start()` installs a `setInterval` that calls
 * `sweepEventLogRetention` every `intervalMs` (default 5 minutes); `stop()`
 * tears it down. Mirrors the `CheckinService` shape so the two background
 * loops are easy to compare in `agent-manager-db.ts`.
 */
export class RetentionService {
  private interval: NodeJS.Timeout | null = null;
  private running = false;
  private readonly intervalMs: number;
  private readonly config: RetentionConfig;
  private readonly log: (line: string) => void;
  private readonly errorLog: (msg: string, err?: unknown) => void;

  constructor(
    private readonly db: { events: EventsRepository; teams: TeamsRepository },
    opts: {
      intervalMs?: number;
      config?: Partial<RetentionConfig>;
      log?: (line: string) => void;
      errorLog?: (msg: string, err?: unknown) => void;
    } = {},
  ) {
    this.intervalMs = opts.intervalMs ?? DEFAULT_RETENTION_INTERVAL_MS;
    const base = resolveRetentionConfig();
    this.config = {
      retentionDays: opts.config?.retentionDays ?? base.retentionDays,
      retentionCount: opts.config?.retentionCount ?? base.retentionCount,
    };
    this.log = opts.log ?? ((line) => console.log(line));
    this.errorLog =
      opts.errorLog ??
      ((msg, err) => console.error(`[wakeup-service] ${msg}`, err));
  }

  /** Start the periodic sweep. Idempotent. */
  start(): void {
    if (this.interval) return;
    const run = () => {
      if (this.running) return;
      this.running = true;
      this.tick(Date.now())
        .catch((err) => this.errorLog('retention tick failed', err))
        .finally(() => {
          this.running = false;
        });
    };
    this.interval = setInterval(run, this.intervalMs);
    this.interval.unref?.();
  }

  /** Stop the periodic sweep. Safe to call multiple times. */
  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  /** Single sweep pass. Public for tests. */
  async tick(now: number): Promise<RetentionSweepResult> {
    return sweepEventLogRetention({
      events: this.db.events,
      teams: this.db.teams,
      now,
      config: this.config,
      log: this.log,
    });
  }

  /** Exposed for tests / diagnostics. */
  getConfig(): RetentionConfig {
    return { ...this.config };
  }
}
