import { describe, expect, it } from "vitest";

import {
  deriveAgentLifecycle,
  deriveRuntimeDriftState,
  evaluateFleetRuntimeDrift,
  evaluateRuntimeDrift,
  INITIAL_DRIFT,
  type AgentDriftTrackerState,
  type FleetRuntimeDriftState,
} from "../../src/dispatch-scheduler/runtime-drift.js";
import { computeRoutingHealth } from "../../src/routing-health/read-model.js";
import type { AgentRow } from "../../src/db/types.js";
import type { RoutingHealthReadModel } from "../../src/routing-health/types.js";

const T0 = Date.parse("2026-07-05T00:00:00.000Z");
const MIN = 60_000;

function healthy(sinceMs = T0): AgentDriftTrackerState {
  return { state: "healthy", since: new Date(sinceMs).toISOString(), last_alert_at: null };
}

function pending(sinceMs = T0, lastAlertMs: number | null = T0): AgentDriftTrackerState {
  return {
    state: "pending",
    since: new Date(sinceMs).toISOString(),
    last_alert_at: lastAlertMs === null ? null : new Date(lastAlertMs).toISOString(),
  };
}

describe("evaluateRuntimeDrift", () => {
  it("healthy -> pending: fires exactly one drifted alert", () => {
    const { next, alert } = evaluateRuntimeDrift(healthy(T0), "pending", T0 + MIN);
    expect(alert?.kind).toBe("drifted");
    expect(next.state).toBe("pending");
    expect(next.last_alert_at).toBe(new Date(T0 + MIN).toISOString());
  });

  it("healthy -> offline: fires exactly one drifted alert", () => {
    const { next, alert } = evaluateRuntimeDrift(healthy(T0), "offline", T0 + MIN);
    expect(alert?.kind).toBe("drifted");
    expect(next.state).toBe("offline");
  });

  it("pending -> healthy: fires a one-shot recovery alert and resets", () => {
    const { next, alert } = evaluateRuntimeDrift(pending(T0, T0), "healthy", T0 + 5 * MIN);
    expect(alert?.kind).toBe("recovered");
    expect(next.state).toBe("healthy");
    expect(next.last_alert_at).toBeNull();
  });

  it("pending -> pending shortly after: no repeat alert (bounded re-alert)", () => {
    const prev = pending(T0, T0);
    const { next, alert } = evaluateRuntimeDrift(prev, "pending", T0 + 5 * MIN);
    expect(alert).toBeNull();
    expect(next.state).toBe("pending");
    expect(next.last_alert_at).toBe(prev.last_alert_at); // unchanged — no new alert stamp
  });

  it("pending -> pending past the re-alert window: re-alerts once", () => {
    const prev = pending(T0, T0);
    const { next, alert } = evaluateRuntimeDrift(prev, "pending", T0 + 61 * MIN);
    expect(alert?.kind).toBe("drifted");
    expect(next.last_alert_at).toBe(new Date(T0 + 61 * MIN).toISOString());
  });

  it("unknown current observation: holds prior state exactly, never alerts", () => {
    const prev = healthy(T0);
    const { next, alert } = evaluateRuntimeDrift(prev, "unknown", T0 + MIN);
    expect(alert).toBeNull();
    expect(next).toEqual(prev);

    const prevPending = pending(T0, T0);
    const held = evaluateRuntimeDrift(prevPending, "unknown", T0 + MIN);
    expect(held.alert).toBeNull();
    expect(held.next).toEqual(prevPending);
  });

  it("no baseline yet (INITIAL_DRIFT) + first observation pending: establishes baseline, no alert", () => {
    const { next, alert } = evaluateRuntimeDrift(INITIAL_DRIFT, "pending", T0);
    expect(alert).toBeNull();
    expect(next.state).toBe("pending");
  });

  it("no baseline yet + first observation offline: establishes baseline, no alert (never live before)", () => {
    const { next, alert } = evaluateRuntimeDrift(INITIAL_DRIFT, "offline", T0);
    expect(alert).toBeNull();
    expect(next.state).toBe("offline");
  });

  it("no baseline yet + first observation healthy: establishes baseline, no alert", () => {
    const { next, alert } = evaluateRuntimeDrift(INITIAL_DRIFT, "healthy", T0);
    expect(alert).toBeNull();
    expect(next.state).toBe("healthy");
  });

  it("offline -> pending (still degraded): treated as bounded re-alert, not a fresh drift", () => {
    const prev: AgentDriftTrackerState = { state: "offline", since: new Date(T0).toISOString(), last_alert_at: new Date(T0).toISOString() };
    const { alert } = evaluateRuntimeDrift(prev, "pending", T0 + MIN);
    expect(alert).toBeNull(); // within the re-alert window
  });
});

