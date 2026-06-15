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
import type { DispatchDoc, Provider, Runtime } from "./types.js";

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

/**
 * Usage Meter (Spec 2026-05-31): the scheduler reads a UsageGateSnapshot
 * before each claim cycle. The provider is OPTIONAL — when undefined,
 * the scheduler behaves exactly as it did pre-spec (no gating). In WARN
 * mode (the overnight default), exclusions are empty and the gate is
 * observed/logged only. In ENFORCE mode, paused agents are excluded
 * from claim — their docs stay `queued`, never failed or bounced.
 *
 * Errors from the provider NEVER throw out of the tick.
 */
export interface UsageGateProvider {
  getSnapshotForScheduler(): Promise<import("../usage-meter/types.js").UsageGateSnapshot>;
  getExcludedAgentsForClaim(): Promise<string[]>;
}

/**
 * B0 (2026-06-08): scheduler-side reader pass over B1's
 * `queries.last_output_at` evidence. The scheduler consults this seam
 * before any requeue path to (a) close out dispatches whose linked agent
 * query is already terminal — preventing the post-outage "scheduler
 * re-fires a done dispatch" failure mode the production replay tracks
 * — and (b) detect silence-based wedges that the existing
 * starting_timeout_ms / stale_in_flight_ttl_ms paths miss. Optional;
 * when omitted, the scheduler behaves exactly as it did pre-B0.
 */
export interface QueryEvidence {
  status: string;
  last_output_at: number | null;
}

export interface QueryEvidenceClient {
  getEvidence(agentQueryId: string): Promise<QueryEvidence | null>;
}

const TERMINAL_QUERY_STATUSES = new Set([
  "completed",
  "failed",
  "cancelled",
  "expired",
]);

function isTerminalSchedulerStatus(status: string): boolean {
  return status === "done" || status === "failed" || status === "cancelled";
}

export interface SchedulerServiceOptions {
  client: DispatchDocClient;
  transport: AgentTransport;
  policy: SchedulerPolicy;
  now: () => string;
  rng?: () => number;
  provider?: Provider;
  /**
   * W1-1: the provider lanes this scheduler drains each tick. Each lane is
   * swept and claimed independently with its own cap and its own in-flight
   * count, so Anthropic / OpenAI(Codex) / Cursor queues never share slots.
   * Defaults to `[provider ?? "anthropic"]` (single-lane, unchanged behavior).
   */
  providers?: Provider[];
  logger?: SchedulerLogger;
  /** Optional usage gate provider. When omitted, no usage gating. */
  usageGateProvider?: UsageGateProvider;
  /** Optional B0 evidence client. When omitted, evidence sweep is skipped. */
  queryEvidence?: QueryEvidenceClient;
}

export interface TickReport {
  claimed: number;
  started: number;
  bounced: number;
  failed: number;
  requeued: number;
  wedged_reaped: number;
  /** B0: linked agent query was already `completed`; dispatch marked done. */
  evidence_closed_done: number;
  /** B0: linked agent query was already `failed`/`cancelled`/`expired`; dispatch marked failed. */
  evidence_closed_failed: number;
  /** B0: in_flight with agent_query_id but silence > silence_threshold_ms; bounced + requeued. */
  evidence_silence_bounced: number;
  /** B0: evidence client raised or returned malformed data; counted, never thrown. */
  evidence_lookup_errors: number;
  /** B0: terminal-state guard skipped a requeue path because the doc was already terminal. */
  terminal_guard_skips: number;
  /** B11 WIP: age-based stale-in-flight detector marked the dispatch failed. */
  stale_in_flight_failed: number;
  cap_decision: { max_safe: number; reason: string; source: string };
  usage_gate?: {
    enforcement: "warn" | "enforce";
    global_state: string;
    excluded_agents: string[];
    error?: string;
  };
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
  private providers: Provider[];
  private logger: SchedulerLogger;
  private budgetState: BudgetState = "ok";
  private usageGateProvider?: UsageGateProvider;
  private queryEvidence?: QueryEvidenceClient;

