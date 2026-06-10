// Minimal in-memory Reactor stub used by DispatchDocClient tests and by
// the scheduler-service tests in Phase 3. Mirrors only the Dispatch
// surface — enqueue, claim, mark, query — not the wider Reactor.
//
// The shape of the operations here is the contract the real Reactor
// mutation surface needs to satisfy before Phase 4 enforce mode flips.

import {
  type ConcurrencySnapshot,
  type DispatchDoc,
  type EnqueueInput,
  type QueueEligibleFilter,
  type Provider,
  type Runtime,
  type SchedulerStatus,
  type BounceRecord,
  type FailureKind,
  type ClarificationEvent,
  type ClarificationBlocker,
  defaultClarificationFields,
  defaultPromotionFields,
} from "./types.js";

export interface FakeReactorOptions {
  now: () => string;
}

interface UnavailableState {
  active: boolean;
  detail: string;
}

let phidCounter = 0;
function mintPhid(): string {
  phidCounter += 1;
  return `phid:fake-${phidCounter.toString(16).padStart(16, "0")}`;
}

export interface BounceInput {
  kind: string;
  message: string;
  next_attempt_at: string;
}

export interface ClaimResult {
  claimed: DispatchDoc[];
}

export class FakeReactor {
  private docs: Map<string, DispatchDoc> = new Map();
  private nowFn: () => string;
  private unavailable: UnavailableState = { active: false, detail: "" };
  private claimLock = Promise.resolve();

  constructor(opts: FakeReactorOptions) {
    this.nowFn = opts.now;
  }

  setNow(iso: string): void {
    this.nowFn = () => iso;
  }

  now(): string {
    return this.nowFn();
  }

  simulateUnavailable(detail: string): void {
    this.unavailable = { active: true, detail };
  }

  restoreAvailable(): void {
    this.unavailable = { active: false, detail: "" };
  }

  private guard(): void {
    if (this.unavailable.active) {
      const err = new Error(this.unavailable.detail);
      (err as Error & { code?: string }).code = "REACTOR_UNAVAILABLE";
      throw err;
    }
  }

  async enqueue(input: EnqueueInput): Promise<DispatchDoc> {
    this.guard();
    const now = this.nowFn();
    const priority =
      input.priority == null || !Number.isFinite(input.priority)
        ? 5
        : Math.max(0, Math.floor(input.priority));
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
    this.docs.set(doc.dispatch_phid, doc);
    return clone(doc);
  }

  async getByPhid(phid: string): Promise<DispatchDoc | null> {
    this.guard();
    const d = this.docs.get(phid);
    return d ? clone(d) : null;
  }

  async getByQueryId(query_id: string): Promise<DispatchDoc | null> {
    this.guard();
    for (const d of this.docs.values()) {
      if (d.query_id === query_id) return clone(d);
    }
    return null;
  }

  async claim(filter: QueueEligibleFilter): Promise<ClaimResult> {
    // Serialize claims so two callers can't snag the same doc. This is
    // the single-writer assumption the plan calls out in Phase 3.1.
    const ticket = this.claimLock.then(() => this.runClaim(filter));
    this.claimLock = ticket.then(
      () => undefined,
      () => undefined,
    );
    return ticket;
  }

  private async runClaim(filter: QueueEligibleFilter): Promise<ClaimResult> {
    this.guard();
    const now = filter.now ?? this.nowFn();
    let limit = filter.limit ?? 10;
    // Atomic max-in-flight check: count currently in_flight under the
    // same filter, and shrink limit so claimed + in_flight ≤ max_in_flight.
    if (filter.max_in_flight != null) {
      const inFlight = [...this.docs.values()].filter(
        (d) =>
          d.status === "in_flight" &&
          (filter.provider == null || d.provider === filter.provider) &&
          (filter.runtime == null || d.runtime === filter.runtime),
      ).length;
      const headroom = Math.max(0, filter.max_in_flight - inFlight);
      limit = Math.min(limit, headroom);
    }
    if (limit === 0) return { claimed: [] };
    const excludeSet = new Set(filter.exclude_agents ?? []);
    const eligible = [...this.docs.values()].filter(
      (d) =>
        d.status === "queued" &&
        d.not_before_at <= now &&
        (filter.provider == null || d.provider === filter.provider) &&
        (filter.runtime == null || d.runtime === filter.runtime) &&
        !excludeSet.has(d.to_agent),
    );
    eligible.sort((a, b) => {
      if (b.priority !== a.priority) return b.priority - a.priority;
      if (a.not_before_at !== b.not_before_at)
        return a.not_before_at.localeCompare(b.not_before_at);
      return a.dispatch_phid.localeCompare(b.dispatch_phid);
    });
    const chosen = eligible.slice(0, limit);
    const claimed: DispatchDoc[] = [];
    for (const doc of chosen) {
      const next: DispatchDoc = {
        ...doc,
        status: "in_flight",
        attempt_count: doc.attempt_count + 1,
        started_at: now,
        updated_at: now,
      };
      this.docs.set(next.dispatch_phid, next);
      claimed.push(clone(next));
    }
    return { claimed };
  }

