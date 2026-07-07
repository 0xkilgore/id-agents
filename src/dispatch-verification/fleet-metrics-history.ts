// Historical fleet-effectiveness snapshots for trend charts.

import type { SqliteAdapter } from "../db/sqlite-adapter.js";
import type { UsageGateSnapshot } from "../usage-meter/types.js";
import type { AgentsEffectivenessResponse } from "./read-model.js";
import type { EffectivenessWindow } from "./types.js";
import type { FleetFreshnessSummary } from "../deploy-guard/fleet-freshness.js";

export const DEFAULT_FLEET_METRICS_RETENTION_DAYS = 35;

export interface FleetMetricsSnapshotInput {
  team_id: string;
  sampled_at: string;
  window: EffectivenessWindow;
  effectiveness: AgentsEffectivenessResponse;
  fleet_total: number | null;
  fleet_healthy: number | null;
  fleet_stale: number | null;
  manager_freshness: FleetFreshnessSummary | null;
  usage_gate: UsageGateSnapshot | null;
}

export interface FleetMetricsHistoryPoint {
  sampled_at: string;
  window: EffectivenessWindow;
  verified_landing_rate: number | null;
  throughput_per_week: number | null;
  failure_rate: number | null;
  healthy: number | null;
  total: number | null;
  stale: number | null;
  manager_freshness_state: "fresh" | "stale" | "unknown";
  manager_freshness_stale_count: number;
  manager_freshness_node_count: number;
  usage_gate_state: string | null;
  usage_gate_decision: string | null;
  usage_gate_enforcement: string | null;
  usage_gate_daily_pct: number | null;
  usage_gate_weekly_pct: number | null;
}

export interface FleetMetricsHistoryResponse {
  schema_version: "fleet.metrics.history.v1";
  generated_at: string;
  range: "24h" | "7d" | "30d" | "90d";
  granularity: "auto";
  points: FleetMetricsHistoryPoint[];
  freshness: {
    status: "fresh" | "unavailable";
    latest_sampled_at: string | null;
    retention_days: number;
  };
  warnings: string[];
}

interface FleetMetricsSnapshotRow {
  team_id: string;
  sampled_at: string;
  window: EffectivenessWindow;
  verified_landing_rate: number | null;
  throughput_per_week: number | null;
  failure_rate: number | null;
  healthy: number | null;
  total: number | null;
  stale: number | null;
  manager_freshness_state: "fresh" | "stale" | "unknown";
  manager_freshness_stale_count: number;
  manager_freshness_node_count: number;
  usage_gate_state: string | null;
  usage_gate_decision: string | null;
  usage_gate_enforcement: string | null;
  usage_gate_daily_pct: number | null;
  usage_gate_weekly_pct: number | null;
  usage_gate_json: string | null;
}

export class FleetMetricsHistoryStorage {
  constructor(
    private readonly adapter: SqliteAdapter,
    private readonly retentionDays = DEFAULT_FLEET_METRICS_RETENTION_DAYS,
  ) {}

  async migrate(): Promise<void> {
    this.adapter.exec(`
      CREATE TABLE IF NOT EXISTS fleet_metrics_snapshots (
        team_id TEXT NOT NULL,
        sampled_at TEXT NOT NULL,
        window TEXT NOT NULL,
        verified_landing_rate REAL,
        throughput_per_week REAL,
        failure_rate REAL,
        healthy INTEGER,
        total INTEGER,
        stale INTEGER,
        manager_freshness_state TEXT NOT NULL DEFAULT 'unknown',
        manager_freshness_stale_count INTEGER NOT NULL DEFAULT 0,
        manager_freshness_node_count INTEGER NOT NULL DEFAULT 0,
        usage_gate_state TEXT,
        usage_gate_decision TEXT,
        usage_gate_enforcement TEXT,
        usage_gate_daily_pct REAL,
        usage_gate_weekly_pct REAL,
        usage_gate_json TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (team_id, sampled_at, window)
      );

      CREATE INDEX IF NOT EXISTS fleet_metrics_snapshots_team_time_idx
        ON fleet_metrics_snapshots(team_id, sampled_at DESC);
    `);
  }

  async insertSnapshot(input: FleetMetricsSnapshotInput): Promise<void> {
    const point = snapshotInputToPoint(input);
    await this.adapter.query(
      `INSERT INTO fleet_metrics_snapshots (
        team_id, sampled_at, window, verified_landing_rate, throughput_per_week,
        failure_rate, healthy, total, stale, manager_freshness_state,
        manager_freshness_stale_count, manager_freshness_node_count,
        usage_gate_state, usage_gate_decision, usage_gate_enforcement,
        usage_gate_daily_pct, usage_gate_weekly_pct, usage_gate_json
      ) VALUES (
        $1, $2, $3, $4, $5,
        $6, $7, $8, $9, $10,
        $11, $12,
        $13, $14, $15,
        $16, $17, $18
      )
      ON CONFLICT(team_id, sampled_at, window) DO UPDATE SET
        verified_landing_rate = excluded.verified_landing_rate,
        throughput_per_week = excluded.throughput_per_week,
        failure_rate = excluded.failure_rate,
        healthy = excluded.healthy,
        total = excluded.total,
        stale = excluded.stale,
        manager_freshness_state = excluded.manager_freshness_state,
        manager_freshness_stale_count = excluded.manager_freshness_stale_count,
        manager_freshness_node_count = excluded.manager_freshness_node_count,
        usage_gate_state = excluded.usage_gate_state,
        usage_gate_decision = excluded.usage_gate_decision,
        usage_gate_enforcement = excluded.usage_gate_enforcement,
        usage_gate_daily_pct = excluded.usage_gate_daily_pct,
        usage_gate_weekly_pct = excluded.usage_gate_weekly_pct,
        usage_gate_json = excluded.usage_gate_json`,
      [
        input.team_id,
        point.sampled_at,
        point.window,
        point.verified_landing_rate,
        point.throughput_per_week,
        point.failure_rate,
        point.healthy,
        point.total,
        point.stale,
        point.manager_freshness_state,
        point.manager_freshness_stale_count,
        point.manager_freshness_node_count,
        point.usage_gate_state,
        point.usage_gate_decision,
        point.usage_gate_enforcement,
        point.usage_gate_daily_pct,
        point.usage_gate_weekly_pct,
        input.usage_gate ? JSON.stringify(input.usage_gate) : null,
      ],
    );
  }