  constructor(opts: SchedulerServiceOptions) {
    this.client = opts.client;
    this.transport = opts.transport;
    this.policy = opts.policy;
    this.now = opts.now;
    this.rng = opts.rng ?? Math.random;
    this.provider = opts.provider ?? "anthropic";
    // De-dup while preserving order; default to the single primary lane so
    // existing single-provider construction is behaviorally unchanged.
    this.providers = Array.from(
      new Set(opts.providers && opts.providers.length > 0 ? opts.providers : [this.provider]),
    );
    this.logger = opts.logger ?? NULL_LOGGER;
    this.usageGateProvider = opts.usageGateProvider;
    this.queryEvidence = opts.queryEvidence;
  }

  setUsageGateProvider(p: UsageGateProvider | undefined): void {
    this.usageGateProvider = p;
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
      evidence_closed_done: 0,
      evidence_closed_failed: 0,
      evidence_silence_bounced: 0,
      evidence_lookup_errors: 0,
      terminal_guard_skips: 0,
      stale_in_flight_failed: 0,
      cap_decision: { max_safe: 0, reason: "", source: "" },
    };

    // W1-1: drain each provider lane independently. The usage gate is
    // agent-scoped (not provider-scoped), so it is computed at most once per
    // tick — lazily, the first time any lane actually has slots to claim.
    let excludeCache: string[] | null = null;
    const getExcludedAgents = async (): Promise<string[]> => {
      if (excludeCache) return excludeCache;
      excludeCache = await this.computeExcludedAgents(report);
      return excludeCache;
    };

    for (const provider of this.providers) {
      // B0: evidence-driven closeout runs FIRST so any in_flight dispatch
      // whose linked agent query is already terminal gets the correct
      // scheduler-side terminal transition before reapWedgedInFlight or
      // sweepBounced get a chance to re-fire it.
      await this.applyQueryEvidenceToInFlight(report, provider);

      report.wedged_reaped += await this.reapWedgedInFlight(report, provider);

      // B11 WIP: age-based stale-in-flight detector runs after wedged-reap
      // and before sweepBounced. Catches dispatches that never produced a
      // last_output_at stamp at all (so the B0 silence detector can't see
      // them). Complementary defense-in-depth.
      const staleFailed = await this.failStaleInFlight(provider);
      report.stale_in_flight_failed += staleFailed;
      report.failed += staleFailed;

      report.requeued += await this.sweepBounced(report, provider);

      await this.claimAndStartLane(provider, report, getExcludedAgents);
    }

