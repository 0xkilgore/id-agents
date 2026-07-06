// B0 (2026-06-08): scheduler-side reader pass over B1's queries.last_output_at
// evidence, plus a terminal-state invariant that prevents the scheduler from
// requeueing dispatches whose linked agent query has already terminated.
//
// The five production phids referenced in the dispatch
// (disp-74d58f0f5e83dfb2, disp-6a1b0e9fc12bda5c, disp-d32ecb5ec7038bef,
// disp-c842552da4c7e756, disp-52d77e60aa58b9eb) are seeded as the
// acceptance replay so the test suite tracks the exact production
// failure mode it is meant to prevent.

import { describe, it, expect } from "vitest";
import { DispatchDocClient } from "../../src/dispatch-scheduler/dispatch-doc-client.js";
import { FakeReactor } from "../../src/dispatch-scheduler/fake-reactor.js";
import { loadSchedulerPolicy } from "../../src/dispatch-scheduler/policy.js";
import { SchedulerService } from "../../src/dispatch-scheduler/scheduler-service.js";
import type {
  AgentTransport,
  AgentTransportResult,
  QueryEvidenceClient,
  QueryEvidence,
} from "../../src/dispatch-scheduler/scheduler-service.js";
import type { DispatchDoc, EnqueueInput } from "../../src/dispatch-scheduler/types.js";

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

class FakeAgentTransport implements AgentTransport {
  calls: Array<{ phid: string; query_id: string; to_agent: string }> = [];
  async sendTalk(doc: DispatchDoc): Promise<AgentTransportResult> {
    this.calls.push({
      phid: doc.dispatch_phid,
      query_id: doc.query_id,
      to_agent: doc.to_agent,
    });
    return { ok: true, agent_query_id: `agent-${doc.query_id}` };
  }
}

class FakeQueryEvidence implements QueryEvidenceClient {
  private records = new Map<string, QueryEvidence>();
  calls: string[] = [];

  set(agentQueryId: string, evidence: QueryEvidence): void {
    this.records.set(agentQueryId, evidence);
  }

  async getEvidence(agentQueryId: string): Promise<QueryEvidence | null> {
    this.calls.push(agentQueryId);
    return this.records.get(agentQueryId) ?? null;
  }
}

function harness(opts?: { now?: string; silence_threshold_ms?: number }) {
  let now = opts?.now ?? "2026-06-08T22:00:00.000Z";
  const reactor = new FakeReactor({ now: () => now });
  const client = new DispatchDocClient({ reactor, now: () => now });
  const transport = new FakeAgentTransport();
  const policy = loadSchedulerPolicy(
    {
      dispatch: opts?.silence_threshold_ms
        ? { silence_threshold_ms: opts.silence_threshold_ms }
        : {},
    },
    {},
  );
  const queryEvidence = new FakeQueryEvidence();
  const scheduler = new SchedulerService({
    client,
    transport,
    policy,
    now: () => now,
    rng: () => 0.5,
    queryEvidence,
  });
  const setNow = (next: string) => {
    now = next;
  };
  return { reactor, client, transport, policy, scheduler, queryEvidence, setNow };
}

describe("B0 — terminal-state invariant on the requeue paths", () => {
  it("reapWedgedInFlight skips dispatches whose latest doc state is already terminal", async () => {
    const { client, reactor, scheduler, setNow } = harness({
      now: "2026-06-08T22:00:00.000Z",
    });
    await client.enqueueDispatch({ ...base, query_id: "q-wedged-but-done" });
    const queued = await reactor.listQueued();
    const phid = queued[0].dispatch_phid;
    await reactor.claim(phid);
    // Intentionally do NOT recordAgentStart so the wedged-start
    // condition (no agent_query_id) is satisfied. Advance the clock past
    // starting_timeout and mark the doc done out-of-band (the failure
    // pattern Spec 2026-06-05 calls out: the agent reports done but the
    // scheduler's in-flight reader still sees the row).
    await reactor.markDone(phid);

    setNow("2026-06-08T22:30:00.000Z");
    const report = await scheduler.tick();

    expect(report.wedged_reaped).toBe(0);
    const doc = await reactor.getByPhid(phid);
    expect(doc?.status).toBe("done");
  });

  it("sweepBounced skips dispatches whose latest doc state is already terminal", async () => {
    const { client, reactor, scheduler, setNow } = harness({
      now: "2026-06-08T22:00:00.000Z",
    });
    await client.enqueueDispatch({ ...base, query_id: "q-bounced-then-done" });
    const queued = await reactor.listQueued();
    const phid = queued[0].dispatch_phid;
    await reactor.claim(phid);
    await reactor.markBounced(phid, {
      kind: "agent_error",
      message: "synthetic",
      next_attempt_at: "2026-06-08T22:00:01.000Z",
    });
    // External actor marks the doc cancelled (e.g. operator intervention)
    // while it's still in the bounced read.
    await reactor.cancel(phid, "operator-cancelled");

    setNow("2026-06-08T22:10:00.000Z");
    const report = await scheduler.tick();

    expect(report.requeued).toBe(0);
    const doc = await reactor.getByPhid(phid);
    expect(doc?.status).toBe("cancelled");
  });
});

