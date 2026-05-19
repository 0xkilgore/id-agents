// Phase 1.2 reducer/query lifecycle coverage. End-to-end round-trips
// through every legal transition, asserting the queries match.

import { describe, it, expect } from "vitest";
import { DispatchDocClient } from "../../src/dispatch-scheduler/dispatch-doc-client.js";
import { FakeReactor } from "../../src/dispatch-scheduler/fake-reactor.js";
import type { EnqueueInput } from "../../src/dispatch-scheduler/types.js";

const base: EnqueueInput = {
  query_id: "q",
  to_agent: "coder-max",
  from_actor: "manager",
  channel: "dispatch",
  subject: "subj",
  body_markdown: "body",
  provider: "anthropic",
  runtime: "claude-code-cli",
  priority: 5,
};

function harness(now = "2026-05-19T20:00:00.000Z") {
  const reactor = new FakeReactor({ now: () => now });
  const client = new DispatchDocClient({ reactor, now: () => now });
  return { reactor, client };
}

describe("dispatch lifecycle: queued → in_flight → done", () => {
  it("happy path completes cleanly", async () => {
    const { client } = harness();
    const enq = await client.enqueueDispatch(base);
    if (!enq.ok) throw new Error();
    const claimed = await client.claimForStart({ limit: 1 });
    if (!claimed.ok || claimed.value.length !== 1) throw new Error();
    const phid = claimed.value[0].dispatch_phid;
    await client.recordAgentStart(phid, "agent-q-xyz");
    const done = await client.markDone(phid);
    if (!done.ok) throw new Error();
    expect(done.value.status).toBe("done");
    expect(done.value.agent_query_id).toBe("agent-q-xyz");
  });
});

describe("dispatch lifecycle: queued → in_flight → bounced → queued → in_flight → done", () => {
  it("retry after bounce reaches done without creating a second doc", async () => {
    const { client, reactor } = harness("2026-05-19T20:00:00.000Z");
    const enq = await client.enqueueDispatch(base);
    if (!enq.ok) throw new Error();
    const phidOriginal = enq.value.dispatch_phid;

    const claim1 = await client.claimForStart({ limit: 1 });
    if (!claim1.ok) throw new Error();
    const bounceTime = "2026-05-19T20:05:00.000Z";
    await client.markBounced(phidOriginal, {
      kind: "provider_rate_limit",
      message: "throttled",
      next_attempt_at: bounceTime,
    });

    // While bounced: visible in dispatchBounceRetries, not in dispatchesInFlight.
    const bouncedList = await client.dispatchBounceRetries({});
    if (!bouncedList.ok) throw new Error();
    expect(bouncedList.value.map((d) => d.dispatch_phid)).toEqual([phidOriginal]);
    const inFlight = await client.dispatchesInFlight({});
    if (!inFlight.ok) throw new Error();
    expect(inFlight.value).toHaveLength(0);

    // Advance, requeue, re-claim, complete.
    reactor.setNow("2026-05-19T20:06:00.000Z");
    const requeued = await client.requeueAfterBounce(phidOriginal);
    if (!requeued.ok) throw new Error(`requeue: ${requeued.detail}`);
    expect(requeued.value.status).toBe("queued");
    const claim2 = await client.claimForStart({ limit: 1, now: "2026-05-19T20:06:00.000Z" });
    if (!claim2.ok) throw new Error();
    expect(claim2.value).toHaveLength(1);
    expect(claim2.value[0].dispatch_phid).toBe(phidOriginal);
    expect(claim2.value[0].attempt_count).toBe(2);

    const done = await client.markDone(phidOriginal);
    if (!done.ok) throw new Error();
    expect(done.value.status).toBe("done");

    // Only one canonical doc exists.
    const all = await Promise.all([
      client.dispatchesInFlight({}),
      client.dispatchBounceRetries({}),
      client.dispatchQueueEligible({}),
    ]);
    for (const r of all) {
      if (!r.ok) throw new Error();
      expect(r.value).toHaveLength(0);
    }
  });
});

