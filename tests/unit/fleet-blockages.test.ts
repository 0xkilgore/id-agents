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

  it("separates the current five deterministic branch/promotion hygiene clarifications from Chris-needed input", async () => {
    const rows = [
      {
        dispatch_phid: "phid:disp-ahead-behind",
        query_id: "query_ahead_behind",
        to_agent: "roger",
        question: "Promotion preflight failed: branch ahead=1 behind=3 relative to main.",
      },
      {
        dispatch_phid: "phid:disp-stale-base",
        query_id: "query_stale_base",
        to_agent: "release-agent",
        question: "Promotion blocked because branch kapelle/fix-health is behind origin/main by 28 commits.",
      },
      {
        dispatch_phid: "phid:disp-dirty-checkout",
        query_id: "query_dirty_checkout",
        to_agent: "builder",
        question: "Working tree has unapproved dirty paths before promotion.",
      },
      {
        dispatch_phid: "phid:disp-held-worktree",
        query_id: "query_held_worktree",
        to_agent: "release-agent",
        question: "Branch kapelle/fix-health is already checked out by another worktree.",
      },
      {
        dispatch_phid: "phid:disp-unlinked-branch",
        query_id: "query_unlinked_branch",
        to_agent: "release-agent",
        question: "Unlinked branch without linked dispatch cannot be promoted safely.",
      },
    ].map((row) => ({
      ...row,
      status: "needs_clarification",
      recovery_status: "none",
      updated_at: "2026-07-13T10:00:00.000Z",
      active_clarification_json: JSON.stringify({
        needs_you: true,
        question: row.question,
        created_at: "2026-07-13T10:00:00.000Z",
        stale_at: "2026-07-13T10:30:00.000Z",
        context: {
          repo: "/repo/kapelle",
          branch: "kapelle/fix-health",
        },
      }),
    }));

    const report = await readFleetBlockages(new MemoryAdapter(rows), "personal");

    expect(report.needs_clarification).toEqual({
      count: 5,
      needs_chris_count: 0,
      non_chris_count: 5,
      stale_non_chris_count: 5,
    });
    expect(report.blockages.find((b) => b.kind === "needs_clarification")).toMatchObject({
      severity: "critical",
      count: 5,
    });
    expect(report.blockages.find((b) => b.kind === "stale_clarification")).toMatchObject({
      severity: "critical",
      count: 5,
    });
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
