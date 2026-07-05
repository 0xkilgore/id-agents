// Phase 3.1 + 3.3 + 3.4 TDD: the scheduler-service loop, including
// backoff/requeue, crash tolerance, and the agent transport seam.
//
// Every dependency is fake: a FakeReactor stands in for the live one, a
// FakeAgentTransport stands in for the /talk seam, and the clock is
// controlled. The scheduler is exercised by manual tick() calls; the
// interval timer that drives ticks in production is not under test
// here — that's start()/stop() infra and is verified separately.

import { describe, it, expect } from "vitest";
import { DispatchDocClient } from "../../src/dispatch-scheduler/dispatch-doc-client.js";
import { FakeReactor } from "../../src/dispatch-scheduler/fake-reactor.js";
import { loadSchedulerPolicy } from "../../src/dispatch-scheduler/policy.js";
import { SchedulerService } from "../../src/dispatch-scheduler/scheduler-service.js";
import type {
  AdmissionGateProvider,
  AgentTransport,
  AgentTransportResult,
} from "../../src/dispatch-scheduler/scheduler-service.js";
import { computeRoutingHealthClaimExclusions } from "../../src/dispatch-scheduler/manager-integration.js";
import { computeRoutingHealth } from "../../src/routing-health/read-model.js";
import type { DispatchDoc, EnqueueInput, Provider, Runtime } from "../../src/dispatch-scheduler/types.js";
import type { ModelPolicyResolver, ResolvedModel } from "../../src/model-policy/types.js";
import type { AgentRow } from "../../src/db/types.js";
import type { RoutingHealthReadModel } from "../../src/routing-health/types.js";

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
  private nextResponses: AgentTransportResult[] = [];
  private defaultResponse: AgentTransportResult = {
    ok: true,
    agent_query_id: "agent-q-default",
  };

  setNextResponses(rs: AgentTransportResult[]): void {
    this.nextResponses = [...rs];
  }

  setDefault(r: AgentTransportResult): void {
    this.defaultResponse = r;
  }

  async sendTalk(doc: DispatchDoc): Promise<AgentTransportResult> {
    this.calls.push({
      phid: doc.dispatch_phid,
      query_id: doc.query_id,
      to_agent: doc.to_agent,
    });
    if (this.nextResponses.length > 0) {
      const r = this.nextResponses.shift()!;
      // Auto-mint only when agent_query_id is undefined; explicit empty
      // string is honoured so tests can assert the wedged-start path.
      if (r.ok && r.agent_query_id === undefined) {
        return { ok: true, agent_query_id: `agent-q-${this.calls.length}` };
      }
      return r;
    }
    if (this.defaultResponse.ok) {
      return {
        ok: true,
        agent_query_id: `agent-q-${this.calls.length}`,
      };
    }
    return this.defaultResponse;
  }
}

/** A fake model-policy resolver that always resolves a fixed choice,
 *  regardless of `unavailableProviders` (tests assert on the CALL, not the
 *  policy's own primary/fallback matching logic — that lives in model-policy
 *  tests). Returns the resolver plus its call log for assertions. */
function fakeModelPolicy(choice: { provider: Provider; runtime: Runtime }): {
  policy: ModelPolicyResolver;
  calls: Array<{ agent: string; unavailableProviders?: Provider[] }>;
} {
  const calls: Array<{ agent: string; unavailableProviders?: Provider[] }> = [];
  const policy: ModelPolicyResolver = {
    resolveModelChoice(input): ResolvedModel {
      calls.push(input);
      return {
        agent: input.agent,
        choice: { runtime: choice.runtime, model: "fake-model", provider: choice.provider },
        source: "fallback",
        fallback_applied: true,
        reason: "fake fallback for test",
        policy_agent: input.agent,
        considered: [{ runtime: choice.runtime, model: "fake-model", provider: choice.provider }],
      };
    },
    constrainedProviders: () => [],
  };
  return { policy, calls };
}

