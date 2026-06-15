// P0 dispatch-recovery service (disp-b329f522b1271e1b).
//
// Scans terminal-failed dispatches, classifies each via the pure classifier,
// and acts: auto-requeues recoverable internal work (capped attempts +
// backoff, lineage metadata), reconciles work that actually landed, and routes
// unsafe/exhausted/ambiguous cases to the operator surface (NOT panic). Never
// auto-resends external side effects without an explicit opt-in.
//
// The reactor seam is injected so this is unit-testable and the manager can
// wire it to the real SqliteDispatchReactor (markBounced(kind:"recovery") +
// requeueAfterBounce reuse the existing bounced/requeue machinery).

import {
  classifyRecovery,
  type DispatchRecoveryDecision,
  type RecoveryConfig,
  type RecoveryInput,
} from "./classifier.js";

export interface RecoverableDispatch extends Omit<RecoveryInput, never> {
  dispatch_phid: string;
}

export interface DispatchRecoveryReactor {
  /** Terminal-failed dispatches eligible for a recovery pass. */
  listFailedForRecovery(): Promise<RecoverableDispatch[]>;
  /** Reuse bounced/requeue machinery: markBounced(kind:"recovery") + requeue. */
  requeueForRecovery(
    phid: string,
    args: { reason: string; next_attempt_at: string },
  ): Promise<boolean>;
  /** Reconcile a dispatch whose work actually landed (artifact/promotion). */
  markRecoveryLanded(phid: string): Promise<void>;
  /** Record a non-retry outcome for the /ops recovery surface (not panic). */
  recordRecoveryOutcome(
    phid: string,
    args: { decision: DispatchRecoveryDecision; reason: string },
  ): Promise<void>;
}

export interface RecoveryLogger {
  info(event: string, payload: Record<string, unknown>): void;
  warn(event: string, payload: Record<string, unknown>): void;
}

const NULL_LOGGER: RecoveryLogger = { info: () => undefined, warn: () => undefined };

export interface DispatchRecoveryServiceOptions {
  reactor: DispatchRecoveryReactor;
  config: RecoveryConfig;
  now: () => string;
  enabled: boolean;
  /** Max auto-retries per run (recovery budget). */
  budget: number;
  /** Base backoff; effective delay = backoffMs * 2^recovery_attempts (capped). */
  backoffMs: number;
  /** Cap on the backoff delay. Default 30 min. */
  maxBackoffMs?: number;
  logger?: RecoveryLogger;
}

export interface RecoveryRunReport {
  skipped: boolean;
  scanned: number;
  landed: number;
  retried: number;
  deferred: number;
  unsafe_side_effect: number;
  exhausted: number;
  needs_operator: number;
  errors: number;
}

const DEFAULT_MAX_BACKOFF_MS = 30 * 60_000;

export class DispatchRecoveryService {
  private reactor: DispatchRecoveryReactor;
  private config: RecoveryConfig;
  private now: () => string;
  private enabled: boolean;
  private budget: number;
  private backoffMs: number;
  private maxBackoffMs: number;
  private logger: RecoveryLogger;
  private interval: ReturnType<typeof setInterval> | null = null;

  constructor(opts: DispatchRecoveryServiceOptions) {
    this.reactor = opts.reactor;
    this.config = opts.config;
    this.now = opts.now;
    this.enabled = opts.enabled;
    this.budget = opts.budget;
    this.backoffMs = opts.backoffMs;
    this.maxBackoffMs = opts.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
    this.logger = opts.logger ?? NULL_LOGGER;
  }

