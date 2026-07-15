import express, { type Express } from "express";
import { describe, expect, it } from "vitest";
import type { DbAdapter, QueryResult } from "../../src/db/db-adapter.js";
import { migrateSqlite } from "../../src/db/migrations/sqlite.js";
import { SqliteEventsRepo } from "../../src/db/repos/sqlite/events-repo.js";
import { SqliteAdapter } from "../../src/db/sqlite-adapter.js";
import { migrateOutputsTables } from "../../src/outputs/storage.js";
import { mountProjectTracksRoutes } from "../../src/project-tracks/routes.js";

const TEAM = "team_project_tracks_index_health";
const NOW = 1_782_000_000_000;

async function seedBase(adapter: SqliteAdapter): Promise<void> {
  await migrateSqlite(adapter);
  await migrateOutputsTables(adapter);
  await adapter.query(`INSERT INTO teams (id, name) VALUES ($1, $2)`, [TEAM, "project-tracks"]);
  await adapter.query(
    `INSERT INTO agents
       (id, team_id, name, type, model, port, endpoint, working_directory, status, created_at, registry, metadata)
     VALUES
       ($1,$2,$3,'worker','test',0,NULL,$4,'running',1782690000,NULL,NULL)`,
    [
      "agent_maestra",
      TEAM,
      "maestra",
      "/Users/kilgore/Dropbox/Code/agent-platform",
    ],
  );
  await adapter.query(
    `INSERT INTO tasks
       (id, name, uuid, team_id, title, description, status, created_by, owner, created_at, updated_at, completed_at, track)
     VALUES
       ('task_1','agent-platform-task','uuid-task-1',$1,'Agent platform task',NULL,'doing','agent_maestra','agent_maestra',1782690000,1782690100,NULL,'T15')`,
    [TEAM],
  );
}

async function request(
  app: Express,
  method: "GET" | "POST",
  path: string,
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, "127.0.0.1", async () => {
      try {
        const addr = server.address();
        if (!addr || typeof addr === "string") throw new Error("no address");
        const res = await fetch(`http://127.0.0.1:${addr.port}${path}`, { method });
        resolve({ status: res.status, body: await res.json() });
      } catch (err) {
        reject(err);
      } finally {
        server.close();
      }
    });
  });
}

