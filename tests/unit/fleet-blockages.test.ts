import { describe, expect, it } from "vitest";

import { readFleetBlockages } from "../../src/dispatch-scheduler/fleet-blockages.js";

class MemoryAdapter {
  public dispatchSql = "";

  constructor(private rows: Array<Record<string, unknown>>) {}

  async query<T = Record<string, unknown>>(sql: string): Promise<{ rows: T[] }> {
    if (sql.includes("FROM dispatch_scheduler_queue")) {
      this.dispatchSql = sql;
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
      return { rows: [{ mode: "running", consecutive_zero_ticks: 0 }] as T[] };
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
  it("includes stall_class_pending_agent when >=1 agent is currently drifted", async () => {
    const report = await readFleetBlockages(new MemoryAdapter([]), "personal", {
      drifted_agents: [
        { agent_id: "a1", agent_name: "roger", state: "pending", since: "2026-07-05T00:00:00.000Z" },
      ],
    });

    expect(report.blocked).toBe(true);
    const block = report.blockages.find((b) => b.kind === "stall_class_pending_agent");
    expect(block).toBeDefined();
    expect(block?.severity).toBe("critical");
    expect(block?.count).toBe(1);
    expect(block?.message).toContain("roger (pending)");
  });

  it("omits stall_class_pending_agent when no agent is drifted", async () => {
    const report = await readFleetBlockages(new MemoryAdapter([]), "personal", { drifted_agents: [] });
    expect(report.blockages.find((b) => b.kind === "stall_class_pending_agent")).toBeUndefined();
  });

  it("omits stall_class_pending_agent when no drift summary is passed at all (back-compat)", async () => {
    const report = await readFleetBlockages(new MemoryAdapter([]), "personal");
    expect(report.blockages.find((b) => b.kind === "stall_class_pending_agent")).toBeUndefined();
  });
});