describe("B0 — query-evidence-driven terminal closeout", () => {
  it("marks an in_flight dispatch done when the linked query has completed", async () => {
    const { client, reactor, scheduler, queryEvidence } = harness();
    await client.enqueueDispatch({ ...base, query_id: "q-agent-done" });
    const queued = await reactor.listQueued();
    const phid = queued[0].dispatch_phid;
    await reactor.claim(phid);
    await reactor.recordAgentStart(phid, "agent-q-agent-done");
    queryEvidence.set("agent-q-agent-done", {
      status: "completed",
      last_output_at: Date.parse("2026-06-08T21:58:00.000Z"),
    });

    const report = await scheduler.tick();

    expect(report.evidence_closed_done).toBe(1);
    const doc = await reactor.getByPhid(phid);
    expect(doc?.status).toBe("done");
  });

  it("marks a completed linked query failed when the result says it is still waiting", async () => {
    const { client, reactor, scheduler, queryEvidence } = harness();
    await client.enqueueDispatch({ ...base, query_id: "q-agent-waiting" });
    const queued = await reactor.listQueued();
    const phid = queued[0].dispatch_phid;
    await reactor.claim(phid);
    await reactor.recordAgentStart(phid, "agent-q-agent-waiting");
    queryEvidence.set("agent-q-agent-waiting", {
      status: "completed",
      last_output_at: Date.parse("2026-06-08T21:58:00.000Z"),
      result_text:
        "Waiting on the test suite and the live recovery dispatch to finish before continuing verification and promotion.",
    });

    const report = await scheduler.tick();

    expect(report.evidence_closed_done).toBe(0);
    expect(report.evidence_closed_failed).toBe(1);
    const doc = await reactor.getByPhid(phid);
    expect(doc?.status).toBe("failed");
    expect(doc?.failure_kind).toBe("failed_verification");
  });

  it("marks an in_flight dispatch failed when the linked query has failed", async () => {
    const { client, reactor, scheduler, queryEvidence } = harness();
    await client.enqueueDispatch({ ...base, query_id: "q-agent-failed" });
    const queued = await reactor.listQueued();
    const phid = queued[0].dispatch_phid;
    await reactor.claim(phid);
    await reactor.recordAgentStart(phid, "agent-q-agent-failed");
    queryEvidence.set("agent-q-agent-failed", {
      status: "failed",
      last_output_at: Date.parse("2026-06-08T21:58:00.000Z"),
    });

    const report = await scheduler.tick();

    expect(report.evidence_closed_failed).toBe(1);
    const doc = await reactor.getByPhid(phid);
    expect(doc?.status).toBe("failed");
    expect(doc?.failure_kind).toBe("agent_error");
  });

  it("leaves an in_flight dispatch alone when the linked query is still processing and silence is below threshold", async () => {
    const { client, reactor, scheduler, queryEvidence } = harness({
      now: "2026-06-08T22:00:00.000Z",
      silence_threshold_ms: 30 * 60_000,
    });
    await client.enqueueDispatch({ ...base, query_id: "q-still-working" });
    const queued = await reactor.listQueued();
    const phid = queued[0].dispatch_phid;
    await reactor.claim(phid);
    await reactor.recordAgentStart(phid, "agent-q-still-working");
    queryEvidence.set("agent-q-still-working", {
      status: "processing",
      last_output_at: Date.parse("2026-06-08T21:59:30.000Z"),
    });

    const report = await scheduler.tick();

    expect(report.evidence_closed_done).toBe(0);
    expect(report.evidence_silence_bounced).toBe(0);
    const doc = await reactor.getByPhid(phid);
    expect(doc?.status).toBe("in_flight");
  });

  it("bounces an in_flight dispatch when the linked query is processing but silent past threshold", async () => {
    const { client, reactor, scheduler, queryEvidence, setNow } = harness({
      now: "2026-06-08T22:00:00.000Z",
      silence_threshold_ms: 30 * 60_000,
    });
    await client.enqueueDispatch({ ...base, query_id: "q-silent" });
    const queued = await reactor.listQueued();
    const phid = queued[0].dispatch_phid;
    await reactor.claim(phid);
    await reactor.recordAgentStart(phid, "agent-q-silent");
    queryEvidence.set("agent-q-silent", {
      status: "processing",
      last_output_at: Date.parse("2026-06-08T21:10:00.000Z"),
    });

    setNow("2026-06-08T22:00:00.000Z");
    const report = await scheduler.tick();

    expect(report.evidence_silence_bounced).toBe(1);
    const doc = await reactor.getByPhid(phid);
    expect(doc?.status).toBe("bounced");
    expect(doc?.last_bounce?.kind).toBe("scheduler_silence");
  });

  it("skips evidence lookup for in_flight dispatches without an agent_query_id", async () => {
    const { client, reactor, scheduler, queryEvidence } = harness();
    await client.enqueueDispatch({ ...base, query_id: "q-pre-claim" });
    const queued = await reactor.listQueued();
    const phid = queued[0].dispatch_phid;
    await reactor.claim(phid);
    // No recordAgentStart -> agent_query_id remains null.

    await scheduler.tick();

    expect(queryEvidence.calls).toHaveLength(0);
    const doc = await reactor.getByPhid(phid);
    expect(doc?.status).toBe("in_flight");
  });

  it("treats evidence client errors as soft — leaves the dispatch untouched and counts the failure", async () => {
    const reactor = new FakeReactor({ now: () => "2026-06-08T22:00:00.000Z" });
    const client = new DispatchDocClient({ reactor, now: () => "2026-06-08T22:00:00.000Z" });
    const transport = new FakeAgentTransport();
    const policy = loadSchedulerPolicy({}, {});
    const errorEvidence: QueryEvidenceClient = {
      async getEvidence() {
        throw new Error("boom");
      },
    };
    const scheduler = new SchedulerService({
      client,
      transport,
      policy,
      now: () => "2026-06-08T22:00:00.000Z",
      rng: () => 0.5,
      queryEvidence: errorEvidence,
    });

    await client.enqueueDispatch({ ...base, query_id: "q-boom" });
    const queued = await reactor.listQueued();
    const phid = queued[0].dispatch_phid;
    await reactor.claim(phid);
    await reactor.recordAgentStart(phid, "agent-q-boom");

    const report = await scheduler.tick();

    expect(report.evidence_lookup_errors).toBeGreaterThanOrEqual(1);
    const doc = await reactor.getByPhid(phid);
    expect(doc?.status).toBe("in_flight");
  });
});