  async acceptDispatchStart(
    phid: string,
    input: { agent_query_id: string },
  ): Promise<DispatchDoc | null> {
    this.guard();
    if (!input.agent_query_id || !input.agent_query_id.trim()) {
      throw conflict("acceptDispatchStart requires a non-empty agent_query_id");
    }
    const doc = this.docs.get(phid);
    if (!doc) return null;
    if (doc.status === "queued") {
      const now = this.nowFn();
      const next: DispatchDoc = {
        ...doc,
        status: "in_flight",
        attempt_count: doc.attempt_count + 1,
        started_at: now,
        updated_at: now,
        agent_query_id: input.agent_query_id,
      };
      this.docs.set(phid, next);
      return clone(next);
    }
    if (doc.status === "in_flight") {
      if (doc.agent_query_id && doc.agent_query_id !== input.agent_query_id) {
        throw conflict(
          `acceptDispatchStart conflict: in_flight has agent_query_id ${doc.agent_query_id}`,
        );
      }
      const next: DispatchDoc = {
        ...doc,
        agent_query_id: input.agent_query_id,
        updated_at: this.nowFn(),
      };
      this.docs.set(phid, next);
      return clone(next);
    }
    if (doc.status === "done" || doc.status === "failed" || doc.status === "cancelled") {
      if (doc.agent_query_id === input.agent_query_id) return clone(doc);
      throw conflict(`acceptDispatchStart cannot run from terminal ${doc.status}`);
    }
    throw conflict(`acceptDispatchStart requires queued or in_flight, was ${doc.status}`);
  }

  async recordAgentStart(phid: string, agent_query_id: string): Promise<DispatchDoc | null> {
    return this.acceptDispatchStart(phid, { agent_query_id });
  }

  async markDone(phid: string): Promise<DispatchDoc | null> {
    this.guard();
    const doc = this.docs.get(phid);
    if (!doc) return null;
    if (doc.status !== "in_flight") {
      throw conflict(`markDone requires in_flight, was ${doc.status}`);
    }
    const now = this.nowFn();
    const next: DispatchDoc = {
      ...doc,
      status: "done",
      completed_at: now,
      updated_at: now,
    };
    this.docs.set(phid, next);
    return clone(next);
  }

  async markFailed(
    phid: string,
    args: { failure_kind: FailureKind; detail: string },
  ): Promise<DispatchDoc | null> {
    this.guard();
    const doc = this.docs.get(phid);
    if (!doc) return null;
    if (doc.status === "done" || doc.status === "cancelled") {
      throw conflict(`markFailed cannot run from terminal ${doc.status}`);
    }
    const now = this.nowFn();
    const next: DispatchDoc = {
      ...doc,
      status: "failed",
      failure_kind: args.failure_kind,
      failure_detail: args.detail,
      completed_at: now,
      updated_at: now,
    };
    this.docs.set(phid, next);
    return clone(next);
  }

  async markBounced(phid: string, bounce: BounceInput): Promise<DispatchDoc | null> {
    this.guard();
    const doc = this.docs.get(phid);
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
    const next: DispatchDoc = {
      ...doc,
      status: "bounced",
      bounce_count: doc.bounce_count + 1,
      last_bounce: record,
      bounce_history: [...doc.bounce_history, record],
      not_before_at: bounce.next_attempt_at,
      updated_at: now,
    };
    this.docs.set(phid, next);
    return clone(next);
  }

