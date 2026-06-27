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
  landedByCommitEvidenceOnly,
  type DispatchRecoveryDecision,
  type RecoveryConfig,
  type RecoveryInput,
} from "./classifier.js";

export interface RecoverableDispatch extends Omit<RecoveryInput, never> {
  dispatch_phid: string;
  /** D3 commit-evidence inputs (from the row's promotion metadata). The service
   *  uses these to probe git for the actual landed state. All optional — absent
   *  rows simply skip the commit-evidence pass. */
  promoted_sha?: string | null;
  repo_path?: string | null;
  base?: string | null;
  /** T13.3: raw promotion result so the live emitter can verify the promoted
   *  commit against EVERY repo's base (not just repo[0]) + completed-promotion. */
  promotion_result_json?: string | null;
}

/**
 * D3: git ground-truth probe. Given a repo + base + commit SHA, answer whether
 * that commit is present/verified on the base branch. Injected so the service
 * is unit-testable with a fake; the manager wires a real `git` implementation.
 * Returns null when the answer can't be determined (probe error / missing repo);
 * the service treats null as "no evidence" (never a false landed).
 */
export interface CommitEvidenceProbe {
  verifyCommitOnBase(args: {
    repoPath: string;
    base: string;
    sha: string;
  }): Promise<boolean | null>;
}

export interface DispatchRecoveryReactor {
  /** Terminal-failed dispatches eligible for a recovery pass. */
  listFailedForRecovery(): Promise<RecoverableDispatch[]>;
  /** T1.11: the wide (no-lookback) boot-backfill scan over already-stuck rows in
   *  the targeted failure-reason set. Optional so legacy reactors still satisfy
   *  the interface; when absent the backfill is a safe no-op. */
  listStuckForBackfill?(opts?: {
    failureKinds?: string[];
    detailMarkers?: string[];
    limit?: number;
  }): Promise<RecoverableDispatch[]>;
  /** Reuse bounced/requeue machinery: markBounced(kind:"recovery") + requeue. */
  requeueForRecovery(
    phid: string,
    args: { reason: string; next_attempt_at: string },
  ): Promise<boolean>;
  /** Reconcile a dispatch whose work actually landed (artifact/promotion/commit).
   *  opts.recovery_status overrides the persisted state (e.g. "verified_done"
   *  for commit-evidence landings). */
  markRecoveryLanded(
    phid: string,
    opts?: { recovery_status?: string; reason?: string },
  ): Promise<void>;
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
  /** D3: optional git ground-truth probe. When present, a failed/expired row
   *  with promotion metadata is checked against the real base before being
   *  retried — catching the lost-closeout false-expire. */
  commitEvidence?: CommitEvidenceProbe;
  logger?: RecoveryLogger;
}

/** T1.11 counters surfaced on /health + /monitor/fleet. */
export interface RecoveryBackfillMetrics {
  recovery_backfill_runs_total: number;
  recovery_backfill_rows_reclassified_total: number;
}

export interface BackfillReport {
  skipped: boolean;
  runs_total: number;
  scanned: number;
  reclassified: number;
  left: number;
  errors: number;
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
  private commitEvidence: CommitEvidenceProbe | null;
  private logger: RecoveryLogger;
  private interval: ReturnType<typeof setInterval> | null = null;
  // T1.11 backfill metrics (monotonic for the lifetime of the manager process).
  private backfillRunsTotal = 0;
  private backfillRowsReclassifiedTotal = 0;

  constructor(opts: DispatchRecoveryServiceOptions) {
    this.reactor = opts.reactor;
    this.config = opts.config;
    this.now = opts.now;
    this.enabled = opts.enabled;
    this.budget = opts.budget;
    this.backoffMs = opts.backoffMs;
    this.maxBackoffMs = opts.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
    this.commitEvidence = opts.commitEvidence ?? null;
    this.logger = opts.logger ?? NULL_LOGGER;
  }

  /**
   * Start the periodic recovery loop. Idempotent; a no-op when disabled. Runs
   * one pass immediately (boot-time backfill of already-stuck rows) then every
   * `intervalMs`. runOnce never throws, so the manager loop is never taken down.
   */
  start(intervalMs: number): void {
    if (!this.enabled || this.interval) return;
    // T1.11: one-time wide boot backfill (reconciles already-landed work that is
    // older than the periodic lookback window), then the periodic loop.
    void this.runBackfill();
    void this.runOnce();
    this.interval = setInterval(() => {
      void this.runOnce();
    }, intervalMs);
    if (this.interval.unref) this.interval.unref();
  }

  /** Current backfill metrics for /health + /monitor/fleet. */
  getBackfillMetrics(): RecoveryBackfillMetrics {
    return {
      recovery_backfill_runs_total: this.backfillRunsTotal,
      recovery_backfill_rows_reclassified_total: this.backfillRowsReclassifiedTotal,
    };
  }

