// Phase 4 integration: SchedulerHandle bootstraps the full stack
// (SqliteDispatchReactor + scheduler + transport) and the test
// exercises enqueue → tick → start → wait → done as it'll run in the
// manager process.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync, mkdtempSync } from "node:fs";
import { SqliteAdapter } from "../../src/db/sqlite-adapter.js";
import { migrateSqlite } from "../../src/db/migrations/sqlite.js";
import { SqliteAgentsRepo } from "../../src/db/repos/sqlite/agents-repo.js";
import {
  SchedulerHandle,
  parseGatewayMode,
  schedulerEnabled,
  MANAGER_LIFECYCLE_ACTOR,
  CHRIS_DASHBOARD_ACTOR,
  actorRefForAgentCompletion,
} from "../../src/dispatch-scheduler/manager-integration.js";
import { buildModelPolicyService } from "../../src/model-policy/policy.js";

let tmpDir: string;
let adapter: SqliteAdapter;

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "scheduler-handle-"));
  adapter = new SqliteAdapter(join(tmpDir, "test.db"));
  await migrateSqlite(adapter);
  await adapter.query(`INSERT INTO teams (id, name) VALUES ('team', 'team')`);
});

afterEach(async () => {
  await adapter.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

async function waitUntil(
  predicate: () => boolean,
  timeoutMs = 1000,
  pollMs = 10,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  throw new Error("timed out waiting for condition");
}

describe("parseGatewayMode / schedulerEnabled", () => {
  it("defaults to shadow when unset", () => {
    expect(parseGatewayMode(undefined)).toBe("shadow");
    expect(parseGatewayMode("")).toBe("shadow");
    expect(parseGatewayMode("garbage")).toBe("shadow");
  });
  it("accepts off / shadow / enforce (case-insensitive)", () => {
    expect(parseGatewayMode("off")).toBe("off");
    expect(parseGatewayMode("ENFORCE")).toBe("enforce");
    expect(parseGatewayMode("Shadow")).toBe("shadow");
  });
  it("schedulerEnabled defaults true", () => {
    expect(schedulerEnabled(undefined)).toBe(true);
    expect(schedulerEnabled({})).toBe(true);
  });
  it("schedulerEnabled honours false/0/no", () => {
    expect(schedulerEnabled({ DISPATCH_SCHEDULER_ENABLED: "false" })).toBe(false);
    expect(schedulerEnabled({ DISPATCH_SCHEDULER_ENABLED: "0" })).toBe(false);
    expect(schedulerEnabled({ DISPATCH_SCHEDULER_ENABLED: "no" })).toBe(false);
  });
});

describe("SchedulerHandle recovery wiring", () => {
  async function seedExpiredFailure(handle: SchedulerHandle): Promise<string> {
    const enq = await handle.enqueue({
      to_agent: "coder-max",
      from_actor: "manager",
      message: "build something",
    });
    const doc = await handle.reactor.getByQueryId(enq.query_id);
    await adapter.query(
      `UPDATE dispatch_scheduler_queue
         SET status = 'failed', failure_kind = 'expired',
             failure_detail = 'linked query terminated expired',
             completed_at = ? WHERE dispatch_phid = ?`,
      [new Date().toISOString(), doc!.dispatch_phid],
    );
    return doc!.dispatch_phid;
  }

  it("is a no-op when DISPATCH_RECOVERY_ENABLED is unset (default off)", async () => {
    const handle = new SchedulerHandle({
      adapter,
      teamId: "team",
      resolveTargetUrl: () => "http://localhost:9999",
      env: {},
    });
    const phid = await seedExpiredFailure(handle);
    const report = await handle.runRecoveryOnce();
    expect(report?.skipped).toBe(true);
    const doc = await handle.reactor.getByPhid(phid);
    expect(doc?.status).toBe("failed");
  });

  it("requeues a recoverable expired failure when enabled", async () => {
    const handle = new SchedulerHandle({
      adapter,
      teamId: "team",
      resolveTargetUrl: () => "http://localhost:9999",
      env: { DISPATCH_RECOVERY_ENABLED: "true" },
    });
    const phid = await seedExpiredFailure(handle);
    const report = await handle.runRecoveryOnce();
    expect(report?.skipped).toBe(false);
    expect(report?.retried).toBe(1);
    const doc = await handle.reactor.getByPhid(phid);
    expect(doc?.status).toBe("bounced");
    expect(doc?.recovery_status).toBe("recovering");
    expect(doc?.recovery_attempts).toBe(1);
  });
});

describe("SchedulerHandle bootstrap + flow", () => {
  it("keeps logical finances addressable on a fallback runtime lane", async () => {
    const agentsRepository = new SqliteAgentsRepo(adapter);
    await adapter.query(
      `INSERT INTO agents (team_id, id, name, type, model, port, endpoint, status, created_at, runtime, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        "team",
        "agent_finances_claude_session_1",
        "finances",
        "claude",
        "claude-sonnet-4-20250514",
        4254,
        "http://localhost:4254",
        "exhausted",
        1000,
        "claude-code-cli",
        JSON.stringify({ logical_agent: "finances", runtime_lane: "claude-code-cli", provider_lane: "anthropic" }),
      ],
    );
    await adapter.query(
      `INSERT INTO agents (team_id, id, name, type, model, port, endpoint, status, created_at, runtime, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        "team",
        "agent_codex_lane_1",
        "substrate-api-codex",
        "claude",
        "gpt-5.5",
        4275,
        "http://localhost:4275",
        "running",
        2000,
        "codex",
        JSON.stringify({ runtime_lane: "codex", provider_lane: "openai" }),
      ],
    );
    await agentsRepository.upsertLogicalIdentityFromAgent({
      team_id: "team",
      name: "finances",
      created_at: 1000,
      metadata: {
        logical_agent: "finances",
        description: "Finance specialist",
        runtime_lane: "claude-code-cli",
        provider_lane: "anthropic",
      },
    });
    const fetchSpy = vi.spyOn(globalThis, "fetch") as ReturnType<typeof vi.spyOn>;
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ query_id: "agent-q-codex" }), { status: 200 }) as unknown as Response,
    );
    const handle = new SchedulerHandle({
      adapter,
      teamId: "team",
      agentsRepository,
      resolveTargetUrl: () => "http://localhost:4254",
      env: { DISPATCH_MAX_IN_FLIGHT_OPENAI: "1" } as any,
    });

    const enq = await handle.enqueue({
      to_agent: "finances",
      from_actor: "manager",
      message: "finance follow-up after Claude exhaustion",
      runtime: "codex",
    });
    await handle.tick();

    const doc = await handle.client.getByQueryId(enq.query_id);
    if (!doc.ok) throw new Error();
    expect(doc.value.to_agent).toBe("finances");
    expect(doc.value.runtime).toBe("codex");
    expect(doc.value.provider).toBe("openai");
    expect(fetchSpy.mock.calls[0]?.[0]).toBe("http://localhost:4275/talk");
    const logical = await agentsRepository.getLogicalIdentity("team", "finances");
    expect(logical?.logical_agent).toBe("finances");
    expect(logical?.metadata).toMatchObject({ description: "Finance specialist" });
    expect(logical?.metadata).not.toHaveProperty("runtime_lane");
    expect(logical?.metadata).not.toHaveProperty("provider_lane");
    fetchSpy.mockRestore();
  });

  it("enqueue → tick → done with mocked transport", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch") as ReturnType<typeof vi.spyOn>;
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ query_id: "agent-q-1" }), { status: 200 }) as unknown as Response,
    );
    const handle = new SchedulerHandle({
      adapter,
      teamId: "team",
      resolveTargetUrl: () => "http://localhost:9999",
      env: {
        DISPATCH_GATEWAY_MODE: "shadow",
        DISPATCH_MAX_IN_FLIGHT_ANTHROPIC: "3",
      },
    });
    expect(handle.mode).toBe("shadow");
    expect(handle.policy.max_in_flight_anthropic).toBe(3);

    const enq = await handle.enqueue({
      to_agent: "coder-max",
      from_actor: "manager",
      message: "hello there",
    });
    expect(enq.status).toBe("queued");
    expect(enq.query_id).toMatch(/^query_/);
    expect(enq.dispatch_phid).toMatch(/^phid:/);

    await handle.tick();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const url = fetchSpy.mock.calls[0]?.[0];
    expect(url).toBe("http://localhost:9999/talk");

    const doc = await handle.client.getByQueryId(enq.query_id);
    if (!doc.ok) throw new Error();
    expect(doc.value.status).toBe("in_flight");
    expect(doc.value.agent_query_id).toBe("agent-q-1");

    // /agent-done arrives via either query_id or agent_query_id.
    const final = await handle.handleAgentDone({
      agent_query_id: "agent-q-1",
      result: { reply: "ack" },
      success: true,
    });
    expect(final?.status).toBe("done");
    fetchSpy.mockRestore();
  });

  it("started scheduler wakes queued dispatches on enqueue without waiting for the interval", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch") as ReturnType<typeof vi.spyOn>;
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ query_id: "agent-q-wake" }), { status: 200 }) as unknown as Response,
    );
    const handle = new SchedulerHandle({
      adapter,
      teamId: "team",
      resolveTargetUrl: () => "http://localhost:9999",
      env: {
        DISPATCH_TICK_INTERVAL_MS: "60000",
        DISPATCH_MAX_IN_FLIGHT_ANTHROPIC: "1",
      },
    });
    handle.start();
    try {
      const enq = await handle.enqueue({
        to_agent: "worker",
        from_actor: "manager",
        message: "wake immediately",
      }, {
        target_url: "http://localhost:9999",
        wake: true,
      });

      await waitUntil(() => fetchSpy.mock.calls.length === 1);
      const doc = await handle.client.getByQueryId(enq.query_id);
      if (!doc.ok) throw new Error();
      expect(doc.value.status).toBe("in_flight");
      expect(doc.value.agent_query_id).toBe("agent-q-wake");
    } finally {
      handle.stop();
      fetchSpy.mockRestore();
    }
  });

  it("8-burst at cap=3 starts at most 3 per tick", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch") as ReturnType<typeof vi.spyOn>;
    let callCount = 0;
    fetchSpy.mockImplementation(async () => {
      callCount += 1;
      return new Response(JSON.stringify({ query_id: `agent-q-${callCount}` }), {
        status: 200,
      }) as unknown as Response;
    });
    const handle = new SchedulerHandle({
      adapter,
      teamId: "team",
      resolveTargetUrl: () => "http://localhost:9999",
      env: { DISPATCH_MAX_IN_FLIGHT_ANTHROPIC: "3" },
    });
    for (let i = 0; i < 8; i++) {
      await handle.enqueue({
        to_agent: `worker-${i}`,
        from_actor: "manager",
        message: `task ${i}`,
      });
    }
    await handle.tick();
    expect(callCount).toBe(3);
    const snap = await handle.snapshot();
    expect(snap.in_flight).toBe(3);
    expect(snap.queued).toBe(5);
    expect(snap.available_slots).toBe(0);

    // Complete one in-flight via /agent-done — the next tick should start one more.
    const inflight = await handle.client.dispatchesInFlight({});
    if (!inflight.ok) throw new Error();
    await handle.handleAgentDone({
      agent_query_id: inflight.value[0].agent_query_id ?? undefined,
      success: true,
    });
    await handle.tick();
    expect(callCount).toBe(4);
    fetchSpy.mockRestore();
  });

  it("waitForTerminal returns when /agent-done fires", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch") as ReturnType<typeof vi.spyOn>;
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ query_id: "agent-q-wait" }), { status: 200 }) as unknown as Response,
    );
    const handle = new SchedulerHandle({
      adapter,
      teamId: "team",
      resolveTargetUrl: () => "http://localhost:9999",
    });
    const enq = await handle.enqueue({
      to_agent: "worker",
      from_actor: "manager",
      message: "wait for me",
    });
    await handle.tick();

    const waitPromise = handle.waitForTerminal(enq.query_id, { timeoutMs: 3000, pollMs: 50 });
    setTimeout(() => {
      void handle.handleAgentDone({
        agent_query_id: "agent-q-wait",
        result: { reply: "done" },
        success: true,
      });
    }, 100);
    const final = await waitPromise;
    expect(final?.status).toBe("done");
    fetchSpy.mockRestore();
  });

  it("waitForTerminal returns the (non-terminal) snapshot on timeout", async () => {
    const handle = new SchedulerHandle({
      adapter,
      teamId: "team",
      resolveTargetUrl: () => "http://localhost:9999",
    });
    const enq = await handle.enqueue({
      to_agent: "worker",
      from_actor: "manager",
      message: "stuck",
    });
    const final = await handle.waitForTerminal(enq.query_id, { timeoutMs: 200, pollMs: 50 });
    expect(final?.status).toBe("queued");
  });

  it("provider rate-limit response bounces the doc + frees the slot", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch") as ReturnType<typeof vi.spyOn>;
    fetchSpy.mockResolvedValueOnce(
      new Response("rate_limit_exceeded", { status: 429 }) as unknown as Response,
    );
    const handle = new SchedulerHandle({
      adapter,
      teamId: "team",
      resolveTargetUrl: () => "http://localhost:9999",
      env: { DISPATCH_MAX_IN_FLIGHT_ANTHROPIC: "3" },
    });
    await handle.enqueue({
      to_agent: "worker",
      from_actor: "manager",
      message: "burst",
    });
    await handle.tick();
    const snap = await handle.snapshot();
    expect(snap.in_flight).toBe(0);
    expect(snap.bounced).toBe(1);
    expect(snap.available_slots).toBe(3);
    expect(snap.last_bounce_kind).toBe("provider_throttle");
    fetchSpy.mockRestore();
  });

  it("stale in_flight claim with agent_query_id is failed and frees the slot", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch") as ReturnType<typeof vi.spyOn>;
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ query_id: "agent-q-stale" }), { status: 200 }) as unknown as Response,
    );
    let now = "2026-06-02T20:00:00.000Z";
    const handle = new SchedulerHandle({
      adapter,
      teamId: "team",
      resolveTargetUrl: () => "http://localhost:9999",
      now: () => now,
      env: {
        DISPATCH_MAX_IN_FLIGHT_ANTHROPIC: "1",
        DISPATCH_STALE_IN_FLIGHT_TTL_MS: "1000",
      },
    });
    const enq = await handle.enqueue({
      to_agent: "worker",
      from_actor: "manager",
      message: "go stale",
    });
    await handle.tick();
    let snap = await handle.snapshot();
    expect(snap.in_flight).toBe(1);

    now = "2026-06-02T20:01:01.000Z";
    await handle.tick();

    const final = await handle.client.getByQueryId(enq.query_id);
    if (!final.ok) throw new Error();
    expect(final.value.status).toBe("failed");
    expect(final.value.failure_kind).toBe("scheduler_wedged");
    expect(final.value.failure_detail).toContain("stale in_flight claim");
    snap = await handle.snapshot();
    expect(snap.in_flight).toBe(0);
    expect(snap.available_slots).toBe(1);
    fetchSpy.mockRestore();
  });

  it("DISPATCH_SCHEDULER_ENABLED=false does not start the interval", async () => {
    const handle = new SchedulerHandle({
      adapter,
      teamId: "team",
      resolveTargetUrl: () => "http://localhost:9999",
      env: { DISPATCH_SCHEDULER_ENABLED: "false" },
    });
    handle.start();
    // No throw, no fetch. tick() can still run on demand.
    expect(handle.enabled).toBe(false);
  });

  it("handleAgentDone with success:false marks failed", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch") as ReturnType<typeof vi.spyOn>;
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ query_id: "agent-q-fail" }), { status: 200 }) as unknown as Response,
    );
    const handle = new SchedulerHandle({
      adapter,
      teamId: "team",
      resolveTargetUrl: () => "http://localhost:9999",
    });
    const enq = await handle.enqueue({
      to_agent: "worker",
      from_actor: "manager",
      message: "fail me",
    });
    await handle.tick();
    const final = await handle.handleAgentDone({
      query_id: enq.query_id,
      success: false,
      error: "agent crashed",
    });
    expect(final?.status).toBe("failed");
    expect(final?.failure_kind).toBe("agent_error");
    expect(final?.failure_detail).toBe("agent crashed");
    fetchSpy.mockRestore();
  });
});