function harness(opts?: {
  max?: number;
  now?: string;
  modelPolicy?: ModelPolicyResolver;
  admissionGateProvider?: AdmissionGateProvider;
}) {
  const now = opts?.now ?? "2026-05-19T20:00:00.000Z";
  const reactor = new FakeReactor({ now: () => now });
  const client = new DispatchDocClient({ reactor, now: () => now });
  const transport = new FakeAgentTransport();
  const policy = loadSchedulerPolicy(
    opts?.max != null ? { dispatch: { max_in_flight_anthropic: opts.max } } : {},
    {},
  );
  const scheduler = new SchedulerService({
    client,
    transport,
    policy,
    now: () => reactor.now(),
    rng: () => 0.5,
    modelPolicy: opts?.modelPolicy,
  });
  if (opts?.admissionGateProvider) {
    scheduler.setAdmissionGateProvider(opts.admissionGateProvider);
  }
  return { reactor, client, transport, policy, scheduler };
}

describe("SchedulerService.tick — claiming and starting", () => {
  it("claims up to max_in_flight_anthropic and posts /talk for each", async () => {
    const { client, transport, scheduler } = harness({ max: 3 });
    for (let i = 0; i < 8; i++) {
      await client.enqueueDispatch({ ...base, query_id: `q-${i}` });
    }
    const report = await scheduler.tick();
    expect(report.claimed).toBe(3);
    expect(report.started).toBe(3);
    expect(transport.calls).toHaveLength(3);

    const snap = await client.concurrencySnapshot({ max_safe: 3 });
    if (!snap.ok) throw new Error();
    expect(snap.value.in_flight).toBe(3);
    expect(snap.value.queued).toBe(5);
    expect(snap.value.available_slots).toBe(0);
  });

  it("leaves available_slots empty when no queued docs exist", async () => {
    const { transport, scheduler } = harness({ max: 3 });
    const report = await scheduler.tick();
    expect(report.claimed).toBe(0);
    expect(transport.calls).toHaveLength(0);
  });

  it("respects in-flight count: completing one frees the next slot", async () => {
    const { client, transport, scheduler } = harness({ max: 3 });
    for (let i = 0; i < 5; i++) {
      await client.enqueueDispatch({ ...base, query_id: `q-${i}` });
    }
    await scheduler.tick();
    expect(transport.calls).toHaveLength(3);

    // Mark the first in-flight done; tick should then start one more.
    const inflight = await client.dispatchesInFlight({});
    if (!inflight.ok) throw new Error();
    await client.markDone(inflight.value[0].dispatch_phid);

    await scheduler.tick();
    expect(transport.calls).toHaveLength(4);
  });

  it("records agent_query_id on successful start", async () => {
    const { client, transport, scheduler } = harness({ max: 1 });
    transport.setNextResponses([{ ok: true, agent_query_id: "agent-xyz" }]);
    await client.enqueueDispatch(base);
    await scheduler.tick();
    const doc = await client.getByQueryId("q");
    if (!doc.ok) throw new Error();
    expect(doc.value.agent_query_id).toBe("agent-xyz");
    expect(doc.value.status).toBe("in_flight");
  });
});

