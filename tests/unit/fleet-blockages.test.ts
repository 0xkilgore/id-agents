import { describe, expect, it } from "vitest";

import { readFleetBlockages } from "../../src/dispatch-scheduler/fleet-blockages.js";
import { migrateSqlite } from "../../src/db/migrations/sqlite.js";
import { SqliteAdapter } from "../../src/db/sqlite-adapter.js";

class MemoryAdapter {
  public dispatchSql = "";
  public orchestrationParams: unknown[] = [];

  constructor(private rows: Array<Record<string, unknown>>) {}

  async query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<{ rows: T[] }> {
    if (sql.includes("FROM dispatch_scheduler_queue")) {
      this.dispatchSql = sql;
      if (sql.includes("COUNT(*) as count")) {
        const liveRows = this.liveClarificationRows();
        const oldest = liveRows
          .map((row) => String(row.started_at ?? row.not_before_at ?? row.updated_at ?? ""))
          .filter(Boolean)
          .sort()[0] ?? null;
        return { rows: [{ count: liveRows.length, oldest_at: oldest }] as T[] };
      }
      if (sql.includes("stale_count")) {
        const staleCutoff = String(params[1] ?? "9999-12-31T23:59:59.999Z");
        const staleRows = this.liveClarificationRows().filter((row) => {
          const parsed = JSON.parse(String(row.active_clarification_json ?? "{}")) as { stale_at?: string };
          return !!parsed.stale_at && parsed.stale_at <= staleCutoff;
        });
        let nonChris = 0;
        for (const row of staleRows) {
          const parsed = JSON.parse(String(row.active_clarification_json ?? "{}")) as {
            needs_you?: boolean;
            requires_chris?: boolean;
            needs_chris?: boolean;
          };
          if (parsed.needs_you === false || parsed.requires_chris === false || parsed.needs_chris === false) {
            nonChris += 1;
          }
        }
        return {
          rows: [{
            stale_count: staleRows.length,
            needs_chris_count: staleRows.length - nonChris,
            non_chris_count: nonChris,
          }] as T[],
        };
      }
      const staleCutoff = String(params[1] ?? "9999-12-31T23:59:59.999Z");
      const limit = Number(params[2] ?? 64);
      return {
        rows: this.liveClarificationRows()
          .filter((row) => {
            const parsed = JSON.parse(String(row.active_clarification_json ?? "{}")) as { stale_at?: string };
            return !!parsed.stale_at && parsed.stale_at <= staleCutoff;
          })
          .sort((a, b) => {
            const aStale = JSON.parse(String(a.active_clarification_json ?? "{}")).stale_at ?? "";
            const bStale = JSON.parse(String(b.active_clarification_json ?? "{}")).stale_at ?? "";
            return aStale.localeCompare(bStale) || String(a.dispatch_phid ?? "").localeCompare(String(b.dispatch_phid ?? ""));
          })
          .slice(0, limit) as T[],
      };
    }
    if (sql.includes("FROM orchestration_state")) {
      this.orchestrationParams = params;
      return { rows: [{ mode: "running", consecutive_zero_ticks: 0 }] as T[] };
    }
    return { rows: [] };
  }

  private liveClarificationRows(): Array<Record<string, unknown>> {
    return this.rows.filter((row) => {
      if (row.status !== "needs_clarification") return false;
      return !["moot", "landed_reconciled", "verified_done", "retry_done"].includes(
        String(row.recovery_status ?? "none"),
      );
    });
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

  it("keeps clarification counts compatible for 20+ rows without returning active rows unbounded", async () => {
    const rows = Array.from({ length: 24 }, (_, i) => {
      const needsChris = i % 3 === 0;
      return {
        dispatch_phid: `phid:disp-clarification-${String(i).padStart(2, "0")}`,
        query_id: `query_clarification_${i}`,
        to_agent: needsChris ? "roger" : "release-agent",
        status: "needs_clarification",
        recovery_status: "none",
        updated_at: `2026-07-13T10:${String(i).padStart(2, "0")}:00.000Z`,
        active_clarification_json: JSON.stringify({
          needs_you: needsChris,
          question: needsChris ? "Which customer behavior should ship?" : "Branch is behind origin/main.",
          stale_at: "2026-07-13T10:30:00.000Z",
        }),
      };
    });

    const report = await readFleetBlockages(new MemoryAdapter(rows), "personal");

    expect(report.needs_clarification).toEqual({
      count: 24,
      needs_chris_count: 8,
      non_chris_count: 16,
      stale_non_chris_count: 16,
    });
    expect(report.blockages.find((b) => b.kind === "needs_clarification")).toMatchObject({
      count: 24,
      severity: "critical",
    });
    expect(report.blockages.find((b) => b.kind === "stale_clarification")).toMatchObject({
      count: 24,
      message: expect.stringContaining("non-Chris=16, Chris-needed=8"),
    });
  });

  it("uses the stale clarification health index for SQLite reads", async () => {
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
    const adapter = new MemoryAdapter([]);
    await readFleetBlockages(adapter, "36ee78b1-d817-4a29-b631-c93945404c7b", null, "default");

    expect(adapter.orchestrationParams).toEqual(["36ee78b1-d817-4a29-b631-c93945404c7b", "default"]);
  });
});
