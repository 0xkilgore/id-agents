import { describe, expect, it } from "vitest";

import {
  computeFleetAdmissionExclusions,
  computeRoutingHealthClaimExclusions,
} from "../../src/dispatch-scheduler/manager-integration.js";
import { computeRoutingHealth } from "../../src/routing-health/read-model.js";
import type { AgentRow } from "../../src/db/types.js";
import type { RoutingHealthReadModel } from "../../src/routing-health/types.js";

function agent(overrides: Partial<AgentRow>): AgentRow {
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

describe("computeFleetAdmissionExclusions", () => {
  it("excludes stopped legacy Claude builders when a live Codex/Cursor lane exists", () => {
    expect(
      computeFleetAdmissionExclusions([
        agent({ id: "agent_brunel", name: "brunel", status: "stopped", runtime: "claude-code-cli" }),
        agent({ id: "agent_codex", name: "codex-builder", status: "running", runtime: "codex" }),
      ]),
    ).toEqual(["brunel", "agent_brunel"]);
  });

  it("does not exclude legacy Claude when no live Codex/Cursor builder exists", () => {
    expect(
      computeFleetAdmissionExclusions([
        agent({ id: "agent_brunel", name: "brunel", status: "stopped", runtime: "claude-code-cli" }),
      ]),
    ).toEqual([]);
  });

  it("does not exclude online explicitly requested legacy Claude builders", () => {
    expect(
      computeFleetAdmissionExclusions([
        agent({ id: "agent_brunel", name: "brunel", status: "running", runtime: "claude-code-cli" }),
        agent({ id: "agent_cursor", name: "cursor-builder", status: "active", runtime: "cursor-cli" }),
      ]),
    ).toEqual([]);
  });
});

// RD-014 Ticket B — the claim-time counterpart. computeFleetAdmissionExclusions
// (above) is a fleet-COMPOSITION check (stopped/offline + a live alternative);
// this is a live-HEALTH check, independent of the agent row's own `status` —
// a `running` agent whose runtime itself is down (e.g. a revoked Codex cert)
// still cannot execute anything.
describe("computeRoutingHealthClaimExclusions", () => {
  function healthModelWith(runtimesDown: string[]): RoutingHealthReadModel {
    return computeRoutingHealth({
      team_id: "team",
      now: new Date().toISOString(),
      pools: [],
      builders: [],
      dispatches: [],
      runtimes: [
        { name: "claude", role: "primary", live: !runtimesDown.includes("claude") },
        { name: "codex", role: "fallback", live: !runtimesDown.includes("codex") },
      ],
    });
  }

  it("excludes an agent whose runtime is down, regardless of its own row status being `running`", () => {
    const agents = [agent({ id: "agent_roger", name: "roger", status: "running", runtime: "codex" })];
    const model = healthModelWith(["codex"]);
    expect(computeRoutingHealthClaimExclusions(agents, model)).toEqual(
      expect.arrayContaining(["roger", "agent_roger"]),
    );
  });

  it("does not exclude an agent whose runtime is live", () => {
    const agents = [agent({ id: "agent_roger", name: "roger", status: "running", runtime: "codex" })];
    const model = healthModelWith([]); // nothing down
    expect(computeRoutingHealthClaimExclusions(agents, model)).toEqual([]);
  });

  it("only excludes agents on the affected runtime, not the whole fleet", () => {
    const agents = [
      agent({ id: "agent_roger", name: "roger", status: "running", runtime: "codex" }),
      agent({ id: "agent_regina", name: "regina", status: "running", runtime: "claude-code-cli" }),
    ];
    const model = healthModelWith(["codex"]);
    const excluded = computeRoutingHealthClaimExclusions(agents, model);
    expect(excluded).toEqual(expect.arrayContaining(["roger", "agent_roger"]));
    expect(excluded).not.toEqual(expect.arrayContaining(["regina", "agent_regina"]));
  });

  it("fails safe: a null/absent model excludes nothing", () => {
    const agents = [agent({ id: "agent_roger", name: "roger", runtime: "codex" })];
    expect(computeRoutingHealthClaimExclusions(agents, null)).toEqual([]);
    expect(computeRoutingHealthClaimExclusions(agents, undefined)).toEqual([]);
  });

  it("fails safe: an all-healthy model excludes nothing (empty runtimes_down)", () => {
    const agents = [agent({ id: "agent_roger", name: "roger", runtime: "codex" })];
    const model = healthModelWith([]);
    expect(model.summary.runtimes_down).toEqual([]);
    expect(computeRoutingHealthClaimExclusions(agents, model)).toEqual([]);
  });
});
