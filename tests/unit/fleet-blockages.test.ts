import { describe, expect, it } from "vitest";

import { readFleetBlockages } from "../../src/dispatch-scheduler/fleet-blockages.js";

class MemoryAdapter {
  public dispatchSql = "";
  public orchestrationParams: unknown[][] = [];

  constructor(
    private rows: Array<Record<string, unknown>>,
    private orchestrationRows: Record<string, unknown>[] = [{ team_id: "default", mode: "running", consecutive_zero_ticks: 0 }],
  ) {}

  async query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<{ rows: T[] }> {
    if (sql.includes("FROM dispatch_scheduler_queue")) {
      this.dispatchSql = sql;
      if (sql.includes("to_agent = ?")) {
        return {
          rows: [{
            count: this.rows.filter((row) => {
              const status = String(row.status ?? "");
              if (row.to_agent !== params[1]) return false;
              if (["moot", "landed_reconciled", "verified_done", "retry_done"].includes(String(row.recovery_status ?? "none"))) {
                return false;
              }
              return status === "failed" || ["in_flight", "bounced", "resume_delivery_failed"].includes(status);
            }).length,
            oldest_work_at: this.rows
              .filter((row) => row.to_agent === params[1])
              .map((row) => String(row.started_at ?? row.updated_at ?? ""))
              .filter(Boolean)
              .sort()[0] ?? null,
          }] as T[],
        };
      }
      return {
        rows: this.rows.filter((row) => {
          if (row.status !== "needs_clarification") return false;
          return !["moot", "landed_reconciled", "verified_done", "retry_done"].includes(
            String(row.recovery_status ?? "none"),
          );
        }) as T[],
      };
    }
    if (sql.includes("FROM orchestration_state")) {
      this.orchestrationParams.push(params);
      if (sql.includes("SELECT team_id")) {
        return { rows: this.orchestrationRows.filter((row) => row.team_id === params[0]).map((row) => ({ team_id: row.team_id })) as T[] };
      }
      return { rows: this.orchestrationRows.filter((row) => row.team_id === params[0]) as T[] };
    }
    return { rows: [] };
  }
}

describe("readFleetBlockages", () => {
  it("does not count mooted clarification rows as live fleet blockers", async () => {
    const adapter = new MemoryAdapter([
      {
        status: "needs_clarification",
        recovery_status: "moot",
        updated_at: "2026-06-26T10:00:00.000Z",
        active_clarification_json: JSON.stringify({
          created_at: "2026-06-26T10:00:00.000Z",
          stale_at: "2026-06-26T10:30:00.000Z",
        }),
      },
    ]);
    const report = await readFleetBlockages(
      adapter,
      "personal",
    );

    expect(adapter.dispatchSql).toContain("COALESCE(recovery_status, 'none') NOT IN");
    expect(adapter.dispatchSql).toContain("'moot'");
    expect(report.blocked).toBe(false);
    expect(report.blockages).toEqual([]);
  });

  it("counts unresolved clarification rows", async () => {
    const report = await readFleetBlockages(
      new MemoryAdapter([
        {
          status: "needs_clarification",
          recovery_status: "none",
          updated_at: "2026-06-26T10:00:00.000Z",
          active_clarification_json: JSON.stringify({
            created_at: "2026-06-26T10:00:00.000Z",
            stale_at: "2999-01-01T00:00:00.000Z",
          }),
        },
      ]),
      "personal",
    );

    expect(report.blocked).toBe(true);
    expect(report.blockages[0]?.kind).toBe("needs_clarification");
    expect(report.blockages[0]?.count).toBe(1);
  });

  // RD-014 drift-guard Ticket A — the in-memory runtime-drift summary is
  // threaded through as a 3rd param (it can't be queried via `adapter` like
  // every other blockage source here, since the tracker is in-memory).
  it("does not flag a drifted agent when its direct /health probe returned ok", async () => {
    const report = await readFleetBlockages(new MemoryAdapter([
      {
        to_agent: "cto",
        status: "failed",
        recovery_status: "none",
        updated_at: "2026-07-05T00:10:00.000Z",
      },
    ]), "personal", {
      drifted_agents: [
        {
          agent_id: "a1",
          agent_name: "cto",
          state: "offline",
          since: "2026-07-05T00:00:00.000Z",
          lifecycle: "always_on",
          health_probe: "ok",
        },
      ],
    });

    expect(report.blockages.find((b) => b.kind === "stall_class_pending_agent")).toBeUndefined();
  });

  it("does not raise critical drift for optional on-demand agents", async () => {
    const report = await readFleetBlockages(new MemoryAdapter([
      {
        to_agent: "coder-max",
        status: "failed",
        recovery_status: "none",
        updated_at: "2026-07-05T00:10:00.000Z",
      },
    ]), "personal", {
      drifted_agents: [
        {
          agent_id: "a1",
          agent_name: "coder-max",
          state: "offline",
          since: "2026-07-05T00:00:00.000Z",
          lifecycle: "optional",
          health_probe: "failed",
        },
      ],
    });

    expect(report.blockages.find((b) => b.kind === "stall_class_pending_agent")).toBeUndefined();
  });

  it("includes stall_class_pending_agent when an always-on agent is unreachable with stale or failed work", async () => {
    const report = await readFleetBlockages(new MemoryAdapter([
      {
        to_agent: "roger",
        status: "failed",
        recovery_status: "none",
        updated_at: "2026-07-05T00:10:00.000Z",
      },
    ]), "personal", {
      drifted_agents: [
        {
          agent_id: "a1",
          agent_name: "roger",
          state: "offline",
          since: "2026-07-05T00:00:00.000Z",
          lifecycle: "always_on",
          health_probe: "failed",
        },
      ],
    });

    expect(report.blocked).toBe(true);
    const block = report.blockages.find((b) => b.kind === "stall_class_pending_agent");
    expect(block).toBeDefined();
    expect(block?.severity).toBe("critical");
    expect(block?.count).toBe(1);
    expect(block?.message).toContain("roger (offline)");
  });

  it("omits stall_class_pending_agent when no agent is drifted", async () => {
    const report = await readFleetBlockages(new MemoryAdapter([]), "personal", { drifted_agents: [] });
    expect(report.blockages.find((b) => b.kind === "stall_class_pending_agent")).toBeUndefined();
  });

  it("omits stall_class_pending_agent when no drift summary is passed at all (back-compat)", async () => {
    const report = await readFleetBlockages(new MemoryAdapter([]), "personal");
    expect(report.blockages.find((b) => b.kind === "stall_class_pending_agent")).toBeUndefined();
  });

  it("checks orchestration state by team id and team name so /dispatches/health is not blind to name-keyed CO rows", async () => {
    const adapter = new MemoryAdapter([], [{ team_id: "default", mode: "running", consecutive_zero_ticks: 0 }]);
    await readFleetBlockages(adapter, "36ee78b1-d817-4a29-b631-c93945404c7b", null, "default");

    expect(adapter.orchestrationParams).toEqual([
      ["36ee78b1-d817-4a29-b631-c93945404c7b"],
      ["default"],
      ["default"],
    ]);
  });
});
