import { afterEach, describe, expect, it } from "vitest";

import {
  readAgentObligations,
  rowToAgentObligation,
} from "../../src/agent-obligations/read-model.js";
import { migrateSqlite } from "../../src/db/migrations/sqlite.js";
import { SqliteAdapter } from "../../src/db/sqlite-adapter.js";
import { SqliteTeamsRepo } from "../../src/db/repos/sqlite/teams-repo.js";
import { migrateLoopsTables, seedLoopsFromRegistry } from "../../src/loops/storage.js";

let adapter: SqliteAdapter | null = null;

afterEach(async () => {
  await adapter?.close();
  adapter = null;
});

describe("agent obligations read model", () => {
  it("keys dispatch obligations by source record plus obligation type and exposes stale escalation", () => {
    const obligation = rowToAgentObligation(
      {
        dispatch_phid: "phid:disp-closeout-1",
        query_id: "query_closeout_1",
        to_agent: "substrate-orch-codex",
        from_actor: "continuous-orchestration",
        channel: "talk",
        subject: "Build dispatch closeout",
        body_markdown: "Promote on green.",
        status: "in_flight",
        not_before_at: "2026-07-08T10:00:00.000Z",
        started_at: "2026-07-08T10:05:00.000Z",
        completed_at: null,
        updated_at: "2026-07-08T10:05:00.000Z",
        failure_kind: null,
        failure_detail: null,
      },
      { now: "2026-07-08T10:40:00.000Z", staleAfterMs: 30 * 60 * 1000 },
    );

    expect(obligation).toMatchObject({
      obligation_id: "agent-obligation:phid:disp-closeout-1:closeout",
      source_kind: "closeout",
      obligation_type: "closeout",
      source_record: "phid:disp-closeout-1",
      source_ref: "query_closeout_1",
      status: "late",
      stale_after: "2026-07-08T10:35:00.000Z",
      due_at: "2026-07-08T10:35:00.000Z",
      is_stale: true,
      stale_seconds: 300,
      escalation_level: "stale",
      escalates_at: "2026-07-08T10:35:00.000Z",
    });
  });

  it("folds report ownership obligations into the same ledger by default", async () => {
    adapter = new SqliteAdapter(":memory:");
    await migrateSqlite(adapter);
    await migrateLoopsTables(adapter);
    await seedLoopsFromRegistry(adapter, "2026-07-10T18:00:00.000Z");
    const teams = new SqliteTeamsRepo(adapter);
    const teamId = await teams.getOrCreateTeamId("report-obligations-unit");

    const envelope = await readAgentObligations(adapter, teamId, {
      agent: "maestra",
      now: "2026-07-10T18:00:00.000Z",
      limit: 50,
    });

    const report = envelope.obligations.find((o) => o.obligation_type === "report");
    expect(report).toBeTruthy();
    expect(report).toMatchObject({
      source_kind: "report",
      obligation_type: "report",
      agent: "maestra",
      owner: "maestra",
    });
    expect(report!.obligation_id).toBe(`agent-obligation:${report!.source_record}:report`);
    expect(report!.source_record).toContain(":2026-");
    expect(["expected", "late", "failed", "done"]).toContain(report!.status);
  });
});
