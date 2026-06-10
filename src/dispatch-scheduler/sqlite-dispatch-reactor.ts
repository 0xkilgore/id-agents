// SQLite-backed canonical store for the scheduler queue.
//
// Implements the DispatchReactor interface from FakeReactor — the
// FakeReactor is the test contract; this is the production contract.
// Same 28+ lifecycle tests pass against either implementation.
//
// Single-writer concurrency: better-sqlite3 prepares statements
// in-process and `claim()` is serialised through a JS-side lock so
// the same dispatch_phid cannot be claimed twice. Atomic
// `max_in_flight` check happens inside the lock against the current
// row state.

import type { SqliteAdapter } from "../db/sqlite-adapter.js";
import type {
  BounceInput,
  ClaimResult,
} from "./fake-reactor.js";
import {
  type DispatchDoc,
  type EnqueueInput,
  type FailureKind,
  type Provider,
  type QueueEligibleFilter,
  type Runtime,
  type SchedulerStatus,
  type ConcurrencySnapshot,
  type BounceRecord,
  type UsagePolicySnapshot,
  type ClarificationEvent,
  type ClarificationBlocker,
  type PromotionInput,
  defaultClarificationFields,
  defaultPromotionFields,
  isTerminal,
} from "./types.js";
import { randomBytes } from "node:crypto";

interface Row {
  dispatch_phid: string;
  team_id: string;
  query_id: string;
  to_agent: string;
  from_actor: string;
  channel: string;
  subject: string;
  body_markdown: string;
  provider: Provider;
  runtime: Runtime;
  priority: number;
  status: SchedulerStatus;
  not_before_at: string;
  attempt_count: number;
  bounce_count: number;
  last_bounce_json: string | null;
  bounce_history_json: string;
  started_at: string | null;
  completed_at: string | null;
  updated_at: string;
  agent_query_id: string | null;
  usage_policy_snapshot_json: string | null;
  failure_kind: FailureKind | null;
  failure_detail: string | null;
  target_url: string | null;
  result_json: string | null;
  // Spec 054 v2 additive columns
  clarification_id: string | null;
  active_clarification_json: string | null;
  clarification_history_json: string;
  resume_delivery_status: "none" | "pending" | "delivered" | "failed";
  promote: number;
  promotion_strategy: DispatchDoc["promotion_strategy"];
  promotion_required_reason: string | null;
  promotion_result_json: string | null;
  // Spec 054 v2 Part 2 — enqueue-side promotion input JSON.
  promotion_input_json: string | null;
}

export interface SqliteDispatchReactorOptions {
  adapter: SqliteAdapter;
  teamId: string;
  now: () => string;
}

export interface EnqueueInputWithTarget extends EnqueueInput {
  target_url?: string;
}

export class SqliteDispatchReactor {
  private adapter: SqliteAdapter;
  private teamId: string;
  private nowFn: () => string;
  private claimLock: Promise<unknown> = Promise.resolve();

  constructor(opts: SqliteDispatchReactorOptions) {
    this.adapter = opts.adapter;
    this.teamId = opts.teamId;
    this.nowFn = opts.now;
  }

  now(): string {
    return this.nowFn();
  }

  setNow(nowIso: string): void {
    this.nowFn = () => nowIso;
  }

  setTeamId(teamId: string): void {
    this.teamId = teamId;
  }