describe("dispatch lifecycle: retry exhaustion is visible terminal", () => {
  it("after markRetryExhausted, no further requeue or claim happens", async () => {
    const { client } = harness();
    const enq = await client.enqueueDispatch(base);
    if (!enq.ok) throw new Error();
    const claim = await client.claimForStart({ limit: 1 });
    if (!claim.ok) throw new Error();
    const phid = claim.value[0].dispatch_phid;
    await client.markBounced(phid, {
      kind: "provider_rate_limit",
      message: "throttled",
      next_attempt_at: "2026-05-19T20:05:00.000Z",
    });
    const ex = await client.markRetryExhausted(phid, "5 attempts exhausted");
    if (!ex.ok) throw new Error();
    expect(ex.value.status).toBe("failed");

    // Requeue after exhaustion is rejected.
    const r = await client.requeueAfterBounce(phid);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("conflict");
  });
});

describe("dispatch lifecycle: cancellation frees a slot from every non-terminal state", () => {
  it("cancel from queued, in_flight, and bounced all free the slot in the snapshot", async () => {
    const { client } = harness();
    // queued cancel
    const q = await client.enqueueDispatch({ ...base, query_id: "q-cancel" });
    if (!q.ok) throw new Error();
    await client.cancel(q.value.dispatch_phid, "no longer needed");
    // in_flight cancel
    const i = await client.enqueueDispatch({ ...base, query_id: "i-cancel" });
    if (!i.ok) throw new Error();
    const claim = await client.claimForStart({ limit: 1 });
    if (!claim.ok) throw new Error();
    await client.cancel(claim.value[0].dispatch_phid, "kill in-flight");
    // bounced cancel
    const b = await client.enqueueDispatch({ ...base, query_id: "b-cancel" });
    if (!b.ok) throw new Error();
    const claim2 = await client.claimForStart({ limit: 1 });
    if (!claim2.ok) throw new Error();
    await client.markBounced(claim2.value[0].dispatch_phid, {
      kind: "provider_rate_limit",
      message: "throttled",
      next_attempt_at: "2026-05-19T20:30:00.000Z",
    });
    await client.cancel(claim2.value[0].dispatch_phid, "abort retry");

    const snap = await client.concurrencySnapshot({ max_safe: 3 });
    if (!snap.ok) throw new Error();
    expect(snap.value.in_flight).toBe(0);
    expect(snap.value.queued).toBe(0);
    expect(snap.value.bounced).toBe(0);
    expect(snap.value.available_slots).toBe(3);
  });
});

describe("dispatchConcurrencySnapshot counts only slot-occupying docs as in_flight", () => {
  it("done + cancelled + bounced do not occupy slots", async () => {
    const { client } = harness();
    const a = await client.enqueueDispatch({ ...base, query_id: "a" });
    if (!a.ok) throw new Error();
    const b = await client.enqueueDispatch({ ...base, query_id: "b" });
    if (!b.ok) throw new Error();
    const c = await client.enqueueDispatch({ ...base, query_id: "c" });
    if (!c.ok) throw new Error();
    const d = await client.enqueueDispatch({ ...base, query_id: "d" });
    if (!d.ok) throw new Error();
    const claim = await client.claimForStart({ limit: 4 });
    if (!claim.ok) throw new Error();
    // First two stay in-flight; third marked done; fourth bounced
    await client.markDone(claim.value[2].dispatch_phid);
    await client.markBounced(claim.value[3].dispatch_phid, {
      kind: "provider_rate_limit",
      message: "throttled",
      next_attempt_at: "2026-05-19T20:30:00.000Z",
    });

    const snap = await client.concurrencySnapshot({ max_safe: 3 });
    if (!snap.ok) throw new Error();
    expect(snap.value.in_flight).toBe(2);
    expect(snap.value.available_slots).toBe(1);
  });
});
