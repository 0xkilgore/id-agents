import { describe, expect, it } from "vitest";
import { migrateSqlite } from "../../src/db/migrations/sqlite.js";
import { SqliteAdapter } from "../../src/db/sqlite-adapter.js";
import { migrateOutputsTables } from "../../src/outputs/storage.js";
import { buildResetConformanceSummary } from "../../src/conformance/reset.js";
import {
  buildTaskRow,
  draftFromManagerApi,
  normalizeTaskCreateTrack,
  normalizeTaskDescriptionNextAction,
} from "../../src/tasks-readmodel/task-draft.js";

const TEAM = "team_reset_conformance";
const NOW = "2026-07-08T12:00:00.000Z";

async function seedBase(adapter: SqliteAdapter): Promise<void> {
  await migrateSqlite(adapter);
  await migrateOutputsTables(adapter);
  await adapter.query(`INSERT INTO teams (id, name) VALUES ($1, $2)`, [TEAM, "kapelle"]);
  await adapter.query(
    `INSERT INTO agents
       (id, team_id, name, type, model, port, endpoint, working_directory, status, created_at, registry, metadata)
     VALUES
       ('agent_api',?,'substrate-api-codex','worker','test',0,NULL,'/Users/kilgore/Dropbox/Code/kapelle','running',1783520000,NULL,NULL),
       ('agent_ui',?,'frontend-ui-codex','worker','test',0,NULL,'/Users/kilgore/Dropbox/Code/kapelle','running',1783520000,NULL,NULL)`,
    [TEAM, TEAM],
  );
}

