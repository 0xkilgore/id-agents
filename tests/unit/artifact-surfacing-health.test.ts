import { describe, expect, it } from "vitest";
import express, { type Express } from "express";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteAdapter } from "../../src/db/sqlite-adapter.js";
import { migrateSqlite } from "../../src/db/migrations/sqlite.js";
import { migrateOutputsTables, registerArtifact } from "../../src/outputs/storage.js";
import { mountOutputsRoutes } from "../../src/outputs/routes.js";
import {
  evaluateSurfacingHealth,
  type SurfacingHealthEvent,
  type ArtifactActionProbe,
} from "../../src/outputs/surfacing-health.js";
import type { ArtifactCatalogRow, OutputsInboxRow } from "../../src/outputs/types.js";

const NOW = "2026-07-08T14:00:00.000Z";

function artifact(over: Partial<ArtifactCatalogRow> = {}): ArtifactCatalogRow {
  return {
    artifact_id: "art-finance",
    basename: "2026-07-08-cash-flow-cobra-boxx-addendum.md",
    agent: "finances",
    tag: "domain_action",
    abs_path: "/Users/kilgore/Dropbox/Code/finances/output/2026-07-08-cash-flow-cobra-boxx-addendum.md",
    title: "Cash-Flow Preview Correction Addendum - COBRA + BOXX LT Lots",
    produced_at: "2026-07-08T13:50:00.000Z",
    source: "agent-done",
    availability: "present",
    source_badges: "[\"agent-done\"]",
    reconciled_at: null,
    created_at: "2026-07-08T13:50:00.000Z",
    updated_at: "2026-07-08T13:50:00.000Z",
    ...over,
  };
}

function surfaced(id = "art-finance"): Pick<OutputsInboxRow, "artifact_id"> {
  return { artifact_id: id };
}

function probe(over: Partial<ArtifactActionProbe> = {}): ArtifactActionProbe {
  return {
    bodyRenderable: true,
    copyAvailable: true,
    downloadAvailable: true,
    bodyText: "# Report\n\nReady.",
    bodyPreview: "# Report",
    sourceMtime: "2026-07-08T13:50:00.000Z",
    contentHash: "abc123",
    ...over,
  };
}

function evaluate(row = artifact(), actionProbe = probe(), rows = [surfaced(row.artifact_id)]) {
  return evaluateSurfacingHealth({
    registered: [row],
    surfaced: rows,
    probes: new Map([[row.artifact_id, actionProbe]]),
    nowIso: NOW,
  });
}

function request(app: Express, path: string): Promise<{ status: number; text: string; body: any }> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, "127.0.0.1", async () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        server.close();
        reject(new Error("no addr"));
        return;
      }
      try {
        const response = await fetch(`http://127.0.0.1:${addr.port}${path}`);
        const text = await response.text();
        const body = response.headers.get("content-type")?.includes("application/json") ? JSON.parse(text) : null;
        server.close(() => resolve({ status: response.status, text, body }));
      } catch (err) {
        server.close(() => reject(err));
      }
    });
  });
}

