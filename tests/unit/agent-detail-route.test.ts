// AGENT-V2 (2026-06-24, phid:disp-94021fb2bd1fb039) — HTTP contract test for
// GET /agents/:name/detail. Mounts the route on a real express app wired to
// getAgentDetail (the same orchestrator the manager wires), and proves the
// route returns the per-agent dossier over the wire (200 + shape) and 404 for
// an unknown agent.

import express, { type Express } from "express";
import { describe, it, expect, beforeEach } from "vitest";

import { getAgentDetail, type AgentDetailDeps } from "../../src/agents-detail/agent-detail.js";

const KNOWN = {
  id: "agent-7",
  name: "hopper",
  model: "claude-opus-4-8",
  type: "interactive",
  status: "active",
  working_directory: "/abs/hopper",
  health: "healthy",
  last_health_check: 1782323000000,
};

function buildApp(): Express {
  const deps: AgentDetailDeps = {
    getIdentity: async (_t, name) => (name === KNOWN.name ? KNOWN : null),
    getHealth: async () => ({
      status: "active",
      dispatches_completed: 5,
      verified_landings: 5,
      verified_landing_rate: 1,
      throughput: 0.8,
      in_flight_dispatch_id: null,
    }),
    getRecentDispatches: async (_t, _n, limit) =>
      Array.from({ length: Math.min(limit, 2) }, (_v, i) => ({ dispatch_id: `phid:disp-${i}` })),
    getRecentOutputs: async () => [{ path: "/abs/hopper/output/report.md", agent: "hopper" }],
    getCost: async () => ({
      date: "2026-06-24",
      weighted_tokens: 4200,
      input_tokens: 3000,
      output_tokens: 1200,
      providers: ["Claude"],
      pct_weighted: 8.3,
    }),
    now: () => "2026-06-24T12:00:00.000Z",
  };

  const app = express();
  app.use(express.json());
  app.get("/agents/:name/detail", async (req, res) => {
    const r = await getAgentDetail(deps, "default", req.params.name, { limit: req.query.limit });
    res.status(r.status).json(r.body);
  });
  return app;
}

let app: Express;
beforeEach(() => { app = buildApp(); });

async function call(path: string) {
  return new Promise<{ status: number; body: any }>((resolve, reject) => {
    const server = app.listen(0, "127.0.0.1", async () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") { server.close(); reject(new Error("no addr")); return; }
      try {
        const r = await fetch(`http://127.0.0.1:${addr.port}${path}`);
        const body = await r.json();
        server.close(() => resolve({ status: r.status, body }));
      } catch (e) { server.close(() => reject(e)); }
    });
  });
}

describe("GET /agents/:name/detail", () => {
  it("returns the per-agent dossier (200) with every section", async () => {
    const res = await call("/agents/hopper/detail");
    expect(res.status).toBe(200);
    expect(res.body.schema_version).toBe("agents.detail.v1");
    expect(res.body.agent_name).toBe("hopper");
    expect(res.body.model).toBe("claude-opus-4-8");
    expect(res.body.identity.id).toBe("agent-7");
    expect(res.body.health.verified_landing_rate).toBe(1);
    expect(Array.isArray(res.body.recent_dispatches)).toBe(true);
    expect(res.body.recent_outputs[0].agent).toBe("hopper");
    expect(res.body.cost.weighted_tokens).toBe(4200);
  });

  it("honors ?limit", async () => {
    const res = await call("/agents/hopper/detail?limit=1");
    expect(res.status).toBe(200);
    expect(res.body.recent_dispatches).toHaveLength(1);
  });

  it("404s an unknown agent", async () => {
    const res = await call("/agents/ghost/detail");
    expect(res.status).toBe(404);
    expect(res.body.error).toContain("ghost");
  });
});