  async enqueue(input: EnqueueInputWithTarget): Promise<DispatchDoc> {
    const now = this.nowFn();
    const priority = clampPriority(input.priority);
    const doc: DispatchDoc = {
      dispatch_phid: mintPhid(),
      query_id: input.query_id,
      to_agent: input.to_agent,
      from_actor: input.from_actor,
      channel: input.channel,
      subject: input.subject,
      body_markdown: input.body_markdown,
      provider: input.provider,
      runtime: input.runtime,
      priority,
      status: "queued",
      not_before_at: input.not_before_at ?? now,
      attempt_count: 0,
      bounce_count: 0,
      last_bounce: null,
      bounce_history: [],
      started_at: null,
      completed_at: null,
      updated_at: now,
      agent_query_id: null,
      usage_policy_snapshot: input.usage_policy_snapshot ?? null,
      failure_kind: null,
      failure_detail: null,
      ...defaultClarificationFields(),
      ...defaultPromotionFields(input),
    };
    const targetUrl = input.target_url ?? null;
    await this.adapter.query(
      `INSERT INTO dispatch_scheduler_queue (
        dispatch_phid, team_id, query_id, to_agent, from_actor, channel,
        subject, body_markdown, provider, runtime, priority, status,
        not_before_at, attempt_count, bounce_count, last_bounce_json,
        bounce_history_json, started_at, completed_at, updated_at,
        agent_query_id, usage_policy_snapshot_json, failure_kind,
        failure_detail, target_url, result_json,
        clarification_id, active_clarification_json, clarification_history_json,
        resume_delivery_status, promote, promotion_strategy,
        promotion_required_reason, promotion_result_json, promotion_input_json
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        doc.dispatch_phid,
        this.teamId,
        doc.query_id,
        doc.to_agent,
        doc.from_actor,
        doc.channel,
        doc.subject,
        doc.body_markdown,
        doc.provider,
        doc.runtime,
        doc.priority,
        doc.status,
        doc.not_before_at,
        doc.attempt_count,
        doc.bounce_count,
        null,
        "[]",
        null,
        null,
        doc.updated_at,
        null,
        doc.usage_policy_snapshot ? JSON.stringify(doc.usage_policy_snapshot) : null,
        null,
        null,
        targetUrl,
        null,
        // Spec 054 v2 columns
        doc.clarification_id,
        doc.active_clarification ? JSON.stringify(doc.active_clarification) : null,
        JSON.stringify(doc.clarification_history),
        doc.resume_delivery_status,
        doc.promote ? 1 : 0,
        doc.promotion_strategy,
        doc.promotion_required_reason,
        null,
        // Spec 054 v2 Part 2 column
        doc.promotion_input ? JSON.stringify(doc.promotion_input) : null,
      ],
    );
    return doc;
  }

  async getByPhid(phid: string): Promise<DispatchDoc | null> {
    const { rows } = await this.adapter.query<Row>(
      `SELECT * FROM dispatch_scheduler_queue WHERE dispatch_phid = ? AND team_id = ?`,
      [phid, this.teamId],
    );
    return rows[0] ? rowToDoc(rows[0]) : null;
  }

  async getByQueryId(query_id: string): Promise<DispatchDoc | null> {
    const { rows } = await this.adapter.query<Row>(
      `SELECT * FROM dispatch_scheduler_queue WHERE query_id = ? AND team_id = ?`,
      [query_id, this.teamId],
    );
    return rows[0] ? rowToDoc(rows[0]) : null;
  }

  async getByAgentQueryId(agent_query_id: string): Promise<DispatchDoc | null> {
    const { rows } = await this.adapter.query<Row>(
      `SELECT * FROM dispatch_scheduler_queue WHERE agent_query_id = ? AND team_id = ?`,
      [agent_query_id, this.teamId],
    );
    return rows[0] ? rowToDoc(rows[0]) : null;
  }

  async claim(filter: QueueEligibleFilter): Promise<ClaimResult> {
    // Serialise claims through a JS-side lock — single-writer assumption.
    const ticket = this.claimLock.then(() => this.runClaim(filter));
    this.claimLock = ticket.then(
      () => undefined,
      () => undefined,
    );
    return ticket;
  }

  private async runClaim(filter: QueueEligibleFilter): Promise<ClaimResult> {
    const now = filter.now ?? this.nowFn();
    let limit = filter.limit ?? 10;
    if (filter.max_in_flight != null) {
      const params: unknown[] = [this.teamId];
      let where = `team_id = ? AND status = 'in_flight'`;
      if (filter.provider) {
        where += ` AND provider = ?`;
        params.push(filter.provider);
      }
      if (filter.runtime) {
        where += ` AND runtime = ?`;
        params.push(filter.runtime);
      }
      const { rows: countRows } = await this.adapter.query<{ n: number }>(
        `SELECT COUNT(*) AS n FROM dispatch_scheduler_queue WHERE ${where}`,
        params,
      );
      const inFlight = Number(countRows[0]?.n ?? 0);
      const headroom = Math.max(0, filter.max_in_flight - inFlight);
      limit = Math.min(limit, headroom);
    }
    if (limit === 0) return { claimed: [] };

    const eligibleParams: unknown[] = [this.teamId, now];
    let eligibleWhere = `team_id = ? AND status = 'queued' AND not_before_at <= ?`;
    if (filter.provider) {
      eligibleWhere += ` AND provider = ?`;
      eligibleParams.push(filter.provider);
    }
    if (filter.runtime) {
      eligibleWhere += ` AND runtime = ?`;
      eligibleParams.push(filter.runtime);
    }
    // Usage Meter (Spec 2026-05-31): exclude budget-paused agents.
    // The scheduler builds this list from the usage gate in ENFORCE mode
    // only (warn mode passes an empty list). Docs for excluded agents
    // stay `queued`; we just don't promote them to in_flight this tick.
    if (filter.exclude_agents && filter.exclude_agents.length > 0) {
      const placeholders = filter.exclude_agents.map(() => "?").join(", ");
      eligibleWhere += ` AND to_agent NOT IN (${placeholders})`;
      eligibleParams.push(...filter.exclude_agents);
    }
    eligibleParams.push(limit);

    const { rows: eligibleRows } = await this.adapter.query<Row>(
      `SELECT * FROM dispatch_scheduler_queue
       WHERE ${eligibleWhere}
       ORDER BY priority DESC, not_before_at ASC, dispatch_phid ASC
       LIMIT ?`,
      eligibleParams,
    );

    // P1 Dependency-Graph: filter out dispatches whose graph node is pending_dependencies.
    // This is a single readiness check — if the dispatch is linked to a graph node that
    // hasn't been released by the evaluator, skip it. Non-graph dispatches pass through.
    const graphFilteredRows = [];
    for (const row of eligibleRows) {
      const { rows: graphNodes } = await this.adapter.query<{ state: string }>(
        "SELECT state FROM dispatch_graph_node WHERE dispatch_id = ? AND state = 'pending_dependencies'",
        [row.dispatch_phid],
      );
      if (graphNodes.length > 0) continue; // Skip — graph dependency not yet satisfied.
      graphFilteredRows.push(row);
    }

    const claimed: DispatchDoc[] = [];
    for (const row of graphFilteredRows) {
      const newAttempt = row.attempt_count + 1;
      const { rowCount } = await this.adapter.query(
        `UPDATE dispatch_scheduler_queue
         SET status = 'in_flight', attempt_count = ?, started_at = ?, updated_at = ?
         WHERE dispatch_phid = ? AND status = 'queued'`,
        [newAttempt, now, now, row.dispatch_phid],
      );
      if (rowCount === 0) continue; // Lost a race; another writer won.
      const fresh = await this.getByPhid(row.dispatch_phid);
      if (fresh) claimed.push(fresh);
    }
    return { claimed };
  }

  async recordAgentStart(
    phid: string,
    agent_query_id: string,
  ): Promise<DispatchDoc | null> {
    return this.acceptDispatchStart(phid, { agent_query_id });
  }

  async acceptDispatchStart(
    phid: string,
    input: { agent_query_id: string },
  ): Promise<DispatchDoc | null> {
    const doc = await this.getByPhid(phid);
    if (!doc) return null;
    const agentQueryId = input.agent_query_id.trim();
    if (!agentQueryId) {
      throw conflict("acceptDispatchStart requires non-empty agent_query_id");
    }
    const now = this.nowFn();
    if (doc.status === "queued") {
      const { rowCount } = await this.adapter.query(
        `UPDATE dispatch_scheduler_queue
         SET status = 'in_flight',
             attempt_count = attempt_count + 1,
             started_at = ?,
             updated_at = ?,
             agent_query_id = ?
         WHERE dispatch_phid = ? AND team_id = ? AND status = 'queued'`,
        [now, now, agentQueryId, phid, this.teamId],
      );
      if (rowCount === 0) {
        throw conflict(`acceptDispatchStart lost queued transition for ${phid}`);
      }
      return this.getByPhid(phid);
    }
    if (doc.status === "in_flight") {
      if (doc.agent_query_id && doc.agent_query_id !== agentQueryId) {
        throw conflict(
          `acceptDispatchStart conflict: in_flight has agent_query_id ${doc.agent_query_id}`,
        );
      }
      const { rowCount } = await this.adapter.query(
        `UPDATE dispatch_scheduler_queue
         SET agent_query_id = ?, updated_at = ?
         WHERE dispatch_phid = ? AND team_id = ? AND status = 'in_flight'`,
        [agentQueryId, now, phid, this.teamId],
      );
      if (rowCount === 0) {
        throw conflict(`acceptDispatchStart lost in_flight transition for ${phid}`);
      }
      return this.getByPhid(phid);
    }
    if (doc.status === "done" || doc.status === "failed" || doc.status === "cancelled") {
      if (doc.agent_query_id === agentQueryId) return doc;
      throw conflict(`acceptDispatchStart cannot run from terminal ${doc.status}`);
    }
    throw conflict(`acceptDispatchStart requires queued or in_flight, was ${doc.status}`);
  }

  async markDone(phid: string): Promise<DispatchDoc | null> {
    const doc = await this.getByPhid(phid);
    if (!doc) return null;
    if (doc.status !== "in_flight") {
      throw conflict(`markDone requires in_flight, was ${doc.status}`);
    }
    const now = this.nowFn();
    await this.adapter.query(
      `UPDATE dispatch_scheduler_queue
       SET status = 'done', completed_at = ?, updated_at = ?
       WHERE dispatch_phid = ?`,
      [now, now, phid],
    );
    return this.getByPhid(phid);
  }

  async markDoneWithResult(
    phid: string,
    result: Record<string, unknown> | null,
  ): Promise<DispatchDoc | null> {
    const doc = await this.getByPhid(phid);
    if (!doc) return null;
    if (doc.status !== "in_flight") {
      throw conflict(`markDoneWithResult requires in_flight, was ${doc.status}`);
    }
    const now = this.nowFn();
    await this.adapter.query(
      `UPDATE dispatch_scheduler_queue
       SET status = 'done', completed_at = ?, updated_at = ?, result_json = ?
       WHERE dispatch_phid = ?`,
      [now, now, result ? JSON.stringify(result) : null, phid],
    );
    return this.getByPhid(phid);
  }

  /**
   * Out-of-band success closeout for a still-queued dispatch
   * (Spec 2026-06-01-queued-dispatch-closeout-spec.md).
   *
   * `markDoneWithResult` is the normal lifecycle guard (in_flight only)
   * and stays unchanged. This narrow method exists only for the
   * `/agent-done` path when the worker delivered+completed the work
   * through an async channel (e.g. `/news-to`) and the scheduler never
   * had a chance to claim the doc. The dispatch row was intentionally
   * tracked but the actual start/in_flight transition never happened,
   * so we skip it and go directly to `done`.
   *
   * Guarded: requires `status = 'queued'`. Any other state throws.
   */
  async markQueuedDoneWithResult(
    phid: string,
    result: Record<string, unknown> | null,
  ): Promise<DispatchDoc | null> {
    const doc = await this.getByPhid(phid);
    if (!doc) return null;
    if (doc.status !== "queued") {
      throw conflict(
        `markQueuedDoneWithResult requires queued, was ${doc.status}`,
      );
    }
    const now = this.nowFn();
    await this.adapter.query(
      `UPDATE dispatch_scheduler_queue
       SET status = 'done', completed_at = ?, updated_at = ?, result_json = ?
       WHERE dispatch_phid = ? AND status = 'queued'`,
      [now, now, result ? JSON.stringify(result) : null, phid],
    );
    return this.getByPhid(phid);
  }

  async markFailed(
    phid: string,
    args: { failure_kind: FailureKind; detail: string },
  ): Promise<DispatchDoc | null> {
    const doc = await this.getByPhid(phid);
    if (!doc) return null;
    if (doc.status === "done" || doc.status === "cancelled") {
      throw conflict(`markFailed cannot run from terminal ${doc.status}`);
    }
    const now = this.nowFn();
    await this.adapter.query(
      `UPDATE dispatch_scheduler_queue
       SET status = 'failed', failure_kind = ?, failure_detail = ?,
           completed_at = ?, updated_at = ?
       WHERE dispatch_phid = ?`,
      [args.failure_kind, args.detail, now, now, phid],
    );
    return this.getByPhid(phid);
  }

  async markBounced(
    phid: string,
    bounce: BounceInput,
  ): Promise<DispatchDoc | null> {
    const doc = await this.getByPhid(phid);
    if (!doc) return null;
    if (doc.status === "done" || doc.status === "cancelled" || doc.status === "failed") {
      throw conflict(`markBounced cannot run from terminal ${doc.status}`);
    }
    const now = this.nowFn();
    const record: BounceRecord = {
      ts: now,
      kind: bounce.kind,
      message: bounce.message,
      next_attempt_at: bounce.next_attempt_at,
      attempt: doc.attempt_count,
    };
    const history = [...doc.bounce_history, record];
    await this.adapter.query(
      `UPDATE dispatch_scheduler_queue
       SET status = 'bounced', bounce_count = bounce_count + 1,
           last_bounce_json = ?, bounce_history_json = ?,
           not_before_at = ?, updated_at = ?
       WHERE dispatch_phid = ?`,
      [
        JSON.stringify(record),
        JSON.stringify(history),
        bounce.next_attempt_at,
        now,
        phid,
      ],
    );
    return this.getByPhid(phid);
  }

  async requeueAfterBounce(phid: string): Promise<DispatchDoc | null> {
    const doc = await this.getByPhid(phid);
    if (!doc) return null;
    if (doc.status !== "bounced") {
      throw conflict(`requeue requires bounced, was ${doc.status}`);
    }
    const now = this.nowFn();
    if (doc.not_before_at > now) {
      throw conflict(`requeue blocked until ${doc.not_before_at}`);
    }
    await this.adapter.query(
      `UPDATE dispatch_scheduler_queue
       SET status = 'queued', updated_at = ?
       WHERE dispatch_phid = ?`,
      [now, phid],
    );
    return this.getByPhid(phid);
  }

  async cancel(phid: string, detail: string): Promise<DispatchDoc | null> {
    const doc = await this.getByPhid(phid);
    if (!doc) return null;
    if (doc.status === "done" || doc.status === "failed" || doc.status === "cancelled") {
      throw conflict(`cancel cannot run from terminal ${doc.status}`);
    }
    const now = this.nowFn();
    await this.adapter.query(
      `UPDATE dispatch_scheduler_queue
       SET status = 'cancelled', failure_kind = ?, failure_detail = ?,
           completed_at = ?, updated_at = ?
       WHERE dispatch_phid = ?`,
      ["cancelled", detail, now, now, phid],
    );
    return this.getByPhid(phid);
  }

  async markRetryExhausted(
    phid: string,
    detail: string,
  ): Promise<DispatchDoc | null> {
    const doc = await this.getByPhid(phid);
    if (!doc) return null;
    if (doc.status === "done" || doc.status === "cancelled") {
      throw conflict(`markRetryExhausted cannot run from terminal ${doc.status}`);
    }
    const now = this.nowFn();
    await this.adapter.query(
      `UPDATE dispatch_scheduler_queue
       SET status = 'failed', failure_kind = 'provider_rate_limit_exhausted',
           failure_detail = ?, completed_at = ?, updated_at = ?
       WHERE dispatch_phid = ?`,
      [detail, now, now, phid],
    );
    return this.getByPhid(phid);
  }

  async listInFlight(provider?: Provider, runtime?: Runtime): Promise<DispatchDoc[]> {
    const params: unknown[] = [this.teamId];
    let where = `team_id = ? AND status = 'in_flight'`;
    if (provider) {
      where += ` AND provider = ?`;
      params.push(provider);
    }
    if (runtime) {
      where += ` AND runtime = ?`;
      params.push(runtime);
    }
    const { rows } = await this.adapter.query<Row>(
      `SELECT * FROM dispatch_scheduler_queue WHERE ${where}
       ORDER BY started_at ASC, dispatch_phid ASC`,
      params,
    );
    return rows.map(rowToDoc);
  }

  async listBounced(provider?: Provider, runtime?: Runtime): Promise<DispatchDoc[]> {
    const params: unknown[] = [this.teamId];
    let where = `team_id = ? AND status = 'bounced'`;
    if (provider) {
      where += ` AND provider = ?`;
      params.push(provider);
    }
    if (runtime) {
      where += ` AND runtime = ?`;
      params.push(runtime);
    }
    const { rows } = await this.adapter.query<Row>(
      `SELECT * FROM dispatch_scheduler_queue WHERE ${where}
       ORDER BY not_before_at ASC, dispatch_phid ASC`,
      params,
    );
    return rows.map(rowToDoc);
  }

  async listQueued(provider?: Provider, runtime?: Runtime): Promise<DispatchDoc[]> {
    const params: unknown[] = [this.teamId];
    let where = `team_id = ? AND status = 'queued'`;
    if (provider) {
      where += ` AND provider = ?`;
      params.push(provider);
    }
    if (runtime) {
      where += ` AND runtime = ?`;
      params.push(runtime);
    }
    const { rows } = await this.adapter.query<Row>(
      `SELECT * FROM dispatch_scheduler_queue WHERE ${where}
       ORDER BY priority DESC, not_before_at ASC, dispatch_phid ASC`,
      params,
    );
    return rows.map(rowToDoc);
  }

  async snapshot(opts: {
    max_safe: number;
    provider?: Provider;
    runtime?: Runtime;
  }): Promise<ConcurrencySnapshot> {
    const now = this.nowFn();
    const [inFlight, queued, bounced] = await Promise.all([
      this.listInFlight(opts.provider, opts.runtime),
      this.listQueued(opts.provider, opts.runtime),
      this.listBounced(opts.provider, opts.runtime),
    ]);
    const oldest =
      queued.length === 0
        ? 0
        : Math.max(
            ...queued.map((d) => Date.parse(now) - Date.parse(d.not_before_at)),
          );
    const lastBounce =
      bounced.length === 0
        ? null
        : bounced.reduce((best, d) =>
            (d.last_bounce?.ts ?? "") > (best.last_bounce?.ts ?? "") ? d : best,
          );
    return {
      in_flight: inFlight.length,
      queued: queued.length,
      bounced: bounced.length,
      max_safe: opts.max_safe,
      available_slots: Math.max(0, opts.max_safe - inFlight.length),
      oldest_queued_age_ms: Math.max(0, oldest),
      last_bounce_kind: lastBounce?.last_bounce?.kind ?? null,
    };
  }

  // ════════════════════════════════════════════════════════════════
  // Spec 054 v2 — clarification lifecycle
  // ════════════════════════════════════════════════════════════════

  /** Pause a dispatch on a clarification question. Idempotent for the
   *  same agent+question within the 5-minute idempotency window. */
  async markNeedsClarification(
    phid: string,
    input: {
      agent_id: string;
      query_id?: string | null;
      question: string;
      context?: unknown;
      urgency?: "normal" | "time_sensitive";
      stale_ms?: number; // override default 2h stale window for tests
    },
  ): Promise<{ doc: DispatchDoc; clarification_id: string; idempotent: boolean }> {
    const doc = await this.getByPhid(phid);
    if (!doc) throw conflict(`markNeedsClarification: dispatch ${phid} not found`);
    if (isTerminal(doc.status)) {
      throw conflict(`markNeedsClarification cannot run from terminal ${doc.status}`);
    }
    const now = this.nowFn();
    const staleMs = input.stale_ms ?? 2 * 60 * 60 * 1000;

    // Idempotency: same agent+question on an open clarification within 5 min.
    if (
      doc.status === "needs_clarification" &&
      doc.active_clarification &&
      doc.active_clarification.agent_id === input.agent_id &&
      doc.active_clarification.question === input.question
    ) {
      const ageMs = Date.parse(now) - Date.parse(doc.active_clarification.created_at);
      if (ageMs <= 5 * 60 * 1000) {
        return { doc, clarification_id: doc.active_clarification.clarification_id, idempotent: true };
      }
    }

    const clarification_id = mintClarificationId();
    const stale_at = new Date(Date.parse(now) + staleMs).toISOString();
    const blocker: ClarificationBlocker = {
      clarification_id,
      agent_id: input.agent_id,
      query_id: input.query_id ?? null,
      question: input.question,
      context: input.context ?? null,
      urgency: input.urgency ?? "normal",
      created_at: now,
      stale_at,
    };
    const event: ClarificationEvent = {
      type: "NEEDS_CLARIFICATION",
      clarification_id,
      ts: now,
      agent_id: input.agent_id,
      query_id: input.query_id ?? null,
      question: input.question,
      context: input.context ?? null,
      urgency: input.urgency ?? "normal",
      stale_at,
    };
    const history = [...doc.clarification_history, event];
    await this.adapter.query(
      `UPDATE dispatch_scheduler_queue
       SET status = 'needs_clarification',
           clarification_id = ?,
           active_clarification_json = ?,
           clarification_history_json = ?,
           updated_at = ?
       WHERE dispatch_phid = ? AND team_id = ?`,
      [
        clarification_id,
        JSON.stringify(blocker),
        JSON.stringify(history),
        now,
        phid,
        this.teamId,
      ],
    );
    const updated = await this.getByPhid(phid);
    if (!updated) throw conflict(`markNeedsClarification: post-update read failed`);
    return { doc: updated, clarification_id, idempotent: false };
  }

  /** Resume a paused dispatch with the operator's answer. Closes the
   *  active clarification, appends RESUME, and requeues for scheduler. */
  async resumeAfterClarification(
    phid: string,
    input: {
      clarification_id?: string;
      actor?: string;
      answer: string;
      instructions?: string[] | string | null;
    },
  ): Promise<DispatchDoc> {
    const doc = await this.getByPhid(phid);
    if (!doc) throw conflict(`resumeAfterClarification: dispatch ${phid} not found`);
    if (doc.status !== "needs_clarification") {
      throw conflict(`resumeAfterClarification requires needs_clarification, was ${doc.status}`);
    }
    if (!doc.active_clarification) {
      throw conflict(`resumeAfterClarification: no active clarification`);
    }
    const target_id = input.clarification_id ?? doc.active_clarification.clarification_id;
    if (target_id !== doc.active_clarification.clarification_id) {
      throw conflict(
        `resumeAfterClarification: clarification_id mismatch (active=${doc.active_clarification.clarification_id}, requested=${target_id})`,
      );
    }
    const now = this.nowFn();
    const event: ClarificationEvent = {
      type: "RESUME",
      clarification_id: target_id,
      ts: now,
      actor: input.actor ?? "manager",
      answer: input.answer,
      instructions: input.instructions ?? null,
    };
    const history = [...doc.clarification_history, event];
    await this.adapter.query(
      `UPDATE dispatch_scheduler_queue
       SET status = 'queued',
           clarification_id = NULL,
           active_clarification_json = NULL,
           clarification_history_json = ?,
           resume_delivery_status = 'pending',
           not_before_at = ?,
           updated_at = ?
       WHERE dispatch_phid = ? AND team_id = ?`,
      [JSON.stringify(history), now, now, phid, this.teamId],
    );
    const updated = await this.getByPhid(phid);
    if (!updated) throw conflict(`resumeAfterClarification: post-update read failed`);
    return updated;
  }

  /** Record that resume delivery to the agent succeeded. */
  async markResumeDelivered(
    phid: string,
    input: {
      clarification_id: string;
      transport: "session_injection" | "talk_followup" | string;
      agent_query_id?: string | null;
    },
  ): Promise<DispatchDoc> {
    const doc = await this.getByPhid(phid);
    if (!doc) throw conflict(`markResumeDelivered: dispatch ${phid} not found`);
    const now = this.nowFn();
    const event: ClarificationEvent = {
      type: "RESUME_DELIVERED",
      clarification_id: input.clarification_id,
      ts: now,
      transport: input.transport,
      delivered_at: now,
      agent_query_id: input.agent_query_id ?? null,
    };
    const history = [...doc.clarification_history, event];
    await this.adapter.query(
      `UPDATE dispatch_scheduler_queue
       SET resume_delivery_status = 'delivered',
           clarification_history_json = ?,
           ${input.agent_query_id ? "agent_query_id = ?," : ""}
           updated_at = ?
       WHERE dispatch_phid = ? AND team_id = ?`,
      input.agent_query_id
        ? [JSON.stringify(history), input.agent_query_id, now, phid, this.teamId]
        : [JSON.stringify(history), now, phid, this.teamId],
    );
    const updated = await this.getByPhid(phid);
    if (!updated) throw conflict(`markResumeDelivered: post-update read failed`);
    return updated;
  }

  /** Resume delivery failed - move to blocked, non-claimable state. */
  async markResumeDeliveryFailed(
    phid: string,
    input: { clarification_id: string; failure_detail: string },
  ): Promise<DispatchDoc> {
    const doc = await this.getByPhid(phid);
    if (!doc) throw conflict(`markResumeDeliveryFailed: dispatch ${phid} not found`);
    const now = this.nowFn();
    const event: ClarificationEvent = {
      type: "RESUME_DELIVERY_FAILED",
      clarification_id: input.clarification_id,
      ts: now,
      failure_detail: input.failure_detail,
    };
    const history = [...doc.clarification_history, event];
    await this.adapter.query(
      `UPDATE dispatch_scheduler_queue
       SET status = 'resume_delivery_failed',
           resume_delivery_status = 'failed',
           clarification_history_json = ?,
           failure_detail = ?,
           updated_at = ?
       WHERE dispatch_phid = ? AND team_id = ?`,
      [JSON.stringify(history), input.failure_detail, now, phid, this.teamId],
    );
    const updated = await this.getByPhid(phid);
    if (!updated) throw conflict(`markResumeDeliveryFailed: post-update read failed`);
    return updated;
  }

  /** Append a CLARIFICATION_STALE event without changing the dispatch
   *  status. Status remains needs_clarification; operator action is
   *  still required. */
  async markClarificationStale(
    phid: string,
    input: { clarification_id: string; age_seconds: number },
  ): Promise<DispatchDoc> {
    const doc = await this.getByPhid(phid);
    if (!doc) throw conflict(`markClarificationStale: dispatch ${phid} not found`);
    const now = this.nowFn();
    const event: ClarificationEvent = {
      type: "CLARIFICATION_STALE",
      clarification_id: input.clarification_id,
      ts: now,
      age_seconds: input.age_seconds,
      surfaced_at: now,
    };
    const history = [...doc.clarification_history, event];
    await this.adapter.query(
      `UPDATE dispatch_scheduler_queue
       SET clarification_history_json = ?, updated_at = ?
       WHERE dispatch_phid = ? AND team_id = ?`,
      [JSON.stringify(history), now, phid, this.teamId],
    );
    const updated = await this.getByPhid(phid);
    if (!updated) throw conflict(`markClarificationStale: post-update read failed`);
    return updated;
  }

  /** Persist the post-promotion result on /agent-done. */
  async recordPromotionResult(
    phid: string,
    input: { result: unknown },
  ): Promise<DispatchDoc> {
    const doc = await this.getByPhid(phid);
    if (!doc) throw conflict(`recordPromotionResult: dispatch ${phid} not found`);
    const now = this.nowFn();
    await this.adapter.query(
      `UPDATE dispatch_scheduler_queue
       SET promotion_result_json = ?, updated_at = ?
       WHERE dispatch_phid = ? AND team_id = ?`,
      [JSON.stringify(input.result), now, phid, this.teamId],
    );
    const updated = await this.getByPhid(phid);
    if (!updated) throw conflict(`recordPromotionResult: post-update read failed`);
    return updated;
  }

  /** List open clarification blockers. With staleOnly=true, only those
   *  past their stale_at timestamp at the supplied (or current) now. */
  async listOpenClarifications(opts: {
    staleOnly?: boolean;
    now?: string;
  } = {}): Promise<DispatchDoc[]> {
    const { rows } = await this.adapter.query<Row>(
      `SELECT * FROM dispatch_scheduler_queue
       WHERE team_id = ? AND status = 'needs_clarification'
       ORDER BY updated_at ASC`,
      [this.teamId],
    );
    const docs = rows.map(rowToDoc);
    if (opts.staleOnly) {
      const now = opts.now ?? this.nowFn();
      return docs.filter(
        (d) => d.active_clarification != null && d.active_clarification.stale_at <= now,
      );
    }
    return docs;
  }

  /** Read the stashed agent reply payload (Phase 5.2 talk-to waiter). */
  async getResult(phid: string): Promise<Record<string, unknown> | null> {
    const { rows } = await this.adapter.query<{ result_json: string | null }>(
      `SELECT result_json FROM dispatch_scheduler_queue WHERE dispatch_phid = ?`,
      [phid],
    );
    if (!rows[0]?.result_json) return null;
    try {
      return JSON.parse(rows[0].result_json);
    } catch {
      return null;
    }
  }

  /** Read the persisted target URL for the scheduler transport. */
  async getTargetUrl(phid: string): Promise<string | null> {
    const { rows } = await this.adapter.query<{ target_url: string | null }>(
      `SELECT target_url FROM dispatch_scheduler_queue WHERE dispatch_phid = ?`,
      [phid],
    );
    return rows[0]?.target_url ?? null;
  }
}

function clampPriority(p: number | undefined): number {
  if (p == null || !Number.isFinite(p)) return 5;
  return Math.max(0, Math.floor(p));
}

function mintPhid(): string {
  return `phid:disp-${randomBytes(8).toString("hex")}`;
}

function mintClarificationId(): string {
  return `clar_${Date.now()}_${randomBytes(2).toString("hex")}`;
}

function parseBounceHistory(raw: string): BounceRecord[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as BounceRecord[]) : [];
  } catch {
    return [];
  }
}

function parseLastBounce(raw: string | null): BounceRecord | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as BounceRecord;
  } catch {
    return null;
  }
}

function parsePolicy(raw: string | null): UsagePolicySnapshot | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as UsagePolicySnapshot;
  } catch {
    return null;
  }
}

function rowToDoc(row: Row): DispatchDoc {
  return {
    dispatch_phid: row.dispatch_phid,
    query_id: row.query_id,
    to_agent: row.to_agent,
    from_actor: row.from_actor,
    channel: row.channel,
    subject: row.subject,
    body_markdown: row.body_markdown,
    provider: row.provider,
    runtime: row.runtime,
    priority: Number(row.priority),
    status: row.status,
    not_before_at: row.not_before_at,
    attempt_count: Number(row.attempt_count),
    bounce_count: Number(row.bounce_count),
    last_bounce: parseLastBounce(row.last_bounce_json),
    bounce_history: parseBounceHistory(row.bounce_history_json),
    started_at: row.started_at,
    completed_at: row.completed_at,
    updated_at: row.updated_at,
    agent_query_id: row.agent_query_id,
    usage_policy_snapshot: parsePolicy(row.usage_policy_snapshot_json),
    failure_kind: row.failure_kind,
    failure_detail: row.failure_detail,
    // Spec 054 v2 fields - tolerate legacy rows with null columns.
    clarification_id: row.clarification_id ?? null,
    active_clarification: parseClarificationBlocker(row.active_clarification_json),
    clarification_history: parseClarificationHistory(row.clarification_history_json),
    resume_delivery_status: (row.resume_delivery_status ?? "none") as DispatchDoc["resume_delivery_status"],
    promote: row.promote == null ? true : Number(row.promote) === 1,
    promotion_strategy: (row.promotion_strategy ?? "auto") as DispatchDoc["promotion_strategy"],
    promotion_required_reason: row.promotion_required_reason ?? null,
    promotion_result: parseJsonOrNull(row.promotion_result_json),
    promotion_input: parsePromotionInput(row.promotion_input_json),
  };
}

function parseClarificationBlocker(raw: string | null): ClarificationBlocker | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as ClarificationBlocker;
  } catch {
    return null;
  }
}

function parseClarificationHistory(raw: string | null | undefined): ClarificationEvent[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as ClarificationEvent[]) : [];
  } catch {
    return [];
  }
}

function parseJsonOrNull(raw: string | null | undefined): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function parsePromotionInput(raw: string | null | undefined): PromotionInput | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    const p = parsed as Record<string, unknown>;
    if (typeof p.repo !== "string" || typeof p.branch !== "string") return null;
    return {
      repo: p.repo,
      branch: p.branch,
      base: typeof p.base === "string" && p.base ? p.base : "main",
      remote: typeof p.remote === "string" && p.remote ? p.remote : "origin",
      promotion_skip_reason:
        typeof p.promotion_skip_reason === "string" ? p.promotion_skip_reason : null,
    };
  } catch {
    return null;
  }
}

function conflict(msg: string): Error & { code: string } {
  const e = new Error(msg) as Error & { code: string };
  e.code = "REACTOR_CONFLICT";
  return e;
}