    return report;
  }

  /**
   * W1-1: compute the cap, snapshot, and claim for ONE provider lane. Each
   * lane uses its own provider cap and counts only its own in-flight dispatches
   * (the reactor scopes claim/snapshot by provider), so no lane consumes
   * another lane's concurrency slots. A full / errored lane simply yields no
   * claims and does not block the other lanes.
   */
  private async claimAndStartLane(
    provider: Provider,
    report: TickReport,
    getExcludedAgents: () => Promise<string[]>,
  ): Promise<void> {
    const safe = getSafeConcurrency(
      {
        provider,
        runtime: representativeRuntimeForProvider(provider),
        budget_state: this.budgetState,
        current_in_flight: await this.countInFlight(provider),
      },
      this.policy,
    );
    // Report the primary lane's cap decision for back-compat with single-lane
    // observers; multi-lane callers should read per-lane snapshots.
    if (provider === this.providers[0]) {
      report.cap_decision = {
        max_safe: safe.max_safe,
        reason: safe.reason,
        source: safe.source,
      };
    }

    const snap = await this.client.concurrencySnapshot({
      max_safe: safe.max_safe,
      provider,
    });
    if (!snap.ok) {
      this.logger.error("scheduler_snapshot_failed", { detail: snap.detail, provider });
      return;
    }
    const slots = Math.max(0, safe.max_safe - snap.value.in_flight);
    if (slots === 0) {
      this.logger.info("scheduler_no_slots", {
        provider,
        in_flight: snap.value.in_flight,
        max_safe: safe.max_safe,
        budget: this.budgetState,
      });
      return;
    }

    const excludeAgents = await getExcludedAgents();

    const claimResult = await this.client.claimForStart({
      limit: Math.min(slots, this.policy.claim_batch_limit),
      provider,
      now: this.now(),
      max_in_flight: safe.max_safe,
      exclude_agents: excludeAgents.length > 0 ? excludeAgents : undefined,
    });
    if (!claimResult.ok) {
      this.logger.error("scheduler_claim_failed", { detail: claimResult.detail, provider });
      return;
    }
    report.claimed += claimResult.value.length;

    for (const doc of claimResult.value) {
      await this.startOne(doc, report);
    }
  }

  /**
   * Usage Meter gate (Spec 2026-05-31): excluded agents for claim. Agent-
   * scoped, provider-agnostic. Always [] in WARN mode and on any provider
   * error. Wedged-reap and /agent-done / /agent-needs-input / monitor routes
   * are NEVER gated — only new claims.
   */
  private async computeExcludedAgents(report: TickReport): Promise<string[]> {
    if (!this.usageGateProvider) return [];
    try {
      const snap = await this.usageGateProvider.getSnapshotForScheduler();
      const excludeAgents = await this.usageGateProvider.getExcludedAgentsForClaim();
      report.usage_gate = {
        enforcement: snap.enforcement,
        global_state: snap.global.state,
        excluded_agents: excludeAgents,
      };
      if (excludeAgents.length > 0 || snap.global.state !== "normal") {
        this.logger.info("scheduler_usage_gate", {
          enforcement: snap.enforcement,
          global_state: snap.global.state,
          excluded_agents: excludeAgents,
          decision: snap.global.decision,
        });
      }
      return excludeAgents;
    } catch (err) {
      // Never throw out of the tick.
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn("scheduler_usage_gate_failed", { detail: msg });
      report.usage_gate = {
        enforcement: "warn",
        global_state: "degraded",
        excluded_agents: [],
        error: msg,
      };
      return [];
    }
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

  private async sweepBounced(report: TickReport, provider: Provider = this.provider): Promise<number> {
    const bounced = await this.client.dispatchBounceRetries({
      provider,
    });
    if (!bounced.ok) return 0;
    const now = this.now();
    let count = 0;
    for (const doc of bounced.value) {
      if (doc.not_before_at > now) continue;
      // B0 terminal-state defense: re-fetch right before any mutation so
      // a doc that transitioned to a terminal state between the list and
      // the mutation is not requeued. The production failure mode this
      // guards against: post-outage manager restart finds a "bounced"
      // row, agent's /agent-done already terminalised it, scheduler
      // would otherwise re-fire it.
      if (await this.docIsTerminal(doc.dispatch_phid, report)) continue;
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

  private async reapWedgedInFlight(report: TickReport, provider: Provider = this.provider): Promise<number> {
    const inflight = await this.client.dispatchesInFlight({
      provider,
    });
    if (!inflight.ok) return 0;
    const nowMs = Date.parse(this.now());
    let reaped = 0;
    for (const doc of inflight.value) {
      if (doc.agent_query_id) continue;
      if (!doc.started_at) continue;
      const age = nowMs - Date.parse(doc.started_at);
      if (age < this.policy.starting_timeout_ms) continue;
      // B0 terminal-state defense: same rationale as sweepBounced.
      if (await this.docIsTerminal(doc.dispatch_phid, report)) continue;
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

  /**
   * B0 — defense-in-depth re-fetch. The list APIs filter by
   * status === in_flight / bounced, but a concurrent operator
   * intervention or /agent-done could have flipped the row terminal
   * between the list snapshot and the mutation. Re-read by phid right
   * before mutation and skip when terminal. Counted in the report so
   * the production replay can assert on the skip rate.
   */
  private async docIsTerminal(phid: string, report: TickReport): Promise<boolean> {
    const got = await this.client.getByPhid(phid);
    if (!got.ok) {
      // Read failure is treated as "do not mutate" to err on the safe
      // side: a transient read miss is better than a duplicate dispatch
      // emit. Logged for visibility.
      this.logger.warn("scheduler_terminal_guard_read_failed", {
        phid,
        detail: got.detail,
      });
      report.terminal_guard_skips += 1;
      return true;
    }
    if (isTerminalSchedulerStatus(got.value.status)) {
      report.terminal_guard_skips += 1;
      this.logger.warn("scheduler_terminal_guard_skipped", {
        phid,
        status: got.value.status,
      });
      return true;
    }
    return false;
  }

  /**
   * B0 — evidence-driven closeout. For every in_flight dispatch that
   * carries an agent_query_id, consult the query-evidence client to
   * learn the agent-side state. Three branches:
   *
   *   1. Linked query is terminal (`completed`) → markDone the dispatch.
   *      This is the load-bearing fix for the production failure where
   *      the agent already called /agent-done before the manager
   *      outage, but the dispatch row stayed `in_flight`. Without this
   *      step, reapWedgedInFlight (and any age-based detector) would
   *      eventually re-fire the dispatch.
   *
   *   2. Linked query is terminal-failure (`failed`/`cancelled`/`expired`)
   *      → markFailed the dispatch with `agent_error`. Same rationale,
   *      different outcome.
   *
   *   3. Linked query is still in-flight but `last_output_at` is older
   *      than `silence_threshold_ms` → markBounced + requeueAfterBounce.
   *      Distinct from canes age-based `failStaleInFlight`: silence is
   *      "no progress observed", which is a meaningful signal when the
   *      query has been processing for a while without any output.
   *
   * Errors are soft: the dispatch is left in_flight and the counter
   * increments. The tick never throws on evidence-client failures.
   */
  private async applyQueryEvidenceToInFlight(report: TickReport, provider: Provider = this.provider): Promise<void> {
    if (!this.queryEvidence) return;
    const inflight = await this.client.dispatchesInFlight({
      provider,
    });
    if (!inflight.ok) return;
    const nowMs = Date.parse(this.now());
    for (const doc of inflight.value) {
      if (!doc.agent_query_id) continue;
      let evidence: QueryEvidence | null;
      try {
        evidence = await this.queryEvidence.getEvidence(doc.agent_query_id);
      } catch (err) {
        report.evidence_lookup_errors += 1;
        this.logger.warn("scheduler_evidence_lookup_failed", {
          phid: doc.dispatch_phid,
          agent_query_id: doc.agent_query_id,
          detail: err instanceof Error ? err.message : String(err),
        });
        continue;
      }
      if (!evidence) continue;

      if (evidence.status === "completed") {
        const r = await this.client.markDone(doc.dispatch_phid);
        if (r.ok) {
          report.evidence_closed_done += 1;
          this.logger.info("scheduler_evidence_closed_done", {
            phid: doc.dispatch_phid,
            agent_query_id: doc.agent_query_id,
          });
        }
        continue;
      }
      if (TERMINAL_QUERY_STATUSES.has(evidence.status)) {
        const r = await this.client.markFailed(doc.dispatch_phid, {
          failure_kind: "agent_error",
          detail: `linked query terminated ${evidence.status}`,
        });
        if (r.ok) {
          report.evidence_closed_failed += 1;
          this.logger.warn("scheduler_evidence_closed_failed", {
            phid: doc.dispatch_phid,
            agent_query_id: doc.agent_query_id,
            query_status: evidence.status,
          });
        }
        continue;
      }

      // Non-terminal: silence detector.
      if (this.policy.silence_threshold_ms <= 0) continue;
      if (evidence.last_output_at == null) continue;
      const silence = nowMs - evidence.last_output_at;
      if (silence < this.policy.silence_threshold_ms) continue;
      if (doc.attempt_count >= this.policy.rate_limit_max_attempts) {
        const ex = await this.client.markRetryExhausted(
          doc.dispatch_phid,
          `silence ${silence}ms past threshold and attempts ${doc.attempt_count} exhausted`,
        );
        if (ex.ok) {
          this.logger.warn("scheduler_evidence_silence_exhausted", {
            phid: doc.dispatch_phid,
            silence_ms: silence,
          });
        }
        continue;
      }
      // Use the rate_limit_backoff_initial_ms as the silence-bounce
      // gap so sweepBounced does not requeue the dispatch in the very
      // same tick (which would cause a tight bounce/requeue/claim
      // loop and burn attempt budget). A 30s default gives the
      // operator a real window to observe before the next attempt.
      const nextAt = new Date(
        nowMs + Math.max(1_000, this.policy.rate_limit_backoff_initial_ms),
      ).toISOString();
      const b = await this.client.markBounced(doc.dispatch_phid, {
        kind: "scheduler_silence",
        message: `silence ${silence}ms past threshold ${this.policy.silence_threshold_ms}ms`,
        next_attempt_at: nextAt,
      });
      if (!b.ok) continue;
      // Intentionally do NOT requeueAfterBounce here — leave the dispatch
      // in bounced state with the backoff above. sweepBounced will pick
      // it up on the first tick after `next_attempt_at`. Keeps the
      // bounce / requeue separation clean and consistent with the
      // existing provider-throttle path.
      report.evidence_silence_bounced += 1;
      this.logger.warn("scheduler_evidence_silence_bounced", {
        phid: doc.dispatch_phid,
        agent_query_id: doc.agent_query_id,
        silence_ms: silence,
      });
    }
  }

  /**
   * B11 WIP — age-based stale-in-flight detector. Distinct from B0's
   * applyQueryEvidenceToInFlight (which is silence-aware, consuming
   * `last_output_at`). This one catches the case where a dispatch was
   * claimed and never produced a `last_output_at` stamp at all — e.g.,
   * the agent process died mid-startup. Defense in depth.
   */
  private async failStaleInFlight(provider: Provider = this.provider): Promise<number> {
    const inflight = await this.client.dispatchesInFlight({
      provider,
    });
    if (!inflight.ok) return 0;
    const nowMs = Date.parse(this.now());
    let failed = 0;
    for (const doc of inflight.value) {
      if (!doc.agent_query_id) continue;
      const startedMs = Date.parse(doc.started_at ?? doc.updated_at);

      // fix/dispatch-expiry-too-aggressive: measure INACTIVITY from the last
      // sign of progress, not raw claim age. A dispatch that is still actively
      // producing output (recent B1 `last_output_at`) must never be expired by
      // this backstop, no matter how long the overall build runs. When no
      // progress evidence is available (the agent never produced a
      // last_output_at — e.g. process died at startup), we fall back to claim
      // age so the backstop still catches a truly wedged dispatch.
      let lastActivityMs = startedMs;
      let hadProgress = false;
      if (this.queryEvidence) {
        try {
          const evidence = await this.queryEvidence.getEvidence(doc.agent_query_id);
          if (evidence && evidence.last_output_at != null) {
            hadProgress = true;
            lastActivityMs = Math.max(lastActivityMs, evidence.last_output_at);
          }
        } catch {
          // Evidence lookup failure → conservatively fall back to claim age.
        }
      }
      const inactivity = nowMs - lastActivityMs;
      if (inactivity < this.policy.stale_in_flight_ttl_ms) continue;
      const r = await this.client.markFailed(doc.dispatch_phid, {
        failure_kind: "scheduler_wedged",
        detail: hadProgress
          ? `stale in_flight: no progress for ${inactivity}ms (last_output_at) with agent_query_id=${doc.agent_query_id}`
          : `stale in_flight claim with agent_query_id=${doc.agent_query_id} for ${inactivity}ms (no progress evidence)`,
      });
      if (r.ok) {
        failed += 1;
        this.logger.warn("scheduler_stale_in_flight_failed", {
          phid: doc.dispatch_phid,
          agent_query_id: doc.agent_query_id,
          inactivity_ms: inactivity,
          had_progress_evidence: hadProgress,
          stale_in_flight_ttl_ms: this.policy.stale_in_flight_ttl_ms,
        });
      }
    }
    return failed;
  }

  private async countInFlight(provider: Provider = this.provider): Promise<number> {
    const r = await this.client.dispatchesInFlight({ provider });
    return r.ok ? r.value.length : 0;
  }
}

/**
 * W1-1: a representative runtime for a provider lane, used only to populate
 * SafeConcurrencyInput.runtime (the cap is keyed off provider). Pure.
 */
export function representativeRuntimeForProvider(provider: Provider): Runtime {
  switch (provider) {
    case "anthropic":
      return "claude-code-cli";
    case "openai":
      return "codex";
    case "cursor":
      return "cursor-cli";
    default:
      return "other";
  }
}
