// SPDX-License-Identifier: MIT

import type { DbAdapter } from "../db/db-adapter.js";

export interface AllocationTelemetryRow {
  agent_id: string;
  dispatch_count: number;
  completed_count: number;
  failed_count: number;
  in_flight_count: number;
  completion_rate: number;
  avg_time_in_flight_ms: number | null;
}

export interface AllocationTelemetryResponse {
  schema_version: "agent_allocation_telemetry.v1";
  generated_at: string;
  window: {
    start: string;
    end: string;
    trailing_hours: number;
  };
  agents: AllocationTelemetryRow[];
}

interface DispatchTelemetrySourceRow {
  to_agent: string;
  status: string;
  started_at: string | null;
  completed_at: string | null;
}

const COMPLETED_STATUSES = new Set(["completed", "done", "verified_done"]);
const FAILED_STATUSES = new Set(["failed", "cancelled", "expired", "error"]);

export async function buildAllocationTelemetry(
  adapter: DbAdapter,
  opts: { now?: Date; trailingHours?: number } = {},
): Promise<AllocationTelemetryResponse> {
  const now = opts.now ?? new Date();
  const trailingHours = clampTrailingHours(opts.trailingHours ?? 48);
  const start = new Date(now.getTime() - trailingHours * 60 * 60 * 1000);
  const startIso = start.toISOString();
  const endIso = now.toISOString();

  const { rows } = await adapter.query<DispatchTelemetrySourceRow>(
    `SELECT to_agent, status, started_at, completed_at
     FROM dispatch_scheduler_queue
     WHERE to_agent IS NOT NULL
       AND not_before_at >= $1
       AND not_before_at < $2`,
    [startIso, endIso],
  );

  const byAgent = new Map<string, {
    dispatch_count: number;
    completed_count: number;
    failed_count: number;
    in_flight_count: number;
    completed_durations: number[];
  }>();

  for (const row of rows) {
    const agentId = row.to_agent;
    const bucket = byAgent.get(agentId) ?? {
      dispatch_count: 0,
      completed_count: 0,
      failed_count: 0,
      in_flight_count: 0,
      completed_durations: [],
    };

    bucket.dispatch_count++;

    if (COMPLETED_STATUSES.has(row.status)) {
      bucket.completed_count++;
      const duration = timeInFlightMs(row.started_at, row.completed_at);
      if (duration != null) bucket.completed_durations.push(duration);
    } else if (FAILED_STATUSES.has(row.status)) {
      bucket.failed_count++;
    } else {
      bucket.in_flight_count++;
    }

    byAgent.set(agentId, bucket);
  }

  const agents = Array.from(byAgent.entries()).map(([agent_id, bucket]) => ({
    agent_id,
    dispatch_count: bucket.dispatch_count,
    completed_count: bucket.completed_count,
    failed_count: bucket.failed_count,
    in_flight_count: bucket.in_flight_count,
    completion_rate: bucket.dispatch_count > 0 ? bucket.completed_count / bucket.dispatch_count : 0,
    avg_time_in_flight_ms: average(bucket.completed_durations),
  }));

  agents.sort((a, b) => {
    if (b.dispatch_count !== a.dispatch_count) return b.dispatch_count - a.dispatch_count;
    return a.agent_id.localeCompare(b.agent_id);
  });

  return {
    schema_version: "agent_allocation_telemetry.v1",
    generated_at: endIso,
    window: {
      start: startIso,
      end: endIso,
      trailing_hours: trailingHours,
    },
    agents,
  };
}

export function clampTrailingHours(value: number): number {
  if (!Number.isFinite(value)) return 48;
  return Math.min(24 * 30, Math.max(1, Math.floor(value)));
}

function timeInFlightMs(startedAt: string | null, completedAt: string | null): number | null {
  if (!startedAt || !completedAt) return null;
  const started = new Date(startedAt).getTime();
  const completed = new Date(completedAt).getTime();
  if (!Number.isFinite(started) || !Number.isFinite(completed)) return null;
  const duration = completed - started;
  return duration >= 0 ? duration : null;
}

function average(values: number[]): number | null {
  if (values.length === 0) return null;
  return Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
}
