import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteAdapter } from "../../src/db/sqlite-adapter.js";
import {
  buildFleetMetricsHistoryResponse,
  FleetMetricsHistoryStorage,
} from "../../src/dispatch-verification/fleet-metrics-history.js";
import type { AgentsEffectivenessResponse } from "../../src/dispatch-verification/read-model.js";
import type { UsageGateSnapshot } from "../../src/usage-meter/types.js";
import type { FleetFreshnessSummary } from "../../src/deploy-guard/fleet-freshness.js";

let adapter: SqliteAdapter;
let storage: FleetMetricsHistoryStorage;

beforeEach(async () => {
  adapter = new SqliteAdapter(":memory:");
  storage = new FleetMetricsHistoryStorage(adapter, 7);
  await storage.migrate();
});

afterEach(async () => {
  await adapter.close();
});

describe("FleetMetricsHistoryStorage", () => {
  it("inserts and reads chart-ready fleet metric snapshots", async () => {
    await storage.insertSnapshot({
      team_id: "team",
      sampled_at: "2026-07-07T12:00:00.000Z",
      window: "7d",
      effectiveness: makeEffectiveness(),
      fleet_total: 6,
      fleet_healthy: 5,
      fleet_stale: 1,
      manager_freshness: makeFreshness(),
      usage_gate: makeUsageGate(),
    });

    const points = await storage.readHistory({
      teamId: "team",
      fromIso: "2026-07-07T00:00:00.000Z",
      toIso: "2026-07-08T00:00:00.000Z",
    });

    expect(points).toEqual([
      expect.objectContaining({
        sampled_at: "2026-07-07T12:00:00.000Z",
        window: "7d",
        verified_landing_rate: 0.75,
        throughput_per_week: 12,
        failure_rate: 0.25,
        healthy: 5,
        total: 6,
        stale: 1,
        manager_freshness_state: "stale",
        manager_freshness_stale_count: 1,
        manager_freshness_node_count: 2,
        usage_gate_state: "soft_warning",
        usage_gate_decision: "warn_allow",
        usage_gate_enforcement: "warn",
        usage_gate_daily_pct: 0.82,
        usage_gate_weekly_pct: 0.44,
      }),
    ]);
  });

  it("upserts on team sampled_at and window, and readHistory can filter by window", async () => {
    await storage.insertSnapshot({
      team_id: "team",
      sampled_at: "2026-07-07T12:00:00.000Z",
      window: "7d",
      effectiveness: makeEffectiveness({ verified_landing_rate: 0.5, throughput_per_week: 8 }),
      fleet_total: 4,
      fleet_healthy: 3,
      fleet_stale: 0,
      manager_freshness: null,
      usage_gate: null,
    });
    await storage.insertSnapshot({
      team_id: "team",
      sampled_at: "2026-07-07T12:00:00.000Z",
      window: "7d",
      effectiveness: makeEffectiveness({ verified_landing_rate: 1, throughput_per_week: 16 }),
      fleet_total: 4,
      fleet_healthy: 4,
      fleet_stale: 0,
      manager_freshness: null,
      usage_gate: null,
    });
    await storage.insertSnapshot({
      team_id: "team",
      sampled_at: "2026-07-07T12:01:00.000Z",
      window: "30d",
      effectiveness: makeEffectiveness(),
      fleet_total: 4,
      fleet_healthy: 4,
      fleet_stale: 0,
      manager_freshness: null,
      usage_gate: null,
    });

    const points = await storage.readHistory({
      teamId: "team",
      fromIso: "2026-07-07T00:00:00.000Z",
      toIso: "2026-07-08T00:00:00.000Z",
      window: "7d",
    });

    expect(points).toHaveLength(1);
    expect(points[0]).toMatchObject({
      window: "7d",
      verified_landing_rate: 1,
      throughput_per_week: 16,
      healthy: 4,
    });
  });

  it("prunes rows older than the configured retention window", async () => {
    await storage.insertSnapshot({
      team_id: "team",
      sampled_at: "2026-06-29T23:59:59.000Z",
      window: "7d",
      effectiveness: makeEffectiveness(),
      fleet_total: 1,
      fleet_healthy: 1,
      fleet_stale: 0,
      manager_freshness: null,
      usage_gate: null,
    });
    await storage.insertSnapshot({
      team_id: "team",
      sampled_at: "2026-06-30T00:00:00.000Z",
      window: "7d",
      effectiveness: makeEffectiveness(),
      fleet_total: 1,
      fleet_healthy: 1,
      fleet_stale: 0,
      manager_freshness: null,
      usage_gate: null,
    });

    const deleted = await storage.prune("2026-07-07T00:00:00.000Z");
    const points = await storage.readHistory({
      teamId: "team",
      fromIso: "2026-06-01T00:00:00.000Z",
      toIso: "2026-07-08T00:00:00.000Z",
    });

    expect(deleted).toBe(1);
    expect(points.map((point) => point.sampled_at)).toEqual(["2026-06-30T00:00:00.000Z"]);
  });
});

describe("buildFleetMetricsHistoryResponse", () => {
  it("marks empty ranges unavailable", () => {
    const body = buildFleetMetricsHistoryResponse({
      points: [],
      range: "30d",
      generated_at: "2026-07-07T12:00:00.000Z",
      retention_days: 35,
    });

    expect(body.freshness).toEqual({
      status: "unavailable",
      latest_sampled_at: null,
      retention_days: 35,
    });
    expect(body.warnings).toEqual(["no fleet metrics snapshots recorded for range"]);
  });
});

function makeEffectiveness(
  overrides: Partial<AgentsEffectivenessResponse["fleet"]> = {},
): AgentsEffectivenessResponse {
  return {
    schema_version: "agents.effectiveness.v1",
    generated_at: "2026-07-07T12:00:00.000Z",
    window: "7d",
    fleet: {
      dispatches_completed: 8,
      verified_landings: 6,
      verified_landing_rate: 0.75,
      throughput_per_week: 12,
      failure_breakdown: {
        expired: 1,
        artifact_missing: 1,
        artifact_stale: 0,
        dispatch_not_found: 0,
        dispatch_id_mismatch: 0,
        rate_limited: 0,
        provider_error: 0,
      },
      trend_4w: [1, 2, 3, 6],
      by_provider: [],
      provider_diversity_check: {
        passed: false,
        distinct_completed_providers: 0,
        required_min_providers: 2,
        providers: [],
      },
      ...overrides,
    },
    agents: [],
  };
}

function makeFreshness(): FleetFreshnessSummary {
  return {
    fleet_behind: true,
    stale_nodes: ["kapelle-site"],
    node_count: 2,
    nodes: [],
    coupling: {
      status: "unknown",
      reason: "test",
      groups: [],
      recommended_action: "none",
    },
  };
}

function makeUsageGate(): UsageGateSnapshot {
  return {
    status: "ok",
    policy_version: "usage-budget-policy.v1",
    global: {
      state: "soft_warning",
      decision: "warn_allow",
      reason: "daily threshold",
      daily_pct: 0.82,
      weekly_pct: 0.44,
    },
    agents: {},
    exempt_agents: [],
    enforcement: "warn",
    override_active: false,
    generated_at: "2026-07-07T12:00:00.000Z",
  };
}
