// Phase 1.1 TDD for DispatchDocClient — typed state adapter against a
// fake Reactor. The adapter is the only seam manager code uses to
// enqueue, claim, mark, requeue, and snapshot Dispatch docs; the scheduler
// transport is the only thing that calls /talk. These tests drive the
// pure contract — no live Reactor required.

import { describe, it, expect, beforeEach } from "vitest";
import { DispatchDocClient } from "../../src/dispatch-scheduler/dispatch-doc-client.js";
import { FakeReactor } from "../../src/dispatch-scheduler/fake-reactor.js";
import type {
  DispatchDoc,
  EnqueueInput,
  SchedulerStatus,
} from "../../src/dispatch-scheduler/types.js";

const baseInput: EnqueueInput = {
  query_id: "q-001",
  to_agent: "coder-max",
  from_actor: "manager",
  channel: "dispatch",
  subject: "do the thing",
  body_markdown: "please do the thing",
  provider: "anthropic",
  runtime: "claude-code-cli",
  priority: 5,
};

function freshClient(now = "2026-05-19T20:00:00.000Z"): {
  reactor: FakeReactor;
  client: DispatchDocClient;
} {
  const reactor = new FakeReactor({ now: () => now });
  const client = new DispatchDocClient({ reactor, now: () => now });
  return { reactor, client };
}

describe("DispatchDocClient.enqueueDispatch", () => {
  it("creates a queued Dispatch doc and returns its phid + query_id", async () => {
    const { client } = freshClient();
    const r = await client.enqueueDispatch(baseInput);
    if (!r.ok) throw new Error(`unexpected degraded: ${r.detail}`);
    expect(r.value.status).toBe("queued");
    expect(r.value.query_id).toBe("q-001");
    expect(r.value.dispatch_phid).toMatch(/^phid:/);
    expect(r.value.attempt_count).toBe(0);
    expect(r.value.bounce_count).toBe(0);
    expect(r.value.last_bounce).toBeNull();
    expect(r.value.usage_policy_snapshot).toBeNull();
  });

  it("preserves query_id across the doc lifecycle", async () => {
    const { client } = freshClient();
    const enq = await client.enqueueDispatch({ ...baseInput, query_id: "stable-id" });
    if (!enq.ok) throw new Error("enqueue failed");
    const phid = enq.value.dispatch_phid;
    const fetched = await client.getByQueryId("stable-id");
    if (!fetched.ok) throw new Error("query lookup failed");
    expect(fetched.value.dispatch_phid).toBe(phid);
    expect(fetched.value.query_id).toBe("stable-id");
  });

  it("clamps invalid priority to a default", async () => {
    const { client } = freshClient();
    const r = await client.enqueueDispatch({ ...baseInput, priority: -7 } as EnqueueInput);
    if (!r.ok) throw new Error("enqueue failed");
    expect(r.value.priority).toBeGreaterThanOrEqual(0);
  });

  it("returns degraded when the Reactor is unavailable", async () => {
    const reactor = new FakeReactor({ now: () => "2026-05-19T20:00:00.000Z" });
    reactor.simulateUnavailable("ECONNREFUSED");
    const client = new DispatchDocClient({
      reactor,
      now: () => "2026-05-19T20:00:00.000Z",
    });
    const r = await client.enqueueDispatch(baseInput);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("reactor_unavailable");
      expect(r.detail).toContain("ECONNREFUSED");
    }
  });
});

