// SPDX-License-Identifier: MIT
/**
 * CTO auto-retry — single-shot recovery for the recurring "stuck
 * harness" class of bug.
 *
 * Symptom (live case 2026-05-18): the manager dispatched a /talk to
 * the CTO agent, the agent's local-agent-server.js process was
 * running with the WRONG runtime (claude-code-cli instead of codex
 * for 5 days because ID_HARNESS env wasn't set at spawn), the
 * process silently dropped the dispatch — no `query.received` /
 * `query.completed` news events ever appeared. The operator polled
 * /news, saw nothing, manually re-dispatched.
 *
 * Fix: a small watcher that owns the "did this dispatch actually
 * run?" question. Five minutes after dispatch, count news events
 * for the query_id. Zero → assume stuck → re-dispatch once. If the
 * retry ALSO produces zero events, surface to the operator via a
 * recorded retry event (the operator's stuck-dispatch detector will
 * pick it up, and the dashboard can render it). One retry budget —
 * if the agent is genuinely down, we want to know fast, not loop
 * forever.
 *
 * Design: this module is a pure async orchestrator with all I/O
 * provided as injected callbacks. The /talk-to handler wires it
 * with the real news repo + redispatch path + a setTimeout-based
 * sleeper. Tests pass synchronous fakes and the watcher runs
 * deterministically in ~milliseconds.
 */

/** All I/O the watcher needs. Caller wires these to the running
 *  manager's dependencies. */
export interface CtoRetryContext {
  /** The dispatched query's id (returned by the agent's /talk
   *  handler at the original dispatch). */
  queryId: string;
  /** Name (not id) of the target agent, e.g. "cto". Echoed back to
   *  redispatch so the caller knows which agent to re-target. */
  agentName: string;
  /** The original dispatch message body. */
  message: string;
  /** Returns the number of news_items rows tied to a queryId. */
  countNewsForQuery: (queryId: string) => Promise<number>;
  /** Re-dispatches the message to the same agent and returns the
   *  new queryId. Caller controls whether this hits /talk-to or
   *  /talk; the watcher only cares that a fresh query is in
   *  flight. */
  redispatch: (opts: {
    message: string;
    agentName: string;
    previousQueryId: string;
  }) => Promise<{ queryId: string }>;
  /** Persists a retry decision so the operator surface can render
   *  it. exhausted=true means the retry was tried and also
   *  silent — the operator needs to know. */
  recordRetryEvent: (opts: {
    queryId: string;
    retryCount: number;
    exhausted: boolean;
  }) => Promise<void>;
  /** Wait `ms` before resolving. In production: setTimeout. In tests:
   *  a no-op resolver so the watcher runs synchronously. */
  sleepMs: (ms: number) => Promise<void>;
}

export interface CtoRetryOptions {
  /** How long to wait before the silence-check. Default: 5 min. */
  delayMs?: number;
  /** Maximum number of redispatches. Default: 1. Setting to 0
   *  disables redispatch entirely (the watcher still records the
   *  exhausted=true event if news is silent — useful for telemetry-
   *  only mode while the operator is debugging a stuck agent). */
  maxRetries?: number;
}

export interface CtoRetryResult {
  /** How many retries actually fired. */
  retried: number;
  /** True iff the dispatch is presumed stuck even after retries —
   *  the operator should be paged. */
  exhausted: boolean;
  /** The queryId that represents the canonical in-flight dispatch
   *  after the watcher returns. Either the original (no retry) or
   *  the post-retry id. */
  finalQueryId: string;
}

const DEFAULT_DELAY_MS = 5 * 60 * 1000;
const DEFAULT_MAX_RETRIES = 1;

export async function runCtoAutoRetry(
  ctx: CtoRetryContext,
  opts: CtoRetryOptions = {},
): Promise<CtoRetryResult> {
  const delayMs = opts.delayMs ?? DEFAULT_DELAY_MS;
  const maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;

  await ctx.sleepMs(delayMs);
  const firstCount = await ctx.countNewsForQuery(ctx.queryId);
  if (firstCount > 0) {
    // Healthy — the agent ack'd within the window.
    return { retried: 0, exhausted: false, finalQueryId: ctx.queryId };
  }

  if (maxRetries <= 0) {
    // Telemetry-only mode: record the silence, don't redispatch.
    await ctx.recordRetryEvent({
      queryId: ctx.queryId,
      retryCount: 0,
      exhausted: true,
    });
    return { retried: 0, exhausted: true, finalQueryId: ctx.queryId };
  }

  // Re-dispatch. If the redispatch itself fails, we can't make
  // forward progress — surface immediately as exhausted.
  let newQueryId: string;
  try {
    const r = await ctx.redispatch({
      message: ctx.message,
      agentName: ctx.agentName,
      previousQueryId: ctx.queryId,
    });
    newQueryId = r.queryId;
  } catch {
    await ctx.recordRetryEvent({
      queryId: ctx.queryId,
      retryCount: 0,
      exhausted: true,
    });
    return { retried: 0, exhausted: true, finalQueryId: ctx.queryId };
  }

  await ctx.sleepMs(delayMs);
  const secondCount = await ctx.countNewsForQuery(newQueryId);
  const exhausted = secondCount === 0;
  await ctx.recordRetryEvent({
    queryId: ctx.queryId,
    retryCount: 1,
    exhausted,
  });
  return { retried: 1, exhausted, finalQueryId: newQueryId };
}
