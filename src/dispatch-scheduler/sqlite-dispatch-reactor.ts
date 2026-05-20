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
    };
    const targetUrl = input.target_url ?? null;
    await this.adapter.query(
      `INSERT INTO dispatch_scheduler_queue (
        dispatch_phid, team_id, query_id, to_agent, from_actor, channel,
        subject, body_markdown, provider, runtime, priority, status,
        not_before_at, attempt_count, bounce_count, last_bounce_json,
        bounce_history_json, started_at, completed_at, updated_at,
        agent_query_id, usage_policy_snapshot_json, failure_kind,
        failure_detail, target_url, result_json
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
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
    eligibleParams.push(limit);

    const { rows: eligibleRows } = await this.adapter.query<Row>(
      `SELECT * FROM dispatch_scheduler_queue
       WHERE ${eligibleWhere}
       ORDER BY priority DESC, not_before_at ASC, dispatch_phid ASC
       LIMIT ?`,
      eligibleParams,
    );

    const claimed: DispatchDoc[] = [];
    for (const row of eligibleRows) {
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
    const doc = await this.getByPhid(phid);
    if (!doc) return null;
    if (doc.status !== "in_flight") {
      throw conflict(`recordAgentStart requires in_flight, was ${doc.status}`);
    }
    const now = this.nowFn();
    await this.adapter.query(
      `UPDATE dispatch_scheduler_queue
       SET agent_query_id = ?, updated_at = ?
       WHERE dispatch_phid = ?`,
      [agent_query_id, now, phid],
    );
    return this.getByPhid(phid);
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
  };
}

function conflict(msg: string): Error & { code: string } {
  const e = new Error(msg) as Error & { code: string };
  e.code = "REACTOR_CONFLICT";
  return e;
}