describe("SchedulerService.tick — provider throttle handling", () => {
  it("HTTP 429 marks the dispatch bounced and frees the slot", async () => {
    const { client, transport, scheduler } = harness({ max: 3 });
    transport.setNextResponses([
      { ok: false, status: 429, body: "rate_limit_exceeded" },
    ]);
    await client.enqueueDispatch(base);

    const report = await scheduler.tick();
    expect(report.bounced).toBe(1);
    expect(report.started).toBe(0);

    const snap = await client.concurrencySnapshot({ max_safe: 3 });
    if (!snap.ok) throw new Error();
    expect(snap.value.in_flight).toBe(0);
    expect(snap.value.bounced).toBe(1);
    expect(snap.value.available_slots).toBe(3);

    const doc = await client.getByQueryId("q");
    if (!doc.ok) throw new Error();
    expect(doc.value.status).toBe("bounced");
    expect(doc.value.last_bounce?.kind).toBe("provider_throttle");
    expect(doc.value.not_before_at > "2026-05-19T20:00:00.000Z").toBe(true);
  });

  it("exact Anthropic message bounces", async () => {
    const { client, transport, scheduler } = harness({ max: 3 });
    transport.setNextResponses([
      { ok: false, status: 529, body: "Server is temporarily limiting requests" },
    ]);
    await client.enqueueDispatch(base);
    const report = await scheduler.tick();
    expect(report.bounced).toBe(1);
  });

  it("requeues bounced docs after backoff window passes", async () => {
    const { client, transport, scheduler, reactor } = harness({
      max: 3,
      now: "2026-05-19T20:00:00.000Z",
    });
    transport.setNextResponses([
      { ok: false, status: 429, body: "rate_limit" },
    ]);
    await client.enqueueDispatch(base);
    await scheduler.tick();
    // doc is bounced with not_before_at in the future
    const bounced = await client.getByQueryId("q");
    if (!bounced.ok) throw new Error();
    expect(bounced.value.status).toBe("bounced");
    const notBefore = bounced.value.not_before_at;

    // Step the clock past the backoff window.
    reactor.setNow("2026-05-19T20:05:00.000Z");
    transport.setNextResponses([{ ok: true, agent_query_id: "agent-after-retry" }]);
    const report = await scheduler.tick();
    expect(report.requeued).toBe(1);
    expect(report.started).toBe(1);
    expect(transport.calls).toHaveLength(2);

    const doc = await client.getByQueryId("q");
    if (!doc.ok) throw new Error();
    expect(doc.value.status).toBe("in_flight");
    expect(doc.value.agent_query_id).toBe("agent-after-retry");
    expect(doc.value.attempt_count).toBe(2);
    expect(Date.parse(notBefore) < Date.parse(reactor.now())).toBe(true);
  });

  it("succeeds after one bounced retry without creating a second canonical Dispatch", async () => {
    const { client, transport, scheduler, reactor } = harness({
      max: 3,
      now: "2026-05-19T20:00:00.000Z",
    });
    transport.setNextResponses([
      { ok: false, status: 429, body: "throttled" },
      { ok: true, agent_query_id: "agent-success" },
    ]);
    await client.enqueueDispatch(base);
    await scheduler.tick();
    reactor.setNow("2026-05-19T20:05:00.000Z");
    await scheduler.tick();

    const all = await Promise.all([
      client.dispatchesInFlight({}),
      client.dispatchBounceRetries({}),
      client.dispatchQueueEligible({}),
    ]);
    if (!all[0].ok || !all[1].ok || !all[2].ok) throw new Error();
    expect(all[0].value.length + all[1].value.length + all[2].value.length).toBe(1);
    expect(all[0].value).toHaveLength(1);
    expect(all[0].value[0].agent_query_id).toBe("agent-success");
  });

  it("retry exhaustion goes terminal", async () => {
    const { client, transport, scheduler, reactor } = harness({
      max: 3,
      now: "2026-05-19T20:00:00.000Z",
    });
    transport.setDefault({ ok: false, status: 429, body: "rate_limit" });
    await client.enqueueDispatch(base);

    // Run enough ticks for attempts to exhaust (rate_limit_max_attempts = 5)
    // Stepping the clock generously between each.
    const stepClock = (s: number) =>
      reactor.setNow(new Date(Date.parse(reactor.now()) + s * 1000).toISOString());
    for (let i = 0; i < 6; i++) {
      await scheduler.tick();
      stepClock(600);
    }
    const doc = await client.getByQueryId("q");
    if (!doc.ok) throw new Error();
    expect(doc.value.status).toBe("failed");
    expect(doc.value.failure_kind).toBe("provider_rate_limit_exhausted");
  });
});