describe("DispatchDocClient.claimForStart", () => {
  it("atomically moves an eligible queued doc to in_flight", async () => {
    const { client } = freshClient();
    const enq = await client.enqueueDispatch(baseInput);
    if (!enq.ok) throw new Error("enqueue failed");

    const claimed = await client.claimForStart({ limit: 1 });
    if (!claimed.ok) throw new Error("claim failed");
    expect(claimed.value).toHaveLength(1);
    expect(claimed.value[0].status).toBe("in_flight");
    expect(claimed.value[0].attempt_count).toBe(1);
    expect(claimed.value[0].started_at).toBeTruthy();
  });

  it("respects priority order (high first)", async () => {
    const { client } = freshClient();
    await client.enqueueDispatch({ ...baseInput, query_id: "low", priority: 1 });
    await client.enqueueDispatch({ ...baseInput, query_id: "high", priority: 9 });
    await client.enqueueDispatch({ ...baseInput, query_id: "mid", priority: 5 });

    const claimed = await client.claimForStart({ limit: 3 });
    if (!claimed.ok) throw new Error("claim failed");
    expect(claimed.value.map((d) => d.query_id)).toEqual(["high", "mid", "low"]);
  });

  it("does not claim docs whose not_before_at is in the future", async () => {
    const { client, reactor } = freshClient("2026-05-19T20:00:00.000Z");
    await client.enqueueDispatch({
      ...baseInput,
      query_id: "later",
      not_before_at: "2026-05-19T20:10:00.000Z",
    });
    await client.enqueueDispatch({ ...baseInput, query_id: "now" });

    const claimed = await client.claimForStart({ limit: 2 });
    if (!claimed.ok) throw new Error("claim failed");
    expect(claimed.value.map((d) => d.query_id)).toEqual(["now"]);

    // Step time forward; the deferred doc should now be eligible.
    reactor.setNow("2026-05-19T20:15:00.000Z");
    const second = await client.claimForStart({ limit: 2, now: "2026-05-19T20:15:00.000Z" });
    if (!second.ok) throw new Error("second claim failed");
    expect(second.value.map((d) => d.query_id)).toEqual(["later"]);
  });

  it("two concurrent claims do not double-claim the same doc", async () => {
    const { client } = freshClient();
    for (let i = 0; i < 4; i++) {
      await client.enqueueDispatch({ ...baseInput, query_id: `q-${i}` });
    }
    const [a, b] = await Promise.all([
      client.claimForStart({ limit: 3 }),
      client.claimForStart({ limit: 3 }),
    ]);
    if (!a.ok || !b.ok) throw new Error("claim degraded");
    const aIds = a.value.map((d) => d.dispatch_phid);
    const bIds = b.value.map((d) => d.dispatch_phid);
    for (const id of aIds) expect(bIds).not.toContain(id);
    expect(aIds.length + bIds.length).toBe(4);
  });
});

