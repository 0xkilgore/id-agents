import express, { type Express } from "express";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { migrateSqlite } from "../../src/db/migrations/sqlite.js";
import { SqliteAdapter } from "../../src/db/sqlite-adapter.js";
import { loadLocalSearchDocuments } from "../../src/local-search/db-documents.js";
import { artifactIdFromPath, migrateOutputsTables } from "../../src/outputs/storage.js";
import { buildProjectTracksEnvelope, canonicalProjectName } from "../../src/project-tracks/read-model.js";
import { mountProjectTracksRoutes } from "../../src/project-tracks/routes.js";
import { buildProjectSourcesEnvelope } from "../../src/project-tracks/sources-read-model.js";

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
    expect(envelope.conformance_quarantine).toMatchObject({
      policy: "quarantine_non_conforming_track_records",
      total: 2,
      unknown_count: 1,
      unassigned_count: 1,
    });
    expect(envelope.conformance_quarantine.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "task",
          id: "task_2",
          owner: "maestra",
          raw_track: "(unassigned)",
          reason: "missing_track",
          next_action: "assign_canonical_track",
        }),
        expect.objectContaining({
          kind: "backlog_item",
          id: "coitem_1",
          owner: "maestra",
          raw_track: "T-NOPE",
          reason: "unknown_track",
          next_action: "register_or_alias_track",
        }),
      ]),
    );

    // Status tracker per-row data: live status_counts, owner lanes, activity ts.
    // Rows are keyed by RAW track string: T15 (task_1) and T-CKPT (art_1) are separate.
    const t15 = envelope.tracks.find((t) => t.track === "T15")!; // task_1 status "doing"
    expect(t15.status_counts.building).toBe(1);
    expect(t15.owner_lanes).toContain("maestra");
    expect(t15.latest_activity_at).not.toBeNull();
    const ckptArtifact = envelope.tracks.find((t) => t.track === "T-CKPT")!; // art_1
    expect(ckptArtifact.status_counts.landed).toBe(1); // produced artifact = landed
    const unassigned = envelope.tracks.find((t) => t.track === "(unassigned)")!;
    expect(unassigned.status_counts.queued).toBe(1); // task_2 status "todo"
    const nope = envelope.tracks.find((t) => t.track === "T-NOPE")!;
    expect(nope.status_counts.held).toBe(1); // coitem_1 readiness "blocked_dependency"
    const orch = envelope.tracks.find((t) => t.track === "T-ORCH.2")!;
    expect(orch.status_counts.queued).toBe(1); // disp-pt-1 status "queued"

    // Honesty bar: the refactor-debt ledger is not a real source here → declared
    // unavailable, never faked.
    expect(envelope.sources.refactor_debt_ledger).toBe("unavailable");
    expect(envelope.sources.spec054_landed).toBe("derived");
    expect(envelope.sources.orchestration_backlog).toBe("available");
    expect(envelope.sources.notes.some((n) => /refactor_debt_ledger unavailable/.test(n))).toBe(true);

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
    expect(res.body.conformance_quarantine).toMatchObject({
      policy: "quarantine_non_conforming_track_records",
      total: 0,
      unassigned_count: 0,
      unknown_count: 0,
      items: [],
    });
    // Honest-unavailable case surfaces even on an empty project (never faked).
    expect(res.body.sources.refactor_debt_ledger).toBe("unavailable");

    await adapter.close();
  });

  it("serves project detail and adjacent project detail from prefetch cache", async () => {
    const adapter = new SqliteAdapter(":memory:");
    await seedBase(adapter);
    await adapter.query(`INSERT INTO teams (id, name) VALUES ($1, $2), ($3, $4)`, [
      "team_alpha",
      "alpha",
      "team_zulu",
      "zulu",
    ]);

    let teamListQueries = 0;
    const originalQuery = adapter.query.bind(adapter);
    adapter.query = (async (...args: Parameters<typeof originalQuery>) => {
      if (typeof args[0] === "string" && /\bFROM teams\b/i.test(args[0])) teamListQueries += 1;
      return originalQuery(...args);
    }) as typeof adapter.query;

    const app = express();
    mountProjectTracksRoutes(app, adapter);

    try {
      const first = await request(app, "/projects/project-tracks/detail");
      expect(first.status).toBe(200);
      expect(first.body).toMatchObject({
        ok: true,
        schema_version: "project.detail.v1",
        project: { canonical: "project-tracks" },
        metadata: { source: "local_project_index" },
        body: { kind: "project_tracks" },
      });
      expect(first.body.version_key).toMatch(/^project:[a-f0-9]{24}$/);
      expect(first.body.body.text).toContain("Project: project-tracks");
      expect(first.body.comments).toEqual([]);
      expect(first.body.timeline).toEqual([]);
      expect(first.body.adjacent_prefetch.previous.name).toBe("alpha");
      expect(first.body.adjacent_prefetch.next.name).toBe("zulu");
      expect(teamListQueries).toBe(1);

      const second = await request(app, "/projects/zulu/detail");
      expect(second.status).toBe(200);
      expect(second.body.project.canonical).toBe("zulu");
      expect(second.body.adjacent_prefetch.previous.name).toBe("project-tracks");
      expect(teamListQueries).toBe(1);
    } finally {
      adapter.query = originalQuery as typeof adapter.query;
      await adapter.close();
    }
  });

  it("indexes Cleveland Park source rows from deterministic project roots and exposes them to local search", async () => {
    const adapter = new SqliteAdapter(":memory:");
    const tmp = mkdtempSync(path.join(os.tmpdir(), "id-agents-cleveland-park-"));
    const root = path.join(tmp, "Dropbox", "Code", "cleveland-park");
    try {
      await seedBase(adapter);
      mkdirSync(path.join(root, "meetings"), { recursive: true });
      mkdirSync(path.join(root, "forms"), { recursive: true });
      mkdirSync(path.join(root, "images"), { recursive: true });
      mkdirSync(path.join(root, "newsletters"), { recursive: true });
      mkdirSync(path.join(root, "output"), { recursive: true });
      mkdirSync(path.join(root, "source"), { recursive: true });
      writeFileSync(path.join(root, "meetings", "neighborhood-parks-transcript.md"), "Neighborhood Parks transcript\n");
      writeFileSync(path.join(root, "forms", "park-permit-form.pdf"), "%PDF-1.4\n");
      writeFileSync(path.join(root, "images", "cleveland-park-logo.png"), "png");
      writeFileSync(path.join(root, "newsletters", "july-newsletter-source.md"), "Newsletter source copy\n");
      writeFileSync(path.join(root, "source", "vendor-list.csv"), "name\n");
      const artifactPath = path.join(root, "output", "agent-artifact-report.md");
      const finalDocumentPath = path.join(root, "output", "cleveland-park-final-document.md");
      const transcriptArtifactPath = path.join(root, "output", "cleveland-park-launch-transcript.md");
      const screenshotArtifactPath = path.join(root, "output", "screenshots", "cleveland-park-homepage-final.png");
      writeFileSync(artifactPath, "# Agent artifact report\n");
      mkdirSync(path.dirname(screenshotArtifactPath), { recursive: true });
      writeFileSync(finalDocumentPath, "# Cleveland Park final document\n");
      writeFileSync(transcriptArtifactPath, "Cleveland Park launch transcript\n");
      writeFileSync(screenshotArtifactPath, "png");

      await adapter.query(`INSERT INTO teams (id, name) VALUES ($1, $2)`, ["team_cleveland", "cleveland-park"]);
      await adapter.query(
        `INSERT INTO agents
           (id, team_id, name, type, model, port, endpoint, working_directory, status, created_at, registry, metadata)
         VALUES
           ('agent_cp','team_cleveland','cleveland-park','worker','test',0,NULL,$1,'running',1782690000,NULL,NULL)`,
        [root],
      );
      await adapter.query(
        `INSERT INTO dispatch_scheduler_queue
           (dispatch_phid, team_id, query_id, to_agent, from_actor, channel, subject, body_markdown, provider, runtime,
            priority, status, not_before_at, updated_at, completed_at, agent_query_id, artifact_path, result_json)
         VALUES
           ('phid:disp-cp','team_cleveland','query_cp_dispatch','agent_cp','manager','dispatch',
            '[project: cleveland-park][T-LOCALREAD] Cleveland Park source lane','discover Parks transcripts and forms',
            'openai','codex',5,'done',$1,$2,$3,'query_cp_agent',$4,$5)`,
        [NOW, NOW, NOW, artifactPath, JSON.stringify({ artifact_path: artifactPath })],
      );
      await adapter.query(
        `INSERT INTO queries
           (team_id, agent_id, query_id, status, prompt, created, completed, result, error, session_id, owner_kind, owner_id, manager_dispatch_id, manager_query_id)
         VALUES
           ('team_cleveland','agent_cp','query_cp_agent','completed','Neighborhood Parks transcript capture',1782690000,1782690100,'ok',NULL,NULL,'agent','agent_cp','phid:disp-cp','query_cp_dispatch')`,
      );
      await adapter.query(
        `INSERT INTO artifacts
           (artifact_id, basename, agent, tag, abs_path, title, produced_at, source, availability, media_type,
            source_mtime, source_size, project_ref, dispatch_ref, created_at, updated_at)
         VALUES
           ('legacy_cp_report','agent-artifact-report.md','cleveland-park','[T-LOCALREAD] artifact report',$1,
            'Cleveland Park agent artifact report',$2,'test','present','text/markdown',$3,1024,'cleveland-park','phid:disp-cp',$4,$5),
           ('legacy_cp_final','cleveland-park-final-document.md','cleveland-park','final-document',$6,
            'Cleveland Park final document',$7,'test','present','text/markdown',$8,2048,'cleveland-park','phid:disp-cp',$9,$10),
           ('legacy_cp_transcript','cleveland-park-launch-transcript.md','cleveland-park','transcript',$11,
            'Cleveland Park launch transcript',$12,'test','present','text/markdown',$13,2048,'cleveland-park','phid:disp-cp',$14,$15),
           ('legacy_cp_screenshot','cleveland-park-homepage-final.png','cleveland-park','screenshot',$16,
            'Cleveland Park homepage final screenshot',$17,'test','present','image/png',$18,2048,'cleveland-park','phid:disp-cp',$19,$20)`,
        [
          artifactPath, NOW, NOW, NOW, NOW,
          finalDocumentPath, NOW, NOW, NOW, NOW,
          transcriptArtifactPath, NOW, NOW, NOW, NOW,
          screenshotArtifactPath, NOW, NOW, NOW, NOW,
        ],
      );
      await adapter.query(
        `INSERT INTO artifact_review_state
           (artifact_id, first_viewed_at, last_viewed_at, viewed_count, created_at, updated_at)
         VALUES
           ('legacy_cp_report',NULL,NULL,0,$1,$2),
           ('legacy_cp_final',NULL,NULL,0,$1,$2),
           ('legacy_cp_transcript',NULL,NULL,0,$1,$2),
           ('legacy_cp_screenshot',NULL,NULL,0,$1,$2)`,
        [NOW, NOW, NOW, NOW, NOW, NOW, NOW, NOW],
      );
      const stableArtifactId = artifactIdFromPath(artifactPath);
      const stableFinalId = artifactIdFromPath(finalDocumentPath);
      const stableTranscriptId = artifactIdFromPath(transcriptArtifactPath);
      const stableScreenshotId = artifactIdFromPath(screenshotArtifactPath);

      const envelope = await buildProjectSourcesEnvelope(adapter, {
        project: "cleveland-park",
        generatedAt: NOW,
        limit: 50,
      });
      const byTitle = new Map(envelope.rows.map((row) => [row.title, row]));

      expect(envelope.schema_version).toBe("project-sources.v1");
      expect(envelope.saved_view.filters).toEqual(["type", "project", "agent", "date", "read_state", "status", "q"]);
      expect(envelope.roots).toEqual([
        expect.objectContaining({
          project: "cleveland-park",
          root_path: root,
          owner_agent: "cleveland-park",
          proof: "agent.working_directory",
        }),
      ]);
      expect(envelope.groups.transcripts).toBeGreaterThanOrEqual(2);
      expect(envelope.groups.pdfs_forms).toBeGreaterThanOrEqual(1);
      expect(envelope.groups.images_screenshots_logos).toBeGreaterThanOrEqual(2);
      expect(envelope.groups.emails_captures).toBeGreaterThanOrEqual(1);
      expect(envelope.groups.artifacts_reports).toBeGreaterThanOrEqual(1);
      expect(envelope.groups.other_files).toBeGreaterThanOrEqual(1);
      expect(byTitle.get("Cleveland Park agent artifact report")).toMatchObject({
        id: `artifact:${stableArtifactId}`,
        source: { kind: "artifact_catalog", path: artifactPath, proof: "artifacts.abs_path" },
        ownership: { project: "cleveland-park", agent: "cleveland-park" },
        links: { dispatch_id: "phid:disp-cp", artifact_id: stableArtifactId },
        open: { href: `/artifacts/${stableArtifactId}` },
        preview: { renderable: true, state: "inline" },
        read: { state: "unread" },
        freshness: { status: "fresh" },
      });
      for (const [title, stableId] of [
        ["Cleveland Park final document", stableFinalId],
        ["Cleveland Park launch transcript", stableTranscriptId],
        ["Cleveland Park homepage final screenshot", stableScreenshotId],
      ] as const) {
        expect(byTitle.get(title)).toMatchObject({
          id: `artifact:${stableId}`,
          links: { dispatch_id: "phid:disp-cp", artifact_id: stableId, query_id: null },
          open: { href: `/artifacts/${stableId}`, fallback: "artifact" },
          source: { kind: "artifact_catalog" },
        });
        expect(byTitle.get(title)?.id).not.toContain(finalDocumentPath);
        expect(byTitle.get(title)?.open.href).not.toContain("query_cp_agent");
      }
      expect(byTitle.get("Neighborhood Parks transcript capture")).toMatchObject({
        group: "transcripts",
        links: { dispatch_id: "phid:disp-cp", query_id: "query_cp_agent" },
      });
      expect(byTitle.get("park permit form")).toMatchObject({ group: "pdfs_forms", preview: { renderable: true } });
      expect(byTitle.get("cleveland park logo")).toMatchObject({ group: "images_screenshots_logos", preview: { renderable: true } });
      expect(byTitle.get("Cleveland Park homepage final screenshot")).toMatchObject({
        group: "images_screenshots_logos",
        source: { path: screenshotArtifactPath },
        preview: { renderable: true, state: "inline", media_type: "image/png" },
      });
      expect(byTitle.get("july newsletter source")).toMatchObject({ group: "emails_captures" });
      expect(byTitle.get("vendor list")).toMatchObject({ group: "other_files" });

      const filtered = await buildProjectSourcesEnvelope(adapter, { project: "cleveland-park", q: "Parks", type: "transcripts" });
      expect(filtered.rows.map((row) => row.title)).toEqual(expect.arrayContaining([
        "Neighborhood Parks transcript capture",
        "neighborhood parks transcript",
      ]));

      const app = express();
      mountProjectTracksRoutes(app, adapter);
      const route = await request(app, "/projects/cleveland-park/sources?q=homepage&type=images_screenshots_logos");
      expect(route.status).toBe(200);
      expect(route.body).toMatchObject({
        schema_version: "project-sources.v1",
        filters: { q: "homepage", type: "images_screenshots_logos", project: "cleveland-park" },
      });
      expect(route.body.rows.map((row: any) => row.title)).toEqual(["Cleveland Park homepage final screenshot"]);

      const searchDocs = await loadLocalSearchDocuments(adapter);
      const sourceHit = searchDocs.find((doc) => doc.entityType === "source" && doc.title === "Cleveland Park agent artifact report");
      expect(sourceHit).toMatchObject({
        project: "cleveland-park",
        agent: "cleveland-park",
        status: "fresh",
        readState: "unread",
        routeMetadata: {
          sourceType: "artifact",
          sourcePath: artifactPath,
          sourceProof: "artifacts.abs_path",
          linkedArtifact: stableArtifactId,
          linkedDispatch: "phid:disp-cp",
          bodyAvailable: true,
        },
      });
    } finally {
      await adapter.close();
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