describe("project tracks local index health", () => {
  it("marks a manager-event gap as event_gap and clears it after bounded resync", async () => {
    const adapter = new SqliteAdapter(":memory:");
    await seedBase(adapter);
    const events = new SqliteEventsRepo(adapter);
    const app = express();
    mountProjectTracksRoutes(app, adapter);

    try {
      const warm = await request(app, "GET", "/projects/project-tracks/detail");
      expect(warm.status).toBe(200);
      expect(warm.body.metadata.local_visual_state.state).toBe("current");
      expect(warm.body.metadata.local_index.state).toBe("current");

      const pruned = await events.insert({
        team_id: TEAM,
        topic: "artifact:registered",
        actor_agent_id: "agent_maestra",
        subject_kind: "artifact",
        subject_id: "artifact-pruned",
        occurred_at: NOW,
        data: { project: "project-tracks", path: "output/pruned.md" },
      });
      await adapter.query(`DELETE FROM event_log WHERE seq = ?`, [pruned.seq]);
      await events.insert({
        team_id: TEAM,
        topic: "artifact:registered",
        actor_agent_id: "agent_maestra",
        subject_kind: "artifact",
        subject_id: "artifact-kept",
        occurred_at: NOW + 1,
        data: { project: "project-tracks", path: "output/kept.md" },
      });

      const gapped = await request(app, "GET", "/projects/project-tracks/detail");
      expect(gapped.status).toBe(200);
      expect(gapped.body.metadata.local_visual_state.state).toBe("event_gap");
      expect(gapped.body.metadata.local_index).toMatchObject({
        state: "event_gap",
        event_gap: {
          expected_seq: pruned.seq,
          earliest_available_seq: pruned.seq + 1,
        },
      });

      const resynced = await request(app, "POST", "/projects/project-tracks/resync");
      expect(resynced.status).toBe(200);
      expect(resynced.body).toMatchObject({ ok: true, resync: "bounded" });
      expect(resynced.body.detail.metadata.local_visual_state.state).toBe("current");
      expect(resynced.body.detail.metadata.local_index).toMatchObject({
        state: "current",
        event_gap: null,
      });
    } finally {
      await adapter.close();
    }
  });

  it("reports source-index current, syncing, stale, event_gap, error, and bounded resync states", async () => {
    const adapter = new SqliteAdapter(":memory:");
    await seedBase(adapter);
    const events = new SqliteEventsRepo(adapter);
    let pauseArtifactCatalog = false;
    let releaseArtifactCatalog: (() => void) | null = null;
    let artifactCatalogPaused: Promise<void> | null = null;
    const delayedAdapter: DbAdapter = {
      dialect: adapter.dialect,
      query: async <T = unknown>(sql: string, params?: unknown[]): Promise<QueryResult<T>> => {
        if (pauseArtifactCatalog && /\bFROM artifacts\b/.test(sql)) {
          pauseArtifactCatalog = false;
          artifactCatalogPaused = new Promise((resolvePaused) => {
            void new Promise<void>((resolveRelease) => {
              releaseArtifactCatalog = resolveRelease;
              resolvePaused();
            });
          });
          await artifactCatalogPaused;
          await new Promise<void>((resolve) => {
            const release = releaseArtifactCatalog;
            releaseArtifactCatalog = () => {
              release?.();
              resolve();
            };
          });
        }
        return adapter.query<T>(sql, params);
      },
      close: () => adapter.close(),
    };
    const app = express();
    mountProjectTracksRoutes(app, delayedAdapter);

    try {
      const warm = await request(app, "GET", "/projects/project-tracks/sources");
      expect(warm.status).toBe(200);
      expect(warm.body.metadata).toMatchObject({
        source: "local_source_index",
        local_visual_state: { state: "current", scope: "source index" },
        source_index: { state: "current", scope: "project-tracks", event_gap: null, error: null },
      });

      await events.insert({
        team_id: TEAM,
        topic: "artifact:registered",
        actor_agent_id: "agent_maestra",
        subject_kind: "artifact",
        subject_id: "artifact-source-stale",
        occurred_at: NOW,
        data: { project: "project-tracks", path: "output/source-stale.md" },
      });

      const stale = await request(app, "GET", "/projects/project-tracks/sources");
      expect(stale.status).toBe(200);
      expect(stale.body.metadata).toMatchObject({
        local_visual_state: { state: "stale", scope: "source index" },
        source_index: { state: "stale", scope: "project-tracks", event_gap: null, error: null },
      });

      pauseArtifactCatalog = true;
      const resyncing = request(app, "POST", "/projects/project-tracks/sources/resync");
      while (!releaseArtifactCatalog) await new Promise((resolve) => setTimeout(resolve, 1));
      const syncing = await request(app, "GET", "/projects/project-tracks/sources");
      expect(syncing.status).toBe(200);
      expect(syncing.body.metadata).toMatchObject({
        local_visual_state: { state: "syncing", scope: "source index" },
        source_index: { state: "syncing", scope: "project-tracks", event_gap: null, error: null },
      });
      releaseArtifactCatalog?.();

      const current = await resyncing;
      expect(current.status).toBe(200);
      expect(current.body).toMatchObject({
        ok: true,
        resync: "bounded",
        sources: {
          metadata: {
            local_visual_state: { state: "current", scope: "source index" },
            source_index: { state: "current", scope: "project-tracks", event_gap: null, error: null },
          },
        },
      });

      const pruned = await events.insert({
        team_id: TEAM,
        topic: "artifact:registered",
        actor_agent_id: "agent_maestra",
        subject_kind: "artifact",
        subject_id: "artifact-source-pruned",
        occurred_at: NOW + 1,
        data: { project: "project-tracks", path: "output/source-pruned.md" },
      });
      await adapter.query(`DELETE FROM event_log WHERE seq = ?`, [pruned.seq]);
      await events.insert({
        team_id: TEAM,
        topic: "artifact:registered",
        actor_agent_id: "agent_maestra",
        subject_kind: "artifact",
        subject_id: "artifact-source-kept",
        occurred_at: NOW + 2,
        data: { project: "project-tracks", path: "output/source-kept.md" },
      });

      const gapped = await request(app, "GET", "/projects/project-tracks/sources");
      expect(gapped.status).toBe(200);
      expect(gapped.body.metadata).toMatchObject({
        local_visual_state: { state: "event_gap", scope: "source index" },
        source_index: {
          state: "event_gap",
          scope: "project-tracks",
          event_gap: {
            expected_seq: pruned.seq,
            observed_seq: pruned.seq + 1,
          },
          error: null,
        },
      });

      await adapter.close();
      const errored = await request(app, "GET", "/projects/project-tracks/sources");
      expect(errored.status).toBe(200);
      expect(errored.body.metadata).toMatchObject({
        local_visual_state: { state: "error", scope: "source index" },
        source_index: {
          state: "error",
          scope: "project-tracks",
        },
      });
      expect(errored.body.metadata.source_index.error).toEqual(expect.any(String));
    } finally {
      await adapter.close().catch(() => undefined);
    }
  });
});
