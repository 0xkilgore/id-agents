// SPDX-License-Identifier: MIT
/**
 * DispatchRetryWatcher — Decision 3.2 (2026-05-04 session): when the
 * manager dispatches to CTO and no /news reply arrives within 5 minutes,
 * auto-retry once. Hide the retry from Chris unless the retry budget is
 * exhausted (i.e. a second window passes without reply), in which case
 * surface a stuck-dispatch notice via the manager inbox.
 *
 * Pure-state logic with injected deps so wiring into agent-manager-db.ts
 * stays small and the unit tests can drive it with a fake clock.
 */

export interface DispatchJob {
  queryId: string;
  teamId: string;
  agentName: string;
  targetAgentId: string;
  targetUrl: string;
  message: string;
  from: string;
  sessionId?: string;
  dispatchedAt: number;
  retried?: boolean;
  retriedAt?: number;
  surfaced?: boolean;
}

export interface DispatchRetryDeps {
  now: () => number;
  isPending: (queryId: string) => Promise<boolean>;
  redispatch: (job: DispatchJob) => Promise<void>;
  surface: (job: DispatchJob) => Promise<void>;
  log: (msg: string) => void;
  retryAfterMs?: number;
  surfaceAfterMs?: number;
  watchAgents?: string[];
}

const DEFAULT_RETRY_MS = 5 * 60 * 1000;
const DEFAULT_SURFACE_MS = 10 * 60 * 1000;

export class DispatchRetryWatcher {
  private jobs = new Map<string, DispatchJob>();
  private readonly retryAfterMs: number;
  private readonly surfaceAfterMs: number;
  private readonly watchAgents: Set<string>;

  constructor(private readonly deps: DispatchRetryDeps) {
    this.retryAfterMs = deps.retryAfterMs ?? DEFAULT_RETRY_MS;
    this.surfaceAfterMs = deps.surfaceAfterMs ?? DEFAULT_SURFACE_MS;
    this.watchAgents = new Set((deps.watchAgents ?? ['cto']).map((a) => a.toLowerCase()));
  }

  register(job: Omit<DispatchJob, 'retried' | 'surfaced'>): void {
    if (!this.watchAgents.has(job.agentName.toLowerCase())) return;
    this.jobs.set(job.queryId, { ...job, retried: false, surfaced: false });
  }

  clear(queryId: string): void {
    this.jobs.delete(queryId);
  }

  size(): number {
    return this.jobs.size;
  }

  getJob(queryId: string): DispatchJob | undefined {
    return this.jobs.get(queryId);
  }

  async tick(): Promise<{ retried: string[]; surfaced: string[] }> {
    const retried: string[] = [];
    const surfaced: string[] = [];
    const now = this.deps.now();

    for (const [queryId, job] of Array.from(this.jobs.entries())) {
      let stillPending = true;
      try {
        stillPending = await this.deps.isPending(queryId);
      } catch (e: any) {
        this.deps.log(`DispatchRetryWatcher: isPending(${queryId}) failed: ${e?.message ?? e}`);
      }
      if (!stillPending) {
        this.jobs.delete(queryId);
        continue;
      }

      const elapsed = now - job.dispatchedAt;

      if (!job.retried && elapsed >= this.retryAfterMs) {
        try {
          await this.deps.redispatch(job);
          job.retried = true;
          job.retriedAt = now;
          retried.push(queryId);
          this.deps.log(`Auto-retry CTO dispatch ${queryId} (${elapsed}ms since first)`);
        } catch (e: any) {
          this.deps.log(`DispatchRetryWatcher: redispatch ${queryId} failed: ${e?.message ?? e}`);
        }
        continue;
      }

      if (job.retried && !job.surfaced && elapsed >= this.surfaceAfterMs) {
        try {
          await this.deps.surface(job);
          job.surfaced = true;
          surfaced.push(queryId);
          this.deps.log(`Surfaced stuck dispatch ${queryId} to Chris (retry budget exhausted)`);
          this.jobs.delete(queryId);
        } catch (e: any) {
          this.deps.log(`DispatchRetryWatcher: surface ${queryId} failed: ${e?.message ?? e}`);
        }
      }
    }

    return { retried, surfaced };
  }
}
