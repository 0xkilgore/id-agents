import express, { type Express } from "express";
import { describe, expect, it } from "vitest";
import { migrateSqlite } from "../../src/db/migrations/sqlite.js";
import { SqliteAdapter } from "../../src/db/sqlite-adapter.js";
import { migrateOutputsTables } from "../../src/outputs/storage.js";
import { buildProjectTracksEnvelope, canonicalProjectName } from "../../src/project-tracks/read-model.js";
import { mountProjectTracksRoutes } from "../../src/project-tracks/routes.js";

const TEAM = "team_project_tracks";
const NOW = "2026-06-28T12:00:00.000Z";

async function seedBase(adapter: SqliteAdapter): Promise<void> {
  await migrateSqlite(adapter);
  await migrateOutputsTables(adapter);
  await adapter.query(`INSERT INTO teams (id, name) VALUES ($1, $2)`, [TEAM, "project-tracks"]);
  await adapter.query(
    `INSERT INTO agents
       (id, team_id, name, type, model, port, endpoint, working_directory, status, created_at, registry, metadata)
     VALUES
       ($1,$2,$3,'worker','test',0,NULL,$4,'running',1782690000,NULL,NULL),
       ($5,$6,$7,'worker','test',0,NULL,$8,'running',1782690000,NULL,NULL)`,
    [
      "agent_maestra",
      TEAM,
      "maestra",
      "/Users/kilgore/Dropbox/Code/agent-platform",
      "agent_roger",
      TEAM,
      "roger",
      "/Users/kilgore/Dropbox/Code/kapelle",
    ],
  );
}

async function request(app: Express, path: string): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, "127.0.0.1", async () => {
      try {
        const addr = server.address();
        if (!addr || typeof addr === "string") throw new Error("no address");
        const res = await fetch(`http://127.0.0.1:${addr.port}${path}`);
        resolve({ status: res.status, body: await res.json() });
      } catch (err) {
        reject(err);
      } finally {
        server.close();
      }
    });
  });
}

describe("project tracks read-model", () => {
  it("maps maestra to the agent-platform project and groups tasks/artifacts/dispatches/backlog by conforming tracks", async () => {
    const adapter = new SqliteAdapter(":memory:");
    await seedBase(adapter);

    await adapter.query(
      `INSERT INTO tasks
       (id, name, uuid, team_id, title, description, status, created_by, owner, created_at, updated_at, completed_at, track)
       VALUES
         ('task_1','agent-platform-task','uuid-task-1',$1,'Agent platform task',NULL,'doing','agent_maestra','agent_maestra',1782690000,1782690100,NULL,'T15')`,
      [TEAM],
    );
    // A task with no assigned track (the NOT NULL column defaults to "(unassigned)")
    // → counts as unassigned, distinct from an unknown/unrecognized track value.
    await adapter.query(
      `INSERT INTO tasks
       (id, name, uuid, team_id, title, description, status, created_by, owner, created_at, updated_at, completed_at, track)
       VALUES
         ('task_2','agent-platform-untracked','uuid-task-2',$1,'Untracked task',NULL,'todo','agent_maestra','agent_maestra',1782690000,1782690100,NULL,'(unassigned)')`,
      [TEAM],
    );
    await adapter.query(
      `INSERT INTO artifacts
       (artifact_id, basename, agent, tag, abs_path, title, produced_at, source, availability, created_at, updated_at)
       VALUES
         ('art_1','qa.md','maestra','qa','/Users/kilgore/Dropbox/Code/agent-platform/output/qa.md','[T-CKPT] QA handoff',$1,'test','present',$2,$3)`,
      [NOW, NOW, NOW],
    );
    await adapter.query(
      `INSERT INTO dispatch_scheduler_queue
         (dispatch_phid, team_id, query_id, to_agent, from_actor, channel, subject, body_markdown, provider, runtime,
          priority, status, not_before_at, updated_at)
       VALUES
         ('phid:disp-pt-1',$1,'query_pt_1','agent_maestra','manager','dispatch',
          '[project: maestra][T-ORCH.2] Build track view','body','openai','codex',5,'queued',$2,$2)`,
      [TEAM, NOW, NOW],
    );
    await adapter.query(
      `INSERT INTO orchestration_backlog_item
         (item_id, team_id, logical_key, title, track, to_agent, dispatch_body, priority, readiness_state, risk_class,
          write_scope_json, dependencies_json, is_north_star, source_refs_json, last_dispatch_phid, track_drift,
          created_at, updated_at)
       VALUES
         ('coitem_1',$1,'lk-1','Backlog checkpoint','T-NOPE','agent_maestra',NULL,5,'blocked_dependency','routine',
          '[]','[]',0,'[]','phid:disp-pt-1',1,$2,$3)`,
      [TEAM, NOW, NOW],
    );

    const envelope = await buildProjectTracksEnvelope(adapter, {
      project: "agent-platform",
      generatedAt: NOW,
    });

    expect(canonicalProjectName("maestra")).toBe("agent-platform");
    expect(envelope.project.aliases).toContain("maestra");
    expect(envelope.empty).toBe(false);
    expect(envelope.tracks.map((t) => t.track)).toEqual(expect.arrayContaining(["T15", "T-CKPT", "T-ORCH.2", "T-NOPE"]));
    expect(envelope.tracks.find((t) => t.track === "T15")?.canonical_track).toBe("T-CKPT");
    expect(envelope.tracks.find((t) => t.track === "T15")?.tasks[0].owner).toBe("maestra");
    expect(envelope.tracks.find((t) => t.track === "T-ORCH.2")?.dispatches[0].dispatch_phid).toBe("phid:disp-pt-1");
    expect(envelope.tracks.find((t) => t.track === "T-NOPE")?.drift).toBe(true);
    expect(envelope.tracks.find((t) => t.track === "T-NOPE")?.blockers[0]).toMatchObject({
      kind: "backlog_item",
      id: "coitem_1",
      status: "blocked_dependency",
    });
    expect(envelope.drift.drift_count).toBe(1);
    // Conformance breakdown: T-NOPE is an assigned-but-unrecognized (unknown)
    // track; task_2 has no track (unassigned). These are reported separately.
    expect(envelope.drift.unknown_count).toBe(1);
    expect(envelope.drift.unassigned_count).toBe(1);
    expect(envelope.tracks.find((t) => t.track === "(unassigned)")?.tasks[0].id).toBe("task_2");

    await adapter.close();
  });

  it("serves an empty project-tracks envelope for projects with no associations", async () => {
    const adapter = new SqliteAdapter(":memory:");
    await seedBase(adapter);
    const app = express();
    mountProjectTracksRoutes(app, adapter);

    const res = await request(app, "/projects/no-such-project/tracks");

    expect(res.status).toBe(200);
    expect(res.body.schema_version).toBe("project-tracks.v1");
    expect(res.body.empty).toBe(true);
    expect(res.body.tracks).toEqual([]);
    expect(res.body.drift.total_associations).toBe(0);
    expect(res.body.drift.conforming_share).toBe(1);
    expect(res.body.drift.unassigned_count).toBe(0);
    expect(res.body.drift.unknown_count).toBe(0);

    await adapter.close();
  });
});
