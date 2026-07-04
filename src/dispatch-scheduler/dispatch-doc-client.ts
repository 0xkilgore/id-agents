// Typed Dispatch doc client — the only seam manager code uses to talk
// to the Reactor-backed dispatch queue. The transport is abstracted so
// the same client works against the in-memory FakeReactor (Phase 1/3
// tests) and the real Reactor mutation surface (Phase 4 onward).
//
// All methods return a Result<T> = Ok<T> | Degraded. Reactor unavailable
// + reactor errors become typed degraded results so the scheduler loop
// can decide whether to retry the call, bounce the doc, or surface to
// /system-live.

import type { FakeReactor, BounceInput } from "./fake-reactor.js";
import {
  type ConcurrencySnapshot,
  type DispatchDoc,
  type EnqueueInput,
  type FailureKind,
  type Provider,
  type QueueEligibleFilter,
  type Result,
  type Runtime,
  degraded,
  ok,
} from "./types.js";

export interface DispatchReactor {
  enqueue: FakeReactor["enqueue"];
  getByPhid: FakeReactor["getByPhid"];
  getByQueryId: FakeReactor["getByQueryId"];
  claim: FakeReactor["claim"];
  recordAgentStart: FakeReactor["recordAgentStart"];
  acceptDispatchStart: FakeReactor["acceptDispatchStart"];
  markDone: FakeReactor["markDone"];
  markFailed: FakeReactor["markFailed"];
  markBounced: FakeReactor["markBounced"];
  requeueAfterBounce: FakeReactor["requeueAfterBounce"];
  cancel: FakeReactor["cancel"];
  markRetryExhausted: FakeReactor["markRetryExhausted"];
  listInFlight: FakeReactor["listInFlight"];
  listBounced: FakeReactor["listBounced"];
  listQueued: FakeReactor["listQueued"];
  snapshot: FakeReactor["snapshot"];
}

/** N1.3: optional hook invoked after a status-changing mutation succeeds. */
export type OnDispatchStatusChanged = (phid: string, newStatus: string) => void;

export interface DispatchDocClientOptions {
  reactor: DispatchReactor;
  now: () => string;
  onStatusChanged?: OnDispatchStatusChanged;
}

export class DispatchDocClient {
  private reactor: DispatchReactor;
  private now: () => string;
  private onStatusChanged?: OnDispatchStatusChanged;

  constructor(opts: DispatchDocClientOptions) {
    this.reactor = opts.reactor;
    this.now = opts.now;
    this.onStatusChanged = opts.onStatusChanged;
  }

  async enqueueDispatch(input: EnqueueInput): Promise<Result<DispatchDoc>> {
    return this.wrap("enqueue", () => this.reactor.enqueue(input));
  }

  async getByQueryId(query_id: string): Promise<Result<DispatchDoc>> {
    return this.wrapNullable("getByQueryId", () =>
      this.reactor.getByQueryId(query_id),
    );
  }

  async getByPhid(phid: string): Promise<Result<DispatchDoc>> {
    return this.wrapNullable("getByPhid", () => this.reactor.getByPhid(phid));
  }

  async claimForStart(
    filter: QueueEligibleFilter,
  ): Promise<Result<DispatchDoc[]>> {
    return this.wrap("claim", async () => {
      const result = await this.reactor.claim(filter);
      return result.claimed;
    });
  }

  async recordAgentStart(
    phid: string,
    agent_query_id: string,
  ): Promise<Result<DispatchDoc>> {
    return this.wrapNullable("recordAgentStart", () =>
      this.reactor.recordAgentStart(phid, agent_query_id),
    );
  }

  async acceptDispatchStart(
    phid: string,
    input: { agent_query_id: string },
  ): Promise<Result<DispatchDoc>> {
    const r = await this.wrapNullable("acceptDispatchStart", () =>
      this.reactor.acceptDispatchStart(phid, input),
    );
    if (r.ok) this.onStatusChanged?.(phid, "in_flight");
    return r;
  }

  async markDone(phid: string): Promise<Result<DispatchDoc>> {
    const r = await this.wrapNullable("markDone", () => this.reactor.markDone(phid));
    if (r.ok) this.onStatusChanged?.(phid, 'done');
    return r;
  }