describe("SchedulerService.tick — BUG-003 rate-limit fallback routing", () => {
  it("a rate-limit bounce with a configured model policy retries on the FALLBACK lane, not the same one", async () => {
    const { policy: modelPolicy, calls } = fakeModelPolicy({ provider: "cursor", runtime: "cursor-cli" });
    const { client, transport, scheduler } = harness({ max: 3, modelPolicy });
    transport.setNextResponses([{ ok: false, status: 429, body: "rate_limit_exceeded" }]);
    await client.enqueueDispatch(base); // base is provider: "anthropic", runtime: "claude-code-cli"

    const report = await scheduler.tick();
    expect(report.bounced).toBe(1);

    const doc = await client.getByQueryId("q");
    if (!doc.ok) throw new Error();
    expect(doc.value.status).toBe("bounced");
    // Retry now targets the resolved fallback lane, not the throttled one.
    expect(doc.value.provider).toBe("cursor");
    expect(doc.value.runtime).toBe("cursor-cli");

    // The policy was asked with the CURRENT (throttled) provider marked unavailable.
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ agent: "coder-max", unavailableProviders: ["anthropic"] });
  });

  it("does NOT change the lane when no model policy is configured (unchanged pre-fallback behavior)", async () => {
    const { client, transport, scheduler } = harness({ max: 3 }); // no modelPolicy
    transport.setNextResponses([{ ok: false, status: 429, body: "rate_limit_exceeded" }]);
    await client.enqueueDispatch(base);
    await scheduler.tick();

    const doc = await client.getByQueryId("q");
    if (!doc.ok) throw new Error();
    expect(doc.value.status).toBe("bounced");
    expect(doc.value.provider).toBe("anthropic");
    expect(doc.value.runtime).toBe("claude-code-cli");
  });

  it("does NOT change the lane when the resolved choice IS the current lane (no viable fallback)", async () => {
    const { policy: modelPolicy } = fakeModelPolicy({ provider: "anthropic", runtime: "claude-code-cli" });
    const { client, transport, scheduler } = harness({ max: 3, modelPolicy });
    transport.setNextResponses([{ ok: false, status: 429, body: "rate_limit_exceeded" }]);
    await client.enqueueDispatch(base);
    await scheduler.tick();

    const doc = await client.getByQueryId("q");
    if (!doc.ok) throw new Error();
    expect(doc.value.provider).toBe("anthropic");
    expect(doc.value.runtime).toBe("claude-code-cli");
  });

  it("does NOT apply fallback routing to a non-throttle (transport) bounce", async () => {
    const { policy: modelPolicy, calls } = fakeModelPolicy({ provider: "cursor", runtime: "cursor-cli" });
    const { client, transport, scheduler } = harness({ max: 3, modelPolicy });
    transport.setNextResponses([
      { ok: false, status: 0, body: "", cause: "transport", transportError: "ECONNREFUSED" },
    ]);
    await client.enqueueDispatch(base);
    await scheduler.tick();

    const doc = await client.getByQueryId("q");
    if (!doc.ok) throw new Error();
    expect(doc.value.status).toBe("bounced");
    expect(doc.value.last_bounce?.kind).toBe("transport");
    // Same lane — a connectivity failure isn't a capacity problem a fallback provider fixes.
    expect(doc.value.provider).toBe("anthropic");
    expect(doc.value.runtime).toBe("claude-code-cli");
    expect(calls).toHaveLength(0);
  });
});

describe("SchedulerService.tick — non-throttle errors", () => {
  it("HTTP 401 marks failed (no retry — terminal auth-required)", async () => {
    const { client, transport, scheduler } = harness({ max: 1 });
    transport.setNextResponses([
      { ok: false, status: 401, body: "invalid api key" },
    ]);
    await client.enqueueDispatch(base);
    const report = await scheduler.tick();
    expect(report.failed).toBe(1);
    expect(report.bounced).toBe(0);
    const doc = await client.getByQueryId("q");
    if (!doc.ok) throw new Error();
    expect(doc.value.status).toBe("failed");
    // D1 / BUG-003: provider_auth_error is a typed terminal — never retried, and
    // distinguishable from a generic agent error so the operator knows to re-auth.
    expect(doc.value.failure_kind).toBe("failed_auth_required");
  });

  it("HTTP 500 marks failed (not bounced)", async () => {
    const { client, transport, scheduler } = harness({ max: 1 });
    transport.setNextResponses([
      { ok: false, status: 500, body: "internal server error" },
    ]);
    await client.enqueueDispatch(base);
    const report = await scheduler.tick();
    expect(report.failed).toBe(1);
    expect(report.bounced).toBe(0);
  });

  it("transport error (ECONNREFUSED) bounces (retryable)", async () => {
    const { client, transport, scheduler } = harness({ max: 1 });
    transport.setNextResponses([
      {
        ok: false,
        status: 0,
        body: "",
        cause: "transport",
        transportError: "ECONNREFUSED",
      },
    ]);
    await client.enqueueDispatch(base);
    const report = await scheduler.tick();
    expect(report.bounced).toBe(1);
  });
});

