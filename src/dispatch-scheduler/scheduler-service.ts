// Phase 3.1 + 3.3 + 3.4: the scheduler-service loop.
//
// Each tick():
//   1. Sweep stale in_flight docs (started_at older than starting_timeout_ms
//      AND no agent_query_id) → return to queued.
//   2. Sweep bounced docs whose not_before_at <= now → requeueAfterBounce,
//      unless attempt_count >= rate_limit_max_attempts then markRetryExhausted.
//   3. Read concurrency snapshot, get safe cap from policy, compute slots.
//   4. Claim up to slots eligible queued docs.
//   5. For each claimed: post agent /talk via transport.
//        - ok + agent_query_id  → recordAgentStart
//        - ok + no agent_query_id → leave in_flight; sweep step (1) reaps it
//        - !ok + retryable      → markBounced w/ backoff next_attempt_at
//        - !ok + !retryable     → markFailed
//
// All transport / IO goes through injected interfaces so the loop is fully
// testable with no real Reactor and no real HTTP.

import type { DispatchDocClient } from "./dispatch-doc-client.js";
import {
  type BudgetState,
  type SchedulerPolicy,
  getSafeConcurrency,
} from "./policy.js";
import { computeNextAttemptAt } from "./backoff.js";
import { classifyAgentStartError } from "./throttle-classifier.js";
import type { DispatchDoc, Provider } from "./types.js";

export type AgentTransportResult =
  | { ok: true; agent_query_id: string }
  | {
      ok: false;
      status: number;
      body: string;
      cause?: "transport" | "local_usage_pause" | "http";
      transportError?: string;
    };

export interface AgentTransport {
  sendTalk(doc: DispatchDoc): Promise<AgentTransportResult>;
}

export interface SchedulerServiceOptions {
  client: DispatchDocClient;
  transport: AgentTransport;
  policy: SchedulerPolicy;
  now: () => string;
  rng?: () => number;
  provider?: Provider;
  logger?: SchedulerLogger;
}

export interface TickReport {
  claimed: number;
  started: number;
  bounced: number;
  failed: number;
  requeued: number;
  wedged_reaped: number;
  cap_decision: { max_safe: number; reason: string; source: string };
}

export interface SchedulerLogger {
  info(event: string, payload: Record<string, unknown>): void;
  warn(event: string, payload: Record<string, unknown>): void;
  error(event: string, payload: Record<string, unknown>): void;
}

const NULL_LOGGER: SchedulerLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

export class SchedulerService {
  private client: DispatchDocClient;
  private transport: AgentTransport;
  private policy: SchedulerPolicy;
  private now: () => string;
  private rng: () => number;
  private provider: Provider;
  private logger: SchedulerLogger;
  private budgetState: BudgetState = "ok";

  constructor(opts: SchedulerServiceOptions) {
    this.client = opts.client;
    this.transport = opts.transport;
    this.policy = opts.policy;
    this.now = opts.now;
    this.rng = opts.rng ?? Math.random;
    this.provider = opts.provider ?? "anthropic";
    this.logger = opts.logger ?? NULL_LOGGER;
  }

  setBudgetState(state: BudgetState): void {
    this.budgetState = state;
  }

  async tick(): Promise<TickReport> {
    const report: TickReport = {
      claimed: 0,
      started: 0,
      bounced: 0,
      failed: 0,
      requeued: 0,
      wedged_reaped: 0,
      cap_decision: { max_safe: 0, reason: "", source: "" },
    };

    const wedged = await this.reapWedgedInFlight();
    report.wedged_reaped = wedged;

    const requeued = await this.sweepBounced();
    report.requeued = requeued;

    const safe = getSafeConcurrency(
      {
        provider: this.provider,
        runtime: "claude-code-cli",
        budget_state: this.budgetState,
        current_in_flight: await this.countInFlight(),
      },
      this.policy,
    );
    report.cap_decision = {
      max_safe: safe.max_safe,
      reason: safe.reason,
      source: safe.source,
    };

    const snap = await this.client.concurrencySnapshot({
      max_safe: safe.max_safe,
      provider: this.provider,
    });
    if (!snap.ok) {
      this.logger.error("scheduler_snapshot_failed", { detail: snap.detail });
      return report;
    }
    const slots = Math.max(0, safe.max_safe - snap.value.in_flight);
    if (slots === 0) {
      this.logger.info("scheduler_no_slots", {
        in_flight: snap.value.in_flight,
        max_safe: safe.max_safe,
        budget: this.budgetState,
      });
      return report;
    }

    const claimResult = await this.client.claimForStart({
      limit: Math.min(slots, this.policy.claim_batch_limit),
      provider: this.provider,
      now: this.now(),
      max_in_flight: safe.max_safe,
    });
    if (!claimResult.ok) {
      this.logger.error("scheduler_claim_failed", { detail: claimResult.detail });
      return report;
    }
    report.claimed = claimResult.value.length;

    for (const doc of claimResult.value) {
      await this.startOne(doc, report);
    }
    return report;
  }