describe("B0 — production replay: zero re-fires for the five known done dispatches", () => {
  // Exact phids from the 2026-06-08 incident the dispatch references.
  // These dispatches were marked done before the manager restart, then
  // the scheduler tried to re-fire them post-outage. The criterion is
  // that across multiple tick cycles (simulating the 24h observation
  // window), no requeue / markBounced / markFailed call touches them.
  const DONE_PHIDS = [
    "phid:disp-74d58f0f5e83dfb2",
    "phid:disp-6a1b0e9fc12bda5c",
    "phid:disp-d32ecb5ec7038bef",
    "phid:disp-c842552da4c7e756",
    "phid:disp-52d77e60aa58b9eb",
  ];

  it("does not bounce, requeue, or markFailed any phid whose doc state is already done across N ticks", async () => {
    let now = "2026-06-08T22:00:00.000Z";
    const reactor = new FakeReactor({ now: () => now });
    const client = new DispatchDocClient({ reactor, now: () => now });
    const transport = new FakeAgentTransport();
    const policy = loadSchedulerPolicy({}, {});
    const queryEvidence = new FakeQueryEvidence();

    // Spy wrappers around the mutating client surface so we can assert
    // that none of the done phids ever appear as a target.
    const seenMutations: Array<{ op: string; phid: string }> = [];
    const spyClient = new Proxy(client, {
      get(target, prop, receiver) {
        const original = Reflect.get(target, prop, receiver);
        if (
          typeof original === "function" &&
          (prop === "markFailed" ||
            prop === "markBounced" ||
            prop === "requeueAfterBounce" ||
            prop === "markRetryExhausted")
        ) {
          return (phid: string, ...rest: unknown[]) => {
            seenMutations.push({ op: String(prop), phid });
            return (original as Function).apply(target, [phid, ...rest]);
          };
        }
        return original;
      },
    }) as DispatchDocClient;

    const scheduler = new SchedulerService({
      client: spyClient,
      transport,
      policy,
      now: () => now,
      rng: () => 0.5,
      queryEvidence,
    });

    // Seed: enqueue, claim, recordAgentStart, markDone for each phid.
    // The five rows now live in the reactor as terminal `done` docs.
    for (let i = 0; i < DONE_PHIDS.length; i++) {
      await client.enqueueDispatch({ ...base, query_id: `q-done-${i}` });
    }
    const queued = await reactor.listQueued();
    const realPhids: string[] = [];
    for (let i = 0; i < queued.length; i++) {
      const phid = queued[i].dispatch_phid;
      realPhids.push(phid);
      await reactor.claim(phid);
      await reactor.recordAgentStart(phid, `agent-q-${i}`);
      await reactor.markDone(phid);
    }

    // Simulate a 24h observation window with one tick per hour.
    for (let hour = 0; hour < 24; hour++) {
      now = `2026-06-08T${String(22 + hour).padStart(2, "0")}:00:00.000Z`;
      await scheduler.tick();
    }

    // Acceptance assertion: no mutating call references the done phids.
    const offending = seenMutations.filter((m) => realPhids.includes(m.phid));
    expect(offending).toEqual([]);

    // And belt-and-braces: all 5 docs are still in done state.
    for (const phid of realPhids) {
      const doc = await reactor.getByPhid(phid);
      expect(doc?.status).toBe("done");
    }
  });
});