  /**
   * Start the periodic recovery loop. Idempotent; a no-op when disabled. Runs
   * one pass immediately (boot-time backfill of already-stuck rows) then every
   * `intervalMs`. runOnce never throws, so the manager loop is never taken down.
   */
  start(intervalMs: number): void {
    if (!this.enabled || this.interval) return;
    void this.runOnce();
    this.interval = setInterval(() => {
      void this.runOnce();
    }, intervalMs);
    if (this.interval.unref) this.interval.unref();
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  /** Never throws — recovery must not take down the manager. */
  async runOnce(): Promise<RecoveryRunReport> {
    const report: RecoveryRunReport = {
      skipped: false,
      scanned: 0,
      landed: 0,
      retried: 0,
      deferred: 0,
      unsafe_side_effect: 0,
      exhausted: 0,
      needs_operator: 0,
      errors: 0,
    };
    if (!this.enabled) {
      report.skipped = true;
      return report;
    }

    let docs: RecoverableDispatch[];
    try {
      docs = await this.reactor.listFailedForRecovery();
    } catch (err) {
      this.logger.warn("recovery_list_failed", { detail: msg(err) });
      report.errors += 1;
      return report;
    }
    report.scanned = docs.length;

    for (const doc of docs) {
      try {
        const decision = classifyRecovery(toInput(doc), this.config);
        switch (decision.decision) {
          case "landed":
            await this.reactor.markRecoveryLanded(doc.dispatch_phid);
            report.landed += 1;
            this.logger.info("recovery_landed", { phid: doc.dispatch_phid });
            break;
          case "retryable":
            if (report.retried >= this.budget) {
              report.deferred += 1; // budget for this run is spent; pick up next run
              break;
            }
            await this.reactor.requeueForRecovery(doc.dispatch_phid, {
              reason: `recovery: ${decision.reason}`,
              next_attempt_at: this.nextAttemptAt(doc.recovery_attempts),
            });
            report.retried += 1;
            this.logger.info("recovery_requeued", {
              phid: doc.dispatch_phid,
              recovery_attempts: doc.recovery_attempts,
            });
            break;
          case "unsafe_side_effect":
            await this.reactor.recordRecoveryOutcome(doc.dispatch_phid, decision);
            report.unsafe_side_effect += 1;
            break;
          case "exhausted":
            await this.reactor.recordRecoveryOutcome(doc.dispatch_phid, decision);
            report.exhausted += 1;
            break;
          case "needs_operator":
            await this.reactor.recordRecoveryOutcome(doc.dispatch_phid, decision);
            report.needs_operator += 1;
            break;
        }
      } catch (err) {
        this.logger.warn("recovery_apply_failed", { phid: doc.dispatch_phid, detail: msg(err) });
        report.errors += 1;
      }
    }
    return report;
  }

  private nextAttemptAt(recoveryAttempts: number): string {
    const exp = Math.min(recoveryAttempts, 16); // guard against overflow
    const delay = Math.min(this.backoffMs * 2 ** exp, this.maxBackoffMs);
    return new Date(Date.parse(this.now()) + delay).toISOString();
  }
}

function toInput(doc: RecoverableDispatch): RecoveryInput {
  return {
    status: doc.status,
    failure_kind: doc.failure_kind,
    failure_detail: doc.failure_detail,
    attempt_count: doc.attempt_count,
    recovery_attempts: doc.recovery_attempts,
    artifact_path: doc.artifact_path,
    promotion_completed: doc.promotion_completed,
    channel: doc.channel,
    side_effect: doc.side_effect,
    allow_auto_retry: doc.allow_auto_retry,
  };
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Parse the recovery env config. Disabled by default during rollout. */
export function recoveryConfigFromEnv(env: NodeJS.ProcessEnv): {
  enabled: boolean;
  maxAttempts: number;
  budget: number;
  backoffMs: number;
  intervalMs: number;
} {
  const enabledRaw = (env.DISPATCH_RECOVERY_ENABLED ?? "").trim().toLowerCase();
  const enabled = enabledRaw === "true" || enabledRaw === "1" || enabledRaw === "yes";
  return {
    enabled,
    maxAttempts: posInt(env.DISPATCH_RECOVERY_MAX_ATTEMPTS) ?? 3,
    budget: posInt(env.DISPATCH_RECOVERY_BUDGET) ?? 10,
    backoffMs: posInt(env.DISPATCH_RECOVERY_BACKOFF_MS) ?? 60_000,
    intervalMs: posInt(env.DISPATCH_RECOVERY_INTERVAL_MS) ?? 300_000,
  };
}

function posInt(raw: string | undefined): number | null {
  if (raw == null) return null;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}