  async requeueAfterBounce(phid: string): Promise<DispatchDoc | null> {
    this.guard();
    const doc = this.docs.get(phid);
    if (!doc) return null;
    if (doc.status !== "bounced") {
      throw conflict(`requeue requires bounced, was ${doc.status}`);
    }
    const now = this.nowFn();
    if (doc.not_before_at > now) {
      throw conflict(`requeue blocked until ${doc.not_before_at}`);
    }
    const next: DispatchDoc = {
      ...doc,
      status: "queued",
      updated_at: now,
    };
    this.docs.set(phid, next);
    return clone(next);
  }

  async cancel(phid: string, detail: string): Promise<DispatchDoc | null> {
    this.guard();
    const doc = this.docs.get(phid);
    if (!doc) return null;
    if (doc.status === "done" || doc.status === "failed" || doc.status === "cancelled") {
      throw conflict(`cancel cannot run from terminal ${doc.status}`);
    }
    const now = this.nowFn();
    const next: DispatchDoc = {
      ...doc,
      status: "cancelled",
      failure_kind: "cancelled",
      failure_detail: detail,
      completed_at: now,
      updated_at: now,
    };
    this.docs.set(phid, next);
    return clone(next);
  }

  async markRetryExhausted(phid: string, detail: string): Promise<DispatchDoc | null> {
    this.guard();
    const doc = this.docs.get(phid);
    if (!doc) return null;
    if (doc.status === "done" || doc.status === "cancelled") {
      throw conflict(`markRetryExhausted cannot run from terminal ${doc.status}`);
    }
    const now = this.nowFn();
    const next: DispatchDoc = {
      ...doc,
      status: "failed",
      failure_kind: "provider_rate_limit_exhausted",
      failure_detail: detail,
      completed_at: now,
      updated_at: now,
    };
    this.docs.set(phid, next);
    return clone(next);
  }

  async listByStatus(s: SchedulerStatus): Promise<DispatchDoc[]> {
    this.guard();
    return [...this.docs.values()].filter((d) => d.status === s).map(clone);
  }

  async listInFlight(
    provider?: Provider,
    runtime?: Runtime,
  ): Promise<DispatchDoc[]> {
    this.guard();
    return [...this.docs.values()]
      .filter(
        (d) =>
          d.status === "in_flight" &&
          (provider == null || d.provider === provider) &&
          (runtime == null || d.runtime === runtime),
      )
      .map(clone);
  }

  async listBounced(
    provider?: Provider,
    runtime?: Runtime,
  ): Promise<DispatchDoc[]> {
    this.guard();
    return [...this.docs.values()]
      .filter(
        (d) =>
          d.status === "bounced" &&
          (provider == null || d.provider === provider) &&
          (runtime == null || d.runtime === runtime),
      )
      .map(clone);
  }

  async listQueued(
    provider?: Provider,
    runtime?: Runtime,
  ): Promise<DispatchDoc[]> {
    this.guard();
    return [...this.docs.values()]
      .filter(
        (d) =>
          d.status === "queued" &&
          (provider == null || d.provider === provider) &&
          (runtime == null || d.runtime === runtime),
      )
      .map(clone);
  }

  async snapshot(opts: {
    max_safe: number;
    provider?: Provider;
    runtime?: Runtime;
  }): Promise<ConcurrencySnapshot> {
    this.guard();
    const now = this.nowFn();
    const inFlight = await this.listInFlight(opts.provider, opts.runtime);
    const queued = await this.listQueued(opts.provider, opts.runtime);
    const bounced = await this.listBounced(opts.provider, opts.runtime);
    const oldest =
      queued.length === 0
        ? 0
        : Math.max(
            ...queued.map(
              (d) => Date.parse(now) - Date.parse(d.not_before_at),
            ),
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
}

function clone(d: DispatchDoc): DispatchDoc {
  return {
    ...d,
    bounce_history: d.bounce_history.map((b) => ({ ...b })),
    last_bounce: d.last_bounce ? { ...d.last_bounce } : null,
    usage_policy_snapshot: d.usage_policy_snapshot
      ? { ...d.usage_policy_snapshot }
      : null,
  };
}

function conflict(msg: string): Error & { code: string } {
  const e = new Error(msg) as Error & { code: string };
  e.code = "REACTOR_CONFLICT";
  return e;
}