describe("Spec 054 step 10: structured actor + causation defaults", () => {
  it("MANAGER_LIFECYCLE_ACTOR is system:manager labeled Manager", () => {
    expect(MANAGER_LIFECYCLE_ACTOR).toEqual({
      kind: "system",
      id: "manager",
      label: "Manager",
      source: "manager",
    });
  });

  it("CHRIS_DASHBOARD_ACTOR is user:chris labeled Chris", () => {
    expect(CHRIS_DASHBOARD_ACTOR).toEqual({
      kind: "user",
      id: "chris",
      label: "Chris",
      source: "manager",
    });
  });

  it("actorRefForAgentCompletion returns agent:<name>", () => {
    expect(actorRefForAgentCompletion("rams")).toEqual({
      kind: "agent",
      id: "rams",
      label: "rams",
      source: "manager",
    });
  });

  it("enqueue accepts an explicit actor_ref + causation override", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch") as ReturnType<typeof vi.spyOn>;
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ query_id: "agent-q" }), { status: 200 }) as unknown as Response,
    );
    const logged: Array<Record<string, unknown>> = [];
    const handle = new SchedulerHandle({
      adapter,
      teamId: "team",
      resolveTargetUrl: () => "http://localhost:9999",
    });
    // Capture the info log line; the scheduler_enqueued payload includes
    // the resolved actor_ref + causation we want to assert on.
    const origInfo = (handle as unknown as { logger: { info: typeof console.log } }).logger.info;
    (handle as unknown as { logger: { info: typeof console.log } }).logger.info = ((
      event: string,
      payload: Record<string, unknown>,
    ) => {
      logged.push({ event, ...payload });
      origInfo.call((handle as unknown as { logger: unknown }).logger, event, payload);
    }) as unknown as typeof console.log;

    await handle.enqueue({
      to_agent: "rams",
      from_actor: "chris",
      message: "do the thing",
      actor_ref: CHRIS_DASHBOARD_ACTOR,
      causation: { query_id: "override", source_event_id: "evt-1" },
    });

    const enqLog = logged.find((l) => l.event === "scheduler_enqueued");
    expect(enqLog).toBeDefined();
    expect(enqLog?.actor_ref).toEqual(CHRIS_DASHBOARD_ACTOR);
    expect(enqLog?.causation).toEqual({ query_id: "override", source_event_id: "evt-1" });
    fetchSpy.mockRestore();
  });

  it("enqueue defaults actor_ref to MANAGER_LIFECYCLE_ACTOR + causation to {query_id}", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch") as ReturnType<typeof vi.spyOn>;
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ query_id: "agent-q" }), { status: 200 }) as unknown as Response,
    );
    const logged: Array<Record<string, unknown>> = [];
    const handle = new SchedulerHandle({
      adapter,
      teamId: "team",
      resolveTargetUrl: () => "http://localhost:9999",
    });
    (handle as unknown as { logger: { info: typeof console.log } }).logger.info = ((
      event: string,
      payload: Record<string, unknown>,
    ) => {
      logged.push({ event, ...payload });
    }) as unknown as typeof console.log;

    const enq = await handle.enqueue({
      to_agent: "rams",
      from_actor: "manager",
      message: "do the thing",
    });
    const enqLog = logged.find((l) => l.event === "scheduler_enqueued");
    expect(enqLog?.actor_ref).toEqual(MANAGER_LIFECYCLE_ACTOR);
    expect((enqLog?.causation as { query_id?: string })?.query_id).toBe(enq.query_id);
    fetchSpy.mockRestore();
  });

  it("handleAgentDone defaults actor_ref to agent:<to_agent>", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch") as ReturnType<typeof vi.spyOn>;
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ query_id: "agent-q-rams" }), { status: 200 }) as unknown as Response,
    );
    const logged: Array<Record<string, unknown>> = [];
    const handle = new SchedulerHandle({
      adapter,
      teamId: "team",
      resolveTargetUrl: () => "http://localhost:9999",
    });
    (handle as unknown as { logger: { info: typeof console.log } }).logger.info = ((
      event: string,
      payload: Record<string, unknown>,
    ) => {
      logged.push({ event, ...payload });
    }) as unknown as typeof console.log;

    const enq = await handle.enqueue({
      to_agent: "rams",
      from_actor: "manager",
      message: "do the thing",
    });
    await handle.tick();
    await handle.handleAgentDone({
      query_id: enq.query_id,
      success: true,
      result: { reply: "ok" },
    });
    const doneLog = logged.find((l) => l.event === "scheduler_agent_done");
    expect(doneLog?.actor_ref).toEqual(actorRefForAgentCompletion("rams"));
    expect((doneLog?.causation as { query_id?: string })?.query_id).toBe(enq.query_id);
    fetchSpy.mockRestore();
  });
});

