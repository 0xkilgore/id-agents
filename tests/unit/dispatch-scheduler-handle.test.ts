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
import {
  SchedulerHandle,
  parseGatewayMode,
  schedulerEnabled,
} from "../../src/dispatch-scheduler/manager-integration.js";

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

describe("SchedulerHandle bootstrap + flow", () => {
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