  /**
   * T1.11 boot-time backfill. A wide, lookback-free sweep over already-stuck
   * {failed} rows in the targeted failure-reason set (the pre-restart casualty
   * wave). Reconciles LANDED work (commit/promotion/artifact evidence) OUT of
   * failed; never retries here (the periodic runOnce owns retries under budget).
   * Idempotent: reconciled rows become `done` and fall out of the next scan;
   * non-landed rows are left untouched and classify the same way every pass.
   * Never throws.
   */
  async runBackfill(): Promise<BackfillReport> {
    const report: BackfillReport = {
      skipped: false,
      runs_total: this.backfillRunsTotal,
      scanned: 0,
      reclassified: 0,
      left: 0,
      errors: 0,
    };
    if (!this.enabled || !this.reactor.listStuckForBackfill) {
      report.skipped = true;
      return report;
    }
    this.backfillRunsTotal += 1;
    report.runs_total = this.backfillRunsTotal;

    let docs: RecoverableDispatch[];
    try {
      docs = await this.reactor.listStuckForBackfill();
    } catch (err) {
      this.logger.warn("recovery_backfill_list_failed", { detail: msg(err) });
      report.errors += 1;
      return report;
    }
    report.scanned = docs.length;

    for (const doc of docs) {
      try {
        const resolved = await this.resolveCommitEvidence(doc);
        const input = toInput(resolved);
        const decision = classifyRecovery(input, this.config);
        if (decision.decision === "landed") {
          const verifiedDone = landedByCommitEvidenceOnly(input);
          await this.reactor.markRecoveryLanded(
            doc.dispatch_phid,
            verifiedDone
              ? {
                  recovery_status: "verified_done",
                  reason: `backfill: commit ${resolved.promoted_sha} verified on ${resolved.repo_path ?? "?"}@${resolved.base ?? "main"}`,
                }
              : { reason: "backfill: landed evidence present" },
          );
          report.reclassified += 1;
          this.backfillRowsReclassifiedTotal += 1;
          this.logger.info("recovery_backfill_reclassified", {
            phid: doc.dispatch_phid,
            via: verifiedDone ? "commit_evidence" : "artifact_or_promotion",
          });
        } else {
          // Not landed — leave for the periodic recovery / operator surface.
          report.left += 1;
        }
      } catch (err) {
        this.logger.warn("recovery_backfill_apply_failed", {
          phid: doc.dispatch_phid,
          detail: msg(err),
        });
        report.errors += 1;
      }
    }
    this.logger.info("recovery_backfill_done", {
      scanned: report.scanned,
      reclassified: report.reclassified,
      runs_total: this.backfillRunsTotal,
    });
    return report;
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
        // D3/T13.3: gather git ground-truth (across ALL promotion repos) before
        // classifying, so a failed/expired row whose commit actually landed is
        // reconciled, not retried. runOnce runs every cycle, so this is the live
        // effective_state emitter — the dispatch-queue UI stays truthful without
        // a manual backfill.
        const resolved = await this.resolveCommitEvidence(doc);
        const input = toInput(resolved);
        const decision = classifyRecovery(input, this.config);
        switch (decision.decision) {
          case "landed": {
            const verifiedDone = landedByCommitEvidenceOnly(input);
            await this.reactor.markRecoveryLanded(
              doc.dispatch_phid,
              verifiedDone
                ? {
                    recovery_status: "verified_done",
                    reason: `commit ${resolved.promoted_sha} verified on ${resolved.repo_path ?? "?"}@${resolved.base ?? "main"}`,
                  }
                : undefined,
            );
            report.landed += 1;
            this.logger.info("recovery_landed", {
              phid: doc.dispatch_phid,
              via: verifiedDone ? "commit_evidence" : "artifact_or_promotion",
            });
            break;
          }
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

  /**
   * Resolve git commit evidence for a failed/expired row. Spends a probe only
   * when it could change the outcome: the row isn't already known-landed and it
   * carries a promoted SHA + repo. A null/false probe result leaves the row
   * unchanged (never a false landed). Never throws.
   */
  private async resolveCommitEvidence(doc: RecoverableDispatch): Promise<RecoverableDispatch> {
    if (!this.commitEvidence) return doc;
    if (doc.commit_verified_on_base === true) return doc;
    if (doc.promotion_completed === true) return doc; // already landed by flag

    // T13.3: a dispatch can promote to a DIFFERENT repo than id-agents
    // (agent-platform, kapelle-site, cane, …). Verify the promoted commit against
    // EVERY repo in the promotion result, not just repo[0] — the single-repo
    // check is what left those casualties stuck failed_needs_operator.
    const repos = parsePromotionRepos(doc.promotion_result_json);
    if (repos.length === 0 && doc.promoted_sha && doc.repo_path) {
      repos.push({ promoted_sha: doc.promoted_sha, path: doc.repo_path, base: doc.base ?? null });
    }
    for (const repo of repos) {
      const sha = typeof repo.promoted_sha === "string" && repo.promoted_sha ? repo.promoted_sha : null;
      const path = typeof repo.path === "string" && repo.path ? repo.path : null;
      if (!sha || !path) continue;
      const base = typeof repo.base === "string" && repo.base ? repo.base : "main";
      try {
        const verified = await this.commitEvidence.verifyCommitOnBase({ repoPath: path, base, sha });
        if (verified === true) {
          this.logger.info("recovery_commit_evidence_verified", { phid: doc.dispatch_phid, sha, repo: path, base });
          return { ...doc, commit_verified_on_base: true, promoted_sha: sha, repo_path: path, base };
        }
      } catch (err) {
        this.logger.warn("recovery_commit_evidence_failed", { phid: doc.dispatch_phid, repo: path, detail: msg(err) });
      }
    }
    return doc;
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
    agent_query_id: doc.agent_query_id,
    attempt_count: doc.attempt_count,
    recovery_attempts: doc.recovery_attempts,
    artifact_path: doc.artifact_path,
    promotion_completed: doc.promotion_completed,
    commit_verified_on_base: doc.commit_verified_on_base ?? null,
    channel: doc.channel,
    side_effect: doc.side_effect,
    allow_auto_retry: doc.allow_auto_retry,
  };
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Parse the repos array out of a promotion_result_json string (T13.3). */
function parsePromotionRepos(json: string | null | undefined): Array<Record<string, unknown>> {
  if (!json) return [];
  try {
    const j = JSON.parse(json) as { repos?: unknown };
    return Array.isArray(j?.repos) ? (j.repos as Array<Record<string, unknown>>) : [];
  } catch {
    return [];
  }
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
