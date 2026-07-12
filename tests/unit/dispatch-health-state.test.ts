import { describe, expect, it } from "vitest";

import { readDispatchHealth } from "../../src/dispatch-scheduler/read-model.js";

class HealthAdapter {
  constructor(
    private opts: {
      statusCounts?: Record<string, number>;
      orchestrationState?: Record<string, unknown> | null;
      readyCount?: number;
      clarificationRows?: Array<Record<string, unknown>>;
    },
  ) {}

  async query<T = Record<string, unknown>>(sql: string): Promise<{ rows: T[] }> {
    if (sql.includes("GROUP BY status")) {
      return {
        rows: Object.entries(this.opts.statusCounts ?? {}).map(([status, count]) => ({ status, count })) as T[],
      };
    }
    if (sql.includes("MIN(CASE WHEN status IN")) {
      return { rows: [{ oldest_active_at: null, newest_terminal_at: null }] as T[] };
    }
    if (sql.includes("FROM dispatch_scheduler_queue") && sql.includes("status = 'needs_clarification'")) {
      return { rows: (this.opts.clarificationRows ?? []) as T[] };
    }
    if (sql.includes("FROM orchestration_state")) {
      return { rows: this.opts.orchestrationState ? [this.opts.orchestrationState as T] : [] };
    }
    if (sql.includes("FROM orchestration_backlog_item")) {
      return { rows: [{ count: this.opts.readyCount ?? 0 }] as T[] };
    }
    return { rows: [] };
  }
}

describe("readDispatchHealth scheduler_health", () => {
  it("does not report generic idle when ready work silently stalls for many no-op ticks", async () => {
    const health = await readDispatchHealth(
      new HealthAdapter({
        statusCounts: { queued: 8 },
        readyCount: 8,
        orchestrationState: {
          mode: "running",
          consecutive_zero_ticks: 170,
          last_tick_at: "2026-07-09T14:00:00.000Z",
          last_dispatch_at: null,
          auto_pause_reason: null,
        },
      }) as any,
      "default",
    );

    expect(health.status).toBe("ok");
    expect(health.scheduler_health.state).toBe("stalled_ready_not_launching");
    expect(health.scheduler_health.evidence).toMatchObject({
      ready_count: 8,
      noop_tick_count: 170,
      last_launch_at: null,
      last_noop_reason: "ready backlog not launching",
    });
  });

  it("reports idle_no_ready_work when there is no ready backlog", async () => {
    const health = await readDispatchHealth(
      new HealthAdapter({
        statusCounts: {},
        readyCount: 0,
        orchestrationState: {
          mode: "running",
          consecutive_zero_ticks: 170,
          last_tick_at: "2026-07-09T14:00:00.000Z",
          last_dispatch_at: null,
          auto_pause_reason: null,
        },
      }) as any,
      "default",
    );

    expect(health.scheduler_health.state).toBe("idle_no_ready_work");
  });

  it("reports blocked_backpressure when an explicit blocker explains no launches", async () => {
    const health = await readDispatchHealth(
      new HealthAdapter({
        statusCounts: { needs_clarification: 1 },
        readyCount: 4,
        orchestrationState: {
          mode: "running",
          consecutive_zero_ticks: 12,
          last_tick_at: "2026-07-09T14:00:00.000Z",
          last_dispatch_at: null,
          auto_pause_reason: null,
        },
        clarificationRows: [
          {
            active_clarification_json: JSON.stringify({ question: "Which merge strategy?" }),
            updated_at: "2026-07-09T13:00:00.000Z",
          },
        ],
      }) as any,
      "default",
    );

    expect(health.scheduler_health.state).toBe("blocked_backpressure");
    expect(health.scheduler_health.reason).toContain("waiting on operator clarification");
  });
});
