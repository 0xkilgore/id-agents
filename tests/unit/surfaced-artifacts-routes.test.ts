import { afterEach, describe, expect, it } from "vitest";
import express from "express";
import * as net from "node:net";
import type { Server } from "node:http";
import { SqliteAdapter } from "../../src/db/sqlite-adapter.js";
import { migrateSqlite } from "../../src/db/migrations/sqlite.js";
import { artifactIdFromPath, migrateOutputsTables, registerArtifact } from "../../src/outputs/storage.js";
import { mountSurfacedArtifactsRoutes } from "../../src/surfaced-artifacts/routes.js";

async function boot(): Promise<{ base: string; server: Server; adapter: SqliteAdapter }> {
  const adapter = new SqliteAdapter(":memory:");
  await migrateSqlite(adapter);
  await migrateOutputsTables(adapter);
  await adapter.query(`INSERT INTO teams (id, name) VALUES ('default', 'default')`);
  const app = express();
  app.use(express.json());
  mountSurfacedArtifactsRoutes(app, adapter);
  const port = await new Promise<number>((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const p = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(p));
    });
    srv.on("error", reject);
  });
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(port, "127.0.0.1", () => resolve(s));
  });
  return { base: `http://127.0.0.1:${port}`, server, adapter };
}

let server: Server | null = null;
afterEach(() => {
  server?.close();
  server = null;
});

describe("GET /ops/surfaced-artifacts", () => {
  it("returns the surfaced artifact envelope and row contract", async () => {
    const b = await boot();
    server = b.server;
    const artifactPath = "/tmp/does-not-need-to-exist.md";
    const stableArtifactId = artifactIdFromPath(artifactPath);
    await registerArtifact(b.adapter, {
      artifact_id: "art-route",
      basename: "2026-07-07-kapelle-route-test.md",
      agent: "maestra",
      tag: "critical",
      abs_path: artifactPath,
      title: "Kapelle route test",
      produced_at: "2026-07-07T12:00:00.000Z",
      source: "manual",
    }, "2026-07-07T12:00:00.000Z");
    const res = await fetch(`${b.base}/ops/surfaced-artifacts`);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body).toMatchObject({
      ok: true,
      schema_version: "surfaced-artifacts.v1",
      count: 1,
      saved_view: {
        id: "surfaced-artifacts.v1.primary",
        execution: "saved_view_backed",
        field_ids: expect.arrayContaining(["artifact.title", "artifact.status", "artifact.projectRef"]),
        raw_row_key_mapping: expect.objectContaining({ project_ref: "artifact.projectRef" }),
      },
    });
    expect(body.rows[0]).toMatchObject({
      id: `artifact:${stableArtifactId}`,
      title: "Kapelle route test",
      status: "unread",
      relevance_reason: "changed_product_behavior",
      rank_score: expect.any(Number),
      group_count: 1,
      source_kind: "artifact",
      visibility_proof: { discovered_by: "manual_fixture", artifact_path_present: true, body_renderable: false },
      delivery: expect.objectContaining({
        stable_url: `/artifacts/${stableArtifactId}/detail`,
        copy_text_url: `/artifacts/${stableArtifactId}/copy-text`,
        download_url: `/artifacts/${stableArtifactId}/download`,
        freshness: "body_unavailable",
        body_cached: false,
      }),
    });
    expect(body.recent_flood).toMatchObject({
      total_raw_count: 1,
      grouped_count: 1,
      suppressed_from_primary_count: 0,
      source_data: { raw_limit: 250, primary_limit: 5, raw_row_count: 1, primary_row_count: 1, capped: false },
    });
    expect(body.recent_flood.raw_rows).toHaveLength(1);
    expect(body.health).toMatchObject({
      ok: false,
      surface: "ops.surfaced-artifacts.health",
      event_count: 1,
      events: [
        expect.objectContaining({
          topic: "artifact.surfacing.body_unavailable",
          severity: "error",
          subject_kind: "artifact",
          subject_id: artifactPath,
        }),
      ],
    });

    const eventRows = await b.adapter.query<{ topic: string; subject_id: string; data: string }>(
      `SELECT topic, subject_id, data FROM event_log ORDER BY seq ASC`,
    );
    expect(eventRows.rows).toHaveLength(1);
    expect(eventRows.rows[0]).toMatchObject({
      topic: "artifact.surfacing.body_unavailable",
      subject_id: artifactPath,
    });

    const second = await fetch(`${b.base}/ops/surfaced-artifacts`);
    expect(second.status).toBe(200);
    const afterRefresh = await b.adapter.query<{ c: number | string }>(
      `SELECT COUNT(*) AS c FROM event_log WHERE topic = 'artifact.surfacing.body_unavailable'`,
    );
    expect(Number(afterRefresh.rows[0]?.c ?? 0)).toBe(1);
  });

  it("rejects raw snake_case predicate fields through the saved-view execution route", async () => {
    const b = await boot();
    server = b.server;

    const res = await fetch(`${b.base}/ops/views/surfaced-artifacts.v1.primary/execute`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        query: { op: "eq", field: "project_ref", value: "kapelle" },
      }),
    });

    expect(res.status).toBe(422);
    const body = await res.json() as any;
    expect(body).toMatchObject({
      ok: false,
      schema_version: "view-execution.v1",
      view_id: "surfaced-artifacts.v1.primary",
      rows: [],
      count: 0,
      errors: [
        {
          code: "unsupported_field",
          field: "project_ref",
          canonical_field: "artifact.projectRef",
        },
      ],
    });
  });

  it("filters saved-view execution rows with canonical dotted fields", async () => {
    const b = await boot();
    server = b.server;
    const kapellePath = "/tmp/kapelle-filter.md";
    const kapelleStableId = artifactIdFromPath(kapellePath);
    await registerArtifact(b.adapter, {
      artifact_id: "art-kapelle-filter",
      basename: "2026-07-07-kapelle-filter.md",
      agent: "maestra",
      tag: "critical",
      abs_path: kapellePath,
      title: "Kapelle saved view filter",
      produced_at: "2026-07-07T12:00:00.000Z",
      source: "manual",
      project_ref: "kapelle",
    }, "2026-07-07T12:00:00.000Z");
    await registerArtifact(b.adapter, {
      artifact_id: "art-trinity-filter",
      basename: "2026-07-07-trinity-filter.md",
      agent: "maestra",
      tag: "critical",
      abs_path: "/tmp/trinity-filter.md",
      title: "Trinity saved view filter",
      produced_at: "2026-07-07T12:01:00.000Z",
      source: "manual",
      project_ref: "trinity",
    }, "2026-07-07T12:01:00.000Z");

    const res = await fetch(`${b.base}/ops/views/surfaced-artifacts.v1.primary/execute`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        query: { op: "eq", field: "artifact.projectRef", value: "kapelle" },
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body).toMatchObject({
      ok: true,
      schema_version: "view-execution.v1",
      view_id: "surfaced-artifacts.v1.primary",
      count: 1,
      errors: [],
    });
    expect(body.rows).toHaveLength(1);
    expect(body.rows[0]).toMatchObject({
      id: `artifact:${kapelleStableId}`,
      project_ref: "kapelle",
      title: "Kapelle saved view filter",
    });
  });
});
