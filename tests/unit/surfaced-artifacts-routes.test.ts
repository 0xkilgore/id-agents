import { afterEach, describe, expect, it } from "vitest";
import express from "express";
import * as net from "node:net";
import type { Server } from "node:http";
import { SqliteAdapter } from "../../src/db/sqlite-adapter.js";
import { migrateSqlite } from "../../src/db/migrations/sqlite.js";
import { migrateOutputsTables, registerArtifact } from "../../src/outputs/storage.js";
import { mountSurfacedArtifactsRoutes } from "../../src/surfaced-artifacts/routes.js";

async function boot(): Promise<{ base: string; server: Server; adapter: SqliteAdapter }> {
  const adapter = new SqliteAdapter(":memory:");
  await migrateSqlite(adapter);
  await migrateOutputsTables(adapter);
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
    await registerArtifact(b.adapter, {
      artifact_id: "art-route",
      basename: "2026-07-07-kapelle-route-test.md",
      agent: "maestra",
      tag: "critical",
      abs_path: "/tmp/does-not-need-to-exist.md",
      title: "Kapelle route test",
      produced_at: "2026-07-07T12:00:00.000Z",
      source: "manual",
    }, "2026-07-07T12:00:00.000Z");
    const res = await fetch(`${b.base}/ops/surfaced-artifacts`);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body).toMatchObject({ ok: true, schema_version: "surfaced-artifacts.v1", count: 1 });
    expect(body.rows[0]).toMatchObject({
      id: "artifact:art-route",
      title: "Kapelle route test",
      status: "unread",
      relevance_reason: "changed_product_behavior",
      rank_score: expect.any(Number),
      group_count: 1,
      source_kind: "artifact",
      visibility_proof: { discovered_by: "manual_fixture", artifact_path_present: true, body_renderable: false },
    });
    expect(body.recent_flood).toMatchObject({
      total_raw_count: 1,
      grouped_count: 1,
      suppressed_from_primary_count: 0,
    });
    expect(body.recent_flood.raw_rows).toHaveLength(1);
  });
});