  async markFailed(
    phid: string,
    args: { failure_kind: FailureKind; detail: string },
  ): Promise<Result<DispatchDoc>> {
    const r = await this.wrapNullable("markFailed", () =>
      this.reactor.markFailed(phid, args),
    );
    if (r.ok) this.onStatusChanged?.(phid, 'failed');
    return r;
  }

  async markBounced(
    phid: string,
    bounce: BounceInput,
  ): Promise<Result<DispatchDoc>> {
    return this.wrapNullable("markBounced", () =>
      this.reactor.markBounced(phid, bounce),
    );
  }

  async requeueAfterBounce(phid: string): Promise<Result<DispatchDoc>> {
    return this.wrapNullable("requeueAfterBounce", () =>
      this.reactor.requeueAfterBounce(phid),
    );
  }

  async cancel(phid: string, detail: string): Promise<Result<DispatchDoc>> {
    const r = await this.wrapNullable("cancel", () => this.reactor.cancel(phid, detail));
    if (r.ok) this.onStatusChanged?.(phid, 'cancelled');
    return r;
  }

  async markRetryExhausted(
    phid: string,
    detail: string,
  ): Promise<Result<DispatchDoc>> {
    const r = await this.wrapNullable("markRetryExhausted", () =>
      this.reactor.markRetryExhausted(phid, detail),
    );
    if (r.ok) this.onStatusChanged?.(phid, 'failed');
    return r;
  }

  async dispatchesInFlight(opts: {
    provider?: Provider;
    runtime?: Runtime;
  }): Promise<Result<DispatchDoc[]>> {
    return this.wrap("dispatchesInFlight", () =>
      this.reactor.listInFlight(opts.provider, opts.runtime),
    );
  }

  async dispatchBounceRetries(opts: {
    provider?: Provider;
    runtime?: Runtime;
  }): Promise<Result<DispatchDoc[]>> {
    return this.wrap("dispatchBounceRetries", () =>
      this.reactor.listBounced(opts.provider, opts.runtime),
    );
  }

  async dispatchQueueEligible(
    filter: QueueEligibleFilter,
  ): Promise<Result<DispatchDoc[]>> {
    return this.wrap("dispatchQueueEligible", async () => {
      const now = filter.now ?? this.now();
      const queued = await this.reactor.listQueued(filter.provider, filter.runtime);
      const eligible = queued
        .filter((d) => d.not_before_at <= now)
        .sort((a, b) => {
          if (b.priority !== a.priority) return b.priority - a.priority;
          if (a.not_before_at !== b.not_before_at)
            return a.not_before_at.localeCompare(b.not_before_at);
          return a.dispatch_phid.localeCompare(b.dispatch_phid);
        });
      const limit = filter.limit ?? eligible.length;
      return eligible.slice(0, limit);
    });
  }

  async concurrencySnapshot(opts: {
    max_safe: number;
    provider?: Provider;
    runtime?: Runtime;
  }): Promise<Result<ConcurrencySnapshot>> {
    return this.wrap("concurrencySnapshot", () => this.reactor.snapshot(opts));
  }

  private async wrap<T>(
    op: string,
    fn: () => Promise<T>,
  ): Promise<Result<T>> {
    try {
      const value = await fn();
      return ok(value);
    } catch (err) {
      return mapError(op, err);
    }
  }

  private async wrapNullable<T>(
    op: string,
    fn: () => Promise<T | null>,
  ): Promise<Result<T>> {
    try {
      const value = await fn();
      if (value == null) {
        return degraded("not_found", `${op}: doc not found`);
      }
      return ok(value);
    } catch (err) {
      return mapError(op, err);
    }
  }
}

function mapError(op: string, err: unknown): Result<never> {
  const e = err as Error & { code?: string };
  const code = e?.code;
  const msg = e?.message ?? String(err);
  if (code === "REACTOR_UNAVAILABLE") {
    return degraded("reactor_unavailable", `${op}: ${msg}`);
  }
  if (code === "REACTOR_CONFLICT") {
    return degraded("conflict", `${op}: ${msg}`);
  }
  return degraded("reactor_error", `${op}: ${msg}`);
}
