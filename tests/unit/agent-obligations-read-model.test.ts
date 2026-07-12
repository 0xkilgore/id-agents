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
      close_signal: null,
      close_signal_ref: null,
    });
  });

  it("derives open, stale, and closed obligations from task ownership and comment receipts", async () => {
    adapter = new SqliteAdapter(":memory:");
    await migrateSqlite(adapter);
    const teams = new SqliteTeamsRepo(adapter);
    const teamId = await teams.getOrCreateTeamId("owed-back-obligations-unit");

    await adapter.query(
      `INSERT INTO agents (id, team_id, name, type, model, port, status, created_at, runtime)
       VALUES (?, ?, ?, 'assistant', 'test', 0, 'idle', ?, 'codex')`,
      ["agent-roger", teamId, "roger", Date.parse("2026-07-10T12:00:00.000Z")],
    );

    await adapter.query(
      `INSERT INTO tasks (id, name, uuid, team_id, title, status, owner, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        "task-open-id",
        "task-open",
        "uuid-task-open",
        teamId,
        "Open owed task",
        "doing",
        "agent-roger",
        Date.parse("2026-07-10T12:00:00.000Z"),
        Date.parse("2026-07-10T12:40:00.000Z"),
      ],
    );
    await adapter.query(
      `INSERT INTO tasks (id, name, uuid, team_id, title, status, owner, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        "task-stale-id",
        "task-stale",
        "uuid-task-stale",
        teamId,
        "Stale owed task",
        "doing",
        "agent-roger",
        Date.parse("2026-07-10T11:00:00.000Z"),
        Date.parse("2026-07-10T11:00:00.000Z"),
      ],
    );
    await adapter.query(
      `INSERT INTO tasks (id, name, uuid, team_id, title, status, owner, created_at, updated_at, completed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        "task-closed-id",
        "task-closed",
        "uuid-task-closed",
        teamId,
        "Closed owed task",
        "done",
        "agent-roger",
        Date.parse("2026-07-10T11:00:00.000Z"),
        Date.parse("2026-07-10T12:05:00.000Z"),
        Date.parse("2026-07-10T12:05:00.000Z"),
      ],
    );

    await adapter.query(
      `INSERT INTO artifact_operations (artifact_id, op_type, actor, ts, payload_json, source_link)
       VALUES (?, 'comment_recorded', ?, ?, ?, ?)`,
      [
        "artifact-1",
        "user:chris",
        "2026-07-10T12:10:00.000Z",
        JSON.stringify({
          body: "please follow up",
          route_status: {
            visible_state: "recorded+routed",
            retryable: false,
            target_agent: "roger",
            dispatch: { dispatch_phid: "phid:disp-comment", query_id: "query-comment", to_agent: "roger" },
            deadline_at: "2026-07-10T12:15:00.000Z",
            updated_at: "2026-07-10T12:10:05.000Z",
          },
        }),
        "artifact:artifact-1",
      ],
    );

    const envelope = await readAgentObligations(adapter, teamId, {
      agent: "roger",
      includeReports: false,
      now: "2026-07-10T12:45:00.000Z",
      limit: 20,
    });

    const byId = new Map(envelope.obligations.map((o) => [o.obligation_id, o]));
    expect(byId.get("agent-obligation:task-open:task")).toMatchObject({
      source_kind: "task",
      status: "expected",
      stale_after: "2026-07-10T13:10:00.000Z",
      close_signal: null,
    });
    expect(byId.get("agent-obligation:task-stale:task")).toMatchObject({
      source_kind: "task",
      status: "late",
      stale_after: "2026-07-10T11:30:00.000Z",
      escalation_level: "stale",
    });
    expect(byId.get("agent-obligation:task-closed:task")).toMatchObject({
      source_kind: "task",
      status: "done",
      close_signal: "done",
      close_signal_ref: "task-closed",
    });
    expect(byId.get("agent-obligation:artifact-comment:artifact-1:1:comment")).toMatchObject({
      source_kind: "comment",
      status: "done",
      close_signal: "receipt",
      close_signal_ref: "phid:disp-comment",
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
    expect(["receipt", "done", null]).toContain(report!.close_signal);
    expect(["expected", "late", "failed", "done"]).toContain(report!.status);
  });
});