describe("fresh-output surfacing health", () => {
  it("emits an operator-visible event when a registered artifact is absent from Desk/Recent Output", () => {
    const report = evaluate(artifact(), probe(), []);
    expect(report.ok).toBe(false);
    expect(report.events.map((event) => event.code)).toContain("absent_row");
    expect(report.events[0]).toMatchObject({
      schema_version: "artifact.surfacing.health_event.v1",
      operator_visible: true,
      artifact_id: "art-finance",
      stable_url: "/artifacts/art-finance/detail",
    });
  });

  it("emits body_unavailable when the registered artifact body cannot be served", () => {
    const report = evaluate(
      artifact({ availability: "missing" }),
      probe({ bodyRenderable: false, copyAvailable: false, downloadAvailable: false, bodyText: undefined, error: "body_unavailable" }),
    );
    expect(report.ok).toBe(false);
    expect(report.events.map((event) => event.code)).toContain("body_unavailable");
    expect(report.deliveries[0].freshness).toBe("body_unavailable");
  });

  it("emits copy/download failure events when fallback actions are unavailable", () => {
    const report = evaluate(
      artifact(),
      probe({ copyAvailable: false, downloadAvailable: false, error: "fallback_route_failed" }),
    );
    expect(report.ok).toBe(false);
    expect(report.events.map((event) => event.code)).toEqual(["copy_failed", "download_failed"]);
  });

  it("emits body_render_failed when body delivery exists but the console cannot render it", () => {
    const report = evaluate(
      artifact(),
      probe({ bodyRenderable: false, error: "renderer_failed" }),
    );
    expect(report.ok).toBe(false);
    expect(report.events).toEqual([
      expect.objectContaining({
        code: "body_render_failed",
        operator_visible: true,
        artifact_id: "art-finance",
      }),
    ]);
  });

  it("passes a healthy current Markdown artifact with body, copy, and download", () => {
    const report = evaluate();
    expect(report.ok).toBe(true);
    expect(report.events).toEqual([]);
    expect(report.deliveries[0]).toMatchObject({
      artifactId: "art-finance",
      mediaType: "text/markdown",
      bodyRenderable: true,
      copyTextUrl: "/artifacts/art-finance/copy-text",
      downloadUrl: "/artifacts/art-finance/download",
      discoveredBy: "agent_done",
      freshness: "current",
    });
  });

  it("dedupes operator-visible events by artifact id and failure code", () => {
    const row = artifact();
    const report = evaluateSurfacingHealth({
      registered: [row, row],
      surfaced: [],
      probes: new Map([[row.artifact_id, probe({ copyAvailable: false, downloadAvailable: false })]]),
      nowIso: NOW,
    });
    expect(report.ok).toBe(false);
    expect(report.events.map((event) => `${event.artifact_id}:${event.code}`)).toEqual([
      "art-finance:absent_row",
      "art-finance:copy_failed",
      "art-finance:download_failed",
    ]);
  });

  it("serves a healthy current artifact through stable body, copy, download, and health routes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "artifact-surfacing-"));
    const file = join(dir, "current.md");
    await writeFile(file, "# Current\n\nReadable from manager routes.\n", "utf8");

    const adapter = new SqliteAdapter(":memory:");
    await migrateSqlite(adapter);
    await migrateOutputsTables(adapter);
    await registerArtifact(
      adapter,
      {
        artifact_id: "art-current",
        basename: "current.md",
        agent: "finances",
        tag: "domain_action",
        abs_path: file,
        title: "Current Artifact",
        produced_at: NOW,
        source: "agent-done",
        availability: "present",
      },
      NOW,
    );

    const events: SurfacingHealthEvent[] = [];
    const app = express();
    app.use(express.json());
    mountOutputsRoutes(app, adapter, {
      autoIngest: false,
      now: () => new Date(NOW),
      onSurfacingHealthEvent: (event) => events.push(event),
    });

    const health = await request(app, "/artifacts/surfacing/health");
    expect(health.status).toBe(200);
    expect(health.body.ok).toBe(true);
    expect(events).toEqual([]);

    const detail = await request(app, "/artifacts/art-current/detail");
    expect(detail.status).toBe(200);
    expect(detail.body).toMatchObject({
      artifact_id: "art-current",
      schema_version: "artifact.detail.v1",
      render: { renderer: "markdown" },
      delivery: { bodyRenderable: true },
    });
    expect(detail.body.body.text).toContain("Readable from manager routes.");

    const copy = await request(app, "/artifacts/art-current/copy-text");
    expect(copy.status).toBe(200);
    expect(copy.text).toContain("Readable from manager routes.");

    const download = await request(app, "/artifacts/art-current/download");
    expect(download.status).toBe(200);
    expect(download.text).toContain("Readable from manager routes.");
  });
});