describe("evaluateFleetRuntimeDrift", () => {
  it("direct /health ok overrides an offline process-list observation", () => {
    const prev: FleetRuntimeDriftState = { a1: healthy(T0) };
    const { alerts, summary, next } = evaluateFleetRuntimeDrift(
      prev,
      [{ agent_id: "a1", agent_name: "cto", state: "offline", health_probe: "ok", lifecycle: "always_on" }],
      T0 + MIN,
    );
    expect(alerts).toEqual([]);
    expect(next.a1.state).toBe("healthy");
    expect(summary.drifted_agents).toEqual([]);
  });

  it("suppresses optional on-demand agents from the critical drift summary", () => {
    const prev: FleetRuntimeDriftState = { a1: healthy(T0) };
    const { alerts, summary, next } = evaluateFleetRuntimeDrift(
      prev,
      [{ agent_id: "a1", agent_name: "coder-max", state: "offline", health_probe: "failed", lifecycle: "optional" }],
      T0 + MIN,
    );
    expect(alerts).toHaveLength(1);
    expect(next.a1.state).toBe("offline");
    expect(summary.drifted_agents).toEqual([]);
  });

  it("no alert for an agent that was never live (first-ever observation is pending)", () => {
    const prev: FleetRuntimeDriftState = {};
    const { alerts, summary, next } = evaluateFleetRuntimeDrift(
      prev,
      [{ agent_id: "a1", agent_name: "roger", state: "pending" }],
      T0,
    );
    expect(alerts).toEqual([]);
    expect(summary.drifted_agents).toEqual([
      {
        agent_id: "a1",
        agent_name: "roger",
        state: "pending",
        since: next.a1.since,
        lifecycle: "always_on",
        health_probe: "unknown",
      },
    ]);
  });

  it("fires exactly one alert within one tick on a live -> non-live transition", () => {
    const prev: FleetRuntimeDriftState = { a1: healthy(T0) };
    const { alerts, summary } = evaluateFleetRuntimeDrift(
      prev,
      [{ agent_id: "a1", agent_name: "roger", state: "offline" }],
      T0 + MIN,
    );
    expect(alerts).toHaveLength(1);
    expect(alerts[0].alert.kind).toBe("drifted");
    expect(summary.drifted_agents.map((d) => d.agent_id)).toEqual(["a1"]);
  });

  it("drops agents no longer present in the observed set", () => {
    const prev: FleetRuntimeDriftState = { a1: healthy(T0), gone: pending(T0, T0) };
    const { next } = evaluateFleetRuntimeDrift(
      prev,
      [{ agent_id: "a1", agent_name: "roger", state: "healthy" }],
      T0 + MIN,
    );
    expect(Object.keys(next)).toEqual(["a1"]);
  });

  it("absent when no agent is currently drifted", () => {
    const { summary } = evaluateFleetRuntimeDrift(
      {},
      [{ agent_id: "a1", agent_name: "roger", state: "healthy" }],
      T0,
    );
    expect(summary.drifted_agents).toEqual([]);
  });
});

function agent(overrides: Partial<AgentRow>): Pick<AgentRow, "status" | "runtime"> {
  return { status: "running", runtime: "claude-code-cli", ...overrides };
}

function agentLifecycle(overrides: Partial<AgentRow>): Pick<AgentRow, "name" | "metadata"> {
  return { name: "roger", metadata: {}, ...overrides };
}

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

describe("deriveRuntimeDriftState", () => {
  it("no status → unknown", () => {
    expect(deriveRuntimeDriftState(agent({ status: "" }), null)).toBe("unknown");
  });

  it("offline status → offline, regardless of routing-health", () => {
    expect(deriveRuntimeDriftState(agent({ status: "stopped" }), healthModelWith(["claude"]))).toBe("offline");
  });

  it("live status + healthy routing-health → healthy", () => {
    expect(deriveRuntimeDriftState(agent({ status: "running" }), healthModelWith([]))).toBe("healthy");
  });

  it("live status + absent routing-health model → fails open to healthy", () => {
    expect(deriveRuntimeDriftState(agent({ status: "running" }), null)).toBe("healthy");
  });

  it("live status + this agent's OWN lane down per routing-health → pending (the silent-drift case)", () => {
    expect(deriveRuntimeDriftState(agent({ status: "running", runtime: "claude-code-cli" }), healthModelWith(["claude"]))).toBe(
      "pending",
    );
  });

  it("live status + a DIFFERENT lane down per routing-health → still healthy", () => {
    expect(deriveRuntimeDriftState(agent({ status: "running", runtime: "claude-code-cli" }), healthModelWith(["codex"]))).toBe(
      "healthy",
    );
  });

  it("the manager's own literal 'pending' status → pending", () => {
    expect(deriveRuntimeDriftState(agent({ status: "pending" }), healthModelWith([]))).toBe("pending");
  });
});

describe("deriveAgentLifecycle", () => {
  it("treats known on-demand lanes as optional", () => {
    expect(deriveAgentLifecycle(agentLifecycle({ name: "coder-max" }))).toBe("optional");
    expect(deriveAgentLifecycle(agentLifecycle({ name: "cursor-coder-pilot" }))).toBe("optional");
    expect(deriveAgentLifecycle(agentLifecycle({ name: "eames" }))).toBe("optional");
  });

  it("honors explicit lifecycle metadata", () => {
    expect(deriveAgentLifecycle(agentLifecycle({ name: "builder", metadata: { lifecycle: "on_demand" } }))).toBe("optional");
  });
});
