import { describe, expect, it } from "vitest";

import {
  deriveRuntimeDriftState,
  deriveFleetRuntimeDriftInputs,
  evaluateFleetRuntimeDrift,
  evaluateRuntimeDrift,
  formatFleetRuntimeDriftAlert,
  INITIAL_DRIFT,
  type AgentDriftTrackerState,
  type RuntimeDriftAgent,
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
  it("no alert for an agent that was never live (first-ever observation is pending)", () => {
    const prev: FleetRuntimeDriftState = {};
    const { alerts, summary, next } = evaluateFleetRuntimeDrift(
      prev,
      [{ agent_id: "a1", agent_name: "roger", state: "pending" }],
      T0,
    );
    expect(alerts).toEqual([]);
    expect(summary.drifted_agents).toEqual([{ agent_id: "a1", agent_name: "roger", state: "pending", since: next.a1.since }]);
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

function driftAgent(name: string, status: string, runtime = "claude-code-cli"): RuntimeDriftAgent {
  return { id: `agent-${name}`, name, status, runtime };
}

describe("deriveFleetRuntimeDriftInputs", () => {
  it("uses the current desired-online set and ignores intentionally parked specialists", () => {
    const currentAgents = [
      driftAgent("cursor-coder-pilot", "stopped"),
      driftAgent("substrate-orch-codex", "running", "codex"),
      driftAgent("substrate-api-codex", "stopped"),
      driftAgent("frontend-qa-cursor", "stopped"),
      driftAgent("frontend-ui-codex", "running"),
      driftAgent("gaudi", "stopped", "codex"),
      driftAgent("eames", "stopped", "codex"),
      driftAgent("brunel", "stopped"),
      driftAgent("hopper", "stopped", "codex"),
      driftAgent("rams", "running"),
      driftAgent("coder-max", "stopped"),
      driftAgent("regina", "running", "codex"),
      driftAgent("cto", "running"),
      driftAgent("blowout", "offline"),
      driftAgent("politics", "offline"),
      driftAgent("sentinel", "running", "codex"),
      driftAgent("roger", "running", "codex"),
      driftAgent("maestra", "running"),
      driftAgent("defi", "offline"),
      driftAgent("trinity", "offline"),
      driftAgent("cleveland-park", "offline"),
      driftAgent("pipeline", "offline"),
      driftAgent("personal", "offline", "codex"),
      driftAgent("finances", "running"),
      driftAgent("cane", "running"),
    ];

    const inputs = deriveFleetRuntimeDriftInputs(currentAgents, healthModelWith([]));
    expect(inputs.map((a) => a.agent_name)).toEqual([
      "substrate-orch-codex",
      "frontend-ui-codex",
      "rams",
      "regina",
      "cto",
      "sentinel",
      "roger",
      "maestra",
      "finances",
      "cane",
    ]);
  });

  it("preserves alerts for desired-online lanes while parked agents on the same runtime are ignored", () => {
    const inputs = deriveFleetRuntimeDriftInputs(
      [
        driftAgent("parked-claude-specialist", "stopped"),
        driftAgent("required-claude-lane", "running"),
      ],
      healthModelWith(["claude"]),
    );

    const { alerts, summary } = evaluateFleetRuntimeDrift(
      { "agent-required-claude-lane": healthy(T0) },
      inputs,
      T0 + MIN,
    );
    expect(alerts.map((a) => a.agent_name)).toEqual(["required-claude-lane"]);
    expect(summary.drifted_agents.map((a) => a.agent_name)).toEqual(["required-claude-lane"]);
  });
});

describe("formatFleetRuntimeDriftAlert", () => {
  it("aggregates repeated drift and recovery events into one actionable Telegram summary", () => {
    const { alerts } = evaluateFleetRuntimeDrift(
      {
        "agent-roger": healthy(T0),
        "agent-regina": healthy(T0),
        "agent-cane": pending(T0, T0),
      },
      [
        { agent_id: "agent-roger", agent_name: "roger", state: "offline" },
        { agent_id: "agent-regina", agent_name: "regina", state: "pending" },
        { agent_id: "agent-cane", agent_name: "cane", state: "healthy" },
      ],
      T0 + MIN,
    );

    const message = formatFleetRuntimeDriftAlert(alerts);
    expect(message).toBe([
      "Runtime drift incident",
      "Drifted desired-online agents (2):",
      "- roger: Agent runtime flipped healthy -> offline.",
      "- regina: Agent runtime flipped healthy -> pending.",
      "Recovered desired-online agents (1):",
      "- cane: Agent runtime recovered — was pending, now healthy.",
    ].join("\n"));
  });

  it("returns no Telegram message when per-agent re-alert suppression produces no alerts", () => {
    const { alerts } = evaluateFleetRuntimeDrift(
      { "agent-roger": pending(T0, T0) },
      [{ agent_id: "agent-roger", agent_name: "roger", state: "pending" }],
      T0 + 5 * MIN,
    );
    expect(formatFleetRuntimeDriftAlert(alerts)).toBeNull();
  });
});

function agent(overrides: Partial<AgentRow>): Pick<AgentRow, "status" | "runtime"> {
  return { status: "running", runtime: "claude-code-cli", ...overrides };
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