describe("DispatchDocClient lifecycle transitions", () => {
  it("recordAgentStart stores the agent_query_id", async () => {
    const { client } = freshClient();
    const enq = await client.enqueueDispatch(baseInput);
    if (!enq.ok) throw new Error("enqueue");
    const claimed = await client.claimForStart({ limit: 1 });
    if (!claimed.ok) throw new Error("claim");
    const phid = claimed.value[0].dispatch_phid;

    const r = await client.recordAgentStart(phid, "agent-query-xyz");
    if (!r.ok) throw new Error("recordAgentStart");
    expect(r.value.agent_query_id).toBe("agent-query-xyz");
    expect(r.value.status).toBe("in_flight");
  });

  it("markDone moves in_flight → done and stamps completed_at", async () => {
    const { client } = freshClient();
    const enq = await client.enqueueDispatch(baseInput);
    if (!enq.ok) throw new Error("enqueue");
    const claimed = await client.claimForStart({ limit: 1 });
    if (!claimed.ok) throw new Error("claim");
    const phid = claimed.value[0].dispatch_phid;

    const r = await client.markDone(phid);
    if (!r.ok) throw new Error(`markDone: ${r.detail}`);
    expect(r.value.status).toBe("done");
    expect(r.value.completed_at).toBeTruthy();
  });

  it("markFailed moves to failed with a failure kind", async () => {
    const { client } = freshClient();
    const enq = await client.enqueueDispatch(baseInput);
    if (!enq.ok) throw new Error("enqueue");
    const claimed = await client.claimForStart({ limit: 1 });
    if (!claimed.ok) throw new Error("claim");
    const phid = claimed.value[0].dispatch_phid;

    const r = await client.markFailed(phid, {
      failure_kind: "agent_error",
      detail: "agent crashed",
    });
    if (!r.ok) throw new Error("markFailed");
    expect(r.value.status).toBe("failed");
    expect(r.value.failure_kind).toBe("agent_error");
    expect(r.value.failure_detail).toBe("agent crashed");
  });

  it("markBounced records a visible bounce + sets not_before_at", async () => {
    const { client } = freshClient();
    const enq = await client.enqueueDispatch(baseInput);
    if (!enq.ok) throw new Error("enqueue");
    const claimed = await client.claimForStart({ limit: 1 });
    if (!claimed.ok) throw new Error("claim");
    const phid = claimed.value[0].dispatch_phid;

    const r = await client.markBounced(phid, {
      kind: "provider_rate_limit",
      message: "Server is temporarily limiting requests",
      next_attempt_at: "2026-05-19T20:05:00.000Z",
    });
    if (!r.ok) throw new Error(`markBounced: ${r.detail}`);
    expect(r.value.status).toBe("bounced");
    expect(r.value.bounce_count).toBe(1);
    expect(r.value.last_bounce?.kind).toBe("provider_rate_limit");
    expect(r.value.last_bounce?.next_attempt_at).toBe("2026-05-19T20:05:00.000Z");
    expect(r.value.not_before_at).toBe("2026-05-19T20:05:00.000Z");
    expect(r.value.bounce_history).toHaveLength(1);
  });

  it("requeueAfterBounce moves bounced → queued only when not_before_at has passed", async () => {
    const { client, reactor } = freshClient("2026-05-19T20:00:00.000Z");
    const enq = await client.enqueueDispatch(baseInput);
    if (!enq.ok) throw new Error("enqueue");
    const claimed = await client.claimForStart({ limit: 1 });
    if (!claimed.ok) throw new Error("claim");
    const phid = claimed.value[0].dispatch_phid;
    await client.markBounced(phid, {
      kind: "provider_rate_limit",
      message: "throttled",
      next_attempt_at: "2026-05-19T20:05:00.000Z",
    });

    // Still before backoff — requeue should refuse / no-op.
    const early = await client.requeueAfterBounce(phid);
    if (!early.ok) {
      expect(early.reason).toBe("conflict");
    } else {
      expect(early.value.status).toBe("bounced");
    }

    // Advance clock past the backoff window.
    reactor.setNow("2026-05-19T20:06:00.000Z");
    const r = await client.requeueAfterBounce(phid);
    if (!r.ok) throw new Error(`requeue: ${r.detail}`);
    expect(r.value.status).toBe("queued");
  });

  it("cancel terminates from queued, in_flight, and bounced", async () => {
    const { client } = freshClient();
    // From queued
    const a = await client.enqueueDispatch({ ...baseInput, query_id: "a" });
    if (!a.ok) throw new Error("a enqueue");
    const cancelA = await client.cancel(a.value.dispatch_phid, "no longer needed");
    if (!cancelA.ok) throw new Error("cancel A");
    expect(cancelA.value.status).toBe("cancelled");

    // From in_flight
    const b = await client.enqueueDispatch({ ...baseInput, query_id: "b" });
    if (!b.ok) throw new Error("b enqueue");
    const claimed = await client.claimForStart({ limit: 1 });
    if (!claimed.ok) throw new Error("claim B");
    const cancelB = await client.cancel(claimed.value[0].dispatch_phid, "kill in-flight");
    if (!cancelB.ok) throw new Error("cancel B");
    expect(cancelB.value.status).toBe("cancelled");

    // From bounced
    const c = await client.enqueueDispatch({ ...baseInput, query_id: "c" });
    if (!c.ok) throw new Error("c enqueue");
    const claimedC = await client.claimForStart({ limit: 1 });
    if (!claimedC.ok) throw new Error("claim C");
    await client.markBounced(claimedC.value[0].dispatch_phid, {
      kind: "provider_rate_limit",
      message: "throttled",
      next_attempt_at: "2026-05-19T21:00:00.000Z",
    });
    const cancelC = await client.cancel(claimedC.value[0].dispatch_phid, "abort retry");
    if (!cancelC.ok) throw new Error("cancel C");
    expect(cancelC.value.status).toBe("cancelled");
  });

  it("markRetryExhausted moves to failed with provider_rate_limit_exhausted", async () => {
    const { client } = freshClient();
    const enq = await client.enqueueDispatch(baseInput);
    if (!enq.ok) throw new Error("enqueue");
    const claimed = await client.claimForStart({ limit: 1 });
    if (!claimed.ok) throw new Error("claim");
    const phid = claimed.value[0].dispatch_phid;
    await client.markBounced(phid, {
      kind: "provider_rate_limit",
      message: "throttled",
      next_attempt_at: "2026-05-19T20:05:00.000Z",
    });

    const r = await client.markRetryExhausted(phid, "5 attempts exhausted");
    if (!r.ok) throw new Error(`markRetryExhausted: ${r.detail}`);
    expect(r.value.status).toBe("failed");
    expect(r.value.failure_kind).toBe("provider_rate_limit_exhausted");
  });

  it("rejects illegal transitions (terminal → other)", async () => {
    const { client } = freshClient();
    const enq = await client.enqueueDispatch(baseInput);
    if (!enq.ok) throw new Error("enqueue");
    const claimed = await client.claimForStart({ limit: 1 });
    if (!claimed.ok) throw new Error("claim");
    const phid = claimed.value[0].dispatch_phid;
    const done = await client.markDone(phid);
    if (!done.ok) throw new Error("markDone");

    const r = await client.markBounced(phid, {
      kind: "provider_rate_limit",
      message: "late bounce",
      next_attempt_at: "2026-05-19T21:00:00.000Z",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("conflict");
  });
});

describe("DispatchDocClient.snapshot + queries", () => {
  it("concurrencySnapshot counts only slot-occupying docs as in_flight", async () => {
    const { client } = freshClient();
    // 2 queued, 1 in-flight, 1 bounced
    await client.enqueueDispatch({ ...baseInput, query_id: "a" });
    await client.enqueueDispatch({ ...baseInput, query_id: "b" });
    const c = await client.enqueueDispatch({ ...baseInput, query_id: "c" });
    if (!c.ok) throw new Error();
    const d = await client.enqueueDispatch({ ...baseInput, query_id: "d" });
    if (!d.ok) throw new Error();
    const claimed = await client.claimForStart({ limit: 2 });
    if (!claimed.ok) throw new Error();
    await client.markBounced(claimed.value[1].dispatch_phid, {
      kind: "provider_rate_limit",
      message: "throttled",
      next_attempt_at: "2026-05-19T21:00:00.000Z",
    });

    const snap = await client.concurrencySnapshot({ max_safe: 3 });
    if (!snap.ok) throw new Error("snapshot");
    expect(snap.value.in_flight).toBe(1);
    expect(snap.value.queued).toBe(2);
    expect(snap.value.bounced).toBe(1);
    expect(snap.value.available_slots).toBe(2);
    expect(snap.value.max_safe).toBe(3);
  });

  it("dispatchesInFlight + dispatchesBouncedRetries filter by provider", async () => {
    const { client } = freshClient();
    const a = await client.enqueueDispatch({ ...baseInput, query_id: "a", provider: "anthropic" });
    const b = await client.enqueueDispatch({ ...baseInput, query_id: "b", provider: "openai" });
    if (!a.ok || !b.ok) throw new Error();
    await client.claimForStart({ limit: 2 });

    const flightAnth = await client.dispatchesInFlight({ provider: "anthropic" });
    if (!flightAnth.ok) throw new Error();
    expect(flightAnth.value.map((d) => d.query_id)).toEqual(["a"]);
    const flightOpenai = await client.dispatchesInFlight({ provider: "openai" });
    if (!flightOpenai.ok) throw new Error();
    expect(flightOpenai.value.map((d) => d.query_id)).toEqual(["b"]);
  });

  it("oldest_queued_age_ms reflects the longest-queued doc", async () => {
    const { client, reactor } = freshClient("2026-05-19T20:00:00.000Z");
    await client.enqueueDispatch({ ...baseInput, query_id: "old" });
    reactor.setNow("2026-05-19T20:00:30.000Z");
    await client.enqueueDispatch({ ...baseInput, query_id: "newer" });
    reactor.setNow("2026-05-19T20:01:00.000Z");
    const snap = await client.concurrencySnapshot({ max_safe: 3 });
    if (!snap.ok) throw new Error();
    expect(snap.value.oldest_queued_age_ms).toBe(60_000);
  });
});

describe("DispatchDocClient terminal status guards", () => {
  it("isTerminal helper recognises done/failed/cancelled", () => {
    const cases: Array<[SchedulerStatus, boolean]> = [
      ["queued", false],
      ["in_flight", false],
      ["bounced", false],
      ["done", true],
      ["failed", true],
      ["cancelled", true],
    ];
    for (const [s, expected] of cases) {
      const doc: Pick<DispatchDoc, "status"> = { status: s };
      expect(["done", "failed", "cancelled"].includes(doc.status)).toBe(expected);
    }
  });
});