describe("reset conformance quarantine", () => {
  it("classifies task, dispatch, artifact, and report records with deterministic missing-field rules", async () => {
    const adapter = new SqliteAdapter(":memory:");
    await seedBase(adapter);

    await adapter.query(
      `INSERT INTO tasks
       (id, name, uuid, team_id, title, description, status, created_by, owner, created_at, updated_at, completed_at, track)
       VALUES
         ('task_good','good-task','uuid-good',?,'Good task','Next action: promote on green','doing','agent_api','agent_api',1783520000,1783520010,NULL,'T-OPRESET'),
         ('task_bad','bad-task','uuid-bad',?,'Bad task',NULL,'todo','agent_api',NULL,1783520000,1783520010,NULL,'(unassigned)')`,
      [TEAM, TEAM],
    );

    await adapter.query(
      `INSERT INTO dispatch_scheduler_queue
         (dispatch_phid, team_id, query_id, to_agent, from_actor, channel, subject, body_markdown, provider, runtime,
          priority, status, not_before_at, updated_at)
       VALUES
         ('phid:disp-good',?,'query_good','agent_api','manager','dispatch',
          '[project: kapelle][T-OPRESET] Reset conformance','Next action: verify quarantine counts','openai','codex',5,'queued',?,?),
         ('phid:disp-bad',?,'query_bad','agent_ui','manager','dispatch',
          'Missing metadata','plain body','openai','codex',5,'queued',?,?)`,
      [TEAM, NOW, NOW, TEAM, NOW, NOW],
    );

    await adapter.query(
      `INSERT INTO artifacts
       (artifact_id, basename, agent, tag, abs_path, title, produced_at, source, availability, created_at, updated_at)
       VALUES
         ('art_good','closeout.md','substrate-api-codex','[T-OPRESET]','/Users/kilgore/Dropbox/Code/kapelle/output/closeout.md','Next action: review closeout',?,'test','present',?,?),
         ('report_bad','weekly-report.md','substrate-api-codex','[T-NOPE]','/Users/kilgore/Dropbox/Code/kapelle/output/reports/weekly-report.md','Weekly report',?,'test','present',?,?)`,
      [NOW, NOW, NOW, NOW, NOW, NOW],
    );

    const summary = await buildResetConformanceSummary(adapter, {
      teamId: TEAM,
      generatedAt: NOW,
    });

    expect(summary.schema_version).toBe("reset-conformance.v1");
    expect(summary.state).toBe("quarantined");
    expect(summary.counts.by_kind.task).toEqual({ total: 2, quarantined: 1 });
    expect(summary.counts.by_kind.dispatch).toEqual({ total: 2, quarantined: 1 });
    expect(summary.counts.by_kind.artifact).toEqual({ total: 1, quarantined: 0 });
    expect(summary.counts.by_kind.report).toEqual({ total: 1, quarantined: 1 });
    expect(summary.counts.unassigned).toBe(2);
    expect(summary.counts.track_unknown).toBe(1);

    const task = summary.records.find((r) => r.kind === "task" && r.id === "task_bad");
    expect(task?.missing).toEqual(expect.arrayContaining(["track", "owner", "next_action"]));
    expect(task?.missing).not.toEqual(expect.arrayContaining(["audience", "kind", "project", "source"]));
    expect(task).toMatchObject({
      audience: "operator",
      metadata_kind: "task",
      project: "kapelle",
      source: "bad-task",
    });
    expect(task?.track_state).toBe("unassigned");

    const dispatch = summary.records.find((r) => r.kind === "dispatch" && r.id === "phid:disp-bad");
    expect(dispatch?.missing).toEqual(expect.arrayContaining(["track"]));
    expect(dispatch?.missing).not.toEqual(expect.arrayContaining(["audience", "kind", "project", "source"]));
    expect(dispatch).toMatchObject({
      audience: "operator",
      metadata_kind: "dispatch",
      project: "kapelle",
      source: "query_bad",
    });

    const report = summary.records.find((r) => r.kind === "report" && r.id === "report_bad");
    expect(report?.track_state).toBe("unknown");
    expect(report?.missing).toContain("track");
    expect(report?.missing).not.toEqual(expect.arrayContaining(["audience", "kind", "project", "source"]));
    expect(report).toMatchObject({
      audience: "operator",
      metadata_kind: "report",
      project: "kapelle",
      source: "/Users/kilgore/Dropbox/Code/kapelle/output/reports/weekly-report.md",
    });

    await adapter.close();
  });

  it("accepts a task row produced by the POST /tasks metadata normalizer", async () => {
    const adapter = new SqliteAdapter(":memory:");
    await seedBase(adapter);

    const row = buildTaskRow(
      draftFromManagerApi({
        name: "reset-conformance-new-task",
        team_id: TEAM,
        title: "Reset conformance new task",
        description: normalizeTaskDescriptionNextAction({
          description: null,
          title: "Reset conformance new task",
        }),
        created_by: "agent_api",
        owner: "agent_api",
        track: normalizeTaskCreateTrack({ title: "Reset conformance new task" }),
      }),
      { nowMs: 1_783_520_000_000, id: "task_from_post", uuid: "uuid-from-post" },
    );

    await adapter.query(
      `INSERT INTO tasks
       (id, name, uuid, team_id, title, description, status, created_by, owner, created_at, updated_at, completed_at, track)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row.id,
        row.name,
        row.uuid,
        row.team_id,
        row.title,
        row.description,
        row.status,
        row.created_by,
        row.owner,
        row.created_at,
        row.updated_at,
        row.completed_at,
        row.track,
      ],
    );

    const summary = await buildResetConformanceSummary(adapter, {
      teamId: TEAM,
      generatedAt: NOW,
    });

    expect(summary.counts.by_kind.task).toEqual({ total: 1, quarantined: 0 });
    expect(summary.records.find((r) => r.id === row.id)).toBeUndefined();

    await adapter.close();
  });

  it("quarantines direct task writes that bypass the next_action repair while preserving repaired substrate metadata", async () => {
    const adapter = new SqliteAdapter(":memory:");
    await seedBase(adapter);

    await adapter.query(
      `INSERT INTO tasks
       (id, name, uuid, team_id, title, description, status, created_by, owner, created_at, updated_at, completed_at, track)
       VALUES
         ('task_direct_missing_action','direct-missing-action','uuid-direct',?,'Direct missing action',NULL,'todo','agent_api','agent_api',1783520000,1783520010,NULL,'T-OPRESET')`,
      [TEAM],
    );

    const summary = await buildResetConformanceSummary(adapter, {
      teamId: TEAM,
      generatedAt: NOW,
    });

    expect(summary.counts.by_kind.task).toEqual({ total: 1, quarantined: 1 });
    const task = summary.records.find((r) => r.id === "task_direct_missing_action");
    expect(task?.missing).toEqual(["next_action"]);
    expect(task).toMatchObject({
      audience: "operator",
      metadata_kind: "task",
      project: "kapelle",
      source: "direct-missing-action",
      track: "T-OPRESET",
    });

    await adapter.close();
  });

  it("falls back to the originating dispatch's track tag when an artifact's own tag/title/basename carry none", async () => {
    const adapter = new SqliteAdapter(":memory:");
    await seedBase(adapter);

    await adapter.query(
      `INSERT INTO dispatch_scheduler_queue
         (dispatch_phid, team_id, query_id, to_agent, from_actor, channel, subject, body_markdown, provider, runtime,
          priority, status, not_before_at, updated_at)
       VALUES
         ('phid:disp-source',?,'query_source','agent_api','manager','dispatch',
          '[project: kapelle][T-OPRESET] Untagged artifact producer','plain body','openai','codex',5,'queued',?,?)`,
      [TEAM, NOW, NOW],
    );

    await adapter.query(
      `INSERT INTO artifacts
       (artifact_id, basename, agent, tag, abs_path, title, produced_at, source, availability, dispatch_ref, created_at, updated_at)
       VALUES
         ('art_untagged','receipt.md','substrate-api-codex',NULL,'/Users/kilgore/Dropbox/Code/kapelle/output/receipt.md','Next action: none',?,'test','present','phid:disp-source',?,?)`,
      [NOW, NOW, NOW],
    );

    const summary = await buildResetConformanceSummary(adapter, {
      teamId: TEAM,
      generatedAt: NOW,
    });

    const artifact = summary.records.find((r) => r.kind === "artifact" && r.id === "art_untagged");
    expect(artifact).toBeUndefined();

    await adapter.close();
  });
});