  private async startOne(doc: DispatchDoc, report: TickReport): Promise<void> {
    let result: AgentTransportResult;
    try {
      result = await this.transport.sendTalk(doc);
    } catch (err) {
      result = {
        ok: false,
        status: 0,
        body: "",
        cause: "transport",
        transportError: err instanceof Error ? err.message : String(err),
      };
    }

    if (result.ok) {
      if (result.agent_query_id && result.agent_query_id.length > 0) {
        const start = await this.client.recordAgentStart(
          doc.dispatch_phid,
          result.agent_query_id,
        );
        if (start.ok) {
          report.started += 1;
          this.logger.info("scheduler_start_ok", {
            phid: doc.dispatch_phid,
            agent_query_id: result.agent_query_id,
          });
        } else {
          this.logger.warn("scheduler_recordAgentStart_failed", {
            phid: doc.dispatch_phid,
            detail: start.detail,
          });
        }
      } else {
        // Transport said OK but didn't give us an agent_query_id. Leave
        // the doc in_flight; the wedged-reap sweep will return it to
        // queued after starting_timeout_ms.
        this.logger.warn("scheduler_start_missing_query_id", {
          phid: doc.dispatch_phid,
        });
      }
      return;
    }

    const classified = classifyAgentStartError({
      provider: this.provider,
      status: result.status,
      body: result.body,
      cause: result.cause,
      transportError: result.transportError,
    });

    if (
      classified.kind === "provider_throttle" ||
      classified.kind === "transport"
    ) {
      // Retryable. Compute backoff from attempt_count (already incremented
      // by claimForStart). If we've hit max attempts, mark exhausted.
      if (doc.attempt_count >= this.policy.rate_limit_max_attempts) {
        const ex = await this.client.markRetryExhausted(
          doc.dispatch_phid,
          `${classified.kind} after ${doc.attempt_count} attempts`,
        );
        if (ex.ok) {
          report.failed += 1;
          this.logger.warn("scheduler_retry_exhausted", {
            phid: doc.dispatch_phid,
            attempts: doc.attempt_count,
          });
        }
        return;
      }
      const next = computeNextAttemptAt(
        this.now(),
        doc.attempt_count,
        this.policy,
        this.rng,
      );
      const b = await this.client.markBounced(doc.dispatch_phid, {
        kind: classified.kind,
        message: classified.detail,
        next_attempt_at: next,
      });
      if (b.ok) {
        report.bounced += 1;
        this.logger.warn("scheduler_bounced", {
          phid: doc.dispatch_phid,
          attempt: doc.attempt_count,
          next_attempt_at: next,
          kind: classified.kind,
        });
      } else {
        this.logger.error("scheduler_markBounced_failed", {
          phid: doc.dispatch_phid,
          detail: b.detail,
        });
      }
      return;
    }

    // Non-retryable: mark failed.
    const f = await this.client.markFailed(doc.dispatch_phid, {
      failure_kind: "agent_error",
      detail: classified.detail,
    });
    if (f.ok) {
      report.failed += 1;
      this.logger.warn("scheduler_failed", {
        phid: doc.dispatch_phid,
        kind: classified.kind,
      });
    }
  }

  private async sweepBounced(): Promise<number> {
    const bounced = await this.client.dispatchBounceRetries({
      provider: this.provider,
    });
    if (!bounced.ok) return 0;
    const now = this.now();
    let count = 0;
    for (const doc of bounced.value) {
      if (doc.not_before_at > now) continue;
      if (doc.attempt_count >= this.policy.rate_limit_max_attempts) {
        const ex = await this.client.markRetryExhausted(
          doc.dispatch_phid,
          `bounce_count=${doc.bounce_count} attempts=${doc.attempt_count}`,
        );
        if (ex.ok) {
          this.logger.warn("scheduler_retry_exhausted_sweep", {
            phid: doc.dispatch_phid,
            attempts: doc.attempt_count,
          });
        }
        continue;
      }
      const r = await this.client.requeueAfterBounce(doc.dispatch_phid);
      if (r.ok) {
        count += 1;
        this.logger.info("scheduler_requeued", {
          phid: doc.dispatch_phid,
          attempt: doc.attempt_count,
        });
      }
    }
    return count;
  }

  private async reapWedgedInFlight(): Promise<number> {
    const inflight = await this.client.dispatchesInFlight({
      provider: this.provider,
    });
    if (!inflight.ok) return 0;
    const nowMs = Date.parse(this.now());
    let reaped = 0;
    for (const doc of inflight.value) {
      if (doc.agent_query_id) continue;
      if (!doc.started_at) continue;
      const age = nowMs - Date.parse(doc.started_at);
      if (age < this.policy.starting_timeout_ms) continue;
      // Wedged start. Return to queued by marking bounced with an
      // immediate next_attempt_at (zero backoff for wedged starts —
      // they are not provider throttles), then requeueing.
      const wedgedAt = new Date(nowMs).toISOString();
      const b = await this.client.markBounced(doc.dispatch_phid, {
        kind: "scheduler_wedged",
        message: `in_flight without agent_query_id for ${age}ms`,
        next_attempt_at: wedgedAt,
      });
      if (!b.ok) continue;
      const r = await this.client.requeueAfterBounce(doc.dispatch_phid);
      if (r.ok) {
        reaped += 1;
        this.logger.warn("scheduler_wedged_reaped", {
          phid: doc.dispatch_phid,
          age_ms: age,
        });
      }
    }
    return reaped;
  }

  private async countInFlight(): Promise<number> {
    const r = await this.client.dispatchesInFlight({ provider: this.provider });
    return r.ok ? r.value.length : 0;
  }
}