// Harness-resilience (Spec 2026-05-29) — structured failure_kind on /agent-done.
describe("handleAgentDone — structured failure_kind", () => {
  it("persists a model_api_error_exhausted failure_kind when supplied", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch") as ReturnType<typeof vi.spyOn>;
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ query_id: "agent-q-mapi" }), { status: 200 }) as unknown as Response,
    );
    const handle = new SchedulerHandle({
      adapter,
      teamId: "team",
      resolveTargetUrl: () => "http://localhost:9999",
    });
    const enq = await handle.enqueue({
      to_agent: "worker",
      from_actor: "manager",
      message: "do the thing",
    });
    await handle.tick();

    const final = await handle.handleAgentDone({
      query_id: enq.query_id,
      success: false,
      failure_kind: "model_api_error_exhausted",
      error: "transient model/API failure exhausted after 3 attempts: thinking_block_400",
    });

    expect(final?.status).toBe("failed");
    expect(final?.failure_kind).toBe("model_api_error_exhausted");
    expect(final?.failure_detail).toContain("thinking_block_400");
    fetchSpy.mockRestore();
  });

  it("falls back to agent_error when no failure_kind is supplied", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch") as ReturnType<typeof vi.spyOn>;
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ query_id: "agent-q-no-kind" }), { status: 200 }) as unknown as Response,
    );
    const handle = new SchedulerHandle({
      adapter,
      teamId: "team",
      resolveTargetUrl: () => "http://localhost:9999",
    });
    const enq = await handle.enqueue({
      to_agent: "worker",
      from_actor: "manager",
      message: "do the thing",
    });
    await handle.tick();

    const final = await handle.handleAgentDone({
      query_id: enq.query_id,
      success: false,
      error: "anything",
    });

    expect(final?.status).toBe("failed");
    expect(final?.failure_kind).toBe("agent_error");
    fetchSpy.mockRestore();
  });

  it("repeated /agent-done on already-failed doc is a no-op", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch") as ReturnType<typeof vi.spyOn>;
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ query_id: "agent-q-noop" }), { status: 200 }) as unknown as Response,
    );
    const handle = new SchedulerHandle({
      adapter,
      teamId: "team",
      resolveTargetUrl: () => "http://localhost:9999",
    });
    const enq = await handle.enqueue({
      to_agent: "worker",
      from_actor: "manager",
      message: "do the thing",
    });
    await handle.tick();

    await handle.handleAgentDone({
      query_id: enq.query_id,
      success: false,
      failure_kind: "model_api_error_exhausted",
      error: "first",
    });
    const second = await handle.handleAgentDone({
      query_id: enq.query_id,
      success: true,
      result: { reply: "ignored" },
    });
    // Second call must not transition the terminal doc — first failure
    // remains the persisted state.
    expect(second?.status).toBe("failed");
    expect(second?.failure_kind).toBe("model_api_error_exhausted");
    fetchSpy.mockRestore();
  });
});

