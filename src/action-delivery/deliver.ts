// T-RELIABILITY AD1 — retry-safe, bounded operator/inter-agent action delivery.
//
// Operator actions (talk-to, agent-resume/unblock, approve, dispatch, promote) had
// no client-visible timeout → a slow call looked like an infinite hang even when
// delivery was healthy. This is the load-bearing primitive: every action gets a
// bounded timeout, a typed status, and an idempotency key so a retry-after-timeout
// re-delivers ONCE (never a double-fire). Pure + injectable so the invariants are
// unit-testable (the AD4 verification-sweep core); the executors wire to it.

export type ActionStatus = "queued" | "in_flight" | "delivered" | "timed_out" | "failed";

export interface ActionResult<T> {
  status: ActionStatus;
  /** Present when status === "delivered". */
  value?: T;
  /** Present when status === "failed". */
  error?: string;
  /** The idempotency key (reuse the dispatch-scheduler dedup_key) this ran under. */
  idempotency_key: string;
  /** Wall-clock latency of THIS call (bounded by timeout_ms on a timeout). */
  latency_ms: number;
  /** True when the result came from an already-in-flight/settled delivery for the
   *  same key (a retry), i.e. run() was NOT invoked again. */
  deduped: boolean;
}

export interface DeliverActionArgs<T> {
  idempotency_key: string;
  timeout_ms: number;
  /** The actual delivery. Invoked at most ONCE per idempotency key. */
  run: () => Promise<T>;
}

type Settled<T> = { value: T } | { error: string };

/**
 * Create an action deliverer with its own in-flight/dedup table. A single `run()`
 * is started per idempotency key; concurrent or later calls with the same key
 * reuse that one delivery. Each call races the shared delivery against its own
 * bounded timeout, so a client can give up (→ `timed_out`) WITHOUT cancelling the
 * underlying delivery — and a retry with the same key reuses it, delivering once.
 */
export function createActionDeliverer(opts: { now?: () => number } = {}) {
  const now = opts.now ?? Date.now;
  const inflight = new Map<string, { promise: Promise<Settled<unknown>>; started: boolean }>();

  async function deliverAction<T>(args: DeliverActionArgs<T>): Promise<ActionResult<T>> {
    const start = now();
    let entry = inflight.get(args.idempotency_key);
    const isRetry = entry !== undefined;
    if (!entry) {
      const promise = args
        .run()
        .then((value): Settled<unknown> => ({ value }))
        .catch((err): Settled<unknown> => ({ error: err instanceof Error ? err.message : String(err) }));
      entry = { promise, started: true };
      inflight.set(args.idempotency_key, entry);
    }

    const TIMEOUT = Symbol("timeout");
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<typeof TIMEOUT>((res) => {
      timer = setTimeout(() => res(TIMEOUT), args.timeout_ms);
    });

    const outcome = await Promise.race([entry.promise, timeout]);
    if (timer) clearTimeout(timer);

    const latency_ms = Math.max(0, now() - start);
    if (outcome === TIMEOUT) {
      // The client's bound elapsed; the shared delivery keeps running under the key
      // so a retry (same key) re-delivers once rather than double-firing.
      return { status: "timed_out", idempotency_key: args.idempotency_key, latency_ms, deduped: isRetry };
    }
    if ("error" in outcome) {
      return { status: "failed", error: outcome.error, idempotency_key: args.idempotency_key, latency_ms, deduped: isRetry };
    }
    return {
      status: "delivered",
      value: outcome.value as T,
      idempotency_key: args.idempotency_key,
      latency_ms,
      deduped: isRetry,
    };
  }

  /** Drop a settled key so its idempotency slot can be reclaimed (optional GC). */
  function forget(idempotency_key: string): void {
    inflight.delete(idempotency_key);
  }

  return { deliverAction, forget };
}
