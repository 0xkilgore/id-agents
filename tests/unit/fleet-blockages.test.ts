import { describe, expect, it } from "vitest";

import { readFleetBlockages } from "../../src/dispatch-scheduler/fleet-blockages.js";
import { migrateSqlite } from "../../src/db/migrations/sqlite.js";
import { SqliteAdapter } from "../../src/db/sqlite-adapter.js";

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
      const liveClarifications = this.rows.filter((row) => {
        if (row.status !== "needs_clarification") return false;
        return !["moot", "landed_reconciled", "verified_done", "retry_done"].includes(
          String(row.recovery_status ?? "none"),
        );
      });
      if (sql.includes("COUNT(*) as count") && sql.includes("MIN(COALESCE")) {
        const oldest = liveClarifications
          .map((row) => String(row.started_at ?? row.not_before_at ?? row.updated_at ?? ""))
          .filter(Boolean)
          .sort()[0] ?? null;
        return { rows: [{ count: liveClarifications.length, oldest_at: oldest }] as T[] };
      }
      const staleRows = liveClarifications.filter((row) => {
        const payload = parseJson(String(row.active_clarification_json ?? ""));
        const staleAt = payload && typeof payload.stale_at === "string" ? payload.stale_at : null;
        return staleAt != null && staleAt <= String(params[1]);
      });
      if (sql.includes("SELECT COUNT(*) as count FROM (")) {
        return { rows: [{ count: staleRows.length }] as T[] };
      }
      return {
        rows: staleRows as T[],
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

function parseJson(raw: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
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

  it("classifies 18 stale clarifications into non-Chris and Chris-needed blockers", async () => {
    const rows = Array.from({ length: 18 }, (_, i) => {
      const nonChris = i < 12;
      return {
        dispatch_phid: `phid:disp-stale-${i}`,
        query_id: `query_stale_${i}`,
        to_agent: nonChris ? "release-agent" : "roger",
        status: "needs_clarification",
        recovery_status: "none",
        updated_at: `2026-07-13T10:${String(i).padStart(2, "0")}:00.000Z`,
        active_clarification_json: JSON.stringify({
          needs_you: !nonChris,
          question: nonChris
            ? "Promotion blocked because branch is behind origin/main by 28 commits."
            : "Which customer-facing behavior should ship?",
          created_at: "2026-07-13T10:00:00.000Z",
          stale_at: "2026-07-13T10:30:00.000Z",
          context: nonChris ? { branch: "kapelle/fix-health" } : { blocking_reasons: ["operator decision required"] },
        }),
      };
    });

    const report = await readFleetBlockages(new MemoryAdapter(rows), "personal");

    expect(report.needs_clarification).toEqual({
      count: 18,
      needs_chris_count: 6,
      non_chris_count: 12,
      stale_non_chris_count: 12,
    });
    expect(report.blockages.find((b) => b.kind === "needs_clarification")).toMatchObject({
      severity: "critical",
      count: 18,
    });
    expect(report.blockages.find((b) => b.kind === "stale_clarification")).toMatchObject({
      severity: "critical",
      count: 18,
      message: expect.stringContaining("non-Chris=12, Chris-needed=6"),
    });
  });

  it("uses the bounded stale clarification health index for SQLite reads", async () => {
    const adapter = new SqliteAdapter(":memory:");
    try {
      await migrateSqlite(adapter);
      const { rows: indexes } = await adapter.query<{ name: string }>(
        `SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'dispatch_scheduler_stale_clarifications_health_idx'`,
      );
      expect(indexes).toHaveLength(1);

      const sqlite = (adapter as unknown as {
        db: { prepare(sql: string): { all(...params: unknown[]): Array<{ detail: string }> } };
      }).db;
      const plan = sqlite.prepare(
        `EXPLAIN QUERY PLAN
         SELECT dispatch_phid, query_id, to_agent, active_clarification_json, updated_at
           FROM dispatch_scheduler_queue
          WHERE team_id = ?
            AND status = 'needs_clarification'
            AND COALESCE(recovery_status, 'none') NOT IN ('moot', 'landed_reconciled', 'verified_done', 'retry_done')
            AND active_clarification_json IS NOT NULL
            AND json_extract(active_clarification_json, '$.stale_at') IS NOT NULL
            AND json_extract(active_clarification_json, '$.stale_at') <= ?
          ORDER BY json_extract(active_clarification_json, '$.stale_at') ASC, dispatch_phid ASC
          LIMIT ?`,
      ).all("default", "2026-07-13T11:00:00.000Z", 64);

      expect(plan.map((row) => row.detail).join("\n")).toContain("dispatch_scheduler_stale_clarifications_health_idx");
    } finally {
      await adapter.close();
    }
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
