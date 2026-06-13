// W1-1 runtime-provider-lanes.
//
// Cursor CLI is a distinct provider lane, not Anthropic. These tests prove:
//   - the canonical runtime → provider resolver,
//   - independent per-provider concurrency caps (policy + admission),
//   - and the headline acceptance: Anthropic / OpenAI(Codex) / Cursor queues
//     do NOT consume each other's concurrency slots at claim time.

import { describe, it, expect } from "vitest";

import {
  Provider,
  normalizeRuntime,
  resolveProviderFromRuntime,
} from "../../src/dispatch-scheduler/types.js";
import {
  POLICY_DEFAULTS,
  getSafeConcurrency,
  loadSchedulerPolicy,
  maxInFlightForProvider,
} from "../../src/dispatch-scheduler/policy.js";
import {
  defaultProviderMaxConcurrent,
  admitDispatch,
} from "../../src/usage-meter/admission.js";
import { DispatchDocClient } from "../../src/dispatch-scheduler/dispatch-doc-client.js";
import { FakeReactor } from "../../src/dispatch-scheduler/fake-reactor.js";
import {
  SchedulerService,
  type AgentTransport,
  type AgentTransportResult,
} from "../../src/dispatch-scheduler/scheduler-service.js";
import type { DispatchDoc, EnqueueInput } from "../../src/dispatch-scheduler/types.js";

describe("resolveProviderFromRuntime (canonical runtime → provider lane)", () => {
  it("maps claude runtimes to anthropic", () => {
    expect(resolveProviderFromRuntime("claude-code-cli")).toBe("anthropic");
    expect(resolveProviderFromRuntime("claude-agent-sdk")).toBe("anthropic");
    expect(resolveProviderFromRuntime("claude-code-local")).toBe("anthropic");
  });
  it("maps codex → openai, cursor-cli → cursor, public-agent-remote → other", () => {
    expect(resolveProviderFromRuntime("codex")).toBe("openai");
    expect(resolveProviderFromRuntime("cursor-cli")).toBe("cursor");
    expect(resolveProviderFromRuntime("public-agent-remote")).toBe("other");
  });
  it("tolerates the legacy 'cursor' alias and unknown values", () => {
    expect(resolveProviderFromRuntime("cursor")).toBe("cursor");
    expect(resolveProviderFromRuntime("whatever")).toBe("other");
    expect(resolveProviderFromRuntime(undefined)).toBe("other");
  });
  it("normalizeRuntime canonicalizes cursor → cursor-cli", () => {
    expect(normalizeRuntime("cursor")).toBe("cursor-cli");
    expect(normalizeRuntime("CURSOR-CLI")).toBe("cursor-cli");
    expect(normalizeRuntime("nope")).toBe("other");
  });
});

describe("policy — independent per-provider caps", () => {
  it("has a cursor cap default distinct from anthropic", () => {
    expect(POLICY_DEFAULTS.max_in_flight_cursor).toBe(2);
    expect(POLICY_DEFAULTS.max_in_flight_anthropic).toBe(3);
  });

  it("DISPATCH_MAX_IN_FLIGHT_CURSOR overrides only the cursor lane", () => {
    const p = loadSchedulerPolicy({}, { DISPATCH_MAX_IN_FLIGHT_CURSOR: "5" });
    expect(p.max_in_flight_cursor).toBe(5);
    expect(p.max_in_flight_anthropic).toBe(POLICY_DEFAULTS.max_in_flight_anthropic);
    expect(p.max_in_flight_openai).toBe(POLICY_DEFAULTS.max_in_flight_openai);
  });

  it("maxInFlightForProvider returns the lane-specific cap", () => {
    const p = loadSchedulerPolicy({}, {});
    expect(maxInFlightForProvider(p, "anthropic")).toBe(p.max_in_flight_anthropic);
    expect(maxInFlightForProvider(p, "openai")).toBe(p.max_in_flight_openai);
    expect(maxInFlightForProvider(p, "cursor")).toBe(p.max_in_flight_cursor);
    expect(maxInFlightForProvider(p, "other")).toBe(p.max_in_flight_other);
  });

  it("getSafeConcurrency returns each lane's own cap (no shared Anthropic default)", () => {
    const p = loadSchedulerPolicy(
      { dispatch: { max_in_flight_anthropic: 3, max_in_flight_openai: 4, max_in_flight_cursor: 2 } },
      {},
    );
    const anth = getSafeConcurrency({ provider: "anthropic", runtime: "claude-code-cli" }, p);
    const oai = getSafeConcurrency({ provider: "openai", runtime: "codex" }, p);
    const cur = getSafeConcurrency({ provider: "cursor", runtime: "cursor-cli" }, p);
    expect(anth.max_safe).toBe(3);
    expect(oai.max_safe).toBe(4);
    expect(cur.max_safe).toBe(2);
    expect(cur.reason).toMatch(/cursor cap = 2/);
  });
});

