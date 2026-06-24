// AGENT-V2 (2026-06-24, phid:disp-94021fb2bd1fb039) — GET /agents/:name/detail
// dossier orchestrator. Pins: 404 on unknown agent; 200 dossier shape with all
// sections; current model surfaced; best-effort degradation when a section's
// dep throws (verification store down / usage un-ingested) without failing the
// whole dossier; the ?limit parse + clamp.

import { test, expect } from "vitest";

import {
  getAgentDetail,
  parseDetailLimit,
  type AgentDetailDeps,
  type AgentDetailIdentity,
  type AgentDetailResponse,
} from "../../src/agents-detail/agent-detail";

const IDENTITY: AgentDetailIdentity = {
  id: "agent-1",
  name: "hopper",
  model: "claude-opus-4-8",
  type: "interactive",
  status: "active",
  working_directory: "/abs/hopper",
  health: "healthy",
  last_health_check: 1782323000000,
};

function deps(overrides: Partial<AgentDetailDeps> = {}): AgentDetailDeps {
  return {
    getIdentity: async () => IDENTITY,
    getHealth: async () => ({
      status: "active",
      dispatches_completed: 12,
      verified_landings: 11,
      verified_landing_rate: 0.92,
      throughput: 1.7,
      in_flight_dispatch_id: null,
    }),
    getRecentDispatches: async (_t, _n, limit) =>
      Array.from({ length: Math.min(limit, 3) }, (_v, i) => ({ dispatch_id: `d${i}` })),
    getRecentOutputs: async () => [{ path: "/abs/hopper/output/x.md" }],
    getCost: async () => ({
      date: "2026-06-24",
      weighted_tokens: 1000,
      input_tokens: 800,
      output_tokens: 200,
      providers: ["Claude"],
      pct_weighted: 12.5,
    }),
    now: () => "2026-06-24T12:00:00.000Z",
    ...overrides,
  };
}

test("404 when the agent is unknown", async () => {
  const r = await getAgentDetail(deps({ getIdentity: async () => null }), "t", "ghost");
  expect(r.status).toBe(404);
  expect((r.body as { error: string }).error).toContain("ghost");
});

test("200 dossier carries identity, current model, health, dispatches, outputs, cost", async () => {
  const r = await getAgentDetail(deps(), "t", "hopper");
  expect(r.status).toBe(200);
  const body = r.body as AgentDetailResponse;
  expect(body.schema_version).toBe("agents.detail.v1");
  expect(body.generated_at).toBe("2026-06-24T12:00:00.000Z");
  expect(body.agent_name).toBe("hopper");
  expect(body.model).toBe("claude-opus-4-8");
  expect(body.identity.model).toBe("claude-opus-4-8");
  expect(body.health?.verified_landing_rate).toBe(0.92);
  expect(body.recent_dispatches).toHaveLength(3);
  expect(body.recent_outputs).toHaveLength(1);
  expect(body.cost?.weighted_tokens).toBe(1000);
});

test("best-effort: a thrown section degrades to null/[] but still returns 200", async () => {
  const r = await getAgentDetail(
    deps({
      getHealth: async () => { throw new Error("verification_disabled"); },
      getRecentDispatches: async () => { throw new Error("storage down"); },
      getCost: async () => { throw new Error("usage table empty"); },
    }),
    "t",
    "hopper",
  );
  expect(r.status).toBe(200);
  const body = r.body as AgentDetailResponse;
  expect(body.health).toBeNull();
  expect(body.recent_dispatches).toEqual([]);
  expect(body.cost).toBeNull();
  // The sections that DID resolve are still present.
  expect(body.identity.name).toBe("hopper");
  expect(body.recent_outputs).toHaveLength(1);
});

test("limit is threaded into the dispatch/output fetches", async () => {
  let seenDispatchLimit = -1;
  let seenOutputLimit = -1;
  await getAgentDetail(
    deps({
      getRecentDispatches: async (_t, _n, limit) => { seenDispatchLimit = limit; return []; },
      getRecentOutputs: async (_t, _a, limit) => { seenOutputLimit = limit; return []; },
    }),
    "t",
    "hopper",
    { limit: "5" },
  );
  expect(seenDispatchLimit).toBe(5);
  expect(seenOutputLimit).toBe(5);
});

test("parseDetailLimit defaults + clamps", () => {
  expect(parseDetailLimit(undefined)).toBe(10);
  expect(parseDetailLimit("")).toBe(10);
  expect(parseDetailLimit("0")).toBe(10);
  expect(parseDetailLimit("-3")).toBe(10);
  expect(parseDetailLimit("abc")).toBe(10);
  expect(parseDetailLimit("7")).toBe(7);
  expect(parseDetailLimit("999")).toBe(50);
});