  async readHistory(input: {
    teamId: string;
    fromIso: string;
    toIso: string;
    window?: EffectivenessWindow | null;
    limit?: number;
  }): Promise<FleetMetricsHistoryPoint[]> {
    const params: unknown[] = [input.teamId, input.fromIso, input.toIso];
    const windowClause = input.window ? "AND window = $4" : "";
    if (input.window) params.push(input.window);
    params.push(input.limit ?? 500);
    const limitParam = `$${params.length}`;
    const res = await this.adapter.query<FleetMetricsSnapshotRow>(
      `SELECT * FROM fleet_metrics_snapshots
        WHERE team_id = $1
          AND sampled_at BETWEEN $2 AND $3
          ${windowClause}
        ORDER BY sampled_at ASC
        LIMIT ${limitParam}`,
      params,
    );
    return res.rows.map(rowToPoint);
  }

  async prune(nowIso: string): Promise<number> {
    const cutoff = new Date(Date.parse(nowIso) - this.retentionDays * 86_400_000).toISOString();
    const res = await this.adapter.query(
      `DELETE FROM fleet_metrics_snapshots WHERE sampled_at < $1`,
      [cutoff],
    );
    return res.rowCount;
  }

  retentionWindowDays(): number {
    return this.retentionDays;
  }
}

export function buildFleetMetricsHistoryResponse(input: {
  points: FleetMetricsHistoryPoint[];
  range: FleetMetricsHistoryResponse["range"];
  generated_at: string;
  retention_days: number;
}): FleetMetricsHistoryResponse {
  const latest = input.points.at(-1)?.sampled_at ?? null;
  return {
    schema_version: "fleet.metrics.history.v1",
    generated_at: input.generated_at,
    range: input.range,
    granularity: "auto",
    points: input.points,
    freshness: {
      status: latest ? "fresh" : "unavailable",
      latest_sampled_at: latest,
      retention_days: input.retention_days,
    },
    warnings: latest ? [] : ["no fleet metrics snapshots recorded for range"],
  };
}

function snapshotInputToPoint(input: FleetMetricsSnapshotInput): FleetMetricsHistoryPoint {
  const fleet = input.effectiveness.fleet;
  const completed = fleet.dispatches_completed;
  const failures = Object.values(fleet.failure_breakdown).reduce((sum, count) => sum + count, 0);
  const staleCount = input.manager_freshness?.stale_nodes.length ?? 0;
  const nodeCount = input.manager_freshness?.node_count ?? 0;
  return {
    sampled_at: input.sampled_at,
    window: input.window,
    verified_landing_rate: finiteOrNull(fleet.verified_landing_rate),
    throughput_per_week: finiteOrNull(fleet.throughput_per_week),
    failure_rate: completed > 0 ? round(failures / completed, 4) : null,
    healthy: input.fleet_healthy,
    total: input.fleet_total,
    stale: input.fleet_stale,
    manager_freshness_state: nodeCount === 0 ? "unknown" : staleCount > 0 ? "stale" : "fresh",
    manager_freshness_stale_count: staleCount,
    manager_freshness_node_count: nodeCount,
    usage_gate_state: input.usage_gate?.global.state ?? null,
    usage_gate_decision: input.usage_gate?.global.decision ?? null,
    usage_gate_enforcement: input.usage_gate?.enforcement ?? null,
    usage_gate_daily_pct: input.usage_gate?.global.daily_pct ?? null,
    usage_gate_weekly_pct: input.usage_gate?.global.weekly_pct ?? null,
  };
}

function rowToPoint(row: FleetMetricsSnapshotRow): FleetMetricsHistoryPoint {
  return {
    sampled_at: row.sampled_at,
    window: row.window,
    verified_landing_rate: numberOrNull(row.verified_landing_rate),
    throughput_per_week: numberOrNull(row.throughput_per_week),
    failure_rate: numberOrNull(row.failure_rate),
    healthy: numberOrNull(row.healthy),
    total: numberOrNull(row.total),
    stale: numberOrNull(row.stale),
    manager_freshness_state: row.manager_freshness_state,
    manager_freshness_stale_count: Number(row.manager_freshness_stale_count),
    manager_freshness_node_count: Number(row.manager_freshness_node_count),
    usage_gate_state: row.usage_gate_state,
    usage_gate_decision: row.usage_gate_decision,
    usage_gate_enforcement: row.usage_gate_enforcement,
    usage_gate_daily_pct: numberOrNull(row.usage_gate_daily_pct),
    usage_gate_weekly_pct: numberOrNull(row.usage_gate_weekly_pct),
  };
}

function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function finiteOrNull(value: number): number | null {
  return Number.isFinite(value) ? value : null;
}

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}