describe("SchedulerService — budget gate", () => {
  it("hard pause prevents claiming new docs", async () => {
    const { client, transport, scheduler } = harness({ max: 3 });
    scheduler.setBudgetState("hard_pause");
    await client.enqueueDispatch(base);
    const report = await scheduler.tick();
    expect(report.claimed).toBe(0);
    expect(transport.calls).toHaveLength(0);
  });

  it("soft pause holds current in-flight, no new starts", async () => {
    const { client, transport, scheduler } = harness({ max: 3 });
    // First, start one normally.
    await client.enqueueDispatch({ ...base, query_id: "running" });
    await scheduler.tick();
    expect(transport.calls).toHaveLength(1);

    scheduler.setBudgetState("soft_pause");
    await client.enqueueDispatch({ ...base, query_id: "waiting" });
    const report = await scheduler.tick();
    expect(report.claimed).toBe(0);
    expect(transport.calls).toHaveLength(1);
  });
});

describe("SchedulerService — crash tolerance (Phase 3.4)", () => {
  it("restart with queued + bounced docs does not lose them", async () => {
    // Simulate restart by spinning up a second SchedulerService against
    // the same reactor.
    const { reactor, client, scheduler, transport, policy } = harness({
      max: 3,
      now: "2026-05-19T20:00:00.000Z",
    });
    await client.enqueueDispatch({ ...base, query_id: "queued-1" });
    await client.enqueueDispatch({ ...base, query_id: "queued-2" });
    transport.setNextResponses([
      { ok: false, status: 429, body: "rate_limit" },
      { ok: true, agent_query_id: "agent-still-up" },
    ]);
    await scheduler.tick();

    const snap1 = await client.concurrencySnapshot({ max_safe: 3 });
    if (!snap1.ok) throw new Error();
    const queuedCount = snap1.value.queued + snap1.value.in_flight + snap1.value.bounced;

    // Restart — drop scheduler reference, spin up a new one.
    const newClient = new DispatchDocClient({ reactor, now: () => reactor.now() });
    const newTransport = new FakeAgentTransport();
    const newScheduler = new SchedulerService({
      client: newClient,
      transport: newTransport,
      policy,
      now: () => reactor.now(),
      rng: () => 0.5,
    });

    const snap2 = await newClient.concurrencySnapshot({ max_safe: 3 });
    if (!snap2.ok) throw new Error();
    expect(snap2.value.queued + snap2.value.in_flight + snap2.value.bounced).toBe(
      queuedCount,
    );
  });

  it("stale in_flight without agent_query_id past starting_timeout_ms is reaped and recovered", async () => {
    const { client, reactor, scheduler, transport } = harness({
      max: 3,
      now: "2026-05-19T20:00:00.000Z",
    });
    // First tick: transport returns ok but with no agent_query_id —
    // simulates a crash between /talk acceptance and recordAgentStart.
    transport.setNextResponses([{ ok: true, agent_query_id: "" }]);
    await client.enqueueDispatch(base);
    await scheduler.tick();
    const docAfter = await client.getByQueryId("q");
    if (!docAfter.ok) throw new Error();
    expect(docAfter.value.status).toBe("in_flight");
    expect(docAfter.value.agent_query_id ?? "").toBe("");
    expect(docAfter.value.attempt_count).toBe(1);

    // Advance clock past starting_timeout_ms (60s default) and tick.
    // Wedge sweep reaps + requeues; same tick re-claims and the next
    // /talk attempt gives us a real agent_query_id.
    reactor.setNow("2026-05-19T20:02:00.000Z");
    transport.setNextResponses([{ ok: true, agent_query_id: "agent-recovered" }]);
    const report = await scheduler.tick();
    expect(report.wedged_reaped).toBe(1);

    const recovered = await client.getByQueryId("q");
    if (!recovered.ok) throw new Error();
    expect(recovered.value.status).toBe("in_flight");
    expect(recovered.value.agent_query_id).toBe("agent-recovered");
    expect(recovered.value.attempt_count).toBe(2);
  });

  it("when wedge sweep produces a backed-off requeue, doc stays queued past the tick", async () => {
    // Variant: if the same tick has no available slot (cap saturated by
    // other in_flight docs), the recovered-to-queued doc remains queued
    // and waits for the next available slot. This proves the wedge
    // recovery does not require capacity to be useful.
    const { client, reactor, scheduler, transport, policy } = harness({
      max: 1,
      now: "2026-05-19T20:00:00.000Z",
    });
    // Doc 1: normal start, will stay in_flight occupying the only slot.
    await client.enqueueDispatch({ ...base, query_id: "q-running" });
    transport.setNextResponses([{ ok: true, agent_query_id: "agent-running" }]);
    await scheduler.tick();

    // Doc 2: claim it AND immediately wedge it. Bump cap, run wedge cycle,
    // drop cap. Doc 2 enters in_flight via direct claim and gets stuck.
    await client.enqueueDispatch({ ...base, query_id: "q-wedge" });
    const otherTransport = {
      calls: [] as Array<{ phid: string }>,
      async sendTalk(doc: DispatchDoc) {
        otherTransport.calls.push({ phid: doc.dispatch_phid });
        return { ok: true as const, agent_query_id: "" };
      },
    };
    const otherScheduler = new SchedulerService({
      client,
      transport: otherTransport,
      policy: { ...policy, max_in_flight_anthropic: 2 },
      now: () => reactor.now(),
      rng: () => 0.5,
    });
    await otherScheduler.tick();
    // Now there are two in_flight (one with agent_query_id, one wedged).

    // Step clock past timeout.
    reactor.setNow("2026-05-19T20:02:00.000Z");

    // Original scheduler (cap=1) ticks. The agent_query_id-bearing doc
    // still occupies its slot, so the wedged doc is reaped+requeued
    // but cannot be started on this tick.
    const report = await scheduler.tick();
    expect(report.wedged_reaped).toBe(1);
    expect(report.started).toBe(0);
    const wedged = await client.getByQueryId("q-wedge");
    if (!wedged.ok) throw new Error();
    expect(wedged.value.status).toBe("queued");
  });

  it("in_flight with agent_query_id is not double-posted on restart", async () => {
    const { client, reactor, scheduler, transport, policy } = harness({
      max: 3,
      now: "2026-05-19T20:00:00.000Z",
    });
    transport.setNextResponses([{ ok: true, agent_query_id: "agent-running" }]);
    await client.enqueueDispatch(base);
    await scheduler.tick();
    expect(transport.calls).toHaveLength(1);

    // Restart: new scheduler, fresh transport. The doc is still in_flight
    // with an agent_query_id. Subsequent ticks must NOT re-post.
    const newTransport = new FakeAgentTransport();
    const newClient = new DispatchDocClient({ reactor, now: () => reactor.now() });
    const newScheduler = new SchedulerService({
      client: newClient,
      transport: newTransport,
      policy,
      now: () => reactor.now(),
      rng: () => 0.5,
    });
    const report = await newScheduler.tick();
    expect(newTransport.calls).toHaveLength(0);
    expect(report.started).toBe(0);
  });

  it("two scheduler instances do not over-claim the same doc", async () => {
    const { client, reactor, transport, policy } = harness({ max: 3 });
    for (let i = 0; i < 4; i++) {
      await client.enqueueDispatch({ ...base, query_id: `q-${i}` });
    }
    const t2 = new FakeAgentTransport();
    const s1 = new SchedulerService({
      client,
      transport,
      policy,
      now: () => reactor.now(),
      rng: () => 0.5,
    });
    const s2 = new SchedulerService({
      client,
      transport: t2,
      policy,
      now: () => reactor.now(),
      rng: () => 0.5,
    });
    await Promise.all([s1.tick(), s2.tick()]);
    const allClaimed = transport.calls.length + t2.calls.length;
    expect(allClaimed).toBe(3); // capped at max_safe = 3
    const ids = [...transport.calls, ...t2.calls].map((c) => c.phid);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

// RD-014 Ticket B: the overnight-audit cascade — "agents silently flip to
// pending... admission keeps dispatching to them anyway." computeFleetAdmissionExclusions
// (fleet-composition, unrelated to live health) alone can't catch this: a
// dispatch already queued against a lane whose runtime degrades AFTER enqueue
// needs the claim query itself to consult live routing-health.
describe("SchedulerService.tick — RD-014 Ticket B: claim-time routing-health gate", () => {
  function agentRow(overrides: Partial<AgentRow>): AgentRow {
    return {
      team_id: "team",
      id: overrides.name ?? "agent-id",
      name: overrides.name ?? "agent",
      type: "persistent",
      model: "claude-sonnet",
      port: 1,
      endpoint: "http://127.0.0.1:1",
      working_directory: null,
      status: "running",
      created_at: 0,
      registry: null,
      metadata: null,
      deleted_at: null,
      runtime: "claude-code-cli",
      token_id: null,
      domain: null,
      api_key: null,
      customer_domain: null,
      public_endpoint_url: null,
      internal_endpoint_url: null,
      ssh_target: null,
      last_seen: null,
      last_probed_at: null,
      last_error: null,
      consecutive_failures: 0,
      ...overrides,
    };
  }

  function healthModelWith(runtimesDown: string[]): RoutingHealthReadModel {
    return computeRoutingHealth({
      team_id: "team",
      now: new Date().toISOString(),
      pools: [],
      builders: [],
      dispatches: [],
      runtimes: [{ name: "claude", role: "primary", live: !runtimesDown.includes("claude") }],
    });
  }

  it("a lane that degrades to down AFTER enqueue is excluded from the very next claim (never silently claimed by the dead lane)", async () => {
    // base.to_agent = "coder-max", provider "anthropic" / runtime "claude-code-cli".
    const agents = [agentRow({ id: "agent_coder-max", name: "coder-max", runtime: "claude-code-cli" })];
    let healthModel: RoutingHealthReadModel | null = healthModelWith([]); // starts healthy
    const admissionGateProvider: AdmissionGateProvider = {
      getExcludedAgentsForClaim: async () => computeRoutingHealthClaimExclusions(agents, healthModel),
    };
    const { client, transport, scheduler } = harness({ max: 3, admissionGateProvider });

    await client.enqueueDispatch(base);
    const t1 = await scheduler.tick();
    expect(t1.claimed).toBe(1); // healthy — claims normally
    expect(transport.calls).toHaveLength(1);

    // A second dispatch queues, then the lane degrades BEFORE this tick claims it
    // (the overnight-audit scenario: enqueue-time health was fine; it died after).
    await client.enqueueDispatch({ ...base, query_id: "q2" });
    healthModel = healthModelWith(["claude"]);

    const t2 = await scheduler.tick();
    expect(t2.claimed).toBe(0);
    expect(transport.calls).toHaveLength(1); // unchanged — q2 was NOT claimed

    const doc2 = await client.getByQueryId("q2");
    if (!doc2.ok) throw new Error();
    expect(doc2.value.status).toBe("queued"); // stays queued with a surfaced reason, never silently claimed
  });

  it("all lanes healthy → unchanged behavior (claims normally, no behavior change)", async () => {
    const agents = [agentRow({ id: "agent_coder-max", name: "coder-max", runtime: "claude-code-cli" })];
    const healthModel = healthModelWith([]);
    const admissionGateProvider: AdmissionGateProvider = {
      getExcludedAgentsForClaim: async () => computeRoutingHealthClaimExclusions(agents, healthModel),
    };
    const { client, transport, scheduler } = harness({ max: 3, admissionGateProvider });

    await client.enqueueDispatch(base);
    const report = await scheduler.tick();
    expect(report.claimed).toBe(1);
    expect(transport.calls).toHaveLength(1);
  });

  it("/routing-health and the claim gate agree on which lanes are excluded (both read the same computeRoutingHealth output)", async () => {
    const model = healthModelWith(["claude"]);
    // The read-model itself is what /routing-health serves — asserting on it
    // directly proves the claim gate and that route can never disagree, since
    // both consume this exact object.
    expect(model.summary.runtimes_down).toContain("claude");
    const agents = [agentRow({ id: "agent_coder-max", name: "coder-max", runtime: "claude-code-cli" })];
    expect(computeRoutingHealthClaimExclusions(agents, model)).toEqual(
      expect.arrayContaining(["coder-max", "agent_coder-max"]),
    );
  });
});