describe("admission — per-provider concurrency defaults", () => {
  it("cursor has its own admission cap (2), distinct from anthropic (3) / openai (4)", () => {
    expect(defaultProviderMaxConcurrent("anthropic")).toBe(3);
    expect(defaultProviderMaxConcurrent("openai")).toBe(4);
    expect(defaultProviderMaxConcurrent("cursor")).toBe(2);
  });

  it("a cursor dispatch is gated on the CURSOR cap, not Anthropic's", () => {
    // 2 cursor dispatches already in flight; cursor cap is 2 → queue.
    const r = admitDispatch({
      dispatch_phid: "phid:disp-cur",
      agent_id: "cursor-agent",
      provider: "cursor",
      enforcement: "enforce",
      now_iso: "2026-06-12T17:00:00.000Z",
      budget: { daily_limit: 1_000_000, weekly_limit: 5_000_000 },
      usage: { daily_used: 0, weekly_used: 0 },
      agent_concurrency: { current: 0, max: 99 },
      provider_concurrency: { current: 2 }, // uses cursor default (2) → at cap
      spacing: { last_dispatched_at: null },
    });
    expect(r.status).toBe("queued_for_capacity");
    expect(r.gate!.gate_reason).toBe("provider_capacity_full");

    // The SAME provider load (2) would NOT cap Anthropic (default 3).
    const anth = admitDispatch({
      dispatch_phid: "phid:disp-anth",
      agent_id: "anth-agent",
      provider: "anthropic",
      enforcement: "enforce",
      now_iso: "2026-06-12T17:00:00.000Z",
      budget: { daily_limit: 1_000_000, weekly_limit: 5_000_000 },
      usage: { daily_used: 0, weekly_used: 0 },
      agent_concurrency: { current: 0, max: 99 },
      provider_concurrency: { current: 2 }, // anthropic default 3 → still admits
      spacing: { last_dispatched_at: null },
    });
    expect(anth.status).toBe("delivering");
  });
});

describe("scheduler tick — lanes do not consume each other's slots", () => {
  function harness(providers: Provider[]) {
    const clock = { now: "2026-06-12T17:00:00.000Z" };
    const reactor = new FakeReactor({ now: () => clock.now });
    const client = new DispatchDocClient({ reactor, now: () => clock.now });
    const transport: AgentTransport = {
      async sendTalk(_doc: DispatchDoc): Promise<AgentTransportResult> {
        return { ok: true, agent_query_id: undefined };
      },
    };
    const policy = loadSchedulerPolicy(
      { dispatch: { max_in_flight_anthropic: 1, max_in_flight_cursor: 2 } },
      {},
    );
    const scheduler = new SchedulerService({
      client,
      transport,
      policy,
      now: () => clock.now,
      providers,
    });
    return { reactor, scheduler, clock };
  }

  function enqueue(reactor: FakeReactor, n: number, provider: Provider, runtime: string) {
    const out: Promise<DispatchDoc>[] = [];
    for (let i = 0; i < n; i++) {
      const input: EnqueueInput = {
        query_id: `q-${provider}-${i}`,
        to_agent: `${provider}-agent-${i}`,
        from_actor: "manager",
        channel: "dispatch",
        subject: "s",
        body_markdown: "b",
        provider,
        runtime: runtime as EnqueueInput["runtime"],
        priority: 5,
      };
      out.push(reactor.enqueue(input));
    }
    return Promise.all(out);
  }

  it("each lane claims only up to its OWN cap; a full Anthropic lane does not starve Cursor, and Cursor's in-flight never counts against Anthropic", async () => {
    const { reactor, scheduler } = harness(["anthropic", "cursor"]);
    await enqueue(reactor, 3, "anthropic", "claude-code-cli");
    await enqueue(reactor, 3, "cursor", "cursor-cli");

    const report = await scheduler.tick();

    // Anthropic cap 1 → exactly 1 claimed; cursor cap 2 → exactly 2 claimed.
    const anthInFlight = (await reactor.listInFlight("anthropic")).length;
    const cursorInFlight = (await reactor.listInFlight("cursor")).length;
    expect(anthInFlight).toBe(1); // did NOT borrow cursor's slots
    expect(cursorInFlight).toBe(2); // not starved by the 3 queued anthropic docs
    expect(report.claimed).toBe(3); // 1 + 2 across both lanes

    // Backlog remains queued in each lane independently.
    expect((await reactor.listQueued("anthropic")).length).toBe(2);
    expect((await reactor.listQueued("cursor")).length).toBe(1);
  });

  it("a single-provider scheduler (default lanes) only drains its own lane", async () => {
    const { reactor, scheduler } = harness(["anthropic"]);
    await enqueue(reactor, 2, "anthropic", "claude-code-cli");
    await enqueue(reactor, 2, "cursor", "cursor-cli");

    await scheduler.tick();

    expect((await reactor.listInFlight("anthropic")).length).toBe(1); // anthropic cap 1
    expect((await reactor.listInFlight("cursor")).length).toBe(0); // cursor lane untouched
  });
});
