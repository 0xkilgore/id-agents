import express from "express";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteAdapter } from "../../src/db/sqlite-adapter.js";
import { buildAllocationTelemetry } from "../../src/telemetry/allocation-telemetry.js";
import { mountMetricsRoutes } from "../../src/telemetry/routes.js";

let adapter: SqliteAdapter;

beforeEach(async () => {
  adapter = new SqliteAdapter(":memory:");
  await adapter.query(`
    CREATE TABLE dispatch_scheduler_queue (
      dispatch_phid TEXT PRIMARY KEY,
      to_agent TEXT NOT NULL,
      status TEXT NOT NULL,
      not_before_at TEXT NOT NULL,
      started_at TEXT,
      completed_at TEXT
    )
  `);
});

afterEach(async () => {
  await adapter.close();
});

describe("allocation telemetry read model", () => {
  it("aggregates dispatch count, completion rate, and average time-in-flight over the trailing window", async () => {
    const now = new Date("2026-07-10T15:00:00.000Z");

    await seedDispatch({
      dispatch_phid: "disp-roger-1",
      to_agent: "roger",
      status: "completed",
      not_before_at: "2026-07-10T10:00:00.000Z",
      started_at: "2026-07-10T10:05:00.000Z",
      completed_at: "2026-07-10T11:05:00.000Z",
    });
    await seedDispatch({
      dispatch_phid: "disp-roger-2",
      to_agent: "roger",
      status: "completed",
      not_before_at: "2026-07-10T12:00:00.000Z",
      started_at: "2026-07-10T12:10:00.000Z",
      completed_at: "2026-07-10T12:40:00.000Z",
    });
    await seedDispatch({
      dispatch_phid: "disp-roger-3",
      to_agent: "roger",
      status: "failed",
      not_before_at: "2026-07-10T13:00:00.000Z",
      started_at: "2026-07-10T13:10:00.000Z",
      completed_at: "2026-07-10T13:20:00.000Z",
    });
    await seedDispatch({
      dispatch_phid: "disp-roger-old",
      to_agent: "roger",
      status: "completed",
      not_before_at: "2026-07-08T13:00:00.000Z",
      started_at: "2026-07-08T13:10:00.000Z",
      completed_at: "2026-07-08T13:20:00.000Z",
    });
    await seedDispatch({
      dispatch_phid: "disp-cto-1",
      to_agent: "cto",
      status: "processing",
      not_before_at: "2026-07-10T13:30:00.000Z",
      started_at: "2026-07-10T13:35:00.000Z",
      completed_at: null,
    });
    await seedDispatch({
      dispatch_phid: "disp-cto-2",
      to_agent: "cto",
      status: "done",
      not_before_at: "2026-07-10T14:00:00.000Z",
      started_at: "2026-07-10T14:05:00.000Z",
      completed_at: "2026-07-10T14:15:00.000Z",
    });

    const telemetry = await buildAllocationTelemetry(adapter, { now, trailingHours: 24 });

    expect(telemetry.window).toEqual({
      start: "2026-07-09T15:00:00.000Z",
      end: "2026-07-10T15:00:00.000Z",
      trailing_hours: 24,
    });

    const byAgent = new Map(telemetry.agents.map((agent) => [agent.agent_id, agent]));
    expect(byAgent.get("roger")).toMatchObject({
      dispatch_count: 3,
      completed_count: 2,
      failed_count: 1,
      in_flight_count: 0,
      avg_time_in_flight_ms: 2_700_000,
    });
    expect(byAgent.get("roger")?.completion_rate).toBeCloseTo(2 / 3);

    expect(byAgent.get("cto")).toMatchObject({
      dispatch_count: 2,
      completed_count: 1,
      failed_count: 0,
      in_flight_count: 1,
      completion_rate: 0.5,
      avg_time_in_flight_ms: 600_000,
    });
  });
});

describe("GET /agents/allocation-telemetry", () => {
  it("returns real per-agent fixture counts from dispatch rows", async () => {
    const now = Date.now();
    await seedDispatch({
      dispatch_phid: "disp-route-1",
      to_agent: "roger",
      status: "completed",
      not_before_at: new Date(now - 60_000).toISOString(),
      started_at: new Date(now - 50_000).toISOString(),
      completed_at: new Date(now - 20_000).toISOString(),
    });
    await seedDispatch({
      dispatch_phid: "disp-route-2",
      to_agent: "roger",
      status: "processing",
      not_before_at: new Date(now - 30_000).toISOString(),
      started_at: new Date(now - 25_000).toISOString(),
      completed_at: null,
    });

    const app = express();
    mountMetricsRoutes(app, adapter);
    const server = app.listen(0, "127.0.0.1");
    try {
      await new Promise<void>((resolve) => server.once("listening", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("server did not bind to a port");

      const res = await fetch(`http://127.0.0.1:${address.port}/agents/allocation-telemetry?window_hours=1`);
      expect(res.status).toBe(200);
      const body = await res.json() as Awaited<ReturnType<typeof buildAllocationTelemetry>>;
      const roger = body.agents.find((agent) => agent.agent_id === "roger");
      expect(roger).toMatchObject({
        dispatch_count: 2,
        completed_count: 1,
        in_flight_count: 1,
        completion_rate: 0.5,
        avg_time_in_flight_ms: 30_000,
      });
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => err ? reject(err) : resolve());
      });
    }
  });
});

async function seedDispatch(row: {
  dispatch_phid: string;
  to_agent: string;
  status: string;
  not_before_at: string;
  started_at: string | null;
  completed_at: string | null;
}): Promise<void> {
  await adapter.query(
    `INSERT INTO dispatch_scheduler_queue
       (dispatch_phid, to_agent, status, not_before_at, started_at, completed_at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [row.dispatch_phid, row.to_agent, row.status, row.not_before_at, row.started_at, row.completed_at],
  );
}