// Queued-dispatch closeout (Spec 2026-06-01) — handle a successful
// /agent-done that arrives BEFORE the scheduler has claimed the doc
// (out-of-band async delivery). The doc is still `queued`; the existing
// markDoneWithResult path rejects with "requires in_flight". The narrow
// fix accepts queued → done for SUCCESS closeout only; failure and
// other non-terminal states keep their existing guards.
describe("handleAgentDone — queued-dispatch closeout (Spec 2026-06-01)", () => {
  it("queued + success: marks done with persisted result, no fetch needed", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch") as ReturnType<typeof vi.spyOn>;
    const handle = new SchedulerHandle({
      adapter,
      teamId: "team",
      resolveTargetUrl: () => "http://localhost:9999",
    });
    const enq = await handle.enqueue({
      to_agent: "worker",
      from_actor: "manager",
      message: "queued closeout",
    });
    // Intentionally do NOT tick — doc stays queued.

    const final = await handle.handleAgentDone({
      query_id: enq.query_id,
      success: true,
      result: { artifact_path: "/tmp/out.md" },
    });

    expect(final?.status).toBe("done");
    expect(final?.completed_at).not.toBeNull();
    // Result round-trip: getResult returns the persisted JSON.
    const r = await handle.reactor.getResult(enq.dispatch_phid);
    expect(r).toEqual({ artifact_path: "/tmp/out.md" });
    // No transport call was made.
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("queued + failure: still routes through markFailed with structured failure_kind", async () => {
    const handle = new SchedulerHandle({
      adapter,
      teamId: "team",
      resolveTargetUrl: () => "http://localhost:9999",
    });
    const enq = await handle.enqueue({
      to_agent: "worker",
      from_actor: "manager",
      message: "queued failure closeout",
    });

    const final = await handle.handleAgentDone({
      query_id: enq.query_id,
      success: false,
      failure_kind: "agent_error",
      error: "failed after async run",
    });

    expect(final?.status).toBe("failed");
    expect(final?.failure_kind).toBe("agent_error");
    expect(final?.failure_detail).toContain("failed after async run");
  });

  it("non-queued non-in_flight state (needs_clarification) remains guarded — no silent done", async () => {
    const handle = new SchedulerHandle({
      adapter,
      teamId: "team",
      resolveTargetUrl: () => "http://localhost:9999",
    });
    const enq = await handle.enqueue({
      to_agent: "worker",
      from_actor: "manager",
      message: "clarif",
    });
    // Move the doc into needs_clarification through the real reactor API.
    await handle.reactor.markNeedsClarification(enq.dispatch_phid, {
      agent_id: "worker",
      query_id: enq.query_id,
      question: "what?",
    });

    // Successful /agent-done arriving on a needs_clarification doc must
    // NOT silently mark it done. The queued-success branch is the only
    // out-of-band acceptance; everything else keeps its existing guard.
    await expect(
      handle.handleAgentDone({
        query_id: enq.query_id,
        success: true,
        result: { x: 1 },
      }),
    ).rejects.toThrow(/needs_clarification|requires in_flight/i);
  });

  it("queued + success closeout twice is idempotent (terminal no-op)", async () => {
    const handle = new SchedulerHandle({
      adapter,
      teamId: "team",
      resolveTargetUrl: () => "http://localhost:9999",
    });
    const enq = await handle.enqueue({
      to_agent: "worker",
      from_actor: "manager",
      message: "double close",
    });

    const first = await handle.handleAgentDone({
      query_id: enq.query_id,
      success: true,
      result: { artifact_path: "/tmp/first.md" },
    });
    expect(first?.status).toBe("done");

    // Second call must be a no-op; the persisted result of the first
    // call wins (terminal docs are not re-mutated).
    const second = await handle.handleAgentDone({
      query_id: enq.query_id,
      success: true,
      result: { artifact_path: "/tmp/second.md" },
    });
    expect(second?.status).toBe("done");
    const r = await handle.reactor.getResult(enq.dispatch_phid);
    expect(r).toEqual({ artifact_path: "/tmp/first.md" });
  });
});

describe("handleAgentDone — Claude provider/session limit", () => {
  it("session-limit child result is bounced for retry/fallback, not marked done or empty-success", async () => {
    const handle = new SchedulerHandle({
      adapter,
      teamId: "team",
      resolveTargetUrl: () => "http://localhost:9999",
      now: () => "2026-07-06T17:55:00.000Z",
      modelPolicy: buildModelPolicyService(
        {
          default: {
            primary: { runtime: "claude-code-cli" },
            fallback: [{ runtime: "codex" }],
          },
        },
        "file",
      ),
    });
    const enq = await handle.enqueue({
      to_agent: "finances",
      from_actor: "manager",
      message: "finance follow-up",
      runtime: "claude-code-cli",
    });
    await handle.acceptDispatchStart({
      dispatch_id: enq.dispatch_phid,
      agent_query_id: "query_1783354128298_pr3kdlp",
    });

    const final = await handle.handleAgentDone({
      agent_query_id: "query_1783354128298_pr3kdlp",
      success: true,
      result: {
        text: "You've hit your session limit · resets 1:10pm (America/Chicago)",
        model: "claude-opus-4-20250514",
      },
    });

    expect(final?.status).toBe("bounced");
    expect(final?.last_bounce?.kind).toBe("provider_limit");
    expect(final?.last_bounce?.message).toContain("Claude limited until 1:10pm");
    expect(final?.not_before_at).toMatch(/T18:10:00\.000Z$/);
    expect(Date.parse(final?.not_before_at ?? "")).toBeGreaterThan(Date.parse("2026-07-06T17:55:00.000Z"));
    expect(final?.allow_auto_retry).toBe(true);
    expect(final?.provider).toBe("openai");
    expect(final?.runtime).toBe("codex");
    expect(final?.failure_kind).toBeNull();
    expect(final?.completed_at).toBeNull();
  });
});

describe("SchedulerHandle.acceptDispatchStart", () => {
  it("resolves dispatch_id with phid prefix via getByPhid", async () => {
    const handle = new SchedulerHandle({
      adapter,
      teamId: "team",
      resolveTargetUrl: () => "http://localhost:9999",
    });
    const enq = await handle.enqueue({
      from_actor: "cane",
      to_agent: "coder",
      message: "hi",
    });
    const doc = await handle.acceptDispatchStart({
      dispatch_id: enq.dispatch_phid,
      agent_query_id: "agent-q-1",
    });
    expect(doc?.status).toBe("in_flight");
    expect(doc?.agent_query_id).toBe("agent-q-1");
  });

  it("resolves dispatch_id given as a manager query_id via getByQueryId", async () => {
    const handle = new SchedulerHandle({
      adapter,
      teamId: "team",
      resolveTargetUrl: () => "http://localhost:9999",
    });
    const enq = await handle.enqueue({
      from_actor: "cane",
      to_agent: "coder",
      message: "hi",
    });
    const doc = await handle.acceptDispatchStart({
      dispatch_id: enq.query_id, // pass the manager query_id, not phid
      agent_query_id: "agent-q-1",
    });
    expect(doc?.status).toBe("in_flight");
  });
});
